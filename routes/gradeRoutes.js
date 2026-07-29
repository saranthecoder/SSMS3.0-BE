const express = require('express');
const router = express.Router();
const {
  addGrade,
  updateGrade,
  getStudentGrades,
  getGradeBySubmission,
  autoEvaluateSubmissions
} = require('../controllers/gradeController');
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');

router.route('/')
  .post(protect, mentorOrAdmin, addGrade);

router.post('/auto-evaluate', protect, mentorOrAdmin, autoEvaluateSubmissions);

router.route('/:id')
  .put(protect, mentorOrAdmin, updateGrade);

router.route('/student/:studentId')
  .get(protect, getStudentGrades);

router.route('/submission/:submissionId')
  .get(protect, mentorOrAdmin, getGradeBySubmission);

module.exports = router;
