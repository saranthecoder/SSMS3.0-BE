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
  bulkUploadStudents
} = require('../controllers/batchController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.route('/')
  .get(protect, getBatches)
  .post(protect, mentorOrAdmin, createBatch);

router.route('/template/excel')
  .get(protect, admin, downloadStudentTemplate);

router.route('/:id')
  .get(protect, getBatchById)
  .put(protect, admin, updateBatch)
  .delete(protect, admin, deleteBatch);

router.route('/:id/report')
  .get(protect, mentorOrAdmin, getBatchReport);

router.route('/:id/bulk-upload-students')
  .post(protect, admin, bulkUploadStudents);

module.exports = router;
