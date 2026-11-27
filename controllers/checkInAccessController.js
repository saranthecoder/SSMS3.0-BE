const CheckInAccess = require('../models/CheckInAccess');
const Leave = require('../models/Leave');
const {
  getISTDateStr,
  getPreviousDayISTDateStr,
  getISTDayStartUTC,
  evaluateBatchEligibility
} = require('../utils/checkinEligibility');

const getISTTimeStr = (date = new Date()) => {
  const istTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const hours = String(istTime.getHours()).padStart(2, '0');
  const minutes = String(istTime.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

// Helper: Automatically grant scheduled WFH access to all students of a batch
const triggerAutoWfhGrant = async (batchId, dateStr = getISTDateStr()) => {
  try {
    const DailyWorkload = require('../models/DailyWorkload');
    const Enrollment = require('../models/Enrollment');
    const Attendance = require('../models/Attendance');

    const dw = await DailyWorkload.findOne({ batchId, dateStr });
    if (!dw || !dw.autoWfhEnabled) return false;

    const effWfhMin = dw.wfhMinHours || 3;
    const effWfhMax = dw.wfhMaxHours || 10;
    const effOnsiteMin = dw.onsiteMinHours || 2;
    const effOnsiteMax = dw.onsiteMaxHours || 10;

    const existingGrants = dw.restrictedToGranted
      ? await CheckInAccess.find({ batchId, dateStr }).select('studentId').lean()
      : [];
    const enrollments = dw.restrictedToGranted
      ? []
      : await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean();
    const studentIds = dw.restrictedToGranted
      ? existingGrants.map(g => g.studentId)
      : enrollments.map(e => e.studentId);

    // Mark DailyWorkload as wfhAllocated: true and autoWfhGranted: true
    dw.wfhAllocated = true;
    dw.autoWfhGranted = true;
    await dw.save();

    for (const sId of studentIds) {
      await CheckInAccess.findOneAndUpdate(
        { studentId: sId, dateStr },
        {
          $set: {
            batchId,
            accessType: 'wfh',
            workHours: effWfhMin,
            minHours: effWfhMin,
            maxHours: effWfhMax,
            onsiteMinHours: effOnsiteMin,
            onsiteMaxHours: effOnsiteMax,
            wfhMinHours: effWfhMin,
            wfhMaxHours: effWfhMax,
            onsiteAllocated: Boolean(dw.onsiteAllocated),
            wfhAllocated: true
          }
        },
        { upsert: true }
      );

      const att = await Attendance.findOne({ studentId: sId, dateStr });
      if (att) {
        if (att.isActive && att.accessType !== 'wfh') {
          const { evaluateAttendanceRecord } = require('./attendanceController');
          const prevElapsed = att.lastCheckInTime
            ? Math.max(0, Math.floor((Date.now() - new Date(att.lastCheckInTime).getTime()) / 1000))
            : 0;
          att.isActive = false;
          att.checkOutTime = Date.now();
          evaluateAttendanceRecord(att, prevElapsed);
        }
        att.wfhAllocated = true;
        att.wfhMinHours = effWfhMin;
        att.wfhMaxHours = effWfhMax;
        await att.save();
      }
    }

    try {
      const { emitToBatch } = require('../sockets/socketHandlers');
      emitToBatch(batchId.toString(), 'checkin_access_updated', {
        batchId: batchId.toString(),
        accessType: 'wfh',
        autoScheduled: true
      });
      emitToBatch(batchId.toString(), 'attendance_policy_updated', {
        batchId: batchId.toString()
      });
    } catch (socketErr) {}

    return true;
  } catch (err) {
    console.error('Error triggering auto WFH grant:', err);
    return false;
  }
};

// Helper: Automatically check out active On-Site students and revoke On-Site check-in access
const triggerAutoOnsiteCheckoutAndRevoke = async (batchId, dateStr = getISTDateStr()) => {
  try {
    const DailyWorkload = require('../models/DailyWorkload');
    const Enrollment = require('../models/Enrollment');
    const Attendance = require('../models/Attendance');
    const { evaluateAttendanceRecord } = require('./attendanceController');

    const dw = await DailyWorkload.findOne({ batchId, dateStr });
    if (!dw || !dw.autoOnsiteCheckoutEnabled) return false;

    const existingGrants = dw.restrictedToGranted
      ? await CheckInAccess.find({ batchId, dateStr }).select('studentId').lean()
      : [];
    const enrollments = dw.restrictedToGranted
      ? []
      : await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean();
    const studentIds = dw.restrictedToGranted
      ? existingGrants.map(g => g.studentId)
      : enrollments.map(e => e.studentId);

    // Mark DailyWorkload as autoOnsiteCheckoutDone: true
    dw.autoOnsiteCheckoutDone = true;
    await dw.save();

    if (studentIds.length > 0) {
      // 1. Auto-checkout all active On-Site sessions for these students today
      const activeOnsiteRecords = await Attendance.find({
        studentId: { $in: studentIds },
        dateStr,
        isActive: true,
        accessType: { $ne: 'wfh' }
      });

      for (const record of activeOnsiteRecords) {
        const nowTime = new Date();
        const lastCheckIn = new Date(record.lastCheckInTime);
        const durationMs = Math.max(0, nowTime.getTime() - lastCheckIn.getTime());
        const elapsedSec = Math.floor(durationMs / 1000);

        record.checkOutTime = nowTime;
        record.isActive = false;

        evaluateAttendanceRecord(record, elapsedSec);
        await record.save();
      }

      // 2. Remove On-Site check-in access for all students in this batch for today
      await CheckInAccess.deleteMany({
        studentId: { $in: studentIds },
        batchId,
        dateStr,
        accessType: { $ne: 'wfh' }
      });
    }

    try {
      const { emitToBatch } = require('../sockets/socketHandlers');
      emitToBatch(batchId.toString(), 'checkin_access_updated', {
        batchId: batchId.toString(),
        accessType: 'none',
        autoOnsiteCheckout: true
      });
      emitToBatch(batchId.toString(), 'attendance_updated', {
        batchId: batchId.toString(),
        autoOnsiteCheckout: true
      });
    } catch (socketErr) {}

    return true;
  } catch (err) {
    console.error('Error triggering auto On-Site checkout & revoke:', err);
    return false;
  }
};

// @desc    Grant check-in access to students for today (batch-wise)
// @route   POST /api/checkin-access/grant
// @access  Private (Admin)
const grantAccess = async (req, res) => {
  try {
    const { studentIds, accessType, batchId, workHours, minHours, maxHours } = req.body;

    if (!batchId) {
      return res.status(400).json({ message: 'batchId is required for batch-wise authorization.' });
    }

    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ message: 'studentIds array is required.' });
    }

    const type = accessType || 'on-site';
    if (!['on-site', 'wfh'].includes(type)) {
      return res.status(400).json({ message: 'Invalid accessType. Must be on-site or wfh.' });
    }

    const dateStr = getISTDateStr();

    // Check for approved leaves for the requested students today
    const approvedLeaves = await Leave.find({
      studentId: { $in: studentIds },
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

    const leaveStudentIds = new Set(approvedLeaves.map(l => l.studentId.toString()));
    let targetStudentIds = studentIds;

    // Students on approved leave are restricted from on-site check-in; only WFH can be allocated
    if (type === 'on-site' && leaveStudentIds.size > 0) {
      if (studentIds.length === 1) {
        return res.status(400).json({ 
          message: 'Student is on approved leave today. On-site access is not allowed; only WFH access can be allocated.' 
        });
      }
      targetStudentIds = studentIds.filter(id => !leaveStudentIds.has(id.toString()));
      if (targetStudentIds.length === 0) {
        return res.status(400).json({ 
          message: 'All selected students are on approved leave today. Only WFH access can be allocated to students on leave.' 
        });
      }
    }

    const effWorkHours = (workHours !== undefined && workHours !== null && workHours !== '') 
      ? Number(workHours) 
      : 4;
    const effMinHours = (minHours !== undefined && minHours !== null && minHours !== '') 
      ? Number(minHours) 
      : effWorkHours;
    const effMaxHours = (maxHours !== undefined && maxHours !== null && maxHours !== '') 
      ? Number(maxHours) 
      : 10;

    const isWfh = (type === 'wfh');
    const updateData = { 
      accessType: type, 
      grantedBy: req.user._id,
      workHours: effWorkHours,
      minHours: effMinHours,
      maxHours: effMaxHours
    };
    if (isWfh) {
      updateData.wfhAllocated = true;
      updateData.wfhMinHours = effMinHours;
      updateData.wfhMaxHours = effMaxHours;
    } else {
      updateData.onsiteAllocated = true;
      updateData.onsiteMinHours = effMinHours;
      updateData.onsiteMaxHours = effMaxHours;
    }

    // Maintain batch-level daily workload record so mentor allocation is never lost
    const DailyWorkload = require('../models/DailyWorkload');
    const dailyWlUpdate = { updatedBy: req.user._id };
    if (isWfh) {
      dailyWlUpdate.wfhAllocated = true;
      dailyWlUpdate.wfhMinHours = effMinHours;
      dailyWlUpdate.wfhMaxHours = effMaxHours;
    } else {
      dailyWlUpdate.onsiteAllocated = true;
      dailyWlUpdate.onsiteMinHours = effMinHours;
      dailyWlUpdate.onsiteMaxHours = effMaxHours;
    }
    const dailyWl = await DailyWorkload.findOneAndUpdate(
      { batchId, dateStr },
      { $set: dailyWlUpdate },
      { upsert: true, returnDocument: 'after' }
    );

    const promises = targetStudentIds.map(studentId => 
      CheckInAccess.findOneAndUpdate(
        { studentId, batchId, dateStr },
        { $set: updateData },
        { upsert: true, returnDocument: 'after' }
      )
    );

    await Promise.all(promises);

    // Keep today's attendance records synchronized with newly granted hours and accessType
    try {
      const Attendance = require('../models/Attendance');
      const { evaluateAttendanceRecord } = require('./attendanceController');
      const todayAttendances = await Attendance.find({
        studentId: { $in: targetStudentIds },
        dateStr
      });

      for (const att of todayAttendances) {
        // If student is actively checked in under a DIFFERENT mode, commit & close the old session first
        // so its hours are saved under the old mode and the student can cleanly Check In to the new mode.
        if (att.isActive && att.accessType && att.accessType !== type) {
          const prevElapsed = att.lastCheckInTime
            ? Math.max(0, Math.floor((Date.now() - new Date(att.lastCheckInTime).getTime()) / 1000))
            : 0;
          att.isActive = false;
          att.checkOutTime = Date.now();
          evaluateAttendanceRecord(att, prevElapsed);
        }

        att.workHours = effWorkHours;
        att.minRequiredHours = effMinHours;
        att.maxValidHours = effMaxHours;
        att.accessType = type;

        // Synchronize with daily workload so dual-mode allocations are preserved
        if (dailyWl) {
          if (dailyWl.onsiteAllocated || (att.onsiteDurationSeconds || 0) > 0) {
            att.onsiteAllocated = true;
            att.onsiteMinHours = dailyWl.onsiteMinHours;
            att.onsiteMaxHours = dailyWl.onsiteMaxHours;
          }
          if (dailyWl.wfhAllocated || (att.wfhDurationSeconds || 0) > 0) {
            att.wfhAllocated = true;
            att.wfhMinHours = dailyWl.wfhMinHours;
            att.wfhMaxHours = dailyWl.wfhMaxHours;
          }
        }

        if (isWfh) {
          att.wfhAllocated = true;
          att.wfhMinHours = effMinHours;
          att.wfhMaxHours = effMaxHours;
        } else {
          att.onsiteAllocated = true;
          att.onsiteMinHours = effMinHours;
          att.onsiteMaxHours = effMaxHours;
        }

        if (!att.isActive) {
          evaluateAttendanceRecord(att, 0);
        }
        await att.save();
      }
    } catch (syncErr) {
      console.warn('Syncing attendance records on grantAccess warning:', syncErr.message);
    }

    // Emit real-time socket event so student dashboards update immediately without manual reload
    try {
      const { emitToUser, emitToBatch } = require('../sockets/socketHandlers');
      const payload = {
        hasAccess: true,
        accessType: type,
        workHours: effWorkHours,
        minHours: effMinHours,
        maxHours: effMaxHours,
        batchId
      };
      emitToBatch(batchId, 'checkin-access-updated', payload);
      targetStudentIds.forEach(id => {
        emitToUser(id, 'checkin-access-updated', payload);
      });
    } catch (socketErr) {
      console.warn('Socket emit error in grantAccess:', socketErr.message);
    }

    const skippedCount = studentIds.length - targetStudentIds.length;
    let message = 'Access granted successfully.';
    if (skippedCount > 0) {
      message = `Access granted to ${targetStudentIds.length} student(s). ${skippedCount} student(s) on approved leave were skipped for On-Site (WFH must be allocated for them).`;
    }

    res.status(200).json({ message, grantedCount: targetStudentIds.length, skippedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Revoke check-in access for a student today
// @route   POST /api/checkin-access/revoke
// @access  Private (Admin)
const revokeAccess = async (req, res) => {
  try {
    const { studentId, studentIds, batchId } = req.body;

    if (!batchId) {
      return res.status(400).json({ message: 'batchId is required.' });
    }

    const dateStr = getISTDateStr();

    if (studentIds && Array.isArray(studentIds) && studentIds.length > 0) {
      await CheckInAccess.deleteMany({ studentId: { $in: studentIds }, batchId, dateStr });
    } else if (studentId) {
      await CheckInAccess.findOneAndDelete({ studentId, batchId, dateStr });
    } else {
      return res.status(400).json({ message: 'studentId or studentIds is required.' });
    }

    // Emit real-time socket event so student dashboards update immediately without manual reload
    try {
      const { emitToUser, emitToBatch } = require('../sockets/socketHandlers');
      const payload = { hasAccess: false, batchId };
      emitToBatch(batchId, 'checkin-access-updated', payload);
      if (studentId) emitToUser(studentId, 'checkin-access-updated', payload);
      if (studentIds && Array.isArray(studentIds)) {
        studentIds.forEach(id => emitToUser(id, 'checkin-access-updated', payload));
      }
    } catch (socketErr) {
      console.warn('Socket emit error in revokeAccess:', socketErr.message);
    }

    res.status(200).json({ message: 'Access revoked successfully.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all access grants for today (optionally filtered by batchId)
// @route   GET /api/checkin-access/today
// @access  Private (Admin)
const getTodayAccess = async (req, res) => {
  try {
    const { batchId } = req.query;
    const dateStr = getISTDateStr();

    let query = { dateStr };
    if (batchId) {
      query.batchId = batchId;
    }

    const DailyWorkload = require('../models/DailyWorkload');
    const Attendance = require('../models/Attendance');
    const Enrollment = require('../models/Enrollment');
    const Task = require('../models/Task');
    const Submission = require('../models/Submission');

    const yesterdayDateStr = getPreviousDayISTDateStr();
    const todayStartIST = getISTDayStartUTC();

    const [grants, leaves, dailyWorkload, batchEnrollments, prevTasks] = await Promise.all([
      CheckInAccess.find(query)
        .populate('studentId', 'name email rollNumber')
        .populate('grantedBy', 'name')
        .populate('batchId', 'batchName')
        .lean(),
      Leave.find({
        status: 'approved',
        $or: [
          { startDate: dateStr },
          { 
            leaveType: 'multiple_days',
            startDate: { $lte: dateStr },
            endDate: { $gte: dateStr }
          }
        ]
      }).select('studentId reason leaveType startDate endDate').lean(),
      batchId ? DailyWorkload.findOne({ batchId, dateStr }).lean() : null,
      batchId ? Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean() : Promise.resolve([]),
      batchId
        ? Task.find({
            batchId,
            $expr: {
              $lt: [{ $ifNull: ['$scheduledAt', '$createdAt'] }, todayStartIST]
            }
          }).select('_id').lean()
        : Promise.resolve([])
    ]);

    const sIds = grants.map(g => g.studentId?._id || g.studentId).filter(Boolean);
    const enrolledIds = batchEnrollments.map(e => e.studentId).filter(Boolean);
    const eligibilityStudentIdSet = new Set([
      ...sIds.map(id => id.toString()),
      ...enrolledIds.map(id => id.toString())
    ]);
    const eligibilityStudentIds = [...eligibilityStudentIdSet];
    const prevTaskIds = prevTasks.map(t => t._id);

    const [rawAttendances, prevTaskSubmissions, yesterdayAttendances] = await Promise.all([
      Attendance.find({ studentId: { $in: sIds }, dateStr }).lean(),
      batchId && eligibilityStudentIds.length > 0 && prevTaskIds.length > 0
        ? Submission.find({
            studentId: { $in: eligibilityStudentIds },
            taskId: { $in: prevTaskIds },
            status: { $in: ['submitted', 'graded'] }
          }).select('studentId taskId status').lean()
        : Promise.resolve([]),
      batchId && eligibilityStudentIds.length > 0
        ? Attendance.find({
            studentId: { $in: eligibilityStudentIds },
            dateStr: yesterdayDateStr
          }).select('studentId status').lean()
        : Promise.resolve([])
    ]);

    const { eligibilityByStudent, summary: eligibilityStats } = evaluateBatchEligibility({
      studentIds: eligibilityStudentIds,
      prevTaskIds,
      submissions: prevTaskSubmissions,
      yesterdayAttendances
    });
    const eligibilitySummary = {
      ...eligibilityStats,
      yesterdayDateStr
    };
    const nowMs = Date.now();
    const attendances = rawAttendances.map(a => {
      if (a.isActive && a.lastCheckInTime) {
        const delta = Math.max(0, Math.floor((nowMs - new Date(a.lastCheckInTime).getTime()) / 1000));
        const liveOnsite = (a.onsiteDurationSeconds || 0) + (a.accessType === 'wfh' ? 0 : delta);
        const liveWfh = (a.wfhDurationSeconds || 0) + (a.accessType === 'wfh' ? delta : 0);
        return {
          ...a,
          onsiteDurationSeconds: liveOnsite,
          wfhDurationSeconds: liveWfh,
          sessionDurationSeconds: liveOnsite + liveWfh
        };
      }
      return a;
    });
    const attMap = {};
    attendances.forEach(a => {
      attMap[a.studentId.toString()] = a;
    });

    const leavesMap = {};
    leaves.forEach(l => {
      leavesMap[l.studentId.toString()] = l;
    });

    const enrichedGrants = grants.map(g => {
      const sId = g.studentId?._id ? g.studentId._id.toString() : g.studentId.toString();
      return {
        ...g,
        attendance: attMap[sId] || null,
        isLeave: Boolean(g.studentId && leavesMap[sId])
      };
    });

    res.status(200).json({
      grants: enrichedGrants,
      leaves,
      dailyWorkload,
      attendances,
      eligibilityByStudent,
      eligibilitySummary
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get student's own check-in access status for today
// @route   GET /api/checkin-access/my-status
// @access  Private (Student)
const getMyStatus = async (req, res) => {
  try {
    const Enrollment = require('../models/Enrollment');
    const DailyWorkload = require('../models/DailyWorkload');
    const dateStr = getISTDateStr();

    // Resolve student's enrolled batch(es) to check batch attendance policies
    const myEnrollments = await Enrollment.find({ studentId: req.user._id, status: 'approved' }).populate('batchId').lean();
    const activeEnrollments = myEnrollments.filter(e => e.batchId && e.batchId.status === 'Active');
    const primaryBatch = activeEnrollments.length > 0 ? activeEnrollments[0].batchId : (myEnrollments[0]?.batchId || null);

    let dailyWl = null;
    if (primaryBatch) {
      const bId = primaryBatch._id || primaryBatch;
      dailyWl = await DailyWorkload.findOne({ batchId: bId, dateStr }).lean();

      // Check auto WFH scheduled grant
      const currentISTTime = getISTTimeStr();
      if (dailyWl && dailyWl.autoWfhEnabled && !dailyWl.autoWfhGranted && currentISTTime >= (dailyWl.autoWfhTime || '19:00')) {
        await triggerAutoWfhGrant(bId, dateStr);
        dailyWl = await DailyWorkload.findOne({ batchId: bId, dateStr }).lean();
      }
    }

    const policy = {
      onsiteMinHours: dailyWl?.onsiteMinHours !== undefined ? Number(dailyWl.onsiteMinHours) : (primaryBatch?.onsiteMinHours !== undefined ? Number(primaryBatch.onsiteMinHours) : 2),
      onsiteMaxHours: dailyWl?.onsiteMaxHours !== undefined ? Number(dailyWl.onsiteMaxHours) : (primaryBatch?.onsiteMaxHours !== undefined ? Number(primaryBatch.onsiteMaxHours) : 10),
      wfhMinHours: dailyWl?.wfhMinHours !== undefined ? Number(dailyWl.wfhMinHours) : (primaryBatch?.wfhMinHours !== undefined ? Number(primaryBatch.wfhMinHours) : 3),
      wfhMaxHours: dailyWl?.wfhMaxHours !== undefined ? Number(dailyWl.wfhMaxHours) : (primaryBatch?.wfhMaxHours !== undefined ? Number(primaryBatch.wfhMaxHours) : 10),
      checkInTime: primaryBatch?.checkInTime || '09:00',
      checkOutTime: primaryBatch?.checkOutTime || '23:59',
      batchName: primaryBatch?.batchName || ''
    };

    const grants = await CheckInAccess.find({ studentId: req.user._id, dateStr });

    if (grants.length === 0) {
      return res.status(200).json({ 
        hasAccess: false,
        policy,
        minHours: policy.onsiteMinHours,
        maxHours: policy.onsiteMaxHours,
        dailyWorkload: {
          onsiteAllocated: Boolean(dailyWl?.onsiteAllocated),
          onsiteMinHours: dailyWl?.onsiteMinHours || policy.onsiteMinHours || 2,
          onsiteMaxHours: dailyWl?.onsiteMaxHours || policy.onsiteMaxHours || 10,
          wfhAllocated: Boolean(dailyWl?.wfhAllocated),
          wfhMinHours: dailyWl?.wfhMinHours || policy.wfhMinHours || 3,
          wfhMaxHours: dailyWl?.wfhMaxHours || policy.wfhMaxHours || 10,
          autoWfhEnabled: Boolean(dailyWl?.autoWfhEnabled),
          autoWfhTime: dailyWl?.autoWfhTime || '19:00',
          autoWfhGranted: Boolean(dailyWl?.autoWfhGranted)
        }
      });
    }

    const activeBatchIds = myEnrollments.map(e => e.batchId?._id?.toString() || e.batchId?.toString()).filter(Boolean);
    const activeGrants = grants.filter(g => g.batchId && activeBatchIds.includes(g.batchId.toString()));
    const primaryGrant = activeGrants.length > 0 
      ? (activeGrants.find(g => g.accessType === 'wfh') || activeGrants[0]) 
      : grants[0];

    const isWfh = primaryGrant.accessType === 'wfh';
    const effMin = primaryGrant.minHours || primaryGrant.workHours || (isWfh ? policy.wfhMinHours : policy.onsiteMinHours);
    const effMax = primaryGrant.maxHours || (isWfh ? policy.wfhMaxHours : policy.onsiteMaxHours);

    res.status(200).json({
      hasAccess: true,
      accessType: primaryGrant.accessType,
      workHours: primaryGrant.workHours || effMin,
      minHours: effMin,
      maxHours: effMax,
      policy,
      dailyWorkload: {
        onsiteAllocated: Boolean(dailyWl?.onsiteAllocated || primaryGrant.onsiteAllocated),
        onsiteMinHours: dailyWl?.onsiteMinHours || primaryGrant.onsiteMinHours || policy.onsiteMinHours || 2,
        onsiteMaxHours: dailyWl?.onsiteMaxHours || primaryGrant.onsiteMaxHours || policy.onsiteMaxHours || 10,
        wfhAllocated: Boolean(dailyWl?.wfhAllocated || primaryGrant.wfhAllocated || isWfh),
        wfhMinHours: dailyWl?.wfhMinHours || primaryGrant.wfhMinHours || policy.wfhMinHours || 3,
        wfhMaxHours: dailyWl?.wfhMaxHours || primaryGrant.wfhMaxHours || policy.wfhMaxHours || 10,
        autoWfhEnabled: Boolean(dailyWl?.autoWfhEnabled),
        autoWfhTime: dailyWl?.autoWfhTime || '19:00',
        autoWfhGranted: Boolean(dailyWl?.autoWfhGranted)
      },
      grantedAt: primaryGrant.createdAt,
      grants: grants.map(g => ({ 
        batchId: g.batchId, 
        accessType: g.accessType,
        workHours: g.workHours,
        minHours: g.minHours,
        maxHours: g.maxHours,
        onsiteAllocated: g.onsiteAllocated,
        onsiteMinHours: g.onsiteMinHours,
        onsiteMaxHours: g.onsiteMaxHours,
        wfhAllocated: g.wfhAllocated,
        wfhMinHours: g.wfhMinHours,
        wfhMaxHours: g.wfhMaxHours
      }))
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get daily workload allocation for a batch today
// @route   GET /api/checkin-access/workload
// @access  Private (Mentor/Admin)
const getDailyWorkload = async (req, res) => {
  try {
    const { batchId, dateStr: reqDateStr } = req.query;
    if (!batchId) {
      return res.status(400).json({ message: 'batchId is required.' });
    }
    const dateStr = reqDateStr || getISTDateStr();
    const DailyWorkload = require('../models/DailyWorkload');
    let workload = await DailyWorkload.findOne({ batchId, dateStr }).lean();
    if (!workload) {
      workload = {
        batchId,
        dateStr,
        onsiteAllocated: true,
        onsiteMinHours: 4,
        onsiteMaxHours: 10,
        wfhAllocated: true,
        wfhMinHours: 4,
        wfhMaxHours: 10,
        autoWfhEnabled: true,
        autoWfhTime: '19:00',
        autoWfhGranted: false,
        autoOnsiteCheckoutEnabled: true,
        autoOnsiteCheckoutTime: '17:00',
        autoOnsiteCheckoutDone: false
      };
    }
    res.status(200).json({ success: true, workload });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Save daily workload allocation for a batch today and synchronize attendance
// @route   POST /api/checkin-access/workload
// @access  Private (Mentor/Admin)
const saveDailyWorkload = async (req, res) => {
  try {
    const {
      batchId,
      dateStr: reqDateStr,
      onsiteAllocated,
      onsiteMinHours,
      onsiteMaxHours,
      wfhAllocated,
      wfhMinHours,
      wfhMaxHours,
      autoWfhEnabled,
      autoWfhTime,
      autoOnsiteCheckoutEnabled,
      autoOnsiteCheckoutTime,
      notes,
      saveOnly
    } = req.body;

    if (!batchId) {
      return res.status(400).json({ message: 'batchId is required.' });
    }

    const dateStr = reqDateStr || getISTDateStr();
    const DailyWorkload = require('../models/DailyWorkload');
    const Enrollment = require('../models/Enrollment');
    const Attendance = require('../models/Attendance');
    const Batch = require('../models/Batch');
    const { evaluateAttendanceRecord } = require('./attendanceController');

    const effOnsiteMin = (onsiteMinHours !== undefined && onsiteMinHours !== null && onsiteMinHours !== '')
      ? Number(onsiteMinHours) : 2;
    const effOnsiteMax = (onsiteMaxHours !== undefined && onsiteMaxHours !== null && onsiteMaxHours !== '')
      ? Number(onsiteMaxHours) : 10;
    const effWfhMin = (wfhMinHours !== undefined && wfhMinHours !== null && wfhMinHours !== '')
      ? Number(wfhMinHours) : 3;
    const effWfhMax = (wfhMaxHours !== undefined && wfhMaxHours !== null && wfhMaxHours !== '')
      ? Number(wfhMaxHours) : 10;

    const currentISTTime = getISTTimeStr();
    const effAutoOnsiteTime = autoOnsiteCheckoutTime || '17:00';
    const effAutoOnsiteEnabled = autoOnsiteCheckoutEnabled !== undefined ? Boolean(autoOnsiteCheckoutEnabled) : false;

    const workload = await DailyWorkload.findOneAndUpdate(
      { batchId, dateStr },
      {
        $set: {
          onsiteAllocated: Boolean(onsiteAllocated),
          onsiteMinHours: effOnsiteMin,
          onsiteMaxHours: effOnsiteMax,
          wfhAllocated: Boolean(wfhAllocated),
          wfhMinHours: effWfhMin,
          wfhMaxHours: effWfhMax,
          autoWfhEnabled: autoWfhEnabled !== undefined ? Boolean(autoWfhEnabled) : false,
          autoWfhTime: autoWfhTime || '19:00',
          autoOnsiteCheckoutEnabled: effAutoOnsiteEnabled,
          autoOnsiteCheckoutTime: effAutoOnsiteTime,
          ...(effAutoOnsiteEnabled && currentISTTime < effAutoOnsiteTime ? { autoOnsiteCheckoutDone: false } : {}),
          ...(saveOnly ? { restrictedToGranted: true } : {}),
          notes: notes || '',
          updatedBy: req.user._id
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    await Batch.findByIdAndUpdate(batchId, {
      $set: {
        autoWfhEnabled: autoWfhEnabled !== undefined ? Boolean(autoWfhEnabled) : false,
        autoWfhTime: autoWfhTime || '19:00',
        autoOnsiteCheckoutEnabled: effAutoOnsiteEnabled,
        autoOnsiteCheckoutTime: effAutoOnsiteTime
      }
    });

    // When saveOnly is true, do NOT bulk-grant WFH to unselected students automatically
    if (!saveOnly && autoWfhEnabled && currentISTTime >= (autoWfhTime || '19:00')) {
      await triggerAutoWfhGrant(batchId, dateStr);
    }

    // Check if auto-scheduled On-Site checkout & revoke should trigger immediately
    if (effAutoOnsiteEnabled && currentISTTime >= effAutoOnsiteTime) {
      await triggerAutoOnsiteCheckoutAndRevoke(batchId, dateStr);
    }

    // Sync only already-granted students when saveOnly is true
    const existingGrants = await CheckInAccess.find({ batchId, dateStr }).select('studentId').lean();
    const grantedIds = existingGrants.map(g => g.studentId);
    const studentIds = saveOnly
      ? grantedIds
      : (await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean()).map(e => e.studentId);

    // Update today's CheckInAccess records for granted students
    if (grantedIds.length > 0) {
      await CheckInAccess.updateMany(
        { batchId, dateStr, studentId: { $in: grantedIds } },
        {
          $set: {
            onsiteAllocated: Boolean(onsiteAllocated),
            onsiteMinHours: effOnsiteMin,
            onsiteMaxHours: effOnsiteMax,
            wfhAllocated: Boolean(wfhAllocated),
            wfhMinHours: effWfhMin,
            wfhMaxHours: effWfhMax
          }
        }
      );
    }

    // Update today's Attendance records and re-evaluate
    const attendances = studentIds.length > 0
      ? await Attendance.find({ studentId: { $in: studentIds }, dateStr })
      : [];

    for (const att of attendances) {
      att.onsiteAllocated = Boolean(onsiteAllocated || (att.onsiteDurationSeconds || 0) > 0);
      att.onsiteMinHours = effOnsiteMin;
      att.onsiteMaxHours = effOnsiteMax;
      att.wfhAllocated = Boolean(wfhAllocated || (att.wfhDurationSeconds || 0) > 0);
      att.wfhMinHours = effWfhMin;
      att.wfhMaxHours = effWfhMax;
      if (!att.isActive) {
        evaluateAttendanceRecord(att, 0);
      }
      await att.save();
    }

    // Emit real-time updates
    try {
      const { emitToBatch } = require('../sockets/socketHandlers');
      emitToBatch(batchId.toString(), 'daily-workload-updated', {
        batchId,
        dateStr,
        workload
      });
    } catch (e) {}

    res.status(200).json({
      success: true,
      message: saveOnly
        ? 'Daily workload rules saved. Use Activate Daily Workload on selected students to grant access.'
        : 'Daily workload policy updated and attendance re-evaluated successfully.',
      workload,
      updatedAttendancesCount: attendances.length
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Activate saved Daily Workload features (On-Site/WFH/Auto-Schedule) ONLY for selected students
// @route   POST /api/checkin-access/activate-workload
// @access  Private (Mentor/Admin)
const activateDailyWorkload = async (req, res) => {
  try {
    const {
      batchId,
      studentIds,
      onsiteAllocated,
      onsiteMinHours,
      onsiteMaxHours,
      wfhAllocated,
      wfhMinHours,
      wfhMaxHours,
      autoWfhEnabled,
      autoWfhTime,
      autoOnsiteCheckoutEnabled,
      autoOnsiteCheckoutTime,
      notes
    } = req.body;

    if (!batchId) {
      return res.status(400).json({ message: 'batchId is required.' });
    }
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ message: 'Please select at least one student to activate the Daily Workload.' });
    }

    const DailyWorkload = require('../models/DailyWorkload');
    const Attendance = require('../models/Attendance');
    const Batch = require('../models/Batch');
    const { evaluateAttendanceRecord } = require('./attendanceController');

    const dateStr = getISTDateStr();
    const existingDw = await DailyWorkload.findOne({ batchId, dateStr }).lean();

    const effOnsiteAllocated = onsiteAllocated !== undefined ? Boolean(onsiteAllocated) : Boolean(existingDw?.onsiteAllocated ?? true);
    const effWfhAllocated = wfhAllocated !== undefined ? Boolean(wfhAllocated) : Boolean(existingDw?.wfhAllocated ?? true);

    if (!effOnsiteAllocated && !effWfhAllocated) {
      return res.status(400).json({ message: 'At least one mode (On-Site or WFH) must be enabled in Daily Workload Record.' });
    }

    const effOnsiteMin = Number(onsiteMinHours ?? existingDw?.onsiteMinHours ?? 4) || 4;
    const effOnsiteMax = Number(onsiteMaxHours ?? existingDw?.onsiteMaxHours ?? 10) || 10;
    const effWfhMin = Number(wfhMinHours ?? existingDw?.wfhMinHours ?? 4) || 4;
    const effWfhMax = Number(wfhMaxHours ?? existingDw?.wfhMaxHours ?? 10) || 10;
    const effAutoWfhEnabled = autoWfhEnabled !== undefined ? Boolean(autoWfhEnabled) : Boolean(existingDw?.autoWfhEnabled ?? true);
    const effAutoWfhTime = autoWfhTime || existingDw?.autoWfhTime || '19:00';
    const effAutoOnsiteEnabled = autoOnsiteCheckoutEnabled !== undefined ? Boolean(autoOnsiteCheckoutEnabled) : Boolean(existingDw?.autoOnsiteCheckoutEnabled ?? true);
    const effAutoOnsiteTime = autoOnsiteCheckoutTime || existingDw?.autoOnsiteCheckoutTime || '17:00';
    const currentISTTime = getISTTimeStr();

    // Persist DailyWorkload benchmark & mark restrictedToGranted so auto-schedule only affects granted students
    const workload = await DailyWorkload.findOneAndUpdate(
      { batchId, dateStr },
      {
        $set: {
          onsiteAllocated: effOnsiteAllocated,
          onsiteMinHours: effOnsiteMin,
          onsiteMaxHours: effOnsiteMax,
          wfhAllocated: effWfhAllocated,
          wfhMinHours: effWfhMin,
          wfhMaxHours: effWfhMax,
          autoWfhEnabled: effAutoWfhEnabled,
          autoWfhTime: effAutoWfhTime,
          autoOnsiteCheckoutEnabled: effAutoOnsiteEnabled,
          autoOnsiteCheckoutTime: effAutoOnsiteTime,
          ...(effAutoOnsiteEnabled && currentISTTime < effAutoOnsiteTime ? { autoOnsiteCheckoutDone: false } : {}),
          restrictedToGranted: true,
          notes: notes !== undefined ? notes : (existingDw?.notes || ''),
          updatedBy: req.user._id
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    await Batch.findByIdAndUpdate(batchId, {
      $set: {
        autoWfhEnabled: effAutoWfhEnabled,
        autoWfhTime: effAutoWfhTime,
        autoOnsiteCheckoutEnabled: effAutoOnsiteEnabled,
        autoOnsiteCheckoutTime: effAutoOnsiteTime
      }
    });

    // Check today's approved leaves for selected students
    const approvedLeaves = await Leave.find({
      studentId: { $in: studentIds },
      status: 'approved',
      $or: [
        { startDate: dateStr },
        { leaveType: 'multiple_days', startDate: { $lte: dateStr }, endDate: { $gte: dateStr } }
      ]
    }).lean();
    const leaveStudentSet = new Set(approvedLeaves.map(l => l.studentId.toString()));

    const preferWfhNow = !effOnsiteAllocated ||
      (effWfhAllocated && ((effAutoWfhEnabled && currentISTTime >= effAutoWfhTime) || (effAutoOnsiteEnabled && currentISTTime >= effAutoOnsiteTime)));

    const activatedIds = [];
    let skippedLeaveCount = 0;

    for (const rawId of studentIds) {
      const sIdStr = rawId.toString();
      const isLeave = leaveStudentSet.has(sIdStr);

      if (isLeave && !effWfhAllocated) {
        skippedLeaveCount += 1;
        continue;
      }

      const studentOnsite = isLeave ? false : effOnsiteAllocated;
      const studentWfh = effWfhAllocated;
      const studentAccessType = (isLeave || preferWfhNow || !studentOnsite) ? 'wfh' : 'on-site';
      const activeMin = studentAccessType === 'wfh' ? effWfhMin : effOnsiteMin;
      const activeMax = studentAccessType === 'wfh' ? effWfhMax : effOnsiteMax;

      await CheckInAccess.findOneAndUpdate(
        { studentId: rawId, batchId, dateStr },
        {
          $set: {
            accessType: studentAccessType,
            grantedBy: req.user._id,
            workHours: activeMin,
            minHours: activeMin,
            maxHours: activeMax,
            onsiteAllocated: studentOnsite,
            onsiteMinHours: effOnsiteMin,
            onsiteMaxHours: effOnsiteMax,
            wfhAllocated: studentWfh,
            wfhMinHours: effWfhMin,
            wfhMaxHours: effWfhMax
          }
        },
        { upsert: true, returnDocument: 'after' }
      );
      activatedIds.push(rawId);
    }

    if (activatedIds.length === 0) {
      return res.status(400).json({
        message: 'All selected students are on approved leave today and WFH is not enabled in Daily Workload.'
      });
    }

    // Sync Attendance records strictly for activated selected students
    const attendances = await Attendance.find({ studentId: { $in: activatedIds }, dateStr });
    for (const att of attendances) {
      const isLeave = leaveStudentSet.has(att.studentId.toString());
      const studentOnsite = isLeave ? false : effOnsiteAllocated;
      const studentAccessType = (isLeave || preferWfhNow || !studentOnsite) ? 'wfh' : 'on-site';
      const activeMin = studentAccessType === 'wfh' ? effWfhMin : effOnsiteMin;
      const activeMax = studentAccessType === 'wfh' ? effWfhMax : effOnsiteMax;

      if (att.isActive && att.accessType && att.accessType !== studentAccessType) {
        const prevElapsed = att.lastCheckInTime
          ? Math.max(0, Math.floor((Date.now() - new Date(att.lastCheckInTime).getTime()) / 1000))
          : 0;
        att.isActive = false;
        att.checkOutTime = Date.now();
        evaluateAttendanceRecord(att, prevElapsed);
      }

      att.accessType = studentAccessType;
      att.workHours = activeMin;
      att.minRequiredHours = activeMin;
      att.maxValidHours = activeMax;
      att.onsiteAllocated = Boolean(studentOnsite || (att.onsiteDurationSeconds || 0) > 0);
      att.onsiteMinHours = effOnsiteMin;
      att.onsiteMaxHours = effOnsiteMax;
      att.wfhAllocated = Boolean(effWfhAllocated || (att.wfhDurationSeconds || 0) > 0);
      att.wfhMinHours = effWfhMin;
      att.wfhMaxHours = effWfhMax;
      if (!att.isActive) {
        evaluateAttendanceRecord(att, 0);
      }
      await att.save();
    }

    try {
      const { emitToUser, emitToBatch } = require('../sockets/socketHandlers');
      emitToBatch(batchId.toString(), 'daily-workload-updated', { batchId, dateStr, workload });
      activatedIds.forEach(id => {
        const isLeave = leaveStudentSet.has(id.toString());
        const sType = (isLeave || preferWfhNow || !effOnsiteAllocated) ? 'wfh' : 'on-site';
        emitToUser(id, 'checkin-access-updated', {
          hasAccess: true,
          accessType: sType,
          workHours: sType === 'wfh' ? effWfhMin : effOnsiteMin,
          minHours: sType === 'wfh' ? effWfhMin : effOnsiteMin,
          maxHours: sType === 'wfh' ? effWfhMax : effOnsiteMax,
          batchId
        });
      });
    } catch (socketErr) {
      console.warn('Socket emit error in activateDailyWorkload:', socketErr.message);
    }

    const msgParts = [`Daily Workload activated for ${activatedIds.length} selected student(s).`];
    if (skippedLeaveCount > 0) {
      msgParts.push(`${skippedLeaveCount} leave student(s) skipped (On-Site only).`);
    }

    res.status(200).json({
      success: true,
      message: msgParts.join(' '),
      activatedCount: activatedIds.length,
      skippedLeaveCount,
      workload
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  grantAccess,
  revokeAccess,
  getTodayAccess,
  getMyStatus,
  getDailyWorkload,
  saveDailyWorkload,
  activateDailyWorkload,
  triggerAutoWfhGrant,
  triggerAutoOnsiteCheckoutAndRevoke,
  getISTTimeStr,
  getISTDateStr
};
