const CheckInAccess = require('../models/CheckInAccess');
const Leave = require('../models/Leave');

const getISTDateStr = (date = new Date()) => {
  const istTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const year = istTime.getFullYear();
  const month = String(istTime.getMonth() + 1).padStart(2, '0');
  const day = String(istTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
    const [grants, leaves, dailyWorkload] = await Promise.all([
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
      batchId ? DailyWorkload.findOne({ batchId, dateStr }).lean() : null
    ]);

    const sIds = grants.map(g => g.studentId?._id || g.studentId).filter(Boolean);
    const attendances = await Attendance.find({ studentId: { $in: sIds }, dateStr }).lean();
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

    res.status(200).json({ grants: enrichedGrants, leaves, dailyWorkload, attendances });
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
          wfhMaxHours: dailyWl?.wfhMaxHours || policy.wfhMaxHours || 10
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
        wfhMaxHours: dailyWl?.wfhMaxHours || primaryGrant.wfhMaxHours || policy.wfhMaxHours || 10
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
        onsiteAllocated: false,
        onsiteMinHours: 2,
        onsiteMaxHours: 10,
        wfhAllocated: false,
        wfhMinHours: 3,
        wfhMaxHours: 10
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
      wfhMaxHours
    } = req.body;

    if (!batchId) {
      return res.status(400).json({ message: 'batchId is required.' });
    }

    const dateStr = reqDateStr || getISTDateStr();
    const DailyWorkload = require('../models/DailyWorkload');
    const Enrollment = require('../models/Enrollment');
    const Attendance = require('../models/Attendance');
    const { evaluateAttendanceRecord } = require('./attendanceController');

    const effOnsiteMin = (onsiteMinHours !== undefined && onsiteMinHours !== null && onsiteMinHours !== '')
      ? Number(onsiteMinHours) : 2;
    const effOnsiteMax = (onsiteMaxHours !== undefined && onsiteMaxHours !== null && onsiteMaxHours !== '')
      ? Number(onsiteMaxHours) : 10;
    const effWfhMin = (wfhMinHours !== undefined && wfhMinHours !== null && wfhMinHours !== '')
      ? Number(wfhMinHours) : 3;
    const effWfhMax = (wfhMaxHours !== undefined && wfhMaxHours !== null && wfhMaxHours !== '')
      ? Number(wfhMaxHours) : 10;

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
          updatedBy: req.user._id
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    // Sync all approved students of this batch
    const enrollments = await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean();
    const studentIds = enrollments.map(e => e.studentId);

    // Update today's CheckInAccess records for this batch
    await CheckInAccess.updateMany(
      { batchId, dateStr, studentId: { $in: studentIds } },
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

    // Update today's Attendance records and re-evaluate
    const attendances = await Attendance.find({
      studentId: { $in: studentIds },
      dateStr
    });

    for (const att of attendances) {
      if (onsiteAllocated || (att.onsiteDurationSeconds || 0) > 0) {
        att.onsiteAllocated = true;
        att.onsiteMinHours = effOnsiteMin;
        att.onsiteMaxHours = effOnsiteMax;
      }
      if (wfhAllocated || (att.wfhDurationSeconds || 0) > 0) {
        att.wfhAllocated = true;
        att.wfhMinHours = effWfhMin;
        att.wfhMaxHours = effWfhMax;
      }
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
      message: 'Daily workload policy updated and attendance re-evaluated successfully.',
      workload,
      updatedAttendancesCount: attendances.length
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
  saveDailyWorkload
};
