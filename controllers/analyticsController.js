const User = require('../models/User');
const Batch = require('../models/Batch');
const Task = require('../models/Task');
const Submission = require('../models/Submission');
const Grade = require('../models/Grade');
const Enrollment = require('../models/Enrollment');
const Message = require('../models/Message');
const Leave = require('../models/Leave');
const Attendance = require('../models/Attendance');

const getISTDateStr = (date = new Date()) => {
  const istTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const year = istTime.getFullYear();
  const month = String(istTime.getMonth() + 1).padStart(2, '0');
  const day = String(istTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// In-memory cache for leaderboard computations to avoid heavy database queries on every page/dashboard load.
// Schema: { [batchId]: { leaderboard: [...], timestamp: number } }
const leaderboardCache = {};
const CACHE_TTL_MS = 180000; // 3 minutes Cache TTL

const getLeaderboardData = async (batchId) => {
  const now = Date.now();
  if (leaderboardCache[batchId] && (now - leaderboardCache[batchId].timestamp) < CACHE_TTL_MS) {
    return leaderboardCache[batchId].leaderboard;
  }

  // Find all approved students in the batch
  const enrollments = await Enrollment.find({ batchId, status: 'approved' })
    .populate('studentId', 'name profileImage leetcodeStreak equippedAvatar badges currentTitle profileBorder currentTheme currentNamecolor equippedPet equippedEffect coins level')
    .lean();
  
  // Fetch tasks belonging to this batch
  const tasks = await Task.find({
    batchId,
    $or: [
      { scheduledAt: { $exists: false } },
      { scheduledAt: null },
      { scheduledAt: { $lte: new Date() } }
    ]
  }).select('_id').lean();
  const taskIds = tasks.map(t => t._id);

  const MockDrive = require('../models/MockDrive');
  const MockDriveScore = require('../models/MockDriveScore');

  // Fetch mock drives for this batch
  const mockDrives = await MockDrive.find({ batchId }).select('_id').lean();
  const mockDriveIds = mockDrives.map(md => md._id);

  const [submissions, mockDriveScores] = await Promise.all([
    Submission.find({ taskId: { $in: taskIds } }).select('_id studentId taskId').lean(),
    MockDriveScore.find({ mockDriveId: { $in: mockDriveIds } }).select('studentId totalMarks').lean()
  ]);

  const submissionIds = submissions.map(s => s._id);
  const grades = await Grade.find({ submissionId: { $in: submissionIds } }).select('submissionId marksObtained').lean();

  // Optimize aggregation using Hash Maps for O(1) lookups
  const gradeMap = {};
  grades.forEach(g => {
    if (g.submissionId) {
      gradeMap[g.submissionId.toString()] = g.marksObtained || 0;
    }
  });

  const studentTaskScores = {};
  submissions.forEach(sub => {
    if (sub.studentId) {
      const sId = sub.studentId.toString();
      const marks = gradeMap[sub._id.toString()] || 0;
      studentTaskScores[sId] = (studentTaskScores[sId] || 0) + marks;
    }
  });

  const studentMockScores = {};
  mockDriveScores.forEach(score => {
    if (score.studentId) {
      const sId = score.studentId.toString();
      studentMockScores[sId] = (studentMockScores[sId] || 0) + (score.totalMarks || 0);
    }
  });

  // Calculate score for each student
  const leaderboard = enrollments.map(e => {
    const student = e.studentId;
    if (!student) return null;

    const sId = student._id.toString();
    const totalTaskScore = studentTaskScores[sId] || 0;
    const totalMockDriveScore = studentMockScores[sId] || 0;
    const streakScore = (student.leetcodeStreak || 0) * 10;
    const overallScore = totalTaskScore + totalMockDriveScore + streakScore;

    return {
      studentId: student._id.toString(),
      name: student.name,
      profileImage: student.profileImage,
      equippedAvatar: student.equippedAvatar,
      badges: student.badges || [],
      currentTitle: student.currentTitle || '',
      profileBorder: student.profileBorder || '',
      currentTheme: student.currentTheme || '',
      currentNamecolor: student.currentNamecolor || '',
      equippedPet: student.equippedPet || '',
      equippedEffect: student.equippedEffect || '',
      coins: student.coins || 0,
      level: student.level || 1,
      totalTaskScore,
      totalMockDriveScore,
      leetcodeStreak: student.leetcodeStreak || 0,
      streakScore,
      overallScore
    };
  }).filter(s => s !== null);

  // Sort descending by overallScore
  leaderboard.sort((a, b) => b.overallScore - a.overallScore);

  // Assign ranks
  leaderboard.forEach((student, index) => {
    student.rank = index + 1;
  });

  leaderboardCache[batchId] = {
    leaderboard,
    timestamp: now
  };

  return leaderboard;
};

// In-memory cache for student analytics to avoid heavy queries.
const studentAnalyticsCache = {};
const STUDENT_ANALYTICS_CACHE_TTL_MS = 120000; // 2 minutes Cache TTL

// @desc    Get student performance analytics
// @route   GET /api/analytics/student/:studentId
// @access  Private
const getStudentAnalytics = async (req, res) => {
  try {
    const studentId = req.params.studentId;

    if (req.user.role === 'student' && req.user._id.toString() !== studentId) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const isMini = req.query.mini === 'true';
    const cacheKey = `${studentId}_${isMini ? 'mini' : 'full'}`;
    const now = Date.now();
    if (studentAnalyticsCache[cacheKey] && (now - studentAnalyticsCache[cacheKey].timestamp) < STUDENT_ANALYTICS_CACHE_TTL_MS) {
      return res.json(studentAnalyticsCache[cacheKey].data);
    }

    if (isMini) {
      // Get all enrollments for student (select only batchId)
      const enrollments = await Enrollment.find({ studentId, status: 'approved' }).select('batchId').lean();
      const batchIds = enrollments.map(e => e.batchId);

      const [
        totalTasks,
        submissions,
        recentMessagesCount,
        newTasks,
        leaveUpdates
      ] = await Promise.all([
        Task.countDocuments({
          batchId: { $in: batchIds },
          $or: [
            { scheduledAt: { $exists: false } },
            { scheduledAt: null },
            { scheduledAt: { $lte: new Date() } }
          ]
        }),
        Submission.find({ studentId }).select('_id taskId status createdAt updatedAt').lean(),
        Message.countDocuments({
          batchId: { $in: batchIds },
          senderId: { $ne: studentId },
        }),
        Task.find({
          batchId: { $in: batchIds },
          $or: [
            { scheduledAt: { $exists: false } },
            { scheduledAt: null },
            { scheduledAt: { $lte: new Date() } }
          ]
        }).sort({ createdAt: -1 }).limit(5).select('title createdAt').lean(),
        Leave.find({ studentId, status: { $ne: 'pending' } }).sort({ updatedAt: -1 }).limit(3).select('date reason status updatedAt').lean()
      ]);

      // Fetch 5 latest grades
      const latestGrades = await Grade.find({ submissionId: { $in: submissions.map(s => s._id) } })
        .sort({ reviewedAt: -1, createdAt: -1 })
        .limit(5)
        .lean();

      // Look up taskId/title for latestGrades submissions
      const gradeSubIds = latestGrades.map(g => g.submissionId);
      const gradeSubmissions = await Submission.find({ _id: { $in: gradeSubIds } })
        .populate('taskId', 'title maxMarks')
        .lean();
      const gradeSubMap = {};
      gradeSubmissions.forEach(s => {
        gradeSubMap[s._id.toString()] = s;
      });

      let notifications = [];
      newTasks.forEach(t => {
        notifications.push({
          id: 'nt_' + t._id,
          type: 'task',
          title: 'New Task Assigned',
          message: t.title,
          time: t.createdAt
        });
      });

      latestGrades.forEach(g => {
        const sub = gradeSubMap[g.submissionId.toString()];
        notifications.push({
          id: 'ng_' + g._id,
          type: 'grade',
          title: `Task Graded: ${g.marksObtained}/${sub?.taskId?.maxMarks || 100}`,
          message: g.feedback || 'Review completed',
          time: g.reviewedAt || g.createdAt
        });
      });

      const resubmitSubmissions = submissions.filter(s => s.status === 'resubmit').slice(0, 5);
      const resubmitSubIds = resubmitSubmissions.map(s => s._id);
      const resubmitSubmissionsPopulated = await Submission.find({ _id: { $in: resubmitSubIds } })
        .populate('taskId', 'title')
        .lean();
      const resubmitMap = {};
      resubmitSubmissionsPopulated.forEach(s => {
        resubmitMap[s._id.toString()] = s;
      });

      resubmitSubmissions.forEach(s => {
        const fullSub = resubmitMap[s._id.toString()];
        notifications.push({
          id: 'rs_' + s._id,
          type: 'warning',
          title: 'Re-submission Requested',
          message: `Admin requested re-submission for: ${fullSub?.taskId?.title || 'Task'}`,
          time: s.updatedAt || s.createdAt
        });
      });

      leaveUpdates.forEach(l => {
        if (new Date() - new Date(l.updatedAt) < 7 * 24 * 60 * 60 * 1000) {
          notifications.push({
            id: 'nl_' + l._id,
            type: l.status === 'approved' ? 'grade' : 'warning',
            title: `Leave Request ${l.status.charAt(0).toUpperCase() + l.status.slice(1)}`,
            message: `Your leave for ${new Date(l.date).toLocaleDateString()} was ${l.status}.`,
            time: l.updatedAt
          });
        }
      });

      // 2.5 Fetch recent gamification reward events for student notifications
      try {
        const GamificationEvent = require('../models/GamificationEvent');
        const recentEvents = await GamificationEvent.find({
          userId: studentId,
          eventType: { $in: ['coins_earned', 'badge_unlocked', 'level_up'] }
        })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

        recentEvents.forEach(ev => {
          notifications.push({
            id: 'ge_' + ev._id,
            type: ev.eventType === 'level_up' ? 'grade' : 'task',
            title: ev.eventType === 'level_up' 
              ? 'Level Up! 🎉' 
              : ev.eventType === 'badge_unlocked' 
                ? 'New Achievement! 🏆' 
                : `Received +${ev.coinsChange} Coins 🪙`,
            message: ev.reason,
            time: ev.createdAt
          });
        });
      } catch (gemErr) {
        console.error('Error adding gamification events to student notifications:', gemErr);
      }

      notifications.sort((a, b) => new Date(b.time) - new Date(a.time));
      notifications = notifications.slice(0, 10);

      const miniPayload = {
        pendingTasks: Math.max(0, totalTasks - submissions.length),
        recentChats: recentMessagesCount,
        notifications
      };

      studentAnalyticsCache[cacheKey] = {
        data: miniPayload,
        timestamp: now
      };

      return res.json(miniPayload);
    }

    // Get all enrollments for student (populated to get batch start date)
    const enrollments = await Enrollment.find({ studentId, status: 'approved' }).populate('batchId').lean();
    const batchIds = enrollments.map(e => e.batchId?._id || e.batchId);

    // Run first batch of queries in parallel
    const [
      totalTasks,
      submissions,
      recentMessagesList,
      allBatchesCount,
      activeBatchesList,
      pendingLeavesCount,
      latestLeave,
      newTasks,
      leaveUpdates
    ] = await Promise.all([
      Task.countDocuments({
        batchId: { $in: batchIds },
        $or: [
          { scheduledAt: { $exists: false } },
          { scheduledAt: null },
          { scheduledAt: { $lte: new Date() } }
        ]
      }),
      Submission.find({ studentId }).select('_id taskId status createdAt updatedAt').populate('taskId', 'title maxMarks').lean(),
      Message.find({
        batchId: { $in: batchIds },
        senderId: { $ne: studentId },
      }).sort({ createdAt: -1 }).limit(3).populate('senderId', 'name').select('senderId text createdAt').lean(),
      Batch.countDocuments({ status: { $in: ['Active', 'Upcoming'] } }),
      Batch.find({ _id: { $in: batchIds } }).limit(3).select('batchName status').lean(),
      Leave.countDocuments({ studentId, status: 'pending' }),
      Leave.findOne({ studentId }).sort({ createdAt: -1 }).select('date reason status createdAt').lean(),
      Task.find({
        batchId: { $in: batchIds },
        $or: [
          { scheduledAt: { $exists: false } },
          { scheduledAt: null },
          { scheduledAt: { $lte: new Date() } }
        ]
      }).sort({ createdAt: -1 }).limit(5).select('title createdAt').lean(),
      Leave.find({ studentId, status: { $ne: 'pending' } }).sort({ updatedAt: -1 }).limit(3).select('date reason status updatedAt').lean()
    ]);

    const completedTasks = submissions.length;
    const taskCompletionRate = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);
    const recentChats = recentMessagesList.length;
    const myBatchesCount = enrollments.length;
    const availableBatchesCount = Math.max(0, allBatchesCount - myBatchesCount);

    // Get grades for these submissionIds (without heavy nested populate!)
    const submissionIds = submissions.map(s => s._id);
    const grades = await Grade.find({ submissionId: { $in: submissionIds } })
      .select('submissionId marksObtained feedback reviewedAt createdAt')
      .lean();

    // Map submissionId to submission object for O(1) lookups
    const submissionMap = {};
    submissions.forEach(s => {
      submissionMap[s._id.toString()] = s;
    });

    let totalMarksObtained = 0;
    let totalMaxMarks = 0;

    grades.forEach(grade => {
      totalMarksObtained += grade.marksObtained;
      const sub = submissionMap[grade.submissionId.toString()];
      if (sub && sub.taskId) {
        totalMaxMarks += sub.taskId.maxMarks;
      }
    });

    const averageScore = totalMaxMarks === 0 ? 0 : Math.round((totalMarksObtained / totalMaxMarks) * 100);

    let performanceTrend = 'Needs Improvement';
    if (averageScore >= 80) performanceTrend = 'Improving';
    else if (averageScore >= 60) performanceTrend = 'Stable';

    // Chart Data (Student Performance Trend) - Up to 7 most recent grades
    const sortedGrades = [...grades].sort((a, b) => new Date(a.reviewedAt || a.createdAt) - new Date(b.reviewedAt || b.createdAt));
    const recentGrades = sortedGrades.slice(-7);
    
    const chartData = recentGrades.map(g => {
      const sub = submissionMap[g.submissionId.toString()];
      const taskTitle = sub?.taskId?.title || 'Task';
      return {
        name: taskTitle.length > 15 ? taskTitle.substring(0, 15) + '...' : taskTitle,
        score: g.marksObtained,
        max: sub?.taskId?.maxMarks || 100
      };
    });

    // Notifications (Recent Activity)
    const latestGrades = [...grades].sort((a, b) => new Date(b.reviewedAt || b.createdAt) - new Date(a.reviewedAt || a.createdAt)).slice(0, 5);
    const resubmitSubmissions = submissions.filter(s => s.status === 'resubmit');

    let notifications = [];
    newTasks.forEach(t => {
      notifications.push({
        id: 'nt_' + t._id,
        type: 'task',
        title: 'New Task Assigned',
        message: t.title,
        time: t.createdAt
      });
    });
    latestGrades.forEach(g => {
      const sub = submissionMap[g.submissionId.toString()];
      notifications.push({
        id: 'ng_' + g._id,
        type: 'grade',
        title: `Task Graded: ${g.marksObtained}/${sub?.taskId?.maxMarks || 100}`,
        message: g.feedback || 'Review completed',
        time: g.reviewedAt || g.createdAt
      });
    });
    resubmitSubmissions.forEach(s => {
      notifications.push({
        id: 'rs_' + s._id,
        type: 'warning',
        title: 'Re-submission Requested',
        message: `Admin requested re-submission for: ${s.taskId?.title || 'Task'}`,
        time: s.updatedAt || s.createdAt
      });
    });

    leaveUpdates.forEach(l => {
      if (new Date() - new Date(l.updatedAt) < 7 * 24 * 60 * 60 * 1000) {
        notifications.push({
          id: 'nl_' + l._id,
          type: l.status === 'approved' ? 'grade' : 'warning',
          title: `Leave Request ${l.status.charAt(0).toUpperCase() + l.status.slice(1)}`,
          message: `Your leave for ${new Date(l.date).toLocaleDateString()} was ${l.status}.`,
          time: l.updatedAt
        });
      }
    });

    // Fetch student's leaderboard rank in their primary batch using cached leaderboard data
    let rank = 'N/A';
    if (batchIds.length > 0) {
      const primaryBatchId = batchIds[0];
      const leaderboard = await getLeaderboardData(primaryBatchId);
      const studentObj = leaderboard.find(s => s.studentId === studentId.toString());
      if (studentObj) {
        rank = studentObj.rank;
      }
    }

    notifications.sort((a, b) => new Date(b.time) - new Date(a.time));
    notifications = notifications.slice(0, 10);

    let batchStartDate = null;
    if (enrollments.length > 0 && enrollments[0].batchId) {
      batchStartDate = enrollments[0].batchId.startDate;
    }

    const attQuery = { studentId };
    if (batchStartDate) {
      const batchStartStr = new Date(batchStartDate).toISOString().split('T')[0];
      attQuery.dateStr = { $gte: batchStartStr };
    }

    // Fetch and compute student attendance stats on the backend for fast bento dashboard renders
    const attendanceLogs = await Attendance.find(attQuery)
      .select('dateStr sessionDurationSeconds checkInTime lastCheckInTime checkOutTime isActive isLeave leaveHours status')
      .sort({ dateStr: -1 })
      .lean();

    const dayMap = {};
    attendanceLogs.forEach(log => {
      const key = log.dateStr;
      if (!dayMap[key]) {
        dayMap[key] = { totalSeconds: 0, isLeave: false, isActive: false, leaveHours: 0, status: null };
      }
      
      let currentDuration = log.sessionDurationSeconds;
      if (log.isActive) {
        currentDuration += Math.floor((Date.now() - new Date(log.lastCheckInTime).getTime()) / 1000);
      }
      
      dayMap[key].totalSeconds += currentDuration;
      if (log.isLeave || log.status === 'Leave') dayMap[key].isLeave = true;
      if (log.isActive) dayMap[key].isActive = true;
      dayMap[key].leaveHours = Math.max(dayMap[key].leaveHours, log.leaveHours || 0);
    });

    let present = 0, absent = 0, leave = 0, inProgress = 0, invalid = 0;
    const todayDateStr = new Date(Date.now() - (new Date().getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    
    const reqHours = (enrollments.length > 0 && enrollments[0].batchId && enrollments[0].batchId.requiredPresentHours !== undefined) ? enrollments[0].batchId.requiredPresentHours : 8;
    const maxHours = (enrollments.length > 0 && enrollments[0].batchId && enrollments[0].batchId.maxValidHours !== undefined) ? enrollments[0].batchId.maxValidHours : 10;

    Object.entries(dayMap).forEach(([dateKey, day]) => {
      if (dateKey === todayDateStr) return; // skip today
      if (day.isLeave && (day.leaveHours || 0) === 0) { leave++; return; }
      const hours = day.totalSeconds / 3600;
      const minRequired = reqHours - (day.leaveHours || 0);
      if (hours >= minRequired && hours <= maxHours) { present++; }
      else if (hours > maxHours) { invalid++; }
      else if (day.isActive) { inProgress++; }
      else { absent++; }
    });

    const totalDays = Object.keys(dayMap).length;
    const pastDays = totalDays - (dayMap[todayDateStr] ? 1 : 0);
    const denominator = pastDays - leave;
    const attendancePercentage = denominator > 0 ? Math.round((present / denominator) * 100) : 0;
    
    const attendanceStats = {
      present,
      absent,
      leave,
      inProgress,
      invalid,
      total: totalDays,
      percentage: attendancePercentage
    };

    const payload = {
      totalTasks,
      completedTasks,
      pendingTasks: totalTasks - completedTasks,
      taskCompletionRate,
      averageScore,
      performanceTrend,
      totalGradesReceived: grades.length,
      chartData,
      notifications,
      recentChats,
      recentMessagesList,
      myBatchesCount,
      availableBatchesCount,
      activeBatchesList,
      pendingLeavesCount,
      latestLeave,
      rank,
      attendanceStats
    };

    studentAnalyticsCache[cacheKey] = {
      data: payload,
      timestamp: now
    };

    res.json(payload);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// In-memory cache for admin dashboard stats
const adminStatsCache = {};
const ADMIN_STATS_CACHE_TTL_MS = 30000; // 30 seconds Cache TTL

const getAdminDashboardStats = async (req, res) => {
  try {
    const { timeframe = 'daily', batchId, refresh } = req.query;

    const cacheKey = `${timeframe}_${batchId || 'all'}_${req.user.role}_${req.user._id}`;
    const now = Date.now();
    if (refresh === 'true') {
      delete adminStatsCache[cacheKey];
    }

    if (adminStatsCache[cacheKey] && (now - adminStatsCache[cacheKey].timestamp) < ADMIN_STATS_CACHE_TTL_MS) {
      return res.status(200).json(adminStatsCache[cacheKey].data);
    }

    let startDate;
    if (timeframe === 'daily') {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 6);
      startDate.setHours(0, 0, 0, 0);
    } else if (timeframe === 'weekly') {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 27);
      startDate.setHours(0, 0, 0, 0);
    } else if (timeframe === 'monthly') {
      startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 11);
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);
    } else if (timeframe === 'yearly') {
      startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - 4);
      startDate.setMonth(0, 1);
      startDate.setHours(0, 0, 0, 0);
    }

    let targetBatchIds = null;

    if (req.user.role === 'mentor') {
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id').lean();
      const mentorBatchIds = mentorBatches.map(b => b._id);
      if (batchId && batchId !== 'all') {
        targetBatchIds = [batchId];
      } else {
        targetBatchIds = mentorBatchIds;
      }
    } else if (batchId && batchId !== 'all') {
      targetBatchIds = [batchId];
    }

    let taskFilter = {};
    let studentFilter = { role: 'student' };
    let batchFilter = {};

    if (targetBatchIds) {
      batchFilter._id = { $in: targetBatchIds };
      taskFilter.batchId = { $in: targetBatchIds };
      
      const enrollments = await Enrollment.find({ 
        batchId: { $in: targetBatchIds }, 
        status: { $regex: /^approved$/i } 
      }).select('studentId').lean();
      const batchStudentIds = enrollments.map(e => e.studentId);
      studentFilter._id = { $in: batchStudentIds };
    }

    const tasksInScope = await Task.find(taskFilter).select('_id').lean();
    const taskIdsInScope = tasksInScope.map(t => t._id);

    let submissionFilter = {};
    if (targetBatchIds) {
      submissionFilter.taskId = { $in: taskIdsInScope };
    }

    const scopedSubmissions = await Submission.find(submissionFilter).select('_id').lean();
    const submissionIdsInScope = scopedSubmissions.map(s => s._id);

    let gradeFilter = {};
    if (targetBatchIds) {
      gradeFilter.submissionId = { $in: submissionIdsInScope };
    }

    let recentSubmissionFilter = {
      $or: [
        { submittedAt: { $gte: startDate } },
        { createdAt: { $gte: startDate } }
      ]
    };
    if (targetBatchIds) {
      recentSubmissionFilter.taskId = { $in: taskIdsInScope };
    }

    let leaveFilter = { status: 'pending' };
    let attendanceFilter = {
      dateStr: getISTDateStr(),
      isActive: true
    };
    if (targetBatchIds) {
      const enrollments = await Enrollment.find({ 
        batchId: { $in: targetBatchIds }, 
        status: { $regex: /^approved$/i } 
      }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);
      leaveFilter.studentId = { $in: studentIds };
      attendanceFilter.studentId = { $in: studentIds };
    }

    const [
      totalStudents,
      totalBatches,
      totalTasks,
      totalSubmissions,
      totalGrades,
      recentSubmissions,
      latestTasks,
      latestSubs,
      pendingLeaves,
      pendingEnrollmentsCount,
      pendingEnrollments,
      todayAttendance
    ] = await Promise.all([
      User.countDocuments(studentFilter),
      Batch.countDocuments(batchFilter),
      Task.countDocuments(taskFilter),
      Submission.countDocuments(submissionFilter),
      Grade.countDocuments(gradeFilter),
      Submission.find(recentSubmissionFilter).select('submittedAt createdAt').lean(),
      Task.find(taskFilter).sort({ createdAt: -1 }).limit(5).populate('batchId', 'batchName').select('title batchId createdAt').lean(),
      Submission.find(submissionFilter).sort({ submittedAt: -1 }).limit(5).populate('studentId', 'name').populate('taskId', 'title').select('studentId taskId submittedAt createdAt').lean(),
      Leave.find(leaveFilter).sort({ createdAt: -1 }).limit(3).populate('studentId', 'name').select('studentId date reason createdAt').lean(),
      Enrollment.countDocuments({ status: 'pending', ...(targetBatchIds ? { batchId: { $in: targetBatchIds } } : {}) }),
      Enrollment.find({ status: 'pending', ...(targetBatchIds ? { batchId: { $in: targetBatchIds } } : {}) }).sort({ createdAt: -1 }).limit(3).populate('studentId', 'name').populate('batchId', 'batchName').select('studentId batchId status createdAt').lean(),
      Attendance.find(attendanceFilter)
      .populate('studentId', 'name rollNumber profileImage')
      .sort({ lastCheckInTime: -1 })
      .limit(3)
      .lean()
    ]);

    const pendingReviews = Math.max(0, totalSubmissions - totalGrades);

    const chartData = [];
    if (timeframe === 'daily') {
      for (let i = 0; i < 7; i++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + i);
        const dateString = d.toLocaleDateString('en-US', { weekday: 'short' });
        
        const count = recentSubmissions.filter(s => {
          const sDate = new Date(s.submittedAt || s.createdAt);
          return sDate.getDate() === d.getDate() && sDate.getMonth() === d.getMonth();
        }).length;
        
        chartData.push({ name: dateString, submissions: count });
      }
    } else if (timeframe === 'weekly') {
      for (let i = 0; i < 4; i++) {
        const dStart = new Date(startDate);
        dStart.setDate(dStart.getDate() + (i * 7));
        const dEnd = new Date(dStart);
        dEnd.setDate(dEnd.getDate() + 6);
        
        const count = recentSubmissions.filter(s => {
          const sDate = new Date(s.submittedAt || s.createdAt);
          return sDate >= dStart && sDate <= dEnd;
        }).length;
        
        chartData.push({ name: `Week ${i + 1}`, submissions: count });
      }
    } else if (timeframe === 'monthly') {
      for (let i = 0; i < 12; i++) {
        const d = new Date(startDate);
        d.setMonth(d.getMonth() + i);
        const monthString = d.toLocaleDateString('en-US', { month: 'short' });
        
        const count = recentSubmissions.filter(s => {
          const sDate = new Date(s.submittedAt || s.createdAt);
          return sDate.getMonth() === d.getMonth() && sDate.getFullYear() === d.getFullYear();
        }).length;
        
        chartData.push({ name: monthString, submissions: count });
      }
    } else if (timeframe === 'yearly') {
      for (let i = 0; i < 5; i++) {
        const year = startDate.getFullYear() + i;
        
        const count = recentSubmissions.filter(s => {
          const sDate = new Date(s.submittedAt || s.createdAt);
          return sDate.getFullYear() === year;
        }).length;
        
        chartData.push({ name: String(year), submissions: count });
      }
    }

    let notifications = [];
    latestTasks.forEach(t => {
      notifications.push({
        id: 't_' + t._id,
        type: 'task',
        title: `New Task Created`,
        message: `"${t.title}" assigned to ${t.batchId?.batchName || 'a batch'}`,
        time: t.createdAt
      });
    });
    latestSubs.forEach(s => {
      notifications.push({
        id: 's_' + s._id,
        type: 'submission',
        title: `New Submission`,
        message: `${s.studentId?.name || 'A student'} submitted "${s.taskId?.title || 'a task'}"`,
        time: s.submittedAt || s.createdAt
      });
    });
    
    pendingLeaves.forEach(l => {
      notifications.push({
        id: 'pl_' + l._id,
        type: 'warning',
        title: 'Leave Request Pending',
        message: `${l.studentId?.name || 'A student'} requested leave for ${new Date(l.date).toLocaleDateString()}`,
        time: l.createdAt
      });
    });

    pendingEnrollments.forEach(e => {
      notifications.push({
        id: 'jr_' + e._id,
        type: 'warning',
        title: 'New Batch Join Request',
        message: `${e.studentId?.name || 'A student'} requested to join ${e.batchId?.batchName || 'a batch'}`,
        time: e.createdAt
      });
    });

    notifications.sort((a, b) => new Date(b.time) - new Date(a.time));
    notifications = notifications.slice(0, 10);

    const payload = {
      totalStudents,
      totalBatches,
      totalTasks,
      pendingReviews,
      completedReviews: totalGrades,
      chartData,
      notifications,
      pendingLeavesCount: pendingLeaves.length,
      joinRequestsCount: pendingEnrollmentsCount,
      todayAttendance
    };

    adminStatsCache[cacheKey] = {
      data: payload,
      timestamp: now
    };

    res.json(payload);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getBatchAnalytics = async (req, res) => {
  try {
    const batchId = req.params.batchId;

    const [enrollmentsCount, tasks] = await Promise.all([
      Enrollment.countDocuments({ batchId, status: 'approved' }),
      Task.find({ batchId }).select('_id').lean()
    ]);

    const taskIds = tasks.map(t => t._id);

    const submissions = await Submission.find({ taskId: { $in: taskIds } }).select('_id').lean();
    const submissionIds = submissions.map(s => s._id);

    const gradesCount = await Grade.countDocuments({ submissionId: { $in: submissionIds } });

    res.json({
      totalStudentsEnrolled: enrollmentsCount,
      totalTasksAssigned: taskIds.length,
      totalSubmissionsReceived: submissionIds.length,
      totalSubmissionsGraded: gradesCount
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getLeaderboard = async (req, res) => {
  try {
    const batchId = req.params.batchId;
    const leaderboard = await getLeaderboardData(batchId);
    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getActivityLogs = async (req, res) => {
  try {
    const [
      submissions,
      attendance,
      leaves,
      enrollments,
      grades,
      tasks
    ] = await Promise.all([
      Submission.find().sort({ createdAt: -1 }).limit(50).populate('studentId', 'name rollNumber').populate('taskId', 'title').lean(),
      Attendance.find().sort({ createdAt: -1 }).limit(50).populate('studentId', 'name rollNumber').lean(),
      Leave.find().sort({ createdAt: -1 }).limit(30).populate('studentId', 'name rollNumber').lean(),
      Enrollment.find().sort({ createdAt: -1 }).limit(30).populate('studentId', 'name rollNumber').populate('batchId', 'batchName').lean(),
      Grade.find().sort({ createdAt: -1 }).limit(50).populate('reviewedBy', 'name').populate({
        path: 'submissionId',
        populate: [
          { path: 'studentId', select: 'name rollNumber' },
          { path: 'taskId', select: 'title' }
        ]
      }).lean(),
      Task.find().sort({ createdAt: -1 }).limit(30).populate('batchId', 'batchName').lean()
    ]);

    const logs = [];

    submissions.forEach(sub => {
      logs.push({
        id: 'sub_' + sub._id,
        timestamp: sub.submittedAt || sub.createdAt,
        type: 'SUBMISSION',
        studentName: sub.studentId?.name || 'A Student',
        rollNumber: sub.studentId?.rollNumber || '',
        message: `${sub.studentId?.name || 'A Student'} submitted "${sub.taskId?.title || 'a task'}"`,
        icon: 'file'
      });
    });

    attendance.forEach(att => {
      if (att.checkInTime) {
        logs.push({
          id: 'in_' + att._id,
          timestamp: att.checkInTime,
          type: 'CHECK IN',
          studentName: att.studentId?.name || 'A Student',
          rollNumber: att.studentId?.rollNumber || '',
          message: `${att.studentId?.name || 'A Student'} checked in`,
          icon: 'checkin'
        });
      }
      if (att.checkOutTime) {
        logs.push({
          id: 'out_' + att._id,
          timestamp: att.checkOutTime,
          type: 'CHECK OUT',
          studentName: att.studentId?.name || 'A Student',
          rollNumber: att.studentId?.rollNumber || '',
          message: `${att.studentId?.name || 'A Student'} checked out`,
          icon: 'checkout'
        });
      }
    });

    leaves.forEach(leave => {
      logs.push({
        id: 'leave_' + leave._id,
        timestamp: leave.createdAt,
        type: 'LEAVE REQUEST',
        studentName: leave.studentId?.name || 'A Student',
        rollNumber: leave.studentId?.rollNumber || '',
        message: `${leave.studentId?.name || 'A Student'} requested leave for ${new Date(leave.date).toLocaleDateString()}`,
        icon: 'leave'
      });
    });

    enrollments.forEach(enr => {
      logs.push({
        id: 'enroll_' + enr._id,
        timestamp: enr.createdAt,
        type: 'JOIN REQUEST',
        studentName: enr.studentId?.name || 'A Student',
        rollNumber: enr.studentId?.rollNumber || '',
        message: `${enr.studentId?.name || 'A Student'} requested to join "${enr.batchId?.batchName || 'a batch'}"`,
        icon: 'join'
      });
    });

    grades.forEach(grade => {
      logs.push({
        id: 'grade_' + grade._id,
        timestamp: grade.reviewedAt || grade.createdAt,
        type: 'GRADING',
        studentName: grade.submissionId?.studentId?.name || 'A Student',
        rollNumber: grade.submissionId?.studentId?.rollNumber || '',
        message: `${grade.reviewedBy?.name || 'Faculty'} graded "${grade.submissionId?.taskId?.title || 'a task'}" (Score: ${grade.marksObtained})`,
        icon: 'grade'
      });
    });

    tasks.forEach(task => {
      logs.push({
        id: 'task_' + task._id,
        timestamp: task.createdAt,
        type: 'TASK CREATED',
        studentName: 'Admin',
        rollNumber: '',
        message: `Admin assigned new task "${task.title}" to batch "${task.batchId?.batchName || 'a batch'}"`,
        icon: 'task'
      });
    });

    // Sort by timestamp descending
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json(logs.slice(0, 100));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const isStudentRankOne = async (studentId) => {
  try {
    const enrollments = await Enrollment.find({ studentId, status: 'approved' }).lean();
    for (const e of enrollments) {
      const leaderboard = await getLeaderboardData(e.batchId);
      const studentObj = leaderboard.find(s => s.studentId === studentId.toString());
      if (studentObj && studentObj.rank === 1 && studentObj.overallScore > 0) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('Error in isStudentRankOne:', error);
    return false;
  }
};

module.exports = {
  getStudentAnalytics,
  getAdminDashboardStats,
  getBatchAnalytics,
  getLeaderboard,
  getActivityLogs,
  getLeaderboardData,
  isStudentRankOne
};
