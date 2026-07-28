const express = require('express');
const router = express.Router();
const {
  addGrade,
  updateGrade,
  getStudentGrades,
  getGradeBySubmission,
  autoEvaluateSubmissions
} = require('../controllers/gradeController');
const { protect, admin } = require('../middleware/authMiddleware');

router.route('/')
  .post(protect, admin, addGrade);

router.post('/auto-evaluate', protect, admin, autoEvaluateSubmissions);

router.route('/:id')
  .put(protect, admin, updateGrade);

router.route('/student/:studentId')
  .get(protect, getStudentGrades);

router.route('/submission/:submissionId')
  .get(protect, admin, getGradeBySubmission);

module.exports = router;
