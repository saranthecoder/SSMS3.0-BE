const express = require('express');
const router = express.Router();
const {
  applyLeave,
  getMyLeaves,
  getAllLeaves,
  updateLeaveStatus,
  getActiveLeaveStatus
} = require('../controllers/leaveController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.post('/', protect, applyLeave);
router.get('/my', protect, getMyLeaves);
router.get('/active-status', protect, getActiveLeaveStatus);
router.get('/', protect, mentorOrAdmin, getAllLeaves);
router.put('/:id/status', protect, mentorOrAdmin, updateLeaveStatus);

module.exports = router;
