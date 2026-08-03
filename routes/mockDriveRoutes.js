const express = require('express');
const router = express.Router();
const multer = require('multer');

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

const {
  parseMockDriveExcel,
  parseMockDriveGoogleSheet,
  saveMockDrive,
  getMockDrivesByBatch,
  getStudentMockDriveScores,
  deleteMockDrive,
  updateStudentScoreManually,
  getMockDriveScores,
  updateMockDrive
} = require('../controllers/mockDriveController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.post('/parse-excel', protect, mentorOrAdmin, upload.single('file'), parseMockDriveExcel);
router.post('/parse-google-sheet', protect, mentorOrAdmin, parseMockDriveGoogleSheet);
router.post('/', protect, mentorOrAdmin, saveMockDrive);
router.get('/batch/:batchId', protect, getMockDrivesByBatch);
router.get('/student/:studentId', protect, getStudentMockDriveScores);
router.get('/:id/scores', protect, mentorOrAdmin, getMockDriveScores);
router.put('/:id', protect, mentorOrAdmin, updateMockDrive);
router.delete('/:id', protect, mentorOrAdmin, deleteMockDrive);
router.put('/:id/score', protect, mentorOrAdmin, updateStudentScoreManually);

module.exports = router;
