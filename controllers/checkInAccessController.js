const CheckInAccess = require('../models/CheckInAccess');

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

    const updateData = { accessType: type, grantedBy: req.user._id };
    if (workHours !== undefined && workHours !== null && workHours !== '') {
      updateData.workHours = Number(workHours);
      updateData.minHours = Number(workHours);
    }
    if (minHours !== undefined && minHours !== null && minHours !== '') {
      updateData.minHours = Number(minHours);
    }
    if (maxHours !== undefined && maxHours !== null && maxHours !== '') {
      updateData.maxHours = Number(maxHours);
    }

    const promises = studentIds.map(studentId => 
      CheckInAccess.findOneAndUpdate(
        { studentId, batchId, dateStr },
        updateData,
        { upsert: true, returnDocument: 'after' }
      )
    );

    await Promise.all(promises);

    res.status(200).json({ message: 'Access granted successfully.' });
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

    const grants = await CheckInAccess.find(query)
      .populate('studentId', 'name email rollNumber')
      .populate('grantedBy', 'name')
      .populate('batchId', 'batchName');

    res.status(200).json(grants);
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

    const grants = await CheckInAccess.find({ studentId: req.user._id, dateStr });

    if (grants.length === 0) {
      return res.status(200).json({ hasAccess: false });
    }

    // Resolve student's enrolled batch(es) to check if they have WFH for their batch
    const myEnrollments = await Enrollment.find({ studentId: req.user._id, status: 'approved' });
    const activeBatchIds = myEnrollments.map(e => e.batchId.toString());

    // Filter grants that match their active batches and prioritize wfh
    const activeGrants = grants.filter(g => g.batchId && activeBatchIds.includes(g.batchId.toString()));
    const primaryGrant = activeGrants.length > 0 
      ? (activeGrants.find(g => g.accessType === 'wfh') || activeGrants[0]) 
      : grants[0];

    res.status(200).json({
      hasAccess: true,
      accessType: primaryGrant.accessType,
      workHours: primaryGrant.workHours || primaryGrant.minHours || null,
      minHours: primaryGrant.minHours || null,
      maxHours: primaryGrant.maxHours || null,
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
