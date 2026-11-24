const express = require('express');
const router = express.Router();
const {
  getChatContacts,
  getDirectMessages,
  getBatchMessages,
  sendMessage,
  markMessagesRead,
  createChatGroup,
  getChatGroups,
  getChatGroupDetails,
  getGroupMessages,
  updateChatGroup,
  addGroupMembers,
  removeGroupMember,
  leaveChatGroup,
  getStudentFriendsAndRequests,
  sendChatFriendRequest,
  respondChatFriendRequest
} = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

// Contacts
router.get('/contacts', protect, getChatContacts);

// Student Friends & Friendship Requests (Required for student-to-student private chat & coin sharing)
router.get('/friends-data', protect, getStudentFriendsAndRequests);
router.post('/friend-request/send', protect, sendChatFriendRequest);
router.post('/friend-request/respond', protect, respondChatFriendRequest);

// Messages: Direct & Batch
router.get('/direct/:otherUserId', protect, getDirectMessages);
router.get('/batch/:batchId', protect, getBatchMessages);

// Message sending & Read receipt endpoints
router.post('/message', protect, sendMessage);
router.post('/send', protect, sendMessage);
router.post('/read', protect, markMessagesRead);

// Custom Chat Groups
router.route('/groups')
  .get(protect, getChatGroups)
  .post(protect, createChatGroup);

router.route('/groups/:id')
  .get(protect, getChatGroupDetails)
  .put(protect, updateChatGroup);

router.get('/groups/:id/messages', protect, getGroupMessages);
router.post('/groups/:id/members', protect, addGroupMembers);
router.delete('/groups/:id/members/:userId', protect, removeGroupMember);
router.post('/groups/:id/leave', protect, leaveChatGroup);

// Backward compatibility with /api/chat/:batchId
router.get('/:batchId', protect, getBatchMessages);

module.exports = router;
