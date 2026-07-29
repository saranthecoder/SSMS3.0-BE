const express = require('express');
const router = express.Router();
const { protect, admin, mentorOrAdmin } = require('../middleware/authMiddleware');
const {
  getNotes,
  addNote,
  editNote,
  deleteNote
} = require('../controllers/noteController');

router.route('/')
  .get(protect, getNotes)
  .post(protect, mentorOrAdmin, addNote);

router.route('/:id')
  .put(protect, mentorOrAdmin, editNote)
  .delete(protect, mentorOrAdmin, deleteNote);

module.exports = router;
