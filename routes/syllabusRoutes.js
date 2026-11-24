const express = require('express');
const router = express.Router();
const { protect, mentorOrAdmin } = require('../middleware/authMiddleware');
const {
  createSyllabusEntry,
  getSyllabusEntries,
  getSyllabusById,
  updateSyllabusEntry,
  deleteSyllabusEntry
} = require('../controllers/syllabusController');

router.route('/')
  .post(protect, mentorOrAdmin, createSyllabusEntry)
  .get(protect, getSyllabusEntries);

router.route('/:id')
  .get(protect, getSyllabusById)
  .put(protect, mentorOrAdmin, updateSyllabusEntry)
  .delete(protect, mentorOrAdmin, deleteSyllabusEntry);

module.exports = router;
