const express = require('express');
const router = express.Router();
const {
  createTask,
  getTasks,
  getTaskById,
  updateTask,
  deleteTask,
  getBatchTrackerData,
  toggleTaskSubmission,
  parseGoogleSheet,
  bulkCreateTasks
} = require('../controllers/taskController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.post('/parse-gsheet', protect, mentorOrAdmin, parseGoogleSheet);
router.post('/bulk', protect, mentorOrAdmin, bulkCreateTasks);

router.route('/tracker/toggle')
  .post(protect, mentorOrAdmin, toggleTaskSubmission);

router.route('/tracker/:batchId')
  .get(protect, getBatchTrackerData);

router.route('/')
  .get(protect, getTasks)
  .post(protect, mentorOrAdmin, createTask);

router.route('/:id')
  .get(protect, getTaskById)
  .put(protect, mentorOrAdmin, updateTask)
  .delete(protect, mentorOrAdmin, deleteTask);

module.exports = router;
