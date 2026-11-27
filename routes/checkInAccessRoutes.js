const express = require('express');
const router = express.Router();
const {
  grantAccess,
  revokeAccess,
  getTodayAccess,
  getMyStatus,
  getDailyWorkload,
  saveDailyWorkload,
  activateDailyWorkload
} = require('../controllers/checkInAccessController');
const { protect, mentorOrAdmin } = require('../middleware/authMiddleware');

router.post('/grant', protect, mentorOrAdmin, grantAccess);
router.post('/revoke', protect, mentorOrAdmin, revokeAccess);
router.get('/today', protect, mentorOrAdmin, getTodayAccess);
router.get('/my-status', protect, getMyStatus);
router.get('/workload', protect, mentorOrAdmin, getDailyWorkload);
router.post('/workload', protect, mentorOrAdmin, saveDailyWorkload);
router.post('/activate-workload', protect, mentorOrAdmin, activateDailyWorkload);

module.exports = router;
