const Enrollment = require('../models/Enrollment');

const studentBatchCache = new Map();
const TTL_MS = 60000; // 60 seconds

const getApprovedBatchIds = async (studentId) => {
  if (!studentId) return [];
  const sId = studentId.toString();
  const now = Date.now();
  const cached = studentBatchCache.get(sId);
  if (cached && (now - cached.timestamp) < TTL_MS) {
    return cached.batchIds;
  }

  const enrollments = await Enrollment.find({ studentId: sId, status: 'approved' })
    .select('batchId')
    .lean();
  const batchIds = enrollments.map(e => e.batchId).filter(Boolean);

  if (studentBatchCache.size > 2000) {
    const oldestKey = studentBatchCache.keys().next().value;
    studentBatchCache.delete(oldestKey);
  }

  studentBatchCache.set(sId, { batchIds, timestamp: now });
  return batchIds;
};

const invalidateStudentBatch = (studentId) => {
  if (studentId) studentBatchCache.delete(studentId.toString());
};

module.exports = {
  getApprovedBatchIds,
  invalidateStudentBatch
};
