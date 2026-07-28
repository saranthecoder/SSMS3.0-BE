const express = require('express');
const router = express.Router();
const { getBatchMessages, getDirectMessages, getChatContacts } = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

router.get('/contacts', protect, getChatContacts);
router.get('/direct/:otherUserId', protect, getDirectMessages);
router.get('/batch/:batchId', protect, getBatchMessages);
router.get('/:batchId', protect, getBatchMessages);

module.exports = router;
