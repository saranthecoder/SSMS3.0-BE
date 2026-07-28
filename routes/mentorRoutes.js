const express = require('express');
const router = express.Router();
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');
const {
  createMentor,
  getMentors,
  updateMentor,
  deleteMentor
} = require('../controllers/mentorController');

router.use(protect);

router.route('/')
  .post(admin, createMentor)
  .get(mentorOrAdmin, getMentors);

router.route('/:id')
  .put(admin, updateMentor)
  .delete(admin, deleteMentor);

module.exports = router;
