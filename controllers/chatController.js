const Message = require('../models/Message');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');

// @desc    Get all messages for a batch
// @route   GET /api/chat/batch/:batchId
// @access  Private
const getBatchMessages = async (req, res) => {
  try {
    const messages = await Message.find({ batchId: req.params.batchId })
      .populate('senderId', 'name email phone role profileImage equippedAvatar')
      .sort('createdAt');
      
    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get direct 1-on-1 messages between logged in user & target user
// @route   GET /api/chat/direct/:otherUserId
// @access  Private
const getDirectMessages = async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const otherUserId = req.params.otherUserId;

    const messages = await Message.find({
      $or: [
        { senderId: currentUserId, recipientId: otherUserId },
        { senderId: otherUserId, recipientId: currentUserId }
      ]
    })
      .populate('senderId', 'name email phone role profileImage equippedAvatar')
      .populate('recipientId', 'name email phone role profileImage equippedAvatar')
      .sort('createdAt');

    // Mark unread messages as read
    await Message.updateMany(
      { senderId: otherUserId, recipientId: currentUserId, readBy: { $ne: currentUserId } },
      { $addToSet: { readBy: currentUserId } }
    );

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get contacts list with unread badges & last message preview for WhatsApp sidebar
// @route   GET /api/chat/contacts
// @access  Private
const getChatContacts = async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.role;

    let contacts = [];

    if (role === 'admin' || role === 'mentor') {
      contacts = await User.find({ _id: { $ne: userId } })
        .select('name email role profileImage equippedAvatar lastSeen')
        .lean();
    } else {
      const myEnrollments = await Enrollment.find({ studentId: userId, status: 'approved' }).populate('batchId');
      const mentorIds = myEnrollments.map(e => e.batchId?.mentorId).filter(Boolean);
      
      contacts = await User.find({
        $or: [
          { role: 'admin' },
          { _id: { $in: mentorIds } }
        ],
        _id: { $ne: userId }
      })
        .select('name email role profileImage equippedAvatar lastSeen')
        .lean();
    }

    const socketHandlers = require('../sockets/socketHandlers');
    const activeUserIds = socketHandlers.getActiveUserIds ? socketHandlers.getActiveUserIds() : [];

    const contactsWithMeta = await Promise.all(contacts.map(async (contact) => {
      const lastMsg = await Message.findOne({
        $or: [
          { senderId: userId, recipientId: contact._id },
          { senderId: contact._id, recipientId: userId }
        ]
      })
        .sort('-createdAt')
        .select('text attachmentUrl attachmentType isAnnouncement createdAt senderId readBy')
        .lean();

      const unreadCount = await Message.countDocuments({
        senderId: contact._id,
        recipientId: userId,
        readBy: { $ne: userId }
      });

      const isOnline = activeUserIds.includes(contact._id.toString());

      return {
        ...contact,
        isOnline,
        lastSeen: contact.lastSeen || null,
        lastMessage: lastMsg || null,
        unreadCount
      };
    }));

    res.json(contactsWithMeta);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getBatchMessages,
  getDirectMessages,
  getChatContacts
};
