const express = require('express');
const router = express.Router();
const { verifyStudent, getMonitorDashboardData, getAllocatedResources } = require('../controllers/publicController');
const { getPublicAttendanceSummary } = require('../controllers/attendanceController');
const { getBatches } = require('../controllers/batchController');

router.get('/verify/:rollNumber', verifyStudent);
router.get('/monitor', getMonitorDashboardData);
router.get('/allocated-resources', getAllocatedResources);
router.get('/attendance/summary', getPublicAttendanceSummary);
router.get('/batches', getBatches);

module.exports = router;
