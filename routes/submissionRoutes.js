const express = require('express');
const router = express.Router();
const {
  submitTask,
  getSubmissions,
  getSubmissionById,
  requestResubmit
} = require('../controllers/submissionController');
const { protect, admin } = require('../middleware/authMiddleware');

router.route('/')
  .post(protect, submitTask)
  .get(protect, getSubmissions);

router.route('/:id')
  .get(protect, getSubmissionById);

router.route('/:id/resubmit')
  .put(protect, admin, requestResubmit);

module.exports = router;
