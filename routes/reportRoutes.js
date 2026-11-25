const express = require('express');
const router = express.Router();
const {
  getMyReports,
  getReportById,
  generateReports,
  getBatchReports,
  updateReportFeedback,
  releaseReports,
  revokeReport,
  getReportJobStatus,
  getReportConfig,
  updateReportConfig,
  getAdminReportsOverview
} = require('../controllers/reportController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.get('/my', protect, getMyReports);
router.get('/config', protect, admin, getReportConfig);
router.put('/config', protect, admin, updateReportConfig);
router.get('/admin/overview', protect, admin, getAdminReportsOverview);
router.post('/generate', protect, mentorOrAdmin, generateReports);
router.post('/release', protect, mentorOrAdmin, releaseReports);
router.get('/jobs/:jobId', protect, mentorOrAdmin, getReportJobStatus);
router.get('/batch/:batchId', protect, mentorOrAdmin, getBatchReports);
router.put('/:id/feedback', protect, mentorOrAdmin, updateReportFeedback);
router.post('/:id/revoke', protect, admin, revokeReport);
router.get('/:id', protect, getReportById);

module.exports = router;
