const Attendance = require('../models/Attendance');
const CheckInAccess = require('../models/CheckInAccess');

const getISTDateStr = (date = new Date()) => {
  const istTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const year = istTime.getFullYear();
  const month = String(istTime.getMonth() + 1).padStart(2, '0');
  const day = String(istTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getBatchHourLimits = async (studentId) => {
  try {
    const Enrollment = require('../models/Enrollment');
    const enrollment = await Enrollment.findOne({ studentId, status: 'approved' }).populate('batchId').lean();
    if (enrollment && enrollment.batchId) {
      return {
        requiredPresentHours: enrollment.batchId.requiredPresentHours !== undefined ? enrollment.batchId.requiredPresentHours : 8,
        maxValidHours: enrollment.batchId.maxValidHours !== undefined ? enrollment.batchId.maxValidHours : 10
      };
    }
  } catch (err) {
    console.error('Error fetching batch hour limits:', err);
  }
  return { requiredPresentHours: 8, maxValidHours: 10 };
};

// Helper: Auto-close any open sessions from previous days for a student
const autoCloseOldSessions = async (studentId) => {
  try {
    const todayStr = getISTDateStr();
    const { requiredPresentHours, maxValidHours } = await getBatchHourLimits(studentId);

    // Find all active records from before today for this student
    const activeRecords = await Attendance.find({
      studentId: studentId,
      isActive: true,
      dateStr: { $lt: todayStr }
    });

    for (const record of activeRecords) {
      const recordDate = new Date(record.dateStr);
      const endOfDay = new Date(recordDate.getFullYear(), recordDate.getMonth(), recordDate.getDate(), 23, 59, 59);
      const lastCheckIn = new Date(record.lastCheckInTime);
      const checkoutTime = endOfDay > lastCheckIn ? endOfDay : lastCheckIn;
      
      const durationMs = checkoutTime.getTime() - lastCheckIn.getTime();
      record.sessionDurationSeconds += Math.floor(durationMs / 1000);
      record.checkOutTime = checkoutTime;
      record.isActive = false;

      // Compute status based on total session time
      if (record.isLeave && (record.leaveHours || 0) === 0) {
        record.status = 'Leave';
      } else {
        const hours = (record.sessionDurationSeconds || 0) / 3600;
        const minRequired = requiredPresentHours - (record.leaveHours || 0);
        if (hours >= minRequired && hours <= maxValidHours) {
          record.status = 'Present';
        } else if (hours > maxValidHours) {
          record.status = 'Invalid';
        } else {
          record.status = 'Absent';
        }
      }

      await record.save();
      console.log(`Auto-closed stale attendance record for student ${studentId} on date ${record.dateStr}`);
    }
  } catch (error) {
    console.error('Error auto-closing old sessions:', error);
  }
};

// Helper: Auto-close any open sessions from previous days globally
const autoCloseAllOldSessions = async () => {
  try {
    const todayStr = getISTDateStr();

    const activeRecords = await Attendance.find({
      isActive: true,
      dateStr: { $lt: todayStr }
    });

    for (const record of activeRecords) {
      const recordDate = new Date(record.dateStr);
      const endOfDay = new Date(recordDate.getFullYear(), recordDate.getMonth(), recordDate.getDate(), 23, 59, 59);
      const lastCheckIn = new Date(record.lastCheckInTime);
      const checkoutTime = endOfDay > lastCheckIn ? endOfDay : lastCheckIn;
      
      const durationMs = checkoutTime.getTime() - lastCheckIn.getTime();
      record.sessionDurationSeconds += Math.floor(durationMs / 1000);
      record.checkOutTime = checkoutTime;
      record.isActive = false;

      if (record.isLeave && (record.leaveHours || 0) === 0) {
        record.status = 'Leave';
      } else {
        const hours = (record.sessionDurationSeconds || 0) / 3600;
        const minRequired = 8 - (record.leaveHours || 0);
        if (hours >= minRequired && hours <= 10) {
          record.status = 'Present';
        } else if (hours > 10) {
          record.status = 'Invalid';
        } else {
          record.status = 'Absent';
        }
      }

      await record.save();
      console.log(`Auto-closed stale attendance record globally for student ${record.studentId} on date ${record.dateStr}`);
    }
  } catch (error) {
    console.error('Error in autoCloseAllOldSessions:', error);
  }
};

// Helper: Process auto checkout for active batches whose autoCheckOutTime has passed
const processBatchAutoCheckouts = async () => {
  try {
    const Batch = require('../models/Batch');
    const Enrollment = require('../models/Enrollment');

    const todayStr = getISTDateStr();

    // Get current IST time in HH:MM format
    const istTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const currentHrs = String(istTime.getHours()).padStart(2, '0');
    const currentMins = String(istTime.getMinutes()).padStart(2, '0');
    const currentTimeStr = `${currentHrs}:${currentMins}`;

    // Find all active batches with auto checkout enabled
    const batches = await Batch.find({ 
      status: 'Active', 
      autoCheckOutEnabled: { $ne: false } 
    }).lean();

    for (const batch of batches) {
      const checkoutCutoff = batch.autoCheckOutTime || batch.checkOutTime || '21:00';
      
      // Compare time HH:MM strings
      if (currentTimeStr >= checkoutCutoff) {
        // Find all approved students in this batch
        const enrollments = await Enrollment.find({ batchId: batch._id, status: 'approved' }).select('studentId').lean();
        const studentIds = enrollments.map(e => e.studentId);

        if (studentIds.length === 0) continue;

        // Find all active (still checked in) attendance records for today for these students
        const activeRecords = await Attendance.find({
          studentId: { $in: studentIds },
          dateStr: todayStr,
          isActive: true
        });

        const reqHours = batch.requiredPresentHours !== undefined ? batch.requiredPresentHours : 8;
        const maxHours = batch.maxValidHours !== undefined ? batch.maxValidHours : 10;

        for (const record of activeRecords) {
          const nowTime = new Date();
          const lastCheckIn = new Date(record.lastCheckInTime);
          const durationMs = Math.max(0, nowTime.getTime() - lastCheckIn.getTime());

          record.sessionDurationSeconds += Math.floor(durationMs / 1000);
          record.checkOutTime = nowTime;
          record.isActive = false;

          if (record.isLeave && (record.leaveHours || 0) === 0) {
            record.status = 'Leave';
          } else {
            const hours = (record.sessionDurationSeconds || 0) / 3600;
            const minRequired = reqHours - (record.leaveHours || 0);
            if (hours >= minRequired && hours <= maxHours) {
              record.status = 'Present';
            } else if (hours > maxHours) {
              record.status = 'Invalid';
            } else {
              record.status = 'Absent';
            }
          }

          await record.save();
          console.log(`[Auto-Checkout] Automatically checked out student ${record.studentId} for batch ${batch.batchName} at cutoff ${checkoutCutoff}`);
        }
      }
    }
  } catch (error) {
    console.error('Error in processBatchAutoCheckouts:', error);
  }
};

// @desc    Check-in student
// @route   POST /api/attendance/checkin
// @access  Private (Student)
const checkIn = async (req, res) => {
  try {
    const Enrollment = require('../models/Enrollment');
    const Batch = require('../models/Batch');

    // Get current time in HH:MM format
    const now = new Date();
    // Force IST timezone for currentTimeStr
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hours = String(istTime.getHours()).padStart(2, '0');
    const minutes = String(istTime.getMinutes()).padStart(2, '0');
    const currentTimeStr = `${hours}:${minutes}`;

    // Verify against batch allowed times
    const myEnrollments = await Enrollment.find({ studentId: req.user._id, status: 'approved' }).populate('batchId');
    const activeBatches = myEnrollments.map(e => e.batchId).filter(b => b && b.status === 'Active');

    let allowedBatchId = null;

    if (activeBatches.length > 0) {
      let isAllowed = false;
      let hasTimeRestrictions = false;

      for (const batch of activeBatches) {
        if (batch.checkInTime && batch.checkOutTime) {
          hasTimeRestrictions = true;
          if (currentTimeStr >= batch.checkInTime && currentTimeStr < batch.checkOutTime) {
            isAllowed = true;
            allowedBatchId = batch._id;
            break;
          }
        } else {
          // If a batch has no restrictions, they are allowed to check in anytime for that batch
          isAllowed = true;
          allowedBatchId = batch._id;
          break;
        }
      }

      if (hasTimeRestrictions && !isAllowed) {
        return res.status(400).json({ message: 'Check-in is currently restricted outside of your batch scheduled hours.' });
      }
    }

    // Auto-close any previous active sessions first
    await autoCloseOldSessions(req.user._id);

    const dateStr = getISTDateStr();

    // Check if daily check-in access has been granted by admin for their active batch
    let accessQuery = { studentId: req.user._id, dateStr };
    if (allowedBatchId) {
      accessQuery.batchId = allowedBatchId;
    }
    const access = await CheckInAccess.findOne(accessQuery);
    if (!access) {
      return res.status(400).json({ message: 'Check-in access not granted for this batch today. Please contact your admin.' });
    }

    let attendance = await Attendance.findOne({
      studentId: req.user._id,
      dateStr: dateStr
    });

    if (attendance) {
      if (attendance.isActive) {
        return res.status(200).json(attendance);
      }
      attendance.lastCheckInTime = Date.now();
      attendance.isActive = true;
      attendance.status = 'In Progress';
      await attendance.save();
    } else {
      attendance = await Attendance.create({
        studentId: req.user._id,
        dateStr: dateStr,
        checkInTime: Date.now(),
        lastCheckInTime: Date.now(),
        isActive: true
      });
    }

    // ─── Attendance Streak Tracking ───
    try {
      const User = require('../models/User');
      const { isSameDay, isYesterday, awardCoinsWithCap, awardXPWithCap, checkAndAwardBadges, checkAndAwardStreakMilestones } = require('../utils/gamification');
      const studentUser = await User.findById(req.user._id);
      if (studentUser && !isSameDay(studentUser.lastAttendanceDate, now)) {
        // New day check-in
        if (isYesterday(studentUser.lastAttendanceDate)) {
          studentUser.attendanceStreak = (studentUser.attendanceStreak || 0) + 1;
        } else if (!studentUser.lastAttendanceDate) {
          studentUser.attendanceStreak = 1;
        } else {
          studentUser.attendanceStreak = 1; // streak broken
        }
        studentUser.lastAttendanceDate = now;

        // Award base attendance XP
        awardCoinsWithCap(studentUser, 10, 'Daily attendance check-in');
        awardXPWithCap(studentUser, 20, 'Daily attendance check-in');

        // Check milestones
        checkAndAwardStreakMilestones(studentUser);

        checkAndAwardBadges(studentUser);
        await studentUser.save();
      }
    } catch (streakErr) {
      console.error('Attendance streak tracking error:', streakErr);
    }

    res.status(201).json(attendance);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Check-out student
// @route   POST /api/attendance/checkout/:id
// @access  Private (Student)
const checkOut = async (req, res) => {
  try {
    const attendance = await Attendance.findById(req.params.id);

    if (!attendance) {
      return res.status(404).json({ message: 'Session not found' });
    }

    if (attendance.studentId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    if (attendance.isActive) {
      const now = Date.now();
      const durationMs = now - new Date(attendance.lastCheckInTime).getTime();
      attendance.sessionDurationSeconds += Math.floor(durationMs / 1000);
      
      attendance.checkOutTime = now;
      attendance.isActive = false;

      // Recalculate status on checkout
      if (attendance.isLeave && (attendance.leaveHours || 0) === 0) {
        attendance.status = 'Leave';
      } else {
        const { requiredPresentHours, maxValidHours } = await getBatchHourLimits(req.user._id);
        const hours = (attendance.sessionDurationSeconds || 0) / 3600;
        const minRequired = requiredPresentHours - (attendance.leaveHours || 0);
        if (hours >= minRequired && hours <= maxValidHours) {
          attendance.status = 'Present';
        } else if (hours > maxValidHours) {
          attendance.status = 'Invalid';
        } else {
          attendance.status = 'Absent';
        }
      }

      await attendance.save();
    }

    res.json(attendance);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all attendance logs
// @route   GET /api/attendance
// @access  Private/Admin
const getAllAttendance = async (req, res) => {
  try {
    // Auto-close stale active sessions globally to ensure admin sees accurate dashboard states
    await autoCloseAllOldSessions();

    const { batchId } = req.query;
    let query = {};
    const Enrollment = require('../models/Enrollment');
    const Batch = require('../models/Batch');
    
    if (req.user.role === 'mentor') {
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id').lean();
      const mentorBatchIds = mentorBatches.map(b => b._id);
      
      let targetBatchIds = mentorBatchIds;
      if (batchId && mentorBatchIds.map(id => id.toString()).includes(batchId.toString())) {
        targetBatchIds = [batchId];
      }
      
      const enrollments = await Enrollment.find({ batchId: { $in: targetBatchIds }, status: 'approved' });
      const studentIds = enrollments.map(e => e.studentId);
      query = { studentId: { $in: studentIds } };
    } else if (batchId) {
      const enrollments = await Enrollment.find({ batchId, status: 'approved' });
      const studentIds = enrollments.map(e => e.studentId);
      query = { studentId: { $in: studentIds } };
    }
    
    const logs = await Attendance.find(query)
      .populate('studentId', 'name email')
      .sort({ createdAt: -1 });
    
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get my attendance logs
// @route   GET /api/attendance/my
// @access  Private (Student)
const getMyAttendance = async (req, res) => {
  try {
    const logs = await Attendance.find({ studentId: req.user._id })
      .sort({ createdAt: -1 });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get summary of all attendance (Admin)
// @route   GET /api/attendance/summary
// @access  Private/Admin
const getAttendanceSummary = async (req, res) => {
  try {
    // Auto-close stale active sessions globally to ensure admin sees accurate dashboard states
    await autoCloseAllOldSessions();

    const { batchId } = req.query;
    const Enrollment = require('../models/Enrollment');
    const Batch = require('../models/Batch');

    let query = {};
    let batchStartDate = null;
    
    if (req.user.role === 'mentor') {
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id startDate').lean();
      const mentorBatchIds = mentorBatches.map(b => b._id);
      
      let targetBatchIds = mentorBatchIds;
      if (batchId && mentorBatchIds.map(id => id.toString()).includes(batchId.toString())) {
        targetBatchIds = [batchId];
        const selectedBatch = mentorBatches.find(b => b._id.toString() === batchId.toString());
        if (selectedBatch && selectedBatch.startDate) batchStartDate = selectedBatch.startDate;
      }
      
      const enrollments = await Enrollment.find({ batchId: { $in: targetBatchIds }, status: 'approved' }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);
      query = { studentId: { $in: studentIds } };
    } else if (batchId) {
      const enrollments = await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);
      query = { studentId: { $in: studentIds } };

      const batch = await Batch.findById(batchId).lean();
      if (batch && batch.startDate) {
        batchStartDate = batch.startDate;
      }
    }

    if (batchStartDate) {
      const batchStartStr = new Date(batchStartDate).toISOString().split('T')[0];
      query.dateStr = { $gte: batchStartStr };
    }
    
    const logs = await Attendance.find(query)
      .select('studentId dateStr sessionDurationSeconds isActive lastCheckInTime checkInTime checkOutTime isLeave leaveHours status')
      .populate('studentId', 'name email rollNumber')
      .sort({ dateStr: -1, createdAt: -1 })
      .lean();
    
    const summaryList = logs.map(log => {
      let currentDuration = log.sessionDurationSeconds;
      if (log.isActive) {
        currentDuration += Math.floor((Date.now() - new Date(log.lastCheckInTime).getTime()) / 1000);
      }
      
      return {
        _id: log._id,
        studentId: log.studentId?._id,
        name: log.studentId?.name || 'Unknown',
        email: log.studentId?.email,
        rollNumber: log.studentId?.rollNumber,
        date: log.dateStr,
        totalSeconds: currentDuration,
        firstCheckIn: log.checkInTime,
        lastCheckOut: log.checkOutTime,
        isActive: log.isActive,
        isLeave: log.isLeave,
        leaveHours: log.leaveHours,
        status: log.status
      };
    });
    
    res.json(summaryList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get my attendance summary (Student)
// @route   GET /api/attendance/my-summary
// @access  Private (Student)
const getMyAttendanceSummary = async (req, res) => {
  try {
    // Auto-close any previous active sessions first
    await autoCloseOldSessions(req.user._id);

    // Get batch start date to filter logs
    const Enrollment = require('../models/Enrollment');
    const enrollments = await Enrollment.find({ studentId: req.user._id, status: 'approved' }).populate('batchId').lean();
    
    let batchStartDate = null;
    if (enrollments.length > 0 && enrollments[0].batchId) {
      batchStartDate = enrollments[0].batchId.startDate;
    }

    const query = { studentId: req.user._id };
    if (batchStartDate) {
      const batchStartStr = new Date(batchStartDate).toISOString().split('T')[0];
      query.dateStr = { $gte: batchStartStr };
    }

    const logs = await Attendance.find(query)
      .select('dateStr sessionDurationSeconds checkInTime lastCheckInTime checkOutTime isActive isLeave leaveHours status')
      .sort({ dateStr: -1, createdAt: -1 })
      .lean();
    
    const summaryList = logs.map(log => {
      let currentDuration = log.sessionDurationSeconds;
      if (log.isActive) {
        currentDuration += Math.floor((Date.now() - new Date(log.lastCheckInTime).getTime()) / 1000);
      }
      
      return {
        _id: log._id,
        date: log.dateStr,
        totalSeconds: currentDuration,
        firstCheckIn: log.checkInTime,
        lastCheckOut: log.checkOutTime,
        isActive: log.isActive,
        isLeave: log.isLeave,
        leaveHours: log.leaveHours,
        status: log.status
      };
    });
    
    res.json(summaryList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Admin check-out specific student
// @route   PUT /api/attendance/admin/checkout/:id
// @access  Private/Admin
const adminCheckOutStudent = async (req, res) => {
  try {
    const attendance = await Attendance.findById(req.params.id);

    if (!attendance) {
      return res.status(404).json({ message: 'Session not found' });
    }

    if (attendance.isActive) {
      const now = Date.now();
      const durationMs = now - new Date(attendance.lastCheckInTime).getTime();
      attendance.sessionDurationSeconds += Math.floor(durationMs / 1000);
      
      attendance.checkOutTime = now;
      attendance.isActive = false;

      // Calculate status on check-out
      if (attendance.isLeave && (attendance.leaveHours || 0) === 0) {
        attendance.status = 'Leave';
      } else {
        const hours = (attendance.sessionDurationSeconds || 0) / 3600;
        const minRequired = 8 - (attendance.leaveHours || 0);
        if (hours >= minRequired && hours <= 10) {
          attendance.status = 'Present';
        } else if (hours > 10) {
          attendance.status = 'Invalid';
        } else {
          attendance.status = 'Absent';
        }
      }

      await attendance.save();

      // Emit socket event
      try {
        const { emitToUser } = require('../sockets/socketHandlers');
        emitToUser(attendance.studentId.toString(), 'force-checkout', { attendanceId: attendance._id });
      } catch (err) {
        console.error('Failed to emit force-checkout socket event:', err);
      }
    }

    res.json(attendance);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Admin check-out all active students
// @route   PUT /api/attendance/admin/checkout-all
// @access  Private/Admin
const adminCheckOutAll = async (req, res) => {
  try {
    const { studentIds } = req.body;
    let query = { isActive: true };
    
    if (studentIds && Array.isArray(studentIds) && studentIds.length > 0) {
      query.studentId = { $in: studentIds };
    }

    const activeSessions = await Attendance.find(query);
    const now = Date.now();

    for (let attendance of activeSessions) {
      const durationMs = now - new Date(attendance.lastCheckInTime).getTime();
      attendance.sessionDurationSeconds += Math.floor(durationMs / 1000);
      
      attendance.checkOutTime = now;
      attendance.isActive = false;

      // Calculate status on check-out
      if (attendance.isLeave && (attendance.leaveHours || 0) === 0) {
        attendance.status = 'Leave';
      } else {
        const hours = (attendance.sessionDurationSeconds || 0) / 3600;
        const minRequired = 8 - (attendance.leaveHours || 0);
        if (hours >= minRequired && hours <= 10) {
          attendance.status = 'Present';
        } else if (hours > 10) {
          attendance.status = 'Invalid';
        } else {
          attendance.status = 'Absent';
        }
      }

      await attendance.save();

      // Emit socket event
      try {
        const { emitToUser } = require('../sockets/socketHandlers');
        emitToUser(attendance.studentId.toString(), 'force-checkout', { attendanceId: attendance._id });
      } catch (err) {
        console.error('Failed to emit force-checkout socket event:', err);
      }
    }

    res.json({ message: `Successfully checked out ${activeSessions.length} students` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get count of active students
// @route   GET /api/attendance/active-count
// @access  Private (Student/Admin)
const getActiveCount = async (req, res) => {
  try {
    const activeCount = await Attendance.countDocuments({ isActive: true });
    res.json({ activeCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get public attendance summary (no auth required)
// @route   GET /api/public/attendance/summary
// @access  Public
const getPublicAttendanceSummary = async (req, res) => {
  try {
    const { batchId, date } = req.query;
    const targetDateStr = date || getISTDateStr();
    
    let query = { dateStr: targetDateStr };
    let totalStrength = 0;
    let students = [];
    
    if (batchId) {
      const Enrollment = require('../models/Enrollment');
      const enrollments = await Enrollment.find({ batchId, status: 'approved' })
        .populate('studentId', 'name email rollNumber')
        .lean();
      
      students = enrollments.map(e => e.studentId).filter(Boolean);
      totalStrength = students.length;
      
      const studentIds = students.map(s => s._id);
      query.studentId = { $in: studentIds };
    } else {
      const User = require('../models/User');
      students = await User.find({ role: 'student' }).select('name email rollNumber').lean();
      totalStrength = students.length;
      
      const studentIds = students.map(s => s._id);
      query.studentId = { $in: studentIds };
    }
    
    const Leave = require('../models/Leave');

    const [logs, accessGrants, leaves] = await Promise.all([
      Attendance.find(query)
        .select('studentId dateStr sessionDurationSeconds isActive lastCheckInTime checkInTime checkOutTime isLeave leaveHours status')
        .lean(),
      CheckInAccess.find(batchId ? { batchId, dateStr: targetDateStr } : { dateStr: targetDateStr })
        .select('studentId dateStr accessType')
        .lean(),
      Leave.find({
        status: 'approved',
        $or: [
          { startDate: targetDateStr },
          { 
            leaveType: 'multiple_days',
            startDate: { $lte: targetDateStr },
            endDate: { $gte: targetDateStr }
          }
        ]
      }).lean()
    ]);
    
    const logsMap = {};
    logs.forEach(log => {
      logsMap[String(log.studentId)] = log;
    });
    
    const accessMap = {};
    accessGrants.forEach(grant => {
      accessMap[String(grant.studentId)] = grant.accessType;
    });

    const leavesMap = {};
    leaves.forEach(l => {
      leavesMap[String(l.studentId)] = l;
    });
    
    const summaryList = students.map(student => {
      const sId = String(student._id);
      const log = logsMap[sId];
      const accessType = accessMap[sId] || 'on-site';
      const studentLeave = leavesMap[sId];
      
      let currentDuration = log ? log.sessionDurationSeconds : 0;
      if (log && log.isActive) {
        currentDuration += Math.floor((Date.now() - new Date(log.lastCheckInTime).getTime()) / 1000);
      }
      
      return {
        _id: log ? log._id : `absent_${sId}`,
        studentId: sId,
        name: student.name || 'Unknown',
        email: student.email,
        rollNumber: student.rollNumber,
        date: targetDateStr,
        totalSeconds: currentDuration,
        firstCheckIn: log ? log.checkInTime : null,
        lastCheckOut: log ? log.checkOutTime : null,
        isActive: log ? log.isActive : false,
        isLeave: log ? log.isLeave : false,
        leaveHours: log ? log.leaveHours : 0,
        leaveInfo: studentLeave ? (
          studentLeave.leaveType === 'hours'
            ? `Hour Leave (${studentLeave.startTime} - ${studentLeave.endTime})`
            : studentLeave.leaveType === 'multiple_days'
              ? `Multiple Day Leave (${studentLeave.startDate} to ${studentLeave.endDate})`
              : 'Day Leave'
        ) : null,
        leaveType: studentLeave ? studentLeave.leaveType : null,
        status: log ? log.status : 'Absent',
        accessType,
        isCheckedIn: !!log
      };
    });
    
    res.json({ totalStrength, logs: summaryList });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateAttendanceRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const { dateStr, hours, status } = req.body;

    let record;
    if (id.startsWith('absent_')) {
      const studentId = id.replace('absent_', '');
      record = new Attendance({
        studentId,
        dateStr: dateStr || getISTDateStr(),
        checkInTime: new Date(),
        lastCheckInTime: new Date(),
        checkOutTime: new Date(),
        sessionDurationSeconds: Math.round(Number(hours) * 3600),
        status,
        isActive: false
      });
    } else {
      record = await Attendance.findById(id);
      if (!record) {
        return res.status(404).json({ message: 'Attendance record not found' });
      }
      record.sessionDurationSeconds = Math.round(Number(hours) * 3600);
      record.status = status;
      record.checkOutTime = record.checkOutTime || new Date();
    }

    await record.save();
    res.json({ success: true, message: 'Attendance updated successfully', record });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  checkIn,
  checkOut,
  getAllAttendance,
  getMyAttendance,
  getAttendanceSummary,
  getMyAttendanceSummary,
  adminCheckOutStudent,
  adminCheckOutAll,
  getActiveCount,
  getPublicAttendanceSummary,
  updateAttendanceRecord,
  processBatchAutoCheckouts
};
