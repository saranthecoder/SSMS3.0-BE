const mongoose = require('mongoose');
const User = require('../models/User');
const Submission = require('../models/Submission');
const Grade = require('../models/Grade');
const Attendance = require('../models/Attendance');
const Batch = require('../models/Batch');
const Task = require('../models/Task');
const Leetcode = require('../models/Leetcode');
const LeetcodeSubmission = require('../models/LeetcodeSubmission');
const MockDrive = require('../models/MockDrive');
const MockDriveScore = require('../models/MockDriveScore');
const Enrollment = require('../models/Enrollment');
const Leave = require('../models/Leave');
const MonitorAccess = require('../models/MonitorAccess');
const StudentAccessLog = require('../models/StudentAccessLog');
const SyllabusTrack = require('../models/SyllabusTrack');

// @desc    Verify student by roll number and get all performance data
// @route   GET /api/public/verify/:rollNumber
// @access  Public
const verifyStudent = async (req, res) => {
  try {
    const rollNumber = req.params.rollNumber.trim().toUpperCase();
    
    // 1. Find User (Student only)
    const user = await User.findOne({ rollNumber, role: 'student' }).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'Student not found or roll number is invalid.' });
    }

    // 2. Fetch Submissions & Grades
    const submissions = await Submission.find({ studentId: user._id, status: 'graded' })
      .populate('taskId', 'title maxMarks')
      .lean();

    const submissionIds = submissions.map(sub => sub._id);
    const grades = await Grade.find({ submissionId: { $in: submissionIds } }).lean();

    const gradeMap = {};
    grades.forEach(grade => {
      if (grade.submissionId) {
        gradeMap[grade.submissionId.toString()] = grade;
      }
    });

    const gradedTasks = [];
    for (const sub of submissions) {
      const grade = gradeMap[sub._id.toString()];
      if (grade && sub.taskId) {
        gradedTasks.push({
          taskTitle: sub.taskId.title,
          maxMarks: sub.taskId.maxMarks,
          marksObtained: grade.marksObtained,
          feedback: grade.feedback,
          submittedAt: sub.submittedAt
        });
      }
    }

    const quizzes = [];

    // 3b. Fetch Mock Drives
    const mockScores = await MockDriveScore.find({ studentId: user._id })
      .populate('mockDriveId', 'title maxMarks date')
      .sort('-createdAt')
      .lean();

    // 4. Fetch Attendance and Aggregate
    const attendanceLogs = await Attendance.find({ studentId: user._id }).lean();
    
    const dailyMap = {};
    attendanceLogs.forEach(log => {
      const logDate = log.dateStr;
      if (!dailyMap[logDate]) {
        dailyMap[logDate] = { totalSeconds: 0 };
      }
      dailyMap[logDate].totalSeconds += (log.sessionDurationSeconds || 0);
    });

    let daysPresent = 0;
    let daysAbsent = 0;
    let totalSecondsLogged = 0;

    Object.values(dailyMap).forEach(day => {
      totalSecondsLogged += day.totalSeconds;
      const hours = day.totalSeconds / 3600;
      if (hours >= 8 && hours <= 10) {
        daysPresent += 1;
      } else {
        daysAbsent += 1;
      }
    });

    const attendanceSummary = {
      daysPresent,
      daysAbsent,
      totalSecondsLogged,
      totalHoursLogged: (totalSecondsLogged / 3600).toFixed(2)
    };

    // Return payload
    res.status(200).json({
      profile: {
        name: user.name,
        email: user.email,
        phone: user.phone,
        profileImage: user.profileImage,
        github: user.github,
        linkedin: user.linkedin,
        portfolio: user.portfolio,
        leetcode: user.leetcode,
        hackerrank: user.hackerrank,
        leetcodeStreak: user.leetcodeStreak || 0,
        totalLeetcodeSubmissions: user.totalLeetcodeSubmissions || 0
      },
      tasks: gradedTasks.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)),
      quizzes: [],
      mockDrives: mockScores,
      attendance: attendanceSummary
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error fetching verification data.' });
  }
};

// In-memory cache & in-flight deduplication for monitor dashboard stats by PIN/Scope
const monitorCacheMap = new Map();
const inFlightMonitorMap = new Map();
const MONITOR_CACHE_TTL_MS = 15000; // 15 seconds fresh cache for near-realtime updates
const MONITOR_STALE_TTL_MS = 1800000; // 30 minutes stale-while-revalidate window

