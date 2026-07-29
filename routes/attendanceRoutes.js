const express = require('express');
const router = express.Router();
const {
  checkIn,
  checkOut,
  getAllAttendance,
  getMyAttendance,
  getAttendanceSummary,
  getMyAttendanceSummary,
  adminCheckOutStudent,
  adminCheckOutAll,
  getActiveCount,
  updateAttendanceRecord
} = require('../controllers/attendanceController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.get('/active-count', protect, getActiveCount);
router.post('/checkin', protect, checkIn);
router.post('/checkout/:id', protect, checkOut);
router.get('/', protect, mentorOrAdmin, getAllAttendance);
router.get('/summary', protect, getAttendanceSummary);
router.get('/my', protect, getMyAttendance);
router.get('/my-summary', protect, getMyAttendanceSummary);
router.put('/admin/checkout/:id', protect, mentorOrAdmin, adminCheckOutStudent);
router.put('/admin/checkout-all', protect, mentorOrAdmin, adminCheckOutAll);
router.put('/:id', protect, mentorOrAdmin, updateAttendanceRecord);

module.exports = router;
