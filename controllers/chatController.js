const mongoose = require('mongoose');
const Message = require('../models/Message');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Batch = require('../models/Batch');
const ChatGroup = require('../models/ChatGroup');
const Friendship = require('../models/Friendship');
const socketHandlers = require('../sockets/socketHandlers');
const { ensureBatchCommonGroup } = require('../utils/batchCommonGroup');

// Helper to sanitize message before JSON response
const formatPopulatedMessage = (msg) => {
  return {
    _id: msg._id,
    batchId: msg.batchId,
    groupId: msg.groupId,
    recipientId: msg.recipientId,
    text: msg.text || '',
    attachmentUrl: msg.attachmentUrl || '',
    attachmentName: msg.attachmentName || '',
    attachmentType: msg.attachmentType || '',
    isAnnouncement: Boolean(msg.isAnnouncement),
    announcementTitle: msg.announcementTitle || '',
    deliveredTo: msg.deliveredTo || [],
    readBy: msg.readBy || [],
    createdAt: msg.createdAt,
    senderId: typeof msg.senderId === 'object' && msg.senderId !== null ? {
      _id: msg.senderId._id,
      name: msg.senderId.name,
      role: msg.senderId.role,
      profileImage: msg.senderId.profileImage,
      equippedAvatar: msg.senderId.equippedAvatar
    } : { _id: msg.senderId }
  };
};

