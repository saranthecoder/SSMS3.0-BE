const express = require('express');
const router = express.Router();
const {
  createBatch,
  getBatches,
  getBatchById,
  updateBatch,
  deleteBatch,
  getBatchReport,
  downloadStudentTemplate,
  fetchGoogleSheetData,
  bulkUploadStudents
} = require('../controllers/batchController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.route('/')
  .get(protect, getBatches)
  .post(protect, mentorOrAdmin, createBatch);

router.route('/template/excel')
  .get(protect, mentorOrAdmin, downloadStudentTemplate);

router.route('/fetch-google-sheet')
  .post(protect, mentorOrAdmin, fetchGoogleSheetData);

router.route('/:id')
  .get(protect, getBatchById)
  .put(protect, admin, updateBatch)
  .delete(protect, admin, deleteBatch);

router.route('/:id/report')
  .get(protect, mentorOrAdmin, getBatchReport);

router.route('/:id/bulk-upload-students')
  .post(protect, mentorOrAdmin, bulkUploadStudents);

module.exports = router;
