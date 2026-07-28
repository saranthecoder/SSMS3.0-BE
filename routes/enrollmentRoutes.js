const express = require('express');
const router = express.Router();
const {
  requestEnrollment,
  getPendingEnrollments,
  approveEnrollment,
  rejectEnrollment,
  getMyEnrollments,
  getBatchEnrollments,
  removeEnrollment
} = require('../controllers/enrollmentController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.post('/request', protect, requestEnrollment);
router.get('/pending', protect, admin, getPendingEnrollments);
router.get('/my', protect, getMyEnrollments);
router.get('/batch/:batchId', protect, mentorOrAdmin, getBatchEnrollments);
router.put('/:id/approve', protect, admin, approveEnrollment);
router.put('/:id/reject', protect, admin, rejectEnrollment);
router.delete('/:id', protect, admin, removeEnrollment);

module.exports = router;
