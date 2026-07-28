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
const { protect, admin } = require('../middleware/authMiddleware');

router.get('/active-count', protect, getActiveCount);
router.post('/checkin', protect, checkIn);
router.post('/checkout/:id', protect, checkOut);
router.get('/', protect, admin, getAllAttendance);
router.get('/summary', protect, getAttendanceSummary);
router.get('/my', protect, getMyAttendance);
router.get('/my-summary', protect, getMyAttendanceSummary);
router.put('/admin/checkout/:id', protect, admin, adminCheckOutStudent);
router.put('/admin/checkout-all', protect, admin, adminCheckOutAll);
router.put('/:id', protect, admin, updateAttendanceRecord);

module.exports = router;
