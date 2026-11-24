const express = require('express');
const router = express.Router();
const { verifyStudent, getMonitorDashboardData, getAllocatedResources } = require('../controllers/publicController');
const { getPublicAttendanceSummary } = require('../controllers/attendanceController');
const { getBatches } = require('../controllers/batchController');
const { verifyMonitorPin } = require('../controllers/monitorAccessController');

router.get('/verify/:rollNumber', verifyStudent);
router.get('/monitor', getMonitorDashboardData);
router.post('/monitor/verify-pin', verifyMonitorPin);
router.get('/allocated-resources', getAllocatedResources);
router.get('/attendance/summary', getPublicAttendanceSummary);
router.get('/batches', getBatches);

module.exports = router;
