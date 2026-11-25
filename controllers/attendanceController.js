const Attendance = require('../models/Attendance');
const CheckInAccess = require('../models/CheckInAccess');
const DailyWorkload = require('../models/DailyWorkload');

const getISTDateStr = (date = new Date()) => {
  const istTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const year = istTime.getFullYear();
  const month = String(istTime.getMonth() + 1).padStart(2, '0');
  const day = String(istTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getBatchHourLimits = async (studentId, dateStr = null, forcedAccessType = null) => {
  try {
    const Enrollment = require('../models/Enrollment');
    const enrollment = await Enrollment.findOne({ studentId, status: 'approved' }).populate('batchId').lean();
    const batch = enrollment && enrollment.batchId ? enrollment.batchId : null;

    const targetDate = dateStr || getISTDateStr();
    let access = null;
    if (studentId) {
      access = await CheckInAccess.findOne({ studentId, dateStr: targetDate }).lean();
    }

    let dailyWl = null;
    if (batch && batch._id) {
      dailyWl = await DailyWorkload.findOne({ batchId: batch._id, dateStr: targetDate }).lean();
    }

    const mode = forcedAccessType || (access && access.accessType) || 'on-site';

    // Default admin/workload limits based on work mode
    const defaultOnsiteMin = (dailyWl && dailyWl.onsiteMinHours) || batch?.onsiteMinHours || 2;
    const defaultOnsiteMax = (dailyWl && dailyWl.onsiteMaxHours) || batch?.onsiteMaxHours || 10;
    const defaultWfhMin = (dailyWl && dailyWl.wfhMinHours) || batch?.wfhMinHours || 3;
    const defaultWfhMax = (dailyWl && dailyWl.wfhMaxHours) || batch?.wfhMaxHours || 10;

    let minRequired = (mode === 'wfh') ? defaultWfhMin : defaultOnsiteMin;
    let maxAllowed = (mode === 'wfh') ? defaultWfhMax : defaultOnsiteMax;

    // Mentor day-wise fixed work time overrides default minRequired
    if (access && access.workHours !== undefined && access.workHours !== null) {
      minRequired = Number(access.workHours);
    } else if (access && access.minHours !== undefined && access.minHours !== null) {
      minRequired = Number(access.minHours);
    }

    if (access && access.maxHours !== undefined && access.maxHours !== null) {
      maxAllowed = Number(access.maxHours);
    }

    return {
      requiredPresentHours: minRequired,
      maxValidHours: maxAllowed,
      onsiteMinHours: (access && access.onsiteMinHours) || defaultOnsiteMin,
      onsiteMaxHours: (access && access.onsiteMaxHours) || defaultOnsiteMax,
      wfhMinHours: (access && access.wfhMinHours) || defaultWfhMin,
      wfhMaxHours: (access && access.wfhMaxHours) || defaultWfhMax,
      accessType: mode,
      workHours: access?.workHours || minRequired
    };
  } catch (err) {
    console.error('Error fetching batch hour limits:', err);
  }
  return { 
    requiredPresentHours: 2, 
    maxValidHours: 10,
    onsiteMinHours: 2,
    onsiteMaxHours: 10,
    wfhMinHours: 3,
    wfhMaxHours: 10,
    accessType: 'on-site', 
    workHours: 2 
  };
};

// Helper: Evaluate attendance records maintaining On-Site and WFH records separately
const evaluateAttendanceRecord = (record, additionalSeconds = 0) => {
  const currentAccessType = record.accessType || 'on-site';
  
  if (additionalSeconds > 0) {
    if (currentAccessType === 'wfh') {
      record.wfhDurationSeconds = (record.wfhDurationSeconds || 0) + additionalSeconds;
      record.wfhAllocated = true;
    } else {
      record.onsiteDurationSeconds = (record.onsiteDurationSeconds || 0) + additionalSeconds;
      record.onsiteAllocated = true;
    }
  }

  // Ensure legacy records get their sessionDurationSeconds attributed
  if ((!record.onsiteDurationSeconds && !record.wfhDurationSeconds) && (record.sessionDurationSeconds || 0) > 0) {
    if (currentAccessType === 'wfh') {
      record.wfhDurationSeconds = record.sessionDurationSeconds;
      record.wfhAllocated = true;
    } else {
      record.onsiteDurationSeconds = record.sessionDurationSeconds;
      record.onsiteAllocated = true;
    }
  }

  record.sessionDurationSeconds = (record.onsiteDurationSeconds || 0) + (record.wfhDurationSeconds || 0);

  const onsiteHrs = (record.onsiteDurationSeconds || 0) / 3600;
  const wfhHrs = (record.wfhDurationSeconds || 0) / 3600;

  const onsiteMin = (record.onsiteMinHours !== undefined && Number(record.onsiteMinHours) > 0)
    ? Number(record.onsiteMinHours)
    : 2;

  const wfhMin = (record.wfhMinHours !== undefined && Number(record.wfhMinHours) > 0)
    ? Number(record.wfhMinHours)
    : 3;

  const onsiteMax = (record.onsiteMaxHours !== undefined && Number(record.onsiteMaxHours) > 0)
    ? Number(record.onsiteMaxHours)
    : (record.maxValidHours || 10);

  const wfhMax = (record.wfhMaxHours !== undefined && Number(record.wfhMaxHours) > 0)
    ? Number(record.wfhMaxHours)
    : (record.maxValidHours || 10);

  // Check over-time first: if either exceeds maximum allowed
  if (onsiteHrs > onsiteMax || wfhHrs > wfhMax) {
    record.status = 'Invalid';
    return record.status;
  }

  // If still actively checked in, status remains 'In Progress'
  if (record.isActive) {
    record.status = 'In Progress';
    return record.status;
  }

  // Determine which modes were allocated or undertaken
  const hasOnsite = Boolean(record.onsiteAllocated || (record.onsiteDurationSeconds || 0) > 0);
  const hasWfh = Boolean(record.wfhAllocated || (record.wfhDurationSeconds || 0) > 0);

  // Case 1: Both On-Site and WFH were allocated or undertaken today
  if (hasOnsite && hasWfh) {
    const onsiteSatisfied = onsiteHrs >= onsiteMin;
    const wfhSatisfied = wfhHrs >= wfhMin;

    if (onsiteSatisfied && wfhSatisfied) {
      record.status = 'Present';
    } else {
      record.status = record.isLeave ? 'Leave' : 'Absent';
    }
  }
  // Case 2: Holiday / WFH-only day (mentor only allocated WFH, no onsite expected)
  else if (hasWfh && !hasOnsite) {
    const minReq = (record.isLeave && record.leaveHours > 0)
      ? Math.max(1, wfhMin - record.leaveHours)
      : wfhMin;

    if (wfhHrs >= minReq && wfhHrs <= wfhMax) {
      record.status = 'Present';
    } else {
      record.status = record.isLeave ? 'Leave' : 'Absent';
    }
  }
  // Case 3: On-Site only day (mentor only allocated on-site, no WFH expected)
  else {
    const minReq = (record.isLeave && record.leaveHours > 0)
      ? Math.max(1, onsiteMin - record.leaveHours)
      : onsiteMin;

    if (onsiteHrs >= minReq && onsiteHrs <= onsiteMax) {
      record.status = 'Present';
    } else {
      record.status = record.isLeave ? 'Leave' : 'Absent';
    }
  }

  return record.status;
};

// Helper: Auto-close any open sessions from previous days for a student
const autoCloseOldSessions = async (studentId) => {
  try {
    const todayStr = getISTDateStr();

    // Find all active records from before today for this student
    const activeRecords = await Attendance.find({
      studentId: studentId,
      isActive: true,
      dateStr: { $lt: todayStr }
    });

    if (!activeRecords || activeRecords.length === 0) {
      return;
    }

    for (const record of activeRecords) {
      const recordDate = new Date(record.dateStr);
      const endOfDay = new Date(recordDate.getFullYear(), recordDate.getMonth(), recordDate.getDate(), 23, 59, 59);
      const lastCheckIn = new Date(record.lastCheckInTime);
      const checkoutTime = endOfDay > lastCheckIn ? endOfDay : lastCheckIn;
      
      const durationMs = checkoutTime.getTime() - lastCheckIn.getTime();
      const elapsedSec = Math.max(0, Math.floor(durationMs / 1000));
      record.checkOutTime = checkoutTime;
      record.isActive = false;

      evaluateAttendanceRecord(record, elapsedSec);
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
      const elapsedSec = Math.max(0, Math.floor(durationMs / 1000));
      record.checkOutTime = checkoutTime;
      record.isActive = false;

      evaluateAttendanceRecord(record, elapsedSec);
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
      const checkoutCutoff = batch.autoCheckOutTime || batch.checkOutTime || '23:59';
      
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

        for (const record of activeRecords) {
          const nowTime = new Date();
          const lastCheckIn = new Date(record.lastCheckInTime);
          const durationMs = Math.max(0, nowTime.getTime() - lastCheckIn.getTime());
          const elapsedSec = Math.floor(durationMs / 1000);

          record.checkOutTime = nowTime;
          record.isActive = false;

          evaluateAttendanceRecord(record, elapsedSec);
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
        const allowedCheckIn = batch.checkInTime || '09:00';
        const allowedCheckOut = batch.checkOutTime || '23:59';
        hasTimeRestrictions = true;
        if (currentTimeStr >= allowedCheckIn && currentTimeStr <= allowedCheckOut) {
          isAllowed = true;
          allowedBatchId = batch._id;
          break;
        }
      }

      if (hasTimeRestrictions && !isAllowed) {
        return res.status(400).json({ message: 'Check-in is currently restricted outside of scheduled hours (09:00 AM - 11:59 PM).' });
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

    // Check if student has approved leave today
    const Leave = require('../models/Leave');
    const todayApprovedLeave = await Leave.findOne({
      studentId: req.user._id,
      status: 'approved',
      $or: [
        { startDate: dateStr },
        { 
          leaveType: 'multiple_days',
          startDate: { $lte: dateStr },
          endDate: { $gte: dateStr }
        }
      ]
    }).lean();

    if (todayApprovedLeave && access.accessType !== 'wfh') {
      return res.status(400).json({ 
        message: 'You are on approved leave today. On-site check-in is not permitted. Only WFH check-in is allowed if authorized by your mentor.' 
      });
    }

    let attendance = await Attendance.findOne({
      studentId: req.user._id,
      dateStr: dateStr
    });

    const isWfh = (access.accessType === 'wfh');
    const minH = access.minHours || access.workHours || (isWfh ? 3 : 2);
    const maxH = access.maxHours || 10;

    let dailyWl = null;
    if (access.batchId) {
      dailyWl = await DailyWorkload.findOne({ batchId: access.batchId, dateStr }).lean();
    }

    const resolvedOnsiteMin = access.onsiteMinHours || dailyWl?.onsiteMinHours || (isWfh ? 2 : minH);
    const resolvedOnsiteMax = access.onsiteMaxHours || dailyWl?.onsiteMaxHours || (isWfh ? 10 : maxH);
    const resolvedWfhMin = access.wfhMinHours || dailyWl?.wfhMinHours || (isWfh ? minH : 3);
    const resolvedWfhMax = access.wfhMaxHours || dailyWl?.wfhMaxHours || (isWfh ? maxH : 10);
    const resolvedOnsiteAlloc = access.onsiteAllocated !== undefined ? access.onsiteAllocated : (dailyWl ? dailyWl.onsiteAllocated : !isWfh);
    const resolvedWfhAlloc = access.wfhAllocated !== undefined ? access.wfhAllocated : (dailyWl ? dailyWl.wfhAllocated : isWfh);

    const targetMode = access.accessType || 'on-site';
    if (attendance) {
      if (attendance.isActive) {
        if (attendance.accessType === targetMode) {
          return res.status(200).json(attendance);
        }
        // Mode changed while still checked in: commit elapsed seconds of previous mode before switching
        const prevElapsed = attendance.lastCheckInTime
          ? Math.max(0, Math.floor((Date.now() - new Date(attendance.lastCheckInTime).getTime()) / 1000))
          : 0;
        evaluateAttendanceRecord(attendance, prevElapsed);
      }
      attendance.lastCheckInTime = Date.now();
      attendance.isActive = true;
      attendance.status = 'In Progress';
      attendance.accessType = access.accessType || 'on-site';
      if (todayApprovedLeave) {
        attendance.isLeave = true;
      }
      if (isWfh) {
        attendance.wfhAllocated = true;
        attendance.wfhMinHours = minH;
        attendance.wfhMaxHours = maxH;
        if (!attendance.onsiteMinHours || attendance.onsiteMinHours === 4) {
          attendance.onsiteMinHours = resolvedOnsiteMin;
        }
        if (resolvedOnsiteAlloc) {
          attendance.onsiteAllocated = true;
        }
      } else {
        attendance.onsiteAllocated = true;
        attendance.onsiteMinHours = minH;
        attendance.onsiteMaxHours = maxH;
        if (!attendance.wfhMinHours || attendance.wfhMinHours === 4) {
          attendance.wfhMinHours = resolvedWfhMin;
        }
        if (resolvedWfhAlloc) {
          attendance.wfhAllocated = true;
        }
      }
      attendance.minRequiredHours = minH;
      attendance.maxValidHours = maxH;
      attendance.workHours = minH;
      if (attendance.onsiteDurationSeconds === undefined) attendance.onsiteDurationSeconds = 0;
      if (attendance.wfhDurationSeconds === undefined) attendance.wfhDurationSeconds = 0;
      await attendance.save();
    } else {
      try {
        attendance = await Attendance.create({
          studentId: req.user._id,
          dateStr: dateStr,
          checkInTime: Date.now(),
          lastCheckInTime: Date.now(),
          accessType: access.accessType || 'on-site',
          workHours: minH,
          minRequiredHours: minH,
          maxValidHours: maxH,
          onsiteDurationSeconds: 0,
          wfhDurationSeconds: 0,
          onsiteAllocated: isWfh ? Boolean(resolvedOnsiteAlloc) : true,
          wfhAllocated: isWfh ? true : Boolean(resolvedWfhAlloc),
          onsiteMinHours: resolvedOnsiteMin,
          onsiteMaxHours: resolvedOnsiteMax,
          wfhMinHours: resolvedWfhMin,
          wfhMaxHours: resolvedWfhMax,
          isLeave: Boolean(todayApprovedLeave),
          isActive: true
        });
      } catch (createErr) {
        // Handle race condition where concurrent request already created today's record
        if (createErr.code === 11000) {
          attendance = await Attendance.findOne({
            studentId: req.user._id,
            dateStr: dateStr
          });
          if (attendance && attendance.isActive) {
            return res.status(200).json(attendance);
          }
        } else {
          throw createErr;
        }
      }
    }

    // ─── Attendance Streak Tracking (Concurrency-Safe) ───
    try {
      const User = require('../models/User');
      const { isSameDay, isYesterday, awardCoinsWithCap, awardXPWithCap, checkAndAwardBadges, checkAndAwardStreakMilestones } = require('../utils/gamification');
      
      const startOfToday = new Date(istTime.getFullYear(), istTime.getMonth(), istTime.getDate());
      // Atomically claim today's attendance streak to prevent duplicate rewards under concurrent requests
      const priorUserDoc = await User.findOneAndUpdate(
        {
          _id: req.user._id,
          $or: [
            { lastAttendanceDate: { $exists: false } },
            { lastAttendanceDate: null },
            { lastAttendanceDate: { $lt: startOfToday } }
          ]
        },
        { $set: { lastAttendanceDate: now } },
        { returnDocument: 'before' }
      );

      if (priorUserDoc) {
        const studentUser = await User.findById(req.user._id);
        if (studentUser) {
          if (isYesterday(priorUserDoc.lastAttendanceDate)) {
            studentUser.attendanceStreak = (priorUserDoc.attendanceStreak || 0) + 1;
          } else {
            studentUser.attendanceStreak = 1;
          }

          // Award base attendance XP
          awardCoinsWithCap(studentUser, 10, 'Daily attendance check-in');
          awardXPWithCap(studentUser, 20, 'Daily attendance check-in');

          // Check milestones & badges
          checkAndAwardStreakMilestones(studentUser);
          checkAndAwardBadges(studentUser);
          await studentUser.save();
        }
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
      const elapsedSec = Math.max(0, Math.floor(durationMs / 1000));
      
      attendance.checkOutTime = now;
      attendance.isActive = false;

      evaluateAttendanceRecord(attendance, elapsedSec);
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
    const { batchId, page: pageQuery, limit: limitQuery, paginated } = req.query;
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
      
      const enrollments = await Enrollment.find({ batchId: { $in: targetBatchIds }, status: 'approved' }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);
      query = { studentId: { $in: studentIds } };
    } else if (batchId) {
      const enrollments = await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);
      query = { studentId: { $in: studentIds } };
    }
    
    const page = parseInt(pageQuery, 10);
    const limit = parseInt(limitQuery, 10);

    if (page > 0 && limit > 0) {
      const skip = (page - 1) * limit;
      const [logs, total] = await Promise.all([
        Attendance.find(query)
          .populate('studentId', 'name email rollNumber')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Attendance.countDocuments(query)
      ]);
      res.setHeader('X-Total-Count', total);
      if (paginated === 'true') {
        return res.json({ logs, total, page, totalPages: Math.ceil(total / limit) });
      }
      return res.json(logs);
    }
    
    const logs = await Attendance.find(query)
      .populate('studentId', 'name email rollNumber')
      .sort({ createdAt: -1 })
      .lean();
    
    res.setHeader('X-Total-Count', logs.length);
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
      .sort({ createdAt: -1 })
      .lean();
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

    const { batchId } = req.query;
    const Enrollment = require('../models/Enrollment');
    const Batch = require('../models/Batch');

    let query = {};
    let batchStartDate = null;
    
    if (batchId && batchId !== 'all') {
      const enrollments = await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);
      query = { studentId: { $in: studentIds } };

      const batch = await Batch.findById(batchId).lean();
      if (batch && batch.startDate) {
        batchStartDate = batch.startDate;
      }
    } else if (req.user.role === 'mentor') {
      const mentorBatches = await Batch.find({ 
        $or: [{ mentorId: req.user._id }, { mentors: req.user._id }] 
      }).select('_id startDate').lean();
      const mentorBatchIds = mentorBatches.map(b => b._id);
      
      const enrollments = await Enrollment.find({ batchId: { $in: mentorBatchIds }, status: 'approved' }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);
      query = { studentId: { $in: studentIds } };
    }

    if (batchStartDate) {
      const batchStartStr = new Date(batchStartDate).toISOString().split('T')[0];
      query.dateStr = { $gte: batchStartStr };
    }
    
    const logs = await Attendance.find(query)
      .select('studentId dateStr sessionDurationSeconds onsiteDurationSeconds wfhDurationSeconds onsiteMinHours onsiteMaxHours wfhMinHours wfhMaxHours onsiteAllocated wfhAllocated accessType isActive lastCheckInTime checkInTime checkOutTime isLeave leaveHours status workHours minRequiredHours maxValidHours')
      .populate('studentId', 'name email rollNumber')
      .sort({ dateStr: -1, createdAt: -1 })
      .lean();

    // Load authoritative DailyWorkload benchmarks for the batch(es) so every student is evaluated against the batch policy
    const DailyWorkload = require('../models/DailyWorkload');
    const wlQuery = {};
    if (batchId) {
      wlQuery.batchId = batchId;
    } else if (req.user.role === 'mentor') {
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id').lean();
      wlQuery.batchId = { $in: mentorBatches.map(b => b._id) };
    }
    if (query.dateStr) {
      wlQuery.dateStr = query.dateStr;
    }
    const dailyWorkloads = await DailyWorkload.find(wlQuery).sort({ updatedAt: -1 }).lean();
    const wlByDate = new Map();
    for (const wl of dailyWorkloads) {
      if (!wlByDate.has(wl.dateStr)) {
        wlByDate.set(wl.dateStr, wl);
      }
    }
    
    const summaryList = logs.map(log => {
      let currentDuration = log.sessionDurationSeconds || 0;
      let currentOnsite = log.onsiteDurationSeconds || 0;
      let currentWfh = log.wfhDurationSeconds || 0;

      // Handle legacy records where onsite/wfh wasn't split
      if (!currentOnsite && !currentWfh && currentDuration > 0) {
        if (log.accessType === 'wfh') currentWfh = currentDuration;
        else currentOnsite = currentDuration;
      }

      if (log.isActive) {
        const delta = Math.floor((Date.now() - new Date(log.lastCheckInTime).getTime()) / 1000);
        currentDuration += delta;
        if (log.accessType === 'wfh') {
          currentWfh += delta;
        } else {
          currentOnsite += delta;
        }
      }

      const wl = wlByDate.get(log.dateStr);
      const effOnsiteMin = wl?.onsiteMinHours || log.onsiteMinHours || 2;
      const effOnsiteMax = wl?.onsiteMaxHours || log.onsiteMaxHours || 10;
      const effWfhMin = wl?.wfhMinHours || log.wfhMinHours || 3;
      const effWfhMax = wl?.wfhMaxHours || log.wfhMaxHours || 10;
      const effOnsiteAlloc = Boolean(log.onsiteAllocated || wl?.onsiteAllocated || (log.onsiteDurationSeconds > 0));
      const effWfhAlloc = Boolean(log.wfhAllocated || wl?.wfhAllocated || (log.wfhDurationSeconds > 0));

      // Re-compute status against authoritative batch DailyWorkload if present
      let effStatus = log.status;
      if (wl && !log.isActive && !log.isLeave && log.status !== 'Leave') {
        if (currentOnsite > effOnsiteMax * 3600 || currentWfh > effWfhMax * 3600) {
          effStatus = 'Invalid';
        } else {
          const onsiteOk = !effOnsiteAlloc || currentOnsite >= effOnsiteMin * 3600;
          const wfhOk = !effWfhAlloc || currentWfh >= effWfhMin * 3600;
          effStatus = (onsiteOk && wfhOk && (currentOnsite > 0 || currentWfh > 0)) ? 'Present' : 'Absent';
        }
      }
      
      return {
        _id: log._id,
        studentId: log.studentId?._id,
        name: log.studentId?.name || 'Unknown',
        email: log.studentId?.email,
        rollNumber: log.studentId?.rollNumber,
        date: log.dateStr,
        totalSeconds: currentDuration,
        onsiteSeconds: currentOnsite,
        wfhSeconds: currentWfh,
        onsiteMinHours: effOnsiteMin,
        onsiteMaxHours: effOnsiteMax,
        wfhMinHours: effWfhMin,
        wfhMaxHours: effWfhMax,
        onsiteAllocated: effOnsiteAlloc,
        wfhAllocated: effWfhAlloc,
        accessType: log.accessType || 'on-site',
        firstCheckIn: log.checkInTime,
        lastCheckOut: log.checkOutTime,
        isActive: log.isActive,
        isLeave: log.isLeave,
        leaveHours: log.leaveHours,
        requiredPresentHours: log.minRequiredHours || log.workHours || (log.accessType === 'wfh' ? effWfhMin : effOnsiteMin),
        maxValidHours: log.maxValidHours || 10,
        status: effStatus
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
    let reqHours = 4;
    let maxHours = 10;

    if (enrollments.length > 0 && enrollments[0].batchId) {
      const b = enrollments[0].batchId;
      batchStartDate = b.startDate;
      if (b.requiredPresentHours !== undefined) reqHours = b.requiredPresentHours;
      if (b.maxValidHours !== undefined) maxHours = b.maxValidHours;
    }

    const query = { studentId: req.user._id };
    if (batchStartDate) {
      const batchStartStr = new Date(batchStartDate).toISOString().split('T')[0];
      query.dateStr = { $gte: batchStartStr };
    }

    const logs = await Attendance.find(query)
      .select('dateStr sessionDurationSeconds onsiteDurationSeconds wfhDurationSeconds onsiteMinHours onsiteMaxHours wfhMinHours wfhMaxHours onsiteAllocated wfhAllocated checkInTime lastCheckInTime checkOutTime isActive isLeave leaveHours status accessType workHours minRequiredHours maxValidHours')
      .sort({ dateStr: -1, createdAt: -1 })
      .lean();
    
    const summaryList = logs.map(log => {
      let currentDuration = log.sessionDurationSeconds || 0;
      let currentOnsite = log.onsiteDurationSeconds || 0;
      let currentWfh = log.wfhDurationSeconds || 0;

      if (!currentOnsite && !currentWfh && currentDuration > 0) {
        if (log.accessType === 'wfh') currentWfh = currentDuration;
        else currentOnsite = currentDuration;
      }

      if (log.isActive) {
        const delta = Math.floor((Date.now() - new Date(log.lastCheckInTime).getTime()) / 1000);
        currentDuration += delta;
        if (log.accessType === 'wfh') {
          currentWfh += delta;
        } else {
          currentOnsite += delta;
        }
      }
      
      const dayReqHours = log.minRequiredHours !== undefined ? log.minRequiredHours : (log.workHours || reqHours);
      const dayMaxHours = log.maxValidHours !== undefined ? log.maxValidHours : maxHours;

      return {
        _id: log._id,
        date: log.dateStr,
        totalSeconds: currentDuration,
        onsiteSeconds: currentOnsite,
        wfhSeconds: currentWfh,
        onsiteMinHours: log.onsiteMinHours || 2,
        onsiteMaxHours: log.onsiteMaxHours || 10,
        wfhMinHours: log.wfhMinHours || 3,
        wfhMaxHours: log.wfhMaxHours || 10,
        onsiteAllocated: Boolean(log.onsiteAllocated || (log.onsiteDurationSeconds > 0)),
        wfhAllocated: Boolean(log.wfhAllocated || (log.wfhDurationSeconds > 0)),
        firstCheckIn: log.checkInTime,
        lastCheckInTime: log.lastCheckInTime,
        lastCheckOut: log.checkOutTime,
        isActive: log.isActive,
        isLeave: log.isLeave,
        leaveHours: log.leaveHours,
        requiredPresentHours: log.minRequiredHours || log.workHours || (log.accessType === 'wfh' ? (log.wfhMinHours || 3) : (log.onsiteMinHours || 2)),
        maxValidHours: log.maxValidHours || 10,
        status: log.status,
        accessType: log.accessType || 'on-site',
        workHours: log.workHours || dayReqHours,
        requiredPresentHours: dayReqHours,
        maxValidHours: dayMaxHours
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
      const elapsedSec = Math.max(0, Math.floor(durationMs / 1000));
      
      attendance.checkOutTime = now;
      attendance.isActive = false;

      evaluateAttendanceRecord(attendance, elapsedSec);
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

// @desc    Auto check-out student (e.g. on disciplinary suspension or block)
const autoCheckOutStudent = async (studentId, reason = 'Administrative action') => {
  try {
    const activeAttendance = await Attendance.findOne({ studentId, isActive: true });
    if (!activeAttendance) return null;

    const now = Date.now();
    const durationMs = activeAttendance.lastCheckInTime ? (now - new Date(activeAttendance.lastCheckInTime).getTime()) : 0;
    const elapsedSec = Math.max(0, Math.floor(durationMs / 1000));
    activeAttendance.checkOutTime = now;
    activeAttendance.isActive = false;

    evaluateAttendanceRecord(activeAttendance, elapsedSec);
    await activeAttendance.save();

    // Emit real-time socket events
    try {
      const { emitToUser, getIO } = require('../sockets/socketHandlers');
      emitToUser(studentId.toString(), 'force-checkout', { 
        attendanceId: activeAttendance._id, 
        reason: reason || 'Access suspended or blocked' 
      });
      const io = getIO();
      if (io) {
        io.emit('attendanceUpdate', { studentId: studentId.toString(), status: 'checked-out', reason });
      }
    } catch (socketErr) {
      console.warn('Socket emit warning on auto-checkout:', socketErr.message);
    }

    return activeAttendance;
  } catch (err) {
    console.error('Error in autoCheckOutStudent:', err);
    return null;
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
      const elapsedSec = Math.max(0, Math.floor(durationMs / 1000));
      
      attendance.checkOutTime = now;
      attendance.isActive = false;

      evaluateAttendanceRecord(attendance, elapsedSec);
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

// In-memory bounded cache for active student count
const activeCountCache = new Map();
const ACTIVE_COUNT_CACHE_TTL_MS = 5000; // 5 seconds

// @desc    Get count of active students
// @route   GET /api/attendance/active-count
// @access  Private (Student/Admin/Mentor)
const getActiveCount = async (req, res) => {
  try {
    const { batchId } = req.query;
    const cacheKey = `${req.user._id}_${req.user.role}_${batchId || 'default'}`;
    const now = Date.now();
    if (activeCountCache.has(cacheKey)) {
      const cached = activeCountCache.get(cacheKey);
      if (now - cached.timestamp < ACTIVE_COUNT_CACHE_TTL_MS) {
        return res.json({ activeCount: cached.count });
      }
    }

    const Enrollment = require('../models/Enrollment');
    const Batch = require('../models/Batch');

    let studentIdsToFilter = null;

    if (req.user.role === 'student') {
      // For student: Find all batch(es) student is enrolled in
      const studentEnrollments = await Enrollment.find({ studentId: req.user._id, status: 'approved' }).select('batchId').lean();
      const studentBatchIds = studentEnrollments.map(e => e.batchId).filter(Boolean);

      if (studentBatchIds.length === 0) {
        return res.json({ activeCount: 0 });
      }

      // Find all students enrolled in those same batches
      const peerEnrollments = await Enrollment.find({ batchId: { $in: studentBatchIds }, status: 'approved' }).select('studentId').lean();
      studentIdsToFilter = [...new Set(peerEnrollments.map(e => e.studentId.toString()))];

    } else if (req.user.role === 'mentor') {
      // For mentor: Filter by requested batchId or mentor's assigned batches
      let targetBatchIds = [];

      if (batchId && batchId !== 'all') {
        targetBatchIds = [batchId];
      } else {
        // Find all batches assigned to this mentor
        const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id').lean();
        targetBatchIds = mentorBatches.map(b => b._id);

        // Also check if mentor object has batches array
        if (req.user.batches && Array.isArray(req.user.batches) && req.user.batches.length > 0) {
          req.user.batches.forEach(bId => {
            if (!targetBatchIds.some(id => id.toString() === bId.toString())) {
              targetBatchIds.push(bId);
            }
          });
        }
      }

      if (targetBatchIds.length === 0) {
        return res.json({ activeCount: 0 });
      }

      const batchEnrollments = await Enrollment.find({ batchId: { $in: targetBatchIds }, status: 'approved' }).select('studentId').lean();
      studentIdsToFilter = [...new Set(batchEnrollments.map(e => e.studentId.toString()))];

    } else if (req.user.role === 'admin') {
      // For admin: If batchId specified and not 'all', filter by that batch; otherwise global count
      if (batchId && batchId !== 'all') {
        const batchEnrollments = await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean();
        studentIdsToFilter = batchEnrollments.map(e => e.studentId).filter(Boolean);
      }
    }

    let query = { isActive: true };
    if (studentIdsToFilter !== null) {
      query.studentId = { $in: studentIdsToFilter };
    }

    const activeCount = await Attendance.countDocuments(query);
    activeCountCache.set(cacheKey, { count: activeCount, timestamp: Date.now() });
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
    const DailyWorkload = require('../models/DailyWorkload');

    const [logs, accessGrants, leaves, dailyWorkload] = await Promise.all([
      Attendance.find(query)
        .select('studentId dateStr sessionDurationSeconds onsiteDurationSeconds wfhDurationSeconds onsiteMinHours onsiteMaxHours wfhMinHours wfhMaxHours onsiteAllocated wfhAllocated accessType isActive lastCheckInTime checkInTime checkOutTime isLeave leaveHours status workHours minRequiredHours maxValidHours')
        .lean(),
      CheckInAccess.find(batchId ? { batchId, dateStr: targetDateStr } : { dateStr: targetDateStr })
        .select('studentId dateStr accessType workHours minHours maxHours onsiteAllocated wfhAllocated onsiteMinHours onsiteMaxHours wfhMinHours wfhMaxHours')
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
      }).lean(),
      batchId ? DailyWorkload.findOne({ batchId, dateStr: targetDateStr }).lean() : Promise.resolve(null)
    ]);
    
    const logsMap = {};
    logs.forEach(log => {
      logsMap[String(log.studentId)] = log;
    });
    
    const accessMap = {};
    accessGrants.forEach(grant => {
      accessMap[String(grant.studentId)] = grant;
    });

    const leavesMap = {};
    leaves.forEach(l => {
      leavesMap[String(l.studentId)] = l;
    });
    
    const summaryList = students.map(student => {
      const sId = String(student._id);
      const log = logsMap[sId];
      const grant = accessMap[sId];
      const accessType = grant?.accessType || log?.accessType || 'on-site';
      const workHours = grant?.workHours || grant?.minHours || log?.workHours || null;
      const minHours = grant?.minHours || log?.minRequiredHours || 4;
      const maxHours = grant?.maxHours || log?.maxValidHours || 10;
      const studentLeave = leavesMap[sId];
      
      let currentDuration = log ? (log.sessionDurationSeconds || 0) : 0;
      let currentOnsite = log ? (log.onsiteDurationSeconds || 0) : 0;
      let currentWfh = log ? (log.wfhDurationSeconds || 0) : 0;

      if (!currentOnsite && !currentWfh && currentDuration > 0) {
        if (accessType === 'wfh') currentWfh = currentDuration;
        else currentOnsite = currentDuration;
      }

      if (log && log.isActive) {
        const delta = Math.floor((Date.now() - new Date(log.lastCheckInTime).getTime()) / 1000);
        currentDuration += delta;
        if (accessType === 'wfh') {
          currentWfh += delta;
        } else {
          currentOnsite += delta;
        }
      }

      const onsiteMinHours = log?.onsiteMinHours || grant?.onsiteMinHours || dailyWorkload?.onsiteMinHours || 4;
      const onsiteMaxHours = log?.onsiteMaxHours || grant?.onsiteMaxHours || dailyWorkload?.onsiteMaxHours || 10;
      const wfhMinHours = log?.wfhMinHours || grant?.wfhMinHours || dailyWorkload?.wfhMinHours || 4;
      const wfhMaxHours = log?.wfhMaxHours || grant?.wfhMaxHours || dailyWorkload?.wfhMaxHours || 10;

      const onsiteAllocated = Boolean(log?.onsiteAllocated || grant?.onsiteAllocated || dailyWorkload?.onsiteAllocated || currentOnsite > 0 || accessType === 'on-site');
      const wfhAllocated = Boolean(log?.wfhAllocated || grant?.wfhAllocated || dailyWorkload?.wfhAllocated || currentWfh > 0 || accessType === 'wfh');

      const onsiteMet = !onsiteAllocated || currentOnsite >= (onsiteMinHours * 3600);
      const wfhMet = !wfhAllocated || currentWfh >= (wfhMinHours * 3600);
      const bothMet = onsiteMet && wfhMet;

      // Evaluate accurate day status (Present, In Progress, Invalid, Leave, Absent)
      let computedStatus = 'Absent';
      const isOvertime = (currentOnsite / 3600) > onsiteMaxHours || (currentWfh / 3600) > wfhMaxHours;
      if (log?.status === 'Leave' || (studentLeave && studentLeave.leaveType !== 'hours' && !log?.isActive && !bothMet)) {
        computedStatus = 'Leave';
      } else if (log?.status === 'Invalid' || isOvertime) {
        computedStatus = 'Invalid';
      } else if (bothMet && (currentOnsite > 0 || currentWfh > 0 || (log?.leaveHours || 0) > 0)) {
        computedStatus = 'Present';
      } else if (log?.isActive) {
        computedStatus = 'In Progress';
      } else if (log?.status === 'Present' && bothMet) {
        computedStatus = 'Present';
      }
      
      return {
        _id: log ? log._id : `absent_${sId}`,
        studentId: sId,
        name: student.name || 'Unknown',
        email: student.email,
        rollNumber: student.rollNumber,
        date: targetDateStr,
        totalSeconds: currentDuration,
        onsiteSeconds: currentOnsite,
        wfhSeconds: currentWfh,
        onsiteMinHours,
        onsiteMaxHours,
        wfhMinHours,
        wfhMaxHours,
        onsiteAllocated,
        wfhAllocated,
        onsiteMet,
        wfhMet,
        bothMet,
        firstCheckIn: log ? log.checkInTime : null,
        lastCheckOut: log ? log.checkOutTime : null,
        isActive: log ? log.isActive : false,
        isLeave: Boolean(log?.isLeave || (studentLeave && studentLeave.leaveType !== 'hours')),
        leaveHours: log ? log.leaveHours : 0,
        leaveInfo: studentLeave ? (
          studentLeave.leaveType === 'hours'
            ? `Hour Leave (${studentLeave.startTime} - ${studentLeave.endTime})`
            : studentLeave.leaveType === 'multiple_days'
              ? `Multiple Day Leave (${studentLeave.startDate} to ${studentLeave.endDate})`
              : 'Day Leave'
        ) : null,
        leaveType: studentLeave ? studentLeave.leaveType : null,
        status: computedStatus,
        accessType,
        workHours,
        minHours,
        maxHours,
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
    const { dateStr, hours, onsiteHours, wfhHours, status } = req.body;

    const hasSplitHours = onsiteHours !== undefined || wfhHours !== undefined;
    const onsiteSec = hasSplitHours ? Math.max(0, Math.round(Number(onsiteHours || 0) * 3600)) : null;
    const wfhSec = hasSplitHours ? Math.max(0, Math.round(Number(wfhHours || 0) * 3600)) : null;
    const totalSec = hasSplitHours
      ? (onsiteSec + wfhSec)
      : Math.max(0, Math.round(Number(hours || 0) * 3600));

    let record;
    if (id.startsWith('absent_')) {
      const studentId = id.replace('absent_', '');
      record = new Attendance({
        studentId,
        dateStr: dateStr || getISTDateStr(),
        checkInTime: new Date(),
        lastCheckInTime: new Date(),
        checkOutTime: new Date(),
        sessionDurationSeconds: totalSec,
        onsiteDurationSeconds: hasSplitHours ? onsiteSec : totalSec,
        wfhDurationSeconds: hasSplitHours ? wfhSec : 0,
        onsiteAllocated: hasSplitHours ? onsiteSec > 0 : totalSec > 0,
        wfhAllocated: hasSplitHours ? wfhSec > 0 : false,
        status,
        isActive: false
      });
    } else {
      record = await Attendance.findById(id);
      if (!record) {
        return res.status(404).json({ message: 'Attendance record not found' });
      }
      record.sessionDurationSeconds = totalSec;
      if (hasSplitHours) {
        record.onsiteDurationSeconds = onsiteSec;
        record.wfhDurationSeconds = wfhSec;
        if (onsiteSec > 0) record.onsiteAllocated = true;
        if (wfhSec > 0) record.wfhAllocated = true;
      } else if (record.accessType === 'wfh') {
        record.wfhDurationSeconds = totalSec;
      } else {
        record.onsiteDurationSeconds = totalSec;
      }
      record.status = status;
      if (status !== 'In Progress') {
        record.isActive = false;
        record.checkOutTime = record.checkOutTime || new Date();
      }
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
  autoCheckOutStudent,
  getActiveCount,
  getPublicAttendanceSummary,
  updateAttendanceRecord,
  processBatchAutoCheckouts,
  autoCloseAllOldSessions,
  evaluateAttendanceRecord,
  getBatchHourLimits
};