// @desc    Get contacts list with unread badges, last message preview, and online status
// @route   GET /api/chat/contacts
// @access  Private
const getChatContacts = async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.role;
    const { batchId } = req.query;

    let contacts = [];

    if (batchId && batchId !== 'all') {
      // Scoped directly to a specific batch
      if (!mongoose.Types.ObjectId.isValid(batchId)) {
        return res.status(400).json({ message: 'Invalid batchId' });
      }

      // 1. Approved enrolled students in this batch
      const enrollments = await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId?.toString()).filter(Boolean);

      // 2. Direct students with user.batchId === batchId
      const batchStudents = await User.find({ batchId, role: 'student' }).select('_id').lean();
      batchStudents.forEach(u => {
        const idStr = u._id.toString();
        if (!studentIds.includes(idStr)) studentIds.push(idStr);
      });

      // 3. Batch mentors
      const batchDoc = await Batch.findById(batchId).select('mentorId mentors').lean();
      const mentorIds = [];
      if (batchDoc?.mentorId) mentorIds.push(batchDoc.mentorId.toString());
      if (Array.isArray(batchDoc?.mentors)) {
        batchDoc.mentors.forEach(m => {
          if (m) mentorIds.push(m.toString());
        });
      }

      // 4. System admins (always reachable for faculty & students)
      const admins = await User.find({ role: 'admin' }).select('_id').lean();
      const adminIds = admins.map(a => a._id.toString());

      // If user is a student, also keep accepted friends reachable
      let acceptedFriendIds = [];
      if (role === 'student') {
        const acceptedFriendships = await Friendship.find({
          status: 'accepted',
          $or: [{ requester: userId }, { recipient: userId }]
        }).select('requester recipient').lean();
        acceptedFriendIds = acceptedFriendships.map(f =>
          f.requester.toString() === userId.toString() ? f.recipient.toString() : f.requester.toString()
        );
      }

      const scopedUserIds = [...new Set([
        ...studentIds,
        ...mentorIds,
        ...adminIds,
        ...acceptedFriendIds
      ])].filter(id => id && id !== userId.toString());

      contacts = await User.find({
        _id: { $in: scopedUserIds }
      })
        .select('name email rollNumber role profileImage equippedAvatar lastSeen updatedAt isProfileComplete')
        .lean();
    } else if (role === 'admin') {
      // Admins without batch filter can view all system users
      contacts = await User.find({ _id: { $ne: userId } })
        .select('name email rollNumber role profileImage equippedAvatar lastSeen updatedAt isProfileComplete')
        .lean();
    } else if (role === 'mentor') {
      // Mentors without specific batch filter: scope to students in ALL batches assigned to this mentor + admins
      const mentorBatches = await Batch.find({
        $or: [{ mentorId: userId }, { mentors: userId }]
      }).select('_id').lean();
      const bIds = mentorBatches.map(b => b._id);

      const enrollments = await Enrollment.find({ batchId: { $in: bIds }, status: 'approved' }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId?.toString()).filter(Boolean);

      const batchStudents = await User.find({ batchId: { $in: bIds }, role: 'student' }).select('_id').lean();
      batchStudents.forEach(u => {
        const idStr = u._id.toString();
        if (!studentIds.includes(idStr)) studentIds.push(idStr);
      });

      const admins = await User.find({ role: 'admin' }).select('_id').lean();
      const adminIds = admins.map(a => a._id.toString());

      const scopedUserIds = [...new Set([...studentIds, ...adminIds])].filter(id => id && id !== userId.toString());

      contacts = await User.find({
        _id: { $in: scopedUserIds }
      })
        .select('name email rollNumber role profileImage equippedAvatar lastSeen updatedAt isProfileComplete')
        .lean();
    } else {
      // Students without batch filter: can contact admins, their batch mentors, and ONLY accepted student friends
      const myEnrollments = await Enrollment.find({ studentId: userId, status: 'approved' }).select('batchId');
      const batchIds = myEnrollments.map(e => e.batchId).filter(Boolean);

      // Find mentors of those batches
      const batches = await Batch.find({ _id: { $in: batchIds } }).select('mentorId mentors');
      const mentorIds = [];
      batches.forEach(b => {
        if (b.mentorId) mentorIds.push(b.mentorId);
        if (Array.isArray(b.mentors)) mentorIds.push(...b.mentors);
      });

      // Find accepted student friends
      const acceptedFriendships = await Friendship.find({
        status: 'accepted',
        $or: [
          { requester: userId },
          { recipient: userId }
        ]
      }).select('requester recipient').lean();

      const acceptedFriendIds = acceptedFriendships.map(f => 
        f.requester.toString() === userId.toString() ? f.recipient : f.requester
      );

      contacts = await User.find({
        $or: [
          { role: 'admin' },
          { _id: { $in: mentorIds } },
          { _id: { $in: acceptedFriendIds } }
        ],
        _id: { $ne: userId }
      })
        .select('name email rollNumber role profileImage equippedAvatar lastSeen updatedAt isProfileComplete')
        .lean();
    }

    const activeUserIds = socketHandlers.getActiveUserIds ? socketHandlers.getActiveUserIds() : [];
    const contactIds = contacts.map(c => c._id);

    // High performance bulk aggregation: Eliminate O(N*2) queries into 2 constant-time index scans
    const [unreadAgg, lastMsgAgg] = await Promise.all([
      contactIds.length > 0 ? Message.aggregate([
        {
          $match: {
            recipientId: userId,
            senderId: { $in: contactIds },
            readBy: { $ne: userId }
          }
        },
        {
          $group: {
            _id: "$senderId",
            count: { $sum: 1 }
          }
        }
      ]) : Promise.resolve([]),
      contactIds.length > 0 ? Message.aggregate([
        {
          $match: {
            $or: [
              { senderId: userId, recipientId: { $in: contactIds } },
              { recipientId: userId, senderId: { $in: contactIds } }
            ]
          }
        },
        {
          $sort: { createdAt: -1 }
        },
        {
          $project: {
            text: 1,
            attachmentUrl: 1,
            attachmentType: 1,
            isAnnouncement: 1,
            createdAt: 1,
            senderId: 1,
            recipientId: 1,
            readBy: 1,
            otherUserId: {
              $cond: {
                if: { $eq: ["$senderId", userId] },
                then: "$recipientId",
                else: "$senderId"
              }
            }
          }
        },
        {
          $group: {
            _id: "$otherUserId",
            lastMessage: { $first: "$$ROOT" }
          }
        }
      ]) : Promise.resolve([])
    ]);

    const unreadMap = new Map();
    unreadAgg.forEach(u => unreadMap.set(u._id.toString(), u.count));

    const lastMsgMap = new Map();
    lastMsgAgg.forEach(m => lastMsgMap.set(m._id.toString(), m.lastMessage));

    const contactsWithMeta = contacts.map((contact) => {
      const cIdStr = contact._id.toString();
      const lastMsg = lastMsgMap.get(cIdStr) || null;
      const unreadCount = unreadMap.get(cIdStr) || 0;
      const isOnline = activeUserIds.includes(cIdStr);

      return {
        ...contact,
        isOnline,
        lastSeen: contact.lastSeen || contact.updatedAt || contact.createdAt || new Date(),
        lastMessage: lastMsg,
        unreadCount
      };
    });

    res.json(contactsWithMeta);
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
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const before = req.query.before;

    if (!mongoose.Types.ObjectId.isValid(otherUserId)) {
      return res.status(400).json({ message: 'Invalid target user ID' });
    }

    // Student-to-student verification: Must be accepted friends
    if (req.user.role === 'student') {
      const otherUser = await User.findById(otherUserId).select('role').lean();
      if (otherUser && otherUser.role === 'student') {
        const isAccepted = await Friendship.findOne({
          status: 'accepted',
          $or: [
            { requester: currentUserId, recipient: otherUserId },
            { requester: otherUserId, recipient: currentUserId }
          ]
        });
        if (!isAccepted) {
          return res.status(403).json({ 
            message: 'Students can only privately chat with accepted friends. Please send a friend request first.' 
          });
        }
      }
    }

    const query = {
      $or: [
        { senderId: currentUserId, recipientId: otherUserId },
        { senderId: otherUserId, recipientId: currentUserId }
      ]
    };

    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
      .populate('senderId', 'name email phone role profileImage equippedAvatar')
      .populate('recipientId', 'name email phone role profileImage equippedAvatar')
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    // Mark unread messages as read and delivered asynchronously in background
    Message.updateMany(
      { senderId: otherUserId, recipientId: currentUserId, readBy: { $ne: currentUserId } },
      { $addToSet: { readBy: currentUserId, deliveredTo: currentUserId } }
    ).then((unreadUpdated) => {
      if (unreadUpdated && unreadUpdated.modifiedCount > 0) {
        const roomName = [currentUserId.toString(), otherUserId.toString()].sort().join('_direct_');
        socketHandlers.emitToUser(otherUserId.toString(), 'messages-read', {
          readBy: currentUserId,
          recipientId: otherUserId,
          room: `direct_${roomName}`
        });
      }
    }).catch(err => console.warn('Background read mark error:', err.message));

    Message.updateMany(
      { recipientId: currentUserId, deliveredTo: { $ne: currentUserId } },
      { $addToSet: { deliveredTo: currentUserId } }
    ).catch(err => console.warn('Background delivered mark error:', err.message));

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all messages for an academic batch channel
// @route   GET /api/chat/batch/:batchId
// @access  Private
const getBatchMessages = async (req, res) => {
  try {
    const batchId = req.params.batchId;
    const userId = req.user._id;
    const role = req.user.role;
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const before = req.query.before;

    if (!mongoose.Types.ObjectId.isValid(batchId)) {
      return res.status(400).json({ message: 'Invalid batch ID' });
    }

    // Authorization check
    let isAuthorized = false;
    if (role === 'admin') {
      isAuthorized = true;
    } else if (role === 'mentor') {
      const batch = await Batch.findOne({
        _id: batchId,
        $or: [{ mentorId: userId }, { mentors: userId }]
      }).select('_id').lean();
      if (batch) isAuthorized = true;
    } else {
      const enrollment = await Enrollment.findOne({
        batchId,
        studentId: userId,
        status: 'approved'
      }).select('_id').lean();
      if (enrollment) isAuthorized = true;
    }

    if (!isAuthorized) {
      return res.status(403).json({ message: 'Not authorized to access this batch chat' });
    }

    const query = { batchId };
    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
      .populate('senderId', 'name email phone role profileImage equippedAvatar')
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    // Mark messages as read by current user asynchronously in background
    Message.updateMany(
      { batchId, readBy: { $ne: userId } },
      { $addToSet: { readBy: userId } }
    ).catch(err => console.warn('Background batch read error:', err.message));

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Send a message via HTTP REST (Direct, Batch, or Custom Group)
// @route   POST /api/chat/message
// @access  Private
const sendMessage = async (req, res) => {
  try {
    const {
      batchId,
      groupId,
      recipientId,
      text,
      attachmentUrl,
      attachmentName,
      attachmentType,
      isAnnouncement,
      announcementTitle
    } = req.body;

    const senderId = req.user._id;
    const senderRole = req.user.role;
    const senderName = req.user.name;
    const senderAvatar = req.user.equippedAvatar || req.user.profileImage || '/logo.png';

    if (!text?.trim() && !attachmentUrl) {
      return res.status(400).json({ message: 'Message text or attachment is required' });
    }

    if (!batchId && !groupId && !recipientId) {
      return res.status(400).json({ message: 'Target batchId, groupId, or recipientId is required' });
    }

    // Authorization checks
    if (batchId) {
      if (!mongoose.Types.ObjectId.isValid(batchId)) return res.status(400).json({ message: 'Invalid batchId' });
      let authorized = senderRole === 'admin';
      if (!authorized && senderRole === 'mentor') {
        const batch = await Batch.findOne({ _id: batchId, $or: [{ mentorId: senderId }, { mentors: senderId }] });
        if (batch) authorized = true;
      }
      if (!authorized) {
        const enr = await Enrollment.findOne({ batchId, studentId: senderId, status: 'approved' });
        if (enr) authorized = true;
      }
      if (!authorized) return res.status(403).json({ message: 'Not authorized to post to this batch' });
    }

    if (groupId) {
      if (!mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ message: 'Invalid groupId' });
      const group = await ChatGroup.findOne({ _id: groupId, 'members.user': senderId });
      if (!group && senderRole !== 'admin') {
        return res.status(403).json({ message: 'You are not a member of this chat group' });
      }
    }

    if (recipientId) {
      if (!mongoose.Types.ObjectId.isValid(recipientId)) return res.status(400).json({ message: 'Invalid recipientId' });
      if (recipientId.toString() === senderId.toString()) {
        return res.status(400).json({ message: 'Cannot message yourself' });
      }

      // Student-to-student verification: Must be accepted friends
      if (senderRole === 'student') {
        const recipientUser = await User.findById(recipientId).select('role name').lean();
        if (recipientUser && recipientUser.role === 'student') {
          const areFriends = await Friendship.findOne({
            status: 'accepted',
            $or: [
              { requester: senderId, recipient: recipientId },
              { requester: recipientId, recipient: senderId }
            ]
          });
          if (!areFriends) {
            return res.status(403).json({
              message: 'Students can only privately message accepted friends. Please send a friend request first.'
            });
          }
        }
      }
    }

    const announcementAllowed = Boolean(isAnnouncement) && (senderRole === 'admin' || senderRole === 'mentor');

    const activeIds = socketHandlers.getActiveUserIds ? socketHandlers.getActiveUserIds() : [];
    const isOnline = recipientId ? activeIds.includes(recipientId.toString()) : false;
    const initialDelivered = isOnline ? [recipientId] : (batchId || groupId ? [senderId] : []);

    const newMessage = await Message.create({
      batchId: batchId || null,
      groupId: groupId || null,
      senderId,
      recipientId: recipientId || null,
      text: text?.trim() || '',
      attachmentUrl: attachmentUrl || '',
      attachmentName: attachmentName || '',
      attachmentType: attachmentType || '',
      isAnnouncement: announcementAllowed,
      announcementTitle: announcementAllowed ? (announcementTitle || '') : '',
      deliveredTo: initialDelivered,
      readBy: [senderId]
    });

    const populated = await Message.findById(newMessage._id)
      .populate('senderId', 'name email phone role profileImage equippedAvatar')
      .populate('recipientId', 'name email phone role profileImage equippedAvatar');

    const formattedMsg = formatPopulatedMessage(populated);

    // Real-time broadcast
    if (batchId) {
      const room = `batch_${batchId}`;
      socketHandlers.publishCrossInstance('to_room', room, 'chat-message-received', formattedMsg);
      if (announcementAllowed) {
        const annPayload = { title: announcementTitle || 'New Announcement', text, senderName, batchId };
        socketHandlers.publishCrossInstance('to_room', room, 'announcement-broadcast', annPayload);
      }

      // Proactively notify all enrolled students & mentors of this batch
      Batch.findById(batchId).select('batchName mentorId mentors').lean().then(async (batchDoc) => {
        if (!batchDoc) return;
        const enrs = await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean();
        const targetIds = new Set();
        enrs.forEach(e => {
          if (e.studentId && e.studentId.toString() !== senderId.toString()) targetIds.add(e.studentId.toString());
        });
        if (batchDoc.mentorId && batchDoc.mentorId.toString() !== senderId.toString()) targetIds.add(batchDoc.mentorId.toString());
        if (Array.isArray(batchDoc.mentors)) {
          batchDoc.mentors.forEach(m => {
            if (m && m.toString() !== senderId.toString()) targetIds.add(m.toString());
          });
        }
        const notifPayload = {
          batchId,
          batchName: batchDoc.batchName,
          senderId,
          senderName,
          text: text?.trim() || (attachmentType ? `Sent an ${attachmentType}` : 'Sent a message'),
          message: formattedMsg
        };
        for (const uid of targetIds) {
          socketHandlers.emitToUser(uid, 'new-batch-message-notification', notifPayload);
        }
      }).catch(err => console.warn('Batch notification error:', err.message));

    } else if (groupId) {
      const room = `group_${groupId}`;
      socketHandlers.publishCrossInstance('to_room', room, 'chat-message-received', formattedMsg);

      // Proactively notify all group members
      ChatGroup.findById(groupId).select('name members').lean().then(groupDoc => {
        if (!groupDoc) return;
        const groupNotifPayload = {
          groupId,
          groupName: groupDoc.name,
          senderId,
          senderName,
          text: text?.trim() || (attachmentType ? `Sent an ${attachmentType}` : 'Sent a message'),
          message: formattedMsg
        };
        (groupDoc.members || []).forEach(m => {
          const uid = (m.user?._id || m.user)?.toString();
          if (uid && uid !== senderId.toString()) {
            socketHandlers.emitToUser(uid, 'new-group-message-notification', groupNotifPayload);
          }
        });
      }).catch(err => console.warn('Group notification error:', err.message));

    } else if (recipientId) {
      const roomName = [senderId.toString(), recipientId.toString()].sort().join('_direct_');
      const directRoom = `direct_${roomName}`;
      socketHandlers.publishCrossInstance('to_room', directRoom, 'chat-message-received', formattedMsg);

      const notifPayload = {
        senderId,
        senderName,
        senderAvatar,
        text: text?.trim() || (attachmentType ? `Sent an ${attachmentType}` : 'Sent a message'),
        message: formattedMsg
      };
      socketHandlers.emitToUser(recipientId.toString(), 'new-direct-message-notification', notifPayload);
    }

    res.status(201).json(formattedMsg);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Mark messages as read
// @route   POST /api/chat/read
// @access  Private
const markMessagesRead = async (req, res) => {
  try {
    const { otherUserId, batchId, groupId } = req.body;
    const userId = req.user._id;

    let filter = {};
    if (otherUserId) {
      filter = { senderId: otherUserId, recipientId: userId, readBy: { $ne: userId } };
    } else if (batchId) {
      filter = { batchId, readBy: { $ne: userId } };
    } else if (groupId) {
      filter = { groupId, readBy: { $ne: userId } };
    } else {
      return res.status(400).json({ message: 'Must specify otherUserId, batchId, or groupId' });
    }

    const result = await Message.updateMany(filter, { $addToSet: { readBy: userId } });

    if (otherUserId) {
      const roomName = [userId.toString(), otherUserId.toString()].sort().join('_direct_');
      socketHandlers.emitToUser(otherUserId.toString(), 'messages-read', {
        readBy: userId,
        room: `direct_${roomName}`
      });
    }

    res.json({ message: 'Messages marked as read', modifiedCount: result.modifiedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── CUSTOM GROUP CHAT CONTROLLERS ───

// @desc    Create a custom chat group
// @route   POST /api/chat/groups
// @access  Private
const createChatGroup = async (req, res) => {
  try {
    const { name, description, avatar, memberIds, batchId } = req.body;
    const creatorId = req.user._id;

    if (!name?.trim()) {
      return res.status(400).json({ message: 'Group name is required' });
    }

    const members = [{ user: creatorId, role: 'admin', joinedAt: new Date() }];

    if (Array.isArray(memberIds)) {
      memberIds.forEach(mId => {
        if (mId && mId.toString() !== creatorId.toString() && mongoose.Types.ObjectId.isValid(mId)) {
          members.push({ user: mId, role: 'member', joinedAt: new Date() });
        }
      });
    }

    const group = await ChatGroup.create({
      name: name.trim(),
      description: description?.trim() || '',
      avatar: avatar || '',
      creatorId,
      batchId: batchId || null,
      members
    });

    const populatedGroup = await ChatGroup.findById(group._id)
      .populate('members.user', 'name email role profileImage equippedAvatar')
      .populate('creatorId', 'name email');

    // Notify all members about group creation
    members.forEach(m => {
      socketHandlers.emitToUser(m.user.toString(), 'group-created', populatedGroup);
    });

    res.status(201).json(populatedGroup);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get user's chat groups
// @route   GET /api/chat/groups
// @access  Private
const getChatGroups = async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.role;
    const { batchId } = req.query;

    // Ensure relevant batch common groups exist and are synced
    if (batchId && batchId !== 'all' && mongoose.Types.ObjectId.isValid(batchId)) {
      await ensureBatchCommonGroup(batchId);
    } else {
      if (role === 'mentor') {
        const mentorBatches = await Batch.find({
          $or: [{ mentorId: userId }, { mentors: userId }]
        }).select('_id').lean();
        for (const b of mentorBatches) {
          await ensureBatchCommonGroup(b._id);
        }
      } else if (role === 'student') {
        const enrollments = await Enrollment.find({ studentId: userId, status: 'approved' }).select('batchId').lean();
        for (const e of enrollments) {
          if (e.batchId) await ensureBatchCommonGroup(e.batchId);
        }
      } else if (role === 'admin') {
        const activeBatches = await Batch.find({ status: 'Active' }).select('_id').lean();
        for (const b of activeBatches) {
          await ensureBatchCommonGroup(b._id);
        }
      }
    }

    let query = {};
    if (batchId && batchId !== 'all' && mongoose.Types.ObjectId.isValid(batchId)) {
      if (role === 'admin') {
        query = {
          $or: [
            { batchId },
            { batchId: null }
          ],
          isArchived: false
        };
      } else {
        query = {
          $or: [
            { batchId, 'members.user': userId },
            { batchId: null, 'members.user': userId }
          ],
          isArchived: false
        };
      }
    } else {
      query = role === 'admin'
        ? { isArchived: false }
        : { 'members.user': userId, isArchived: false };
    }

    const groups = await ChatGroup.find(query)
      .populate('creatorId', 'name email role')
      .populate('batchId', 'batchName panelName status')
      .sort({ isBatchCommon: -1, updatedAt: -1 })
      .lean();

    const groupIds = groups.map(g => g._id);

    // High performance bulk aggregation: Eliminate N*2 queries
    const [unreadAgg, lastMsgAgg] = await Promise.all([
      groupIds.length > 0 ? Message.aggregate([
        {
          $match: {
            groupId: { $in: groupIds },
            readBy: { $ne: userId }
          }
        },
        {
          $group: {
            _id: "$groupId",
            count: { $sum: 1 }
          }
        }
      ]) : Promise.resolve([]),
      groupIds.length > 0 ? Message.aggregate([
        {
          $match: {
            groupId: { $in: groupIds }
          }
        },
        {
          $sort: { createdAt: -1 }
        },
        {
          $group: {
            _id: "$groupId",
            lastMessage: { $first: "$$ROOT" }
          }
        }
      ]) : Promise.resolve([])
    ]);

    const unreadMap = new Map();
    unreadAgg.forEach(u => unreadMap.set(u._id.toString(), u.count));

    const lastMsgMap = new Map();
    lastMsgAgg.forEach(m => lastMsgMap.set(m._id.toString(), m.lastMessage));

    const groupsWithMeta = groups.map((grp) => {
      const gIdStr = grp._id.toString();
      return {
        ...grp,
        isBatchCommon: Boolean(grp.isBatchCommon),
        memberCount: grp.members?.length || 0,
        lastMessage: lastMsgMap.get(gIdStr) || null,
        unreadCount: unreadMap.get(gIdStr) || 0
      };
    });

    // Ensure common batch groups are pinned at the top
    groupsWithMeta.sort((a, b) => {
      if (a.isBatchCommon && !b.isBatchCommon) return -1;
      if (!a.isBatchCommon && b.isBatchCommon) return 1;
      const timeA = a.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt).getTime() : new Date(a.updatedAt).getTime();
      const timeB = b.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt).getTime() : new Date(b.updatedAt).getTime();
      return timeB - timeA;
    });

    res.json(groupsWithMeta);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get group details
// @route   GET /api/chat/groups/:id
// @access  Private
const getChatGroupDetails = async (req, res) => {
  try {
    const groupId = req.params.id;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ message: 'Invalid group ID' });
    }

    const group = await ChatGroup.findById(groupId)
      .populate('members.user', 'name email role profileImage equippedAvatar lastSeen')
      .populate('creatorId', 'name email');

    if (!group) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    const isMember = group.members.some(m => m.user._id.toString() === userId.toString());
    if (!isMember && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied: You are not a member of this group' });
    }

    res.json(group);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get group messages
// @route   GET /api/chat/groups/:id/messages
// @access  Private
const getGroupMessages = async (req, res) => {
  try {
    const groupId = req.params.id;
    const userId = req.user._id;
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const before = req.query.before;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ message: 'Invalid group ID' });
    }

    const group = await ChatGroup.findById(groupId).select('members').lean();
    if (!group) return res.status(404).json({ message: 'Group not found' });

    const isMember = group.members.some(m => m.user.toString() === userId.toString());
    if (!isMember && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied: You are not a member of this group' });
    }

    const query = { groupId };
    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
      .populate('senderId', 'name email phone role profileImage equippedAvatar')
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    // Mark group messages as read asynchronously in background
    Message.updateMany(
      { groupId, readBy: { $ne: userId } },
      { $addToSet: { readBy: userId } }
    ).catch(err => console.warn('Background group read error:', err.message));

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update chat group
// @route   PUT /api/chat/groups/:id
// @access  Private
const updateChatGroup = async (req, res) => {
  try {
    const groupId = req.params.id;
    const userId = req.user._id;
    const { name, description, avatar } = req.body;

    const group = await ChatGroup.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Group not found' });

    const isAdmin = req.user.role === 'admin' ||
      group.members.some(m => m.user.toString() === userId.toString() && m.role === 'admin');

    if (!isAdmin) {
      return res.status(403).json({ message: 'Only group admins can edit group details' });
    }

    if (name) group.name = name.trim();
    if (description !== undefined) group.description = description.trim();
    if (avatar !== undefined) group.avatar = avatar;

    await group.save();
    res.json(group);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Add members to chat group
// @route   POST /api/chat/groups/:id/members
// @access  Private
const addGroupMembers = async (req, res) => {
  try {
    const groupId = req.params.id;
    const userId = req.user._id;
    const { userIds } = req.body;

    if (!Array.isArray(userIds) || !userIds.length) {
      return res.status(400).json({ message: 'userIds array is required' });
    }

    const group = await ChatGroup.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Group not found' });

    const isAdmin = req.user.role === 'admin' ||
      group.members.some(m => m.user.toString() === userId.toString() && m.role === 'admin');

    if (!isAdmin) {
      return res.status(403).json({ message: 'Only group admins can add members' });
    }

    const existingUserIds = new Set(group.members.map(m => m.user.toString()));
    const addedMembers = [];

    userIds.forEach(uId => {
      if (mongoose.Types.ObjectId.isValid(uId) && !existingUserIds.has(uId.toString())) {
        group.members.push({ user: uId, role: 'member', joinedAt: new Date() });
        existingUserIds.add(uId.toString());
        addedMembers.push(uId);
      }
    });

    await group.save();

    const updated = await ChatGroup.findById(groupId)
      .populate('members.user', 'name email role profileImage equippedAvatar');

    // Notify new members
    addedMembers.forEach(uId => {
      socketHandlers.emitToUser(uId.toString(), 'group-added', updated);
    });

    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Remove member from chat group
// @route   DELETE /api/chat/groups/:id/members/:userId
// @access  Private
const removeGroupMember = async (req, res) => {
  try {
    const groupId = req.params.id;
    const targetUserId = req.params.userId;
    const currentUserId = req.user._id;

    const group = await ChatGroup.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Group not found' });

    const isGroupAdmin = req.user.role === 'admin' ||
      group.members.some(m => m.user.toString() === currentUserId.toString() && m.role === 'admin');

    if (!isGroupAdmin) {
      return res.status(403).json({ message: 'Only group admins can remove members' });
    }

    group.members = group.members.filter(m => m.user.toString() !== targetUserId.toString());
    await group.save();

    socketHandlers.emitToUser(targetUserId, 'group-removed', { groupId });

    res.json({ message: 'Member removed from group' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Leave chat group
// @route   POST /api/chat/groups/:id/leave
// @access  Private
const leaveChatGroup = async (req, res) => {
  try {
    const groupId = req.params.id;
    const userId = req.user._id;

    const group = await ChatGroup.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Group not found' });

    if (group.isBatchCommon) {
      return res.status(400).json({ message: 'Cannot leave an official batch classroom group' });
    }

    group.members = group.members.filter(m => m.user.toString() !== userId.toString());

    // If no members remain, archive group
    if (group.members.length === 0) {
      group.isArchived = true;
    }

    await group.save();
    res.json({ message: 'Successfully left the group' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get student friends list, incoming/outgoing requests, and batch peers for chat
// @route   GET /api/chat/friends-data
// @access  Private
const getStudentFriendsAndRequests = async (req, res) => {
  try {
    const studentId = req.user._id;

    // 1. Get all friendships for current student
    const friendships = await Friendship.find({
      $or: [{ requester: studentId }, { recipient: studentId }]
    })
      .populate('requester', 'name email rollNumber profileImage equippedAvatar lastSeen role')
      .populate('recipient', 'name email rollNumber profileImage equippedAvatar lastSeen role')
      .lean();

    const friends = [];
    const pendingIncoming = [];
    const pendingOutgoing = [];
    const friendOrPendingIds = new Set([studentId.toString()]);

    friendships.forEach(f => {
      const other = f.requester._id.toString() === studentId.toString() ? f.recipient : f.requester;
      if (!other) return;
      friendOrPendingIds.add(other._id.toString());

      if (f.status === 'accepted') {
        friends.push({
          friendshipId: f._id,
          friend: other
        });
      } else if (f.status === 'pending') {
        if (f.recipient._id.toString() === studentId.toString()) {
          pendingIncoming.push({
            requestId: f._id,
            user: other,
            createdAt: f.createdAt
          });
        } else {
          pendingOutgoing.push({
            requestId: f._id,
            user: other,
            createdAt: f.createdAt
          });
        }
      }
    });

    // 2. Discover peers in the same batches who are not friends or pending yet
    const myEnrollments = await Enrollment.find({ studentId, status: 'approved' }).select('batchId');
    const batchIds = myEnrollments.map(e => e.batchId).filter(Boolean);

    const peerEnrollments = await Enrollment.find({
      batchId: { $in: batchIds },
      status: 'approved',
      studentId: { $nin: Array.from(friendOrPendingIds) }
    }).select('studentId').lean();

    const peerIds = [...new Set(peerEnrollments.map(e => e.studentId.toString()))];

    const discoverPeers = await User.find({
      _id: { $in: peerIds },
      role: 'student'
    })
      .select('name email rollNumber profileImage equippedAvatar lastSeen')
      .limit(30)
      .lean();

    res.json({
      friends,
      pendingIncoming,
      pendingOutgoing,
      discoverPeers
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Send friend request to another student
// @route   POST /api/chat/friend-request/send
// @access  Private
const sendChatFriendRequest = async (req, res) => {
  try {
    const studentId = req.user._id;
    const { targetUserId, rollNumber } = req.body;

    let recipient = null;
    if (targetUserId && mongoose.Types.ObjectId.isValid(targetUserId)) {
      recipient = await User.findById(targetUserId);
    } else if (rollNumber) {
      recipient = await User.findOne({ rollNumber: { $regex: new RegExp(`^${rollNumber.trim()}$`, 'i') } });
    }

    if (!recipient) {
      return res.status(404).json({ message: 'Student not found.' });
    }

    if (recipient._id.toString() === studentId.toString()) {
      return res.status(400).json({ message: 'You cannot add yourself as a friend.' });
    }

    if (recipient.role !== 'student') {
      return res.status(400).json({ message: 'Friend requests are for students only.' });
    }

    const existing = await Friendship.findOne({
      $or: [
        { requester: studentId, recipient: recipient._id },
        { requester: recipient._id, recipient: studentId }
      ]
    });

    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(400).json({ message: 'You are already friends!' });
      }
      if (existing.status === 'pending') {
        if (existing.requester.toString() === studentId.toString()) {
          return res.status(400).json({ message: 'Friend request already sent.' });
        } else {
          // Accept it directly
          existing.status = 'accepted';
          await existing.save();
          socketHandlers.emitToUser(recipient._id.toString(), 'friend-request-accepted', {
            friend: { _id: studentId, name: req.user.name, avatar: req.user.profileImage }
          });
          return res.json({ success: true, message: 'Friend request accepted!' });
        }
      }
      existing.requester = studentId;
      existing.recipient = recipient._id;
      existing.status = 'pending';
      await existing.save();
    } else {
      await Friendship.create({
        requester: studentId,
        recipient: recipient._id,
        status: 'pending'
      });
    }

    // Real-time notification to recipient
    socketHandlers.emitToUser(recipient._id.toString(), 'friend-request-received', {
      requester: {
        _id: studentId,
        name: req.user.name,
        rollNumber: req.user.rollNumber,
        avatar: req.user.equippedAvatar || req.user.profileImage
      }
    });

    res.status(201).json({ success: true, message: `Friend request sent to ${recipient.name}!` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Accept or reject friend request
// @route   POST /api/chat/friend-request/respond
// @access  Private
const respondChatFriendRequest = async (req, res) => {
  try {
    const studentId = req.user._id;
    const { requestId, action } = req.body;

    if (!requestId || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action.' });
    }

    const friendship = await Friendship.findById(requestId);
    if (!friendship) {
      return res.status(404).json({ message: 'Friend request not found.' });
    }

    if (friendship.recipient.toString() !== studentId.toString()) {
      return res.status(403).json({ message: 'Unauthorized.' });
    }

    if (action === 'accept') {
      friendship.status = 'accepted';
      await friendship.save();

      // Notify the requester in real-time
      socketHandlers.emitToUser(friendship.requester.toString(), 'friend-request-accepted', {
        friend: { _id: studentId, name: req.user.name, avatar: req.user.profileImage }
      });

      return res.json({ success: true, message: 'Friend request accepted! You can now chat and share coins.' });
    } else {
      friendship.status = 'rejected';
      await friendship.save();
      return res.json({ success: true, message: 'Friend request declined.' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
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
};
