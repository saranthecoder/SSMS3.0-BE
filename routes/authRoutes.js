const express = require('express');
const router = express.Router();
const {
  loginUser,
  registerUser,
  logoutUser,
  getUserProfile,
  updateUserProfile,
  getAllStudents,
  adminUpdateStudentPassword,
  adminUpdateStudentProfile,
} = require('../controllers/authController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/logout', logoutUser);
router.get('/profile', protect, getUserProfile);
router.put('/profile', protect, updateUserProfile);
router.get('/students', protect, mentorOrAdmin, getAllStudents);
router.put('/students/:id/password', protect, admin, adminUpdateStudentPassword);
router.put('/students/:id', protect, admin, adminUpdateStudentProfile);

module.exports = router;
