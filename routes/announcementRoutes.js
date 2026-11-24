const express = require('express');
const router = express.Router();
const {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  markAnnouncementAsRead,
  getUnreadAnnouncementCount
} = require('../controllers/announcementController');
const { protect, mentorOrAdmin } = require('../middleware/authMiddleware');

router.route('/')
  .get(protect, getAnnouncements)
  .post(protect, mentorOrAdmin, createAnnouncement);

router.get('/unread-count', protect, getUnreadAnnouncementCount);

router.route('/:id')
  .put(protect, mentorOrAdmin, updateAnnouncement)
  .delete(protect, mentorOrAdmin, deleteAnnouncement);

router.post('/:id/read', protect, markAnnouncementAsRead);

module.exports = router;