const getISTDateStr = (date = new Date()) => {
  const istTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const year = istTime.getFullYear();
  const month = String(istTime.getMonth() + 1).padStart(2, '0');
  const day = String(istTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const buildMonitorPayload = async (pin, cacheKey) => {
  if (inFlightMonitorMap.has(cacheKey)) {
    return inFlightMonitorMap.get(cacheKey);
  }

  const buildPromise = (async () => {
    // Resolve PIN permissions & custom college panel name
    let panelName = 'Monitoring Center';
    let isGlobal = true;
    let allowedBatchIds = [];

    if (pin) {
      const accessRecord = await MonitorAccess.findOne({ pin, isActive: true }).lean();
      if (accessRecord) {
        panelName = accessRecord.panelName || 'Monitoring Center';
        isGlobal = Boolean(accessRecord.isGlobal);
        allowedBatchIds = (accessRecord.allowedBatches || []).map(b => b.toString());
      } else if (pin === 'SA123') {
        panelName = 'Executive Command Center';
        isGlobal = true;
      }
    }

    const isRestrictedScope = !isGlobal && allowedBatchIds.length > 0;
    const allowedBatchSet = new Set(allowedBatchIds);

    // If restricted scope, pre-fetch task IDs and student IDs belonging to allowed batches
    let scopedTaskIds = [];
    let scopedBatchStudentIds = [];
    if (isRestrictedScope) {
      const [scopedTasksPre, scopedEnrollmentsPre, scopedUsersPre] = await Promise.all([
        Task.find({ batchId: { $in: allowedBatchIds } }).select('_id').lean(),
        Enrollment.find({ batchId: { $in: allowedBatchIds }, status: 'approved' }).select('studentId').lean(),
        User.find({ batchId: { $in: allowedBatchIds }, role: 'student' }).select('_id').lean()
      ]);
      scopedTaskIds = scopedTasksPre.map(t => t._id);
      const studentIdStrings = [
        ...scopedEnrollmentsPre.map(e => (e.studentId?._id || e.studentId)?.toString()),
        ...scopedUsersPre.map(u => u._id.toString())
      ].filter(Boolean);
      scopedBatchStudentIds = [...new Set(studentIdStrings)];
    }

    const taskQuery = isRestrictedScope ? { batchId: { $in: allowedBatchIds } } : {};
    const submissionQuery = isRestrictedScope
      ? {
          $or: [
            { taskId: { $in: scopedTaskIds } },
            ...(scopedBatchStudentIds.length > 0 ? [{ studentId: { $in: scopedBatchStudentIds } }] : [])
          ]
        }
      : {};
    const submissionMatchAgg = isRestrictedScope
      ? [{
          $match: {
            $or: [
              { taskId: { $in: scopedTaskIds } },
              ...(scopedBatchStudentIds.length > 0
                ? [{ studentId: { $in: scopedBatchStudentIds.map(id => new mongoose.Types.ObjectId(id)) } }]
                : [])
            ]
          }
        }]
      : [];
    const taskAggMatch = isRestrictedScope ? [{ $match: { taskId: { $in: scopedTaskIds } } }] : [];

    // Phase 1: Fetch raw collections & full-DB aggregations in parallel WITHOUT duplicate Mongoose .populate() round-trips
    const todayDateStr = getISTDateStr();
    const leetcodeAggPipeline = isRestrictedScope
      ? [
          ...(scopedBatchStudentIds.length > 0
            ? [{ $match: { studentId: { $in: scopedBatchStudentIds.map(id => new mongoose.Types.ObjectId(id)) } } }]
            : [{ $match: { _id: null } }]),
          { $group: { _id: '$problemId', count: { $sum: 1 } } }
        ]
      : [{ $group: { _id: '$problemId', count: { $sum: 1 } } }];

    const [
      students,
      activeAttendances,
      allSubmissions,
      allTasks,
      taskStatsAgg,
      subStatusAgg,
      studentSubAgg,
      attendanceAggregates,
      todayAttendance,
      batches,
      leetcodeProblems,
      leetcodeSubCountsAgg,
      allMockDriveScores,
      allEnrollments,
      allLeaves,
      allAccessLogs,
      allSyllabus
    ] = await Promise.all([
      User.find({ role: 'student' })
        .select('name email rollNumber phone profileImage batchId batch github linkedin portfolio leetcode hackerrank leetcodeStreak maxLeetcodeStreak totalLeetcodeSubmissions isRestricted isBlocked isSuspended suspendedUntil blockReason coins level xp points league createdAt')
        .lean(),
      
      Attendance.find({ isActive: true })
        .select('studentId batchId checkInTime lastCheckInTime sessionDurationSeconds isActive dateStr mode locationType')
        .lean(),

      // Recent submissions for UI tables/timeline (exact totals come from aggregations below)
      Submission.find(submissionQuery)
        .sort({ submittedAt: -1 })
        .limit(isRestrictedScope ? 1000 : 300)
        .select('taskId studentId status submittedAt createdAt submissionType githubLink liveLink isLate delayHours latePenalty coinsAwarded xpAwarded')
        .lean(),

      // Tasks without large HTML description bodies
      Task.find(taskQuery)
        .sort({ createdAt: -1 })
        .select('title category maxMarks dueDate batchId scheduledAt createdAt taskType')
        .lean(),

      // Exact submission counts by status aggregated per task across ALL submissions
      Submission.aggregate([
        ...taskAggMatch,
        {
          $group: {
            _id: "$taskId",
            submissionCount: { $sum: 1 },
            gradedCount: {
              $sum: { $cond: [{ $eq: ["$status", "graded"] }, 1, 0] }
            },
            pendingCount: {
              $sum: { $cond: [{ $in: ["$status", ["submitted", "pending"]] }, 1, 0] }
            },
            resubmitCount: {
              $sum: { $cond: [{ $eq: ["$status", "resubmit"] }, 1, 0] }
            }
          }
        }
      ]),

      // Exact submission status summary counts across ALL submissions
      Submission.aggregate([
        ...taskAggMatch,
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 }
          }
        }
      ]),

      // Full-DB per-student submission & grade statistics across ALL submissions (not capped to 300/1000)
      Submission.aggregate([
        ...submissionMatchAgg,
        {
          $lookup: {
            from: "grades",
            localField: "_id",
            foreignField: "submissionId",
            as: "gradeDoc"
          }
        },
        {
          $lookup: {
            from: "tasks",
            localField: "taskId",
            foreignField: "_id",
            as: "taskDoc"
          }
        },
        {
          $project: {
            studentId: 1,
            status: 1,
            marksObtained: { $arrayElemAt: ["$gradeDoc.marksObtained", 0] },
            maxMarks: { $arrayElemAt: ["$taskDoc.maxMarks", 0] }
          }
        },
        {
          $group: {
            _id: "$studentId",
            totalSubmissions: { $sum: 1 },
            pendingCount: {
              $sum: { $cond: [{ $in: ["$status", ["submitted", "pending"]] }, 1, 0] }
            },
            gradedCount: {
              $sum: { $cond: [{ $eq: ["$status", "graded"] }, 1, 0] }
            },
            resubmitCount: {
              $sum: { $cond: [{ $eq: ["$status", "resubmit"] }, 1, 0] }
            },
            totalTaskScore: { $sum: { $ifNull: ["$marksObtained", 0] } },
            pctSum: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$status", "graded"] }, { $ne: ["$marksObtained", null] }, { $gt: ["$maxMarks", 0] }] },
                  { $multiply: [{ $divide: ["$marksObtained", "$maxMarks"] }, 100] },
                  0
                ]
              }
            },
            pctCount: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$status", "graded"] }, { $ne: ["$marksObtained", null] }, { $gt: ["$maxMarks", 0] }] },
                  1,
                  0
                ]
              }
            }
          }
        }
      ]),

      // Accurate attendance aggregation per student (only Present/active sessions count as daysPresent)
      Attendance.aggregate([
        {
          $group: {
            _id: "$studentId",
            totalSeconds: { $sum: { $ifNull: ["$sessionDurationSeconds", 0] } },
            daysPresent: {
              $addToSet: {
                $cond: [
                  { $or: [{ $eq: ["$status", "Present"] }, { $eq: ["$isActive", true] }] },
                  "$dateStr",
                  "$$REMOVE"
                ]
              }
            }
          }
        }
      ]),

      // Today's attendance logs for activity timeline
      Attendance.find({ dateStr: todayDateStr })
        .select('studentId checkInTime checkOutTime')
        .sort({ checkInTime: -1 })
        .lean(),

      Batch.find().populate('mentorId', 'name email profileImage phone').lean(),

      Leetcode.find()
        .select('title problemLink deadline difficulty batchId scheduledAt createdAt')
        .lean(),

      // Aggregated submission counts per LeetCode problem instead of transferring 3000+ raw rows
      LeetcodeSubmission.aggregate(leetcodeAggPipeline),

      MockDriveScore.find()
        .populate('mockDriveId', 'title maxMarks date')
        .lean(),

      Enrollment.find()
        .select('studentId batchId status createdAt')
        .lean(),

      Leave.find()
        .sort({ createdAt: -1 })
        .lean(),

      StudentAccessLog.find()
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),

      SyllabusTrack.find()
        .populate('mentorId', 'name email')
        .sort({ date: -1, createdAt: -1 })
        .limit(250)
        .lean()
    ]);

    // Build fast O(1) lookup maps in memory to replace 10+ redundant Atlas populate queries
    const studentMiniMap = new Map();
    students.forEach(st => {
      studentMiniMap.set(st._id.toString(), {
        _id: st._id,
        name: st.name,
        email: st.email,
        rollNumber: st.rollNumber,
        profileImage: st.profileImage,
        batchId: st.batchId || null,
        batch: st.batch || null
      });
    });

    const batchMiniMap = new Map();
    batches.forEach(b => {
      batchMiniMap.set(b._id.toString(), {
        _id: b._id,
        batchName: b.batchName,
        courseName: b.courseName
      });
    });

    const taskMiniMap = new Map();
    allTasks.forEach(t => {
      taskMiniMap.set(t._id.toString(), {
        _id: t._id,
        title: t.title,
        category: t.category,
        maxMarks: t.maxMarks,
        dueDate: t.dueDate,
        batchId: t.batchId
      });
    });

    const leetcodeSubCountMap = new Map();
    (leetcodeSubCountsAgg || []).forEach(item => {
      if (item._id) {
        leetcodeSubCountMap.set(item._id.toString(), item.count || 0);
      }
    });

    const hydrateStudent = (idVal) => {
      if (!idVal) return null;
      const key = (idVal._id || idVal).toString();
      return studentMiniMap.get(key) || (typeof idVal === 'object' ? idVal : { _id: idVal });
    };

    const hydrateBatch = (idVal) => {
      if (!idVal) return null;
      const key = (idVal._id || idVal).toString();
      return batchMiniMap.get(key) || (typeof idVal === 'object' ? idVal : { _id: idVal });
    };

    const hydrateTask = (idVal) => {
      if (!idVal) return null;
      const key = (idVal._id || idVal).toString();
      return taskMiniMap.get(key) || (typeof idVal === 'object' ? idVal : { _id: idVal });
    };

    // Phase 2: Query grades ONLY for the loaded submissions using indexed unique field submissionId
    const subIds = allSubmissions.map(s => s._id);
    const allGrades = subIds.length > 0
      ? await Grade.find({ submissionId: { $in: subIds } })
          .select('submissionId marksObtained rawMarks latePenalty feedback reviewedBy reviewedAt')
          .populate('reviewedBy', 'name')
          .lean()
      : [];

    // Build attendance map
    const attendanceMap = {};
    attendanceAggregates.forEach(agg => {
      if (agg._id) {
        attendanceMap[agg._id.toString()] = {
          totalSeconds: agg.totalSeconds,
          daysPresentCount: agg.daysPresent.length
        };
      }
    });

    // Build grade map (submissionId -> grade)
    const gradeMap = {};
    allGrades.forEach(g => {
      if (g.submissionId) {
        gradeMap[g.submissionId.toString()] = g;
      }
    });

    // Build student enrollment to batch map (source of truth for student batch assignment)
    const studentBatchMap = {};
    allEnrollments.forEach(e => {
      if (e.status === 'approved' && e.studentId && e.batchId) {
        const sId = (e.studentId._id || e.studentId).toString();
        const bId = (e.batchId._id || e.batchId).toString();
        studentBatchMap[sId] = bId;
      }
    });

    // Filter datasets by allowed batches if scoped to specific batches
    const effectiveBatches = isRestrictedScope
      ? batches.filter(b => allowedBatchSet.has(b._id.toString()))
      : batches;

    const effectiveStudents = isRestrictedScope
      ? students.filter(s => {
          const sId = s._id.toString();
          const bId = studentBatchMap[sId] || (s.batchId?._id || s.batchId)?.toString();
          return bId && allowedBatchSet.has(bId);
        })
      : students;

    const scopedStudentIdSet = new Set(effectiveStudents.map(s => s._id.toString()));

    const effectiveActiveAttendances = isRestrictedScope
      ? activeAttendances.filter(a => {
          const sId = (a.studentId?._id || a.studentId)?.toString();
          return sId && scopedStudentIdSet.has(sId);
        })
      : activeAttendances;

    const effectiveSubmissions = isRestrictedScope
      ? allSubmissions.filter(sub => {
          const sId = (sub.studentId?._id || sub.studentId)?.toString();
          const hydratedTask = hydrateTask(sub.taskId);
          const bId = (hydratedTask?.batchId?._id || hydratedTask?.batchId)?.toString();
          return (sId && scopedStudentIdSet.has(sId)) || (bId && allowedBatchSet.has(bId));
        })
      : allSubmissions;

    // Build task stats map from aggregation
    const taskStatsMap = {};
    (taskStatsAgg || []).forEach(stat => {
      if (stat._id) {
        taskStatsMap[stat._id.toString()] = {
          submissionCount: stat.submissionCount || 0,
          gradedCount: stat.gradedCount || 0,
          pendingCount: stat.pendingCount || 0,
          resubmitCount: stat.resubmitCount || 0
        };
      }
    });

    const effectiveTasks = (isRestrictedScope
      ? allTasks.filter(t => t.batchId && allowedBatchSet.has((t.batchId._id || t.batchId).toString()))
      : allTasks
    ).map(task => {
      const tId = task._id?.toString();
      const stats = taskStatsMap[tId] || { submissionCount: 0, gradedCount: 0, pendingCount: 0, resubmitCount: 0 };
      return {
        ...task,
        batchId: hydrateBatch(task.batchId),
        submissionCount: stats.submissionCount,
        gradedCount: stats.gradedCount,
        pendingCount: stats.pendingCount,
        resubmitCount: stats.resubmitCount
      };
    });

    const effectiveTodayAttendance = (isRestrictedScope
      ? todayAttendance.filter(a => {
          const sId = (a.studentId?._id || a.studentId)?.toString();
          return sId && scopedStudentIdSet.has(sId);
        })
      : todayAttendance
    ).map(a => ({
      ...a,
      studentId: hydrateStudent(a.studentId)
    }));

    const effectiveLeetcodeProblems = (isRestrictedScope
      ? leetcodeProblems.filter(lp => !lp.batchId || allowedBatchSet.has((lp.batchId._id || lp.batchId).toString()))
      : leetcodeProblems
    ).map(lp => ({
      ...lp,
      batchId: hydrateBatch(lp.batchId),
      submissionCount: leetcodeSubCountMap.get(lp._id.toString()) || 0
    }));

    const effectiveLeetcodeSubmissions = [];

    const effectiveMockDriveScores = isRestrictedScope
      ? allMockDriveScores.filter(m => {
          const sId = (m.studentId?._id || m.studentId)?.toString();
          return sId && scopedStudentIdSet.has(sId);
        })
      : allMockDriveScores;

    const effectiveEnrollments = (isRestrictedScope
      ? allEnrollments.filter(e => allowedBatchSet.has((e.batchId?._id || e.batchId)?.toString()))
      : allEnrollments
    ).map(e => ({
      ...e,
      studentId: hydrateStudent(e.studentId),
      batchId: hydrateBatch(e.batchId)
    }));

    const effectiveLeaves = isRestrictedScope
      ? allLeaves.filter(l => {
          const sId = (l.studentId?._id || l.studentId)?.toString();
          return sId && scopedStudentIdSet.has(sId);
        })
      : allLeaves;

    const effectiveAccessLogs = isRestrictedScope
      ? allAccessLogs.filter(log => {
          const sId = (log.studentId?._id || log.studentId)?.toString();
          const bId = (log.batchId?._id || log.batchId)?.toString();
          return (sId && scopedStudentIdSet.has(sId)) || (bId && allowedBatchSet.has(bId));
        })
      : allAccessLogs;

    // Enrich submissions with student batch, task info, and grades
    const enrichedSubmissions = effectiveSubmissions.map(sub => {
      const sId = sub.studentId?._id ? sub.studentId._id.toString() : sub.studentId?.toString();
      const studentObj = hydrateStudent(sub.studentId);
      const studentBatchId = studentBatchMap[sId] || null;
      return {
        ...sub,
        studentId: studentObj ? {
          ...studentObj,
          batchId: studentObj.batchId || studentBatchId
        } : null,
        taskId: hydrateTask(sub.taskId),
        grade: gradeMap[sub._id.toString()] || null
      };
    });

    // Enrich active attendances with student batch assignment
    const enrichedActiveAttendances = effectiveActiveAttendances.map(a => {
      const sId = a.studentId?._id ? a.studentId._id.toString() : a.studentId?.toString();
      const studentObj = hydrateStudent(a.studentId);
      const studentBatchId = studentBatchMap[sId] || null;
      return {
        ...a,
        studentId: studentObj ? {
          ...studentObj,
          batchId: studentObj.batchId || studentBatchId
        } : null
      };
    });

    // Enrich mock drive scores with student batch assignment
    const enrichedMockDriveScores = effectiveMockDriveScores.map(score => {
      const sId = score.studentId?._id ? score.studentId._id.toString() : score.studentId?.toString();
      const studentObj = hydrateStudent(score.studentId);
      const studentBatchId = studentBatchMap[sId] || null;
      return {
        ...score,
        studentId: studentObj ? {
          ...studentObj,
          batchId: studentObj.batchId || studentBatchId
        } : null
      };
    });

    // Enrich leaves with student batch assignment
    const enrichedLeaves = effectiveLeaves.map(l => {
      const sId = l.studentId?._id ? l.studentId._id.toString() : l.studentId?.toString();
      const studentObj = hydrateStudent(l.studentId);
      const studentBatchId = studentBatchMap[sId] || null;
      return {
        ...l,
        studentId: studentObj ? {
          ...studentObj,
          batchId: studentObj.batchId || l.batch || studentBatchId
        } : null
      };
    });

    // Build full-DB per-student submission & score lookup map
    const studentSubStatsMap = new Map();
    (studentSubAgg || []).forEach(row => {
      if (!row._id) return;
      studentSubStatsMap.set(row._id.toString(), {
        totalSubmissions: row.totalSubmissions || 0,
        pendingCount: row.pendingCount || 0,
        gradedCount: row.gradedCount || 0,
        resubmitCount: row.resubmitCount || 0,
        totalTaskScore: row.totalTaskScore || 0,
        avgGrade: row.pctCount > 0 ? Math.round(row.pctSum / row.pctCount) : 0
      });
    });

    const studentMockScores = {};
    effectiveMockDriveScores.forEach(score => {
      if (score.studentId && score.attended) {
        const sId = score.studentId._id ? score.studentId._id.toString() : score.studentId.toString();
        studentMockScores[sId] = (studentMockScores[sId] || 0) + (score.totalMarks || 0);
      }
    });

    // Pre-index active student set in O(N)
    const activeStudentSet = new Set();
    effectiveActiveAttendances.forEach(a => {
      const sId = (a.studentId?._id || a.studentId)?.toString();
      if (sId) activeStudentSet.add(sId);
    });

    // Build student data with full-DB attendance & submission stats
    const studentData = effectiveStudents.map(student => {
      const sId = student._id.toString();
      const batchId = studentBatchMap[sId] || null;
      const att = attendanceMap[sId] || { totalSeconds: 0, daysPresentCount: 0 };
      const isActive = activeStudentSet.has(sId);
      const subStats = studentSubStatsMap.get(sId) || {
        totalSubmissions: 0,
        pendingCount: 0,
        gradedCount: 0,
        resubmitCount: 0,
        totalTaskScore: 0,
        avgGrade: 0
      };

      const totalTaskScore = subStats.totalTaskScore;
      const totalMockDriveScore = studentMockScores[sId] || 0;
      const streakScore = (student.leetcodeStreak || 0) * 10;
      const overallScore = totalTaskScore + totalMockDriveScore + streakScore;

      return {
        ...student,
        batchId,
        totalSeconds: att.totalSeconds,
        daysPresent: att.daysPresentCount,
        isActive,
        totalSubmissions: subStats.totalSubmissions,
        gradedCount: subStats.gradedCount,
        pendingCount: subStats.pendingCount,
        resubmitCount: subStats.resubmitCount,
        avgGrade: subStats.avgGrade,
        totalTaskScore,
        totalMockDriveScore,
        overallScore
      };
    });

    const studentsByBatchMap = new Map();
    studentData.forEach(s => {
      const bId = s.batchId ? s.batchId.toString() : null;
      if (!bId) return;
      if (!studentsByBatchMap.has(bId)) studentsByBatchMap.set(bId, []);
      studentsByBatchMap.get(bId).push(s);
    });

    const tasksByBatchMap = new Map();
    effectiveTasks.forEach(t => {
      const bId = (t.batchId?._id || t.batchId)?.toString();
      if (!bId) return;
      if (!tasksByBatchMap.has(bId)) tasksByBatchMap.set(bId, []);
      tasksByBatchMap.get(bId).push(t);
    });

    // Build batch summary data from exact full-DB task & student stats
    const batchSummaries = effectiveBatches.map(batch => {
      const bIdStr = batch._id.toString();
      const batchStudents = studentsByBatchMap.get(bIdStr) || [];
      const batchTasks = tasksByBatchMap.get(bIdStr) || [];
      const batchSubmissionCount = batchTasks.reduce((sum, t) => sum + (t.submissionCount || 0), 0);

      let activeInBatch = 0;
      let totalAtt = 0;
      let totalGrade = 0;
      let gradedStudentCount = 0;
      for (const s of batchStudents) {
        if (s.isActive) activeInBatch++;
        totalAtt += s.daysPresent;
        if ((s.gradedCount || 0) > 0 || (s.avgGrade || 0) > 0) {
          totalGrade += s.avgGrade;
          gradedStudentCount++;
        }
      }

      const avgAttendance = batchStudents.length > 0 ? Math.round(totalAtt / batchStudents.length) : 0;
      const avgGrade = gradedStudentCount > 0 ? Math.round(totalGrade / gradedStudentCount) : 0;

      return {
        ...batch,
        studentCount: batchStudents.length,
        activeCount: activeInBatch,
        taskCount: batchTasks.length,
        submissionCount: batchSubmissionCount,
        avgAttendanceDays: avgAttendance,
        avgGrade
      };
    });

    // Build activity timeline from today's attendance
    const activityTimeline = [];
    effectiveTodayAttendance.forEach(log => {
      if (log.checkInTime) {
        activityTimeline.push({
          type: 'check-in',
          studentName: log.studentId?.name || 'Unknown',
          rollNumber: log.studentId?.rollNumber || '',
          timestamp: log.checkInTime,
          description: `${log.studentId?.name} checked in`
        });
      }
      if (log.checkOutTime) {
        activityTimeline.push({
          type: 'check-out',
          studentName: log.studentId?.name || 'Unknown',
          rollNumber: log.studentId?.rollNumber || '',
          timestamp: log.checkOutTime,
          description: `${log.studentId?.name} checked out`
        });
      }
    });

    // Add today's submissions (IST day) to timeline
    const todayStr = getISTDateStr();
    enrichedSubmissions.forEach(sub => {
      if (sub.submittedAt && getISTDateStr(new Date(sub.submittedAt)) === todayStr) {
        activityTimeline.push({
          type: 'submission',
          studentName: sub.studentId?.name || 'Unknown',
          rollNumber: sub.studentId?.rollNumber || '',
          timestamp: sub.submittedAt,
          description: `${sub.studentId?.name} submitted "${sub.taskId?.title}"`
        });
      }
    });

    // Add recent access changes to timeline
    effectiveAccessLogs.slice(0, 25).forEach(log => {
      activityTimeline.push({
        type: log.action === 'restore' ? 'access-restore' : 'access-restrict',
        studentName: log.studentName || 'Student',
        rollNumber: log.studentRollNumber || '',
        timestamp: log.createdAt,
        description: `${log.studentName} access was ${log.action === 'block' ? 'blocked' : log.action === 'suspend' ? 'suspended' : 'restored'} by ${log.performedByName}${log.reason ? ` (${log.reason})` : ''}`
      });
    });

    activityTimeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Calculate global stats
    let totalSubmissionsCount = 0;
    let totalPendingReviews = 0;
    let totalCompletedReviews = 0;
    let totalResubmitReviews = 0;

    (subStatusAgg || []).forEach(item => {
      totalSubmissionsCount += (item.count || 0);
      if (item._id === 'submitted' || item._id === 'pending') totalPendingReviews += (item.count || 0);
      if (item._id === 'graded') totalCompletedReviews += (item.count || 0);
      if (item._id === 'resubmit') totalResubmitReviews += (item.count || 0);
    });

    if (totalSubmissionsCount === 0 && effectiveSubmissions.length > 0) {
      totalSubmissionsCount = effectiveSubmissions.length;
      totalPendingReviews = effectiveSubmissions.filter(s => s.status === 'submitted' || s.status === 'pending').length;
      totalCompletedReviews = effectiveSubmissions.filter(s => s.status === 'graded').length;
      totalResubmitReviews = effectiveSubmissions.filter(s => s.status === 'resubmit').length;
    }
    const gradedStudentList = studentData.filter(s => (s.gradedCount || 0) > 0 || (s.avgGrade || 0) > 0);
    const overallAvgGrade = gradedStudentList.length > 0
      ? Math.round(gradedStudentList.reduce((sum, s) => sum + s.avgGrade, 0) / gradedStudentList.length)
      : 0;
    const overallAvgAttendance = studentData.length > 0
      ? Math.round(studentData.reduce((sum, s) => sum + s.daysPresent, 0) / studentData.length)
      : 0;

    let topLeetcodeStreak = 0;
    let totalLeetcodeSolved = 0;
    studentData.forEach(student => {
      if (student.leetcodeStreak > topLeetcodeStreak) {
        topLeetcodeStreak = student.leetcodeStreak;
      }
      totalLeetcodeSolved += (student.totalLeetcodeSubmissions || 0);
    });

    let totalMockPercentage = 0;
    let mockPercentageCount = 0;
    effectiveMockDriveScores.forEach(score => {
      if (score.attended && score.percentage !== undefined) {
        totalMockPercentage += score.percentage;
        mockPercentageCount += 1;
      }
    });
    const avgMockDriveScore = mockPercentageCount > 0 ? Math.round(totalMockPercentage / mockPercentageCount) : 0;

    const effectiveSyllabus = (isRestrictedScope
      ? (allSyllabus || []).filter(s => {
          const bId = s.batchId?._id ? s.batchId._id.toString() : s.batchId?.toString();
          return bId && allowedBatchIds.includes(bId);
        })
      : (allSyllabus || [])
    ).map(s => ({
      ...s,
      batchId: hydrateBatch(s.batchId)
    }));

    const payload = {
      stats: {
        totalStudents: effectiveStudents.length,
        activeStudents: effectiveActiveAttendances.length,
        offlineStudents: effectiveStudents.length - effectiveActiveAttendances.length,
        totalBatches: effectiveBatches.length,
        totalTasks: effectiveTasks.length,
        totalSubmissions: totalSubmissionsCount || effectiveSubmissions.length,
        pendingReviews: totalPendingReviews,
        completedReviews: totalCompletedReviews,
        resubmitReviews: totalResubmitReviews,
        avgAttendanceDays: overallAvgAttendance,
        avgPerformance: overallAvgGrade,
        avgMockDriveScore,
        topLeetcodeStreak,
        totalLeetcodeSolved
      },
      serverTimestamp: new Date().toISOString(),
      panelName,
      isRestricted: isRestrictedScope,
      allowedBatchIds: isRestrictedScope ? allowedBatchIds : [],
      students: studentData,
      activeStudents: enrichedActiveAttendances,
      submissions: enrichedSubmissions,
      tasks: effectiveTasks,
      batches: batchSummaries,
      activityTimeline: activityTimeline.slice(0, 200),
      leetcodeProblems: effectiveLeetcodeProblems,
      leetcodeSubmissions: effectiveLeetcodeSubmissions,
      mockDriveScores: enrichedMockDriveScores,
      enrollments: effectiveEnrollments,
      leaves: enrichedLeaves,
      accessLogs: effectiveAccessLogs,
      syllabusTracks: effectiveSyllabus
    };

    monitorCacheMap.set(cacheKey, { payload, timestamp: Date.now() });
    return payload;
  })();

  inFlightMonitorMap.set(cacheKey, buildPromise);
  try {
    return await buildPromise;
  } finally {
    inFlightMonitorMap.delete(cacheKey);
  }
};

