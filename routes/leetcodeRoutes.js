const express = require('express');
const router = express.allocateProblem ? express : express.Router();
const {
  allocateProblem,
  getActiveProblems,
  submitSolution,
  getBatchProblems,
  getStudentLeetcodeHistory,
  updateProblem,
  deleteProblem
} = require('../controllers/leetcodeController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.post('/', protect, mentorOrAdmin, allocateProblem);
router.get('/active', protect, getActiveProblems);
router.get('/history', protect, getStudentLeetcodeHistory);
router.post('/:id/submit', protect, submitSolution);
router.get('/batch/:batchId', protect, getBatchProblems);

router.route('/:id')
  .put(protect, mentorOrAdmin, updateProblem)
  .delete(protect, mentorOrAdmin, deleteProblem);

module.exports = router;
