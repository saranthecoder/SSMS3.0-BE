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

    const updateData = { 
      accessType: type, 
      grantedBy: req.user._id,
      workHours: effWorkHours,
      minHours: effMinHours,
      maxHours: effMaxHours
    };

    const promises = targetStudentIds.map(studentId => 
      CheckInAccess.findOneAndUpdate(
        { studentId, batchId, dateStr },
        updateData,
        { upsert: true, returnDocument: 'after' }
      )
    );

    await Promise.all(promises);

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

    const [grants, leaves] = await Promise.all([
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
      }).select('studentId reason leaveType startDate endDate').lean()
    ]);

    const leavesMap = {};
    leaves.forEach(l => {
      leavesMap[l.studentId.toString()] = l;
    });

    const enrichedGrants = grants.map(g => ({
      ...g,
      isLeave: Boolean(g.studentId && leavesMap[g.studentId._id ? g.studentId._id.toString() : g.studentId.toString()])
    }));

    res.status(200).json({ grants: enrichedGrants, leaves });
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
    const dateStr = getISTDateStr();

    // Resolve student's enrolled batch(es) to check batch attendance policies
    const myEnrollments = await Enrollment.find({ studentId: req.user._id, status: 'approved' }).populate('batchId').lean();
    const activeEnrollments = myEnrollments.filter(e => e.batchId && e.batchId.status === 'Active');
    const primaryBatch = activeEnrollments.length > 0 ? activeEnrollments[0].batchId : (myEnrollments[0]?.batchId || null);

    const policy = {
      onsiteMinHours: primaryBatch?.onsiteMinHours !== undefined ? Number(primaryBatch.onsiteMinHours) : 4,
      onsiteMaxHours: primaryBatch?.onsiteMaxHours !== undefined ? Number(primaryBatch.onsiteMaxHours) : 10,
      wfhMinHours: primaryBatch?.wfhMinHours !== undefined ? Number(primaryBatch.wfhMinHours) : 4,
      wfhMaxHours: primaryBatch?.wfhMaxHours !== undefined ? Number(primaryBatch.wfhMaxHours) : 10,
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
        maxHours: policy.onsiteMaxHours
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
      grantedAt: primaryGrant.createdAt,
      grants: grants.map(g => ({ 
        batchId: g.batchId, 
        accessType: g.accessType,
        workHours: g.workHours,
        minHours: g.minHours,
        maxHours: g.maxHours
      }))
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  grantAccess,
  revokeAccess,
  getTodayAccess,
  getMyStatus
};