// Trigger silent background pre-warm for instant /verify dashboard open
const prewarmMonitorDashboard = (rawPin = '') => {
  const cleanPin = (rawPin || '').trim().toUpperCase();
  const cacheKey = cleanPin || 'global';
  const entry = monitorCacheMap.get(cacheKey);
  if (entry && (Date.now() - entry.timestamp) < MONITOR_CACHE_TTL_MS) return;
  buildMonitorPayload(cleanPin, cacheKey).catch(() => {});
};

// @desc    Get complete monitoring dashboard data
// @route   GET /api/public/monitor
// @access  Public (Requires Frontend Passcode / PIN)
const getMonitorDashboardData = async (req, res) => {
  try {
    const now = Date.now();
    const isFreshRequested = req.query.fresh === 'true';
    const pin = (req.query.pin || req.headers['x-monitor-pin'] || '').trim().toUpperCase();
    const cacheKey = pin || 'global';

    if (!isFreshRequested && monitorCacheMap.has(cacheKey)) {
      const entry = monitorCacheMap.get(cacheKey);
      const age = entry ? (now - entry.timestamp) : Infinity;
      if (age < MONITOR_CACHE_TTL_MS) {
        return res.status(200).json(entry.payload);
      }
      if (age < MONITOR_STALE_TTL_MS) {
        // Return stale snapshot immediately and refresh silently in background
        buildMonitorPayload(pin, cacheKey).catch(() => {});
        return res.status(200).json(entry.payload);
      }
    }

    const payload = await buildMonitorPayload(pin, cacheKey);
    res.status(200).json(payload);
  } catch (error) {
    console.error('getMonitorDashboardData error:', error);
    const pin = (req.query.pin || req.headers['x-monitor-pin'] || '').trim().toUpperCase();
    const cacheKey = pin || 'global';
    const staleEntry = monitorCacheMap.get(cacheKey);
    if (staleEntry?.payload) {
      return res.status(200).json(staleEntry.payload);
    }
    res.status(500).json({ message: 'Server error fetching monitoring data.' });
  }
};

