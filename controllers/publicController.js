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

// In-memory cache for monitor dashboard stats
let monitorCache = null;
let monitorCacheTimestamp = 0;
const MONITOR_CACHE_TTL_MS = 15000; // 15 seconds

// @desc    Get complete monitoring dashboard data
// @route   GET /api/public/monitor
// @access  Public (Requires Frontend Passcode)
const getMonitorDashboardData = async (req, res) => {
  try {
    const now = Date.now();
    if (monitorCache && (now - monitorCacheTimestamp) < MONITOR_CACHE_TTL_MS) {
      return res.status(200).json(monitorCache);
    }

    // Phase 1: Fetch all data except grades in parallel
    const [
      students,
      activeAttendances,
      allSubmissions,
      allTasks,
      attendanceAggregates,
      todayAttendance,
      batches,
      leetcodeProblems,
      leetcodeSubmissions,
      allMockDriveScores,
      allEnrollments,
      allLeaves
    ] = await Promise.all([
      User.find({ role: 'student' }).select('-password -__v').lean(),
      
      Attendance.find({ isActive: true })
        .populate('studentId', 'name rollNumber profileImage batchId')
        .lean(),

      // All submissions with student + task data (limited to 500 latest)
      Submission.find()
        .sort({ submittedAt: -1 })
        .limit(500)
        .populate('studentId', 'name rollNumber profileImage email batchId')
        .populate('taskId', 'title category maxMarks dueDate batchId')
        .lean(),

      // All tasks
      Task.find()
        .sort({ createdAt: -1 })
        .populate('batchId', 'batchName')
        .lean(),

      // Attendance aggregation per student
      Attendance.aggregate([
        {
          $group: {
            _id: "$studentId",
            totalSeconds: { $sum: { $ifNull: ["$sessionDurationSeconds", 0] } },
            daysPresent: { $addToSet: "$dateStr" }
          }
        }
      ]),

      // Today's attendance logs for activity timeline
      Attendance.find({ dateStr: new Date().toISOString().split('T')[0] })
        .populate('studentId', 'name rollNumber')
        .sort({ checkInTime: -1 })
        .lean(),

      Batch.find().lean(),

      Leetcode.find().populate('batchId', 'batchName').lean(),

      LeetcodeSubmission.find().populate('studentId', 'name rollNumber').lean(),

      MockDriveScore.find()
        .populate('mockDriveId', 'title maxMarks date')
        .populate('studentId', 'name rollNumber batchId')
        .lean(),

      Enrollment.find()
        .populate('studentId', 'name email rollNumber')
        .populate('batchId', 'batchName')
        .lean(),

      Leave.find()
        .populate('studentId', 'name email rollNumber batch')
        .sort({ createdAt: -1 })
        .lean()
    ]);

    // Phase 2: Query grades ONLY for the loaded 500 submissions using indexed unique field submissionId
    const subIds = allSubmissions.map(s => s._id);
    const allGrades = await Grade.find({ submissionId: { $in: subIds } })
      .populate('reviewedBy', 'name')
      .lean();

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

    // Enrich submissions with grades
    const enrichedSubmissions = allSubmissions.map(sub => ({
      ...sub,
      grade: gradeMap[sub._id.toString()] || null
    }));

    // Build student task/quiz/mock scores maps for efficient lookups
    const studentTaskScores = {};
    allSubmissions.forEach(sub => {
      if (sub.studentId) {
        const sId = sub.studentId._id ? sub.studentId._id.toString() : sub.studentId.toString();
        const marks = gradeMap[sub._id.toString()]?.marksObtained || 0;
        studentTaskScores[sId] = (studentTaskScores[sId] || 0) + marks;
      }
    });

    const studentQuizScores = {};

    const studentMockScores = {};
    allMockDriveScores.forEach(score => {
      if (score.studentId && score.attended) {
        const sId = score.studentId._id ? score.studentId._id.toString() : score.studentId.toString();
        studentMockScores[sId] = (studentMockScores[sId] || 0) + (score.totalMarks || 0);
      }
    });

    // Build student enrollment to batch map
    const studentBatchMap = {};
    allEnrollments.forEach(e => {
      if (e.status === 'approved' && e.studentId && e.batchId) {
        const sId = (e.studentId._id || e.studentId).toString();
        const bId = (e.batchId._id || e.batchId).toString();
        studentBatchMap[sId] = bId;
      }
    });

    // Build student data with attendance stats
    const studentData = students.map(student => {
      const sId = student._id.toString();
      const batchId = studentBatchMap[sId] || null;
      const att = attendanceMap[sId] || { totalSeconds: 0, daysPresentCount: 0 };
      const isActive = activeAttendances.some(a => 
        a.studentId && a.studentId._id.toString() === sId
      );
      
      // Calculate student's submissions and avg grade
      const studentSubmissions = allSubmissions.filter(s => 
        s.studentId && s.studentId._id.toString() === sId
      );
      const gradedSubs = studentSubmissions.filter(s => s.status === 'graded');
      let avgGrade = 0;
      if (gradedSubs.length > 0) {
        const totalMarksPercent = gradedSubs.reduce((acc, s) => {
          const g = gradeMap[s._id.toString()];
          if (g && s.taskId && s.taskId.maxMarks) {
            return acc + (g.marksObtained / s.taskId.maxMarks) * 100;
          }
          return acc;
        }, 0);
        avgGrade = Math.round(totalMarksPercent / gradedSubs.length);
      }

      const totalTaskScore = studentTaskScores[sId] || 0;
      const totalMockDriveScore = studentMockScores[sId] || 0;
      const streakScore = (student.leetcodeStreak || 0) * 10;
      const overallScore = totalTaskScore + totalMockDriveScore + streakScore;

      return {
        ...student,
        batchId,
        totalSeconds: att.totalSeconds,
        daysPresent: att.daysPresentCount,
        isActive,
        totalSubmissions: studentSubmissions.length,
        gradedCount: gradedSubs.length,
        pendingCount: studentSubmissions.filter(s => s.status === 'submitted').length,
        avgGrade,
        totalTaskScore,
        totalMockDriveScore,
        overallScore
      };
    });

    // Build batch summary data
    const batchSummaries = batches.map(batch => {
      const batchStudents = studentData.filter(s => 
        s.batchId && s.batchId.toString() === batch._id.toString()
      );
      const batchTasks = allTasks.filter(t => 
        t.batchId && t.batchId._id ? t.batchId._id.toString() === batch._id.toString() : t.batchId.toString() === batch._id.toString()
      );
      const batchSubmissions = allSubmissions.filter(s =>
        s.taskId && s.taskId.batchId && s.taskId.batchId.toString() === batch._id.toString()
      );
      const activeInBatch = batchStudents.filter(s => s.isActive).length;

      // Average attendance of batch students
      const avgAttendance = batchStudents.length > 0
        ? Math.round(batchStudents.reduce((sum, s) => sum + s.daysPresent, 0) / batchStudents.length)
        : 0;
      
      // Average grade of batch students  
      const avgGrade = batchStudents.length > 0
        ? Math.round(batchStudents.reduce((sum, s) => sum + s.avgGrade, 0) / batchStudents.length)
        : 0;

      return {
        ...batch,
        studentCount: batchStudents.length,
        activeCount: activeInBatch,
        taskCount: batchTasks.length,
        submissionCount: batchSubmissions.length,
        avgAttendanceDays: avgAttendance,
        avgGrade
      };
    });

    // Build activity timeline from today's attendance
    const activityTimeline = [];
    todayAttendance.forEach(log => {
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

    // Add today's submissions to timeline
    const todayStr = new Date().toISOString().split('T')[0];
    allSubmissions.forEach(sub => {
      if (sub.submittedAt && new Date(sub.submittedAt).toISOString().split('T')[0] === todayStr) {
        activityTimeline.push({
          type: 'submission',
          studentName: sub.studentId?.name || 'Unknown',
          rollNumber: sub.studentId?.rollNumber || '',
          timestamp: sub.submittedAt,
          description: `${sub.studentId?.name} submitted "${sub.taskId?.title}"`
        });
      }
    });

    activityTimeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Calculate global stats
    const totalPendingReviews = allSubmissions.filter(s => s.status === 'submitted').length;
    const totalCompletedReviews = allSubmissions.filter(s => s.status === 'graded').length;
    const overallAvgGrade = studentData.length > 0
      ? Math.round(studentData.reduce((sum, s) => sum + s.avgGrade, 0) / studentData.filter(s => s.avgGrade > 0).length) || 0
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
    allMockDriveScores.forEach(score => {
      if (score.attended && score.percentage !== undefined) {
        totalMockPercentage += score.percentage;
        mockPercentageCount += 1;
      }
    });
    const avgMockDriveScore = mockPercentageCount > 0 ? Math.round(totalMockPercentage / mockPercentageCount) : 0;

    const payload = {
      stats: {
        totalStudents: students.length,
        activeStudents: activeAttendances.length,
        offlineStudents: students.length - activeAttendances.length,
        totalBatches: batches.length,
        totalTasks: allTasks.length,
        totalSubmissions: allSubmissions.length,
        pendingReviews: totalPendingReviews,
        completedReviews: totalCompletedReviews,
        avgAttendanceDays: overallAvgAttendance,
        avgPerformance: overallAvgGrade,
        avgMockDriveScore,
        topLeetcodeStreak,
        totalLeetcodeSolved
      },
      students: studentData,
      activeStudents: activeAttendances,
      submissions: enrichedSubmissions,
      tasks: allTasks,
      batches: batchSummaries,
      activityTimeline: activityTimeline.slice(0, 200),
      leetcodeProblems,
      leetcodeSubmissions,
      mockDriveScores: allMockDriveScores,
      enrollments: allEnrollments,
      leaves: allLeaves
    };

    monitorCache = payload;
    monitorCacheTimestamp = now;

    res.status(200).json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error fetching monitoring data.' });
  }
};

// @desc    Get all allocated tasks, projects and leetcode problems
// @route   GET /api/public/allocated-resources
// @access  Public
const getAllocatedResources = async (req, res) => {
  try {
    const [tasks, leetcodeProblems] = await Promise.all([
      Task.find({
        $or: [
          { scheduledAt: { $exists: false } },
          { scheduledAt: null },
          { scheduledAt: { $lte: new Date() } }
        ]
      })
        .populate('batchId', 'batchName')
        .sort({ createdAt: -1 })
        .lean(),
      Leetcode.find({
        $or: [
          { scheduledAt: { $exists: false } },
          { scheduledAt: null },
          { scheduledAt: { $lte: new Date() } }
        ]
      })
        .populate('batchId', 'batchName')
        .sort({ createdAt: -1 })
        .lean()
    ]);

    res.status(200).json({
      tasks,
      leetcodeProblems
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error fetching allocated resources.' });
  }
};

module.exports = {
  verifyStudent,
  getMonitorDashboardData,
  getAllocatedResources
};
