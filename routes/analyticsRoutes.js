const express = require('express');
const router = express.Router();
const {
  getStudentAnalytics,
  getAdminDashboardStats,
  getBatchAnalytics,
  getLeaderboard,
  getActivityLogs
} = require('../controllers/analyticsController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.get('/student/:studentId', protect, getStudentAnalytics);
router.get('/dashboard', protect, mentorOrAdmin, getAdminDashboardStats);
router.get('/batch/:batchId', protect, mentorOrAdmin, getBatchAnalytics);
router.get('/leaderboard/:batchId', protect, getLeaderboard);
router.get('/activity-logs', protect, mentorOrAdmin, getActivityLogs);

module.exports = router;