const allocatedResourcesCacheMap = new Map();

// @desc    Get all allocated tasks, projects and leetcode problems (optionally scoped to a specific batch)
// @route   GET /api/public/allocated-resources
// @access  Public
const getAllocatedResources = async (req, res) => {
  const { batchId } = req.query;
  const cacheKey = batchId ? String(batchId).trim() : 'all';
  try {
    const cached = allocatedResourcesCacheMap.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < MONITOR_CACHE_TTL_MS) {
      return res.status(200).json(cached.payload);
    }

    const taskQuery = {
      $or: [
        { scheduledAt: { $exists: false } },
        { scheduledAt: null },
        { scheduledAt: { $lte: new Date() } }
      ]
    };

    const leetcodeQuery = {
      $or: [
        { scheduledAt: { $exists: false } },
        { scheduledAt: null },
        { scheduledAt: { $lte: new Date() } }
      ]
    };

    let targetBatch = null;
    if (batchId && batchId !== 'all') {
      const isValidId = mongoose.Types.ObjectId.isValid(batchId);
      if (isValidId) {
        targetBatch = await Batch.findById(batchId).select('batchName panelName description').lean();
      } else {
        targetBatch = await Batch.findOne({ batchName: batchId }).select('batchName panelName description').lean();
      }

      if (targetBatch) {
        taskQuery.batchId = targetBatch._id;
        leetcodeQuery.$and = [
          {
            $or: [
              { scheduledAt: { $exists: false } },
              { scheduledAt: null },
              { scheduledAt: { $lte: new Date() } }
            ]
          },
          {
            $or: [
              { batchId: targetBatch._id },
              { batchId: null },
              { batchId: { $exists: false } }
            ]
          }
        ];
        delete leetcodeQuery.$or;
      }
    }

    const [tasksRaw, leetcodeRaw, allBatches] = await Promise.all([
      Task.find(taskQuery)
        .sort({ createdAt: -1 })
        .lean(),
      Leetcode.find(leetcodeQuery)
        .sort({ createdAt: -1 })
        .lean(),
      Batch.find().select('batchName panelName status').lean()
    ]);

    const batchMap = new Map(allBatches.map(b => [b._id.toString(), { _id: b._id, batchName: b.batchName, panelName: b.panelName }]));
    const tasks = tasksRaw.map(t => ({ ...t, batchId: t.batchId ? (batchMap.get(t.batchId.toString()) || t.batchId) : null }));
    const leetcodeProblems = leetcodeRaw.map(lp => ({ ...lp, batchId: lp.batchId ? (batchMap.get(lp.batchId.toString()) || lp.batchId) : null }));

    const payload = {
      tasks,
      leetcodeProblems,
      batches: allBatches,
      selectedBatch: targetBatch || null
    };
    allocatedResourcesCacheMap.set(cacheKey, { payload, timestamp: Date.now() });
    res.status(200).json(payload);
  } catch (error) {
    console.error(error);
    const stale = allocatedResourcesCacheMap.get(cacheKey);
    if (stale?.payload) {
      return res.status(200).json(stale.payload);
    }
    res.status(500).json({ message: 'Server error fetching allocated resources.' });
  }
};

module.exports = {
  verifyStudent,
  getMonitorDashboardData,
  prewarmMonitorDashboard,
  getAllocatedResources
};
