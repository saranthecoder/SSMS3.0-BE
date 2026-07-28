const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
const {
  getNotes,
  addNote,
  editNote,
  deleteNote
} = require('../controllers/noteController');

router.route('/')
  .get(protect, getNotes)
  .post(protect, admin, addNote);

router.route('/:id')
  .put(protect, admin, editNote)
  .delete(protect, admin, deleteNote);

module.exports = router;
