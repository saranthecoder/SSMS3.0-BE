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
const { protect, admin } = require('../middleware/authMiddleware');

router.post('/', protect, admin, allocateProblem);
router.get('/active', protect, getActiveProblems);
router.get('/history', protect, getStudentLeetcodeHistory);
router.post('/:id/submit', protect, submitSolution);
router.get('/batch/:batchId', protect, getBatchProblems);

router.route('/:id')
  .put(protect, admin, updateProblem)
  .delete(protect, admin, deleteProblem);

module.exports = router;
