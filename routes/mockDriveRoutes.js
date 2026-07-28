const express = require('express');
const router = express.Router();
const multer = require('multer');

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

const {
  parseMockDriveExcel,
  saveMockDrive,
  getMockDrivesByBatch,
  getStudentMockDriveScores,
  deleteMockDrive,
  updateStudentScoreManually,
  getMockDriveScores,
  updateMockDrive
} = require('../controllers/mockDriveController');
const { protect, admin } = require('../middleware/authMiddleware');

router.post('/parse-excel', protect, admin, upload.single('file'), parseMockDriveExcel);
router.post('/', protect, admin, saveMockDrive);
router.get('/batch/:batchId', protect, getMockDrivesByBatch);
router.get('/student/:studentId', protect, getStudentMockDriveScores);
router.get('/:id/scores', protect, admin, getMockDriveScores);
router.put('/:id', protect, admin, updateMockDrive);
router.delete('/:id', protect, admin, deleteMockDrive);
router.put('/:id/score', protect, admin, updateStudentScoreManually);

module.exports = router;
