const mongoose = require('mongoose');
const User = require('../models/User');
const Friendship = require('../models/Friendship');
const Enrollment = require('../models/Enrollment');
const GamificationEvent = require('../models/GamificationEvent');
const { addRewardHistory } = require('../utils/gamification');
const socketHandlers = require('../sockets/socketHandlers');

// @desc    Get student's friends list, pending requests, batch peers, and coins info
// @route   GET /api/gamification/friends
// @access  Private
const getFriends = async (req, res) => {
  try {
    const studentId = req.user._id;

    // Fetch friendships where this user is requester or recipient
    const friendships = await Friendship.find({
      $or: [
        { requester: studentId },
        { recipient: studentId }
      ]
    })
      .populate('requester', 'name rollNumber email profileImage equippedAvatar level league coins lastSeen role')
      .populate('recipient', 'name rollNumber email profileImage equippedAvatar level league coins lastSeen role')
      .lean();

    const friends = [];
    const pendingIncoming = [];
    const pendingOutgoing = [];
    const friendOrPendingIds = new Set([studentId.toString()]);

    friendships.forEach(f => {
      const otherUser = f.requester?._id?.toString() === studentId.toString() ? f.recipient : f.requester;
      if (!otherUser) return;
      friendOrPendingIds.add(otherUser._id.toString());
      
      if (f.status === 'accepted') {
        friends.push({
          friendshipId: f._id,
          friendId: otherUser._id,
          name: otherUser.name,
          rollNumber: otherUser.rollNumber,
          email: otherUser.email,
          avatar: otherUser.equippedAvatar || otherUser.profileImage,
          level: otherUser.level || 1,
          league: otherUser.league || 'Bronze',
          coins: otherUser.coins || 0,
          lastSeen: otherUser.lastSeen,
          createdAt: f.createdAt
        });
      } else if (f.status === 'pending') {
        const item = {
          requestId: f._id,
          friendId: otherUser._id,
          name: otherUser.name,
          rollNumber: otherUser.rollNumber,
          email: otherUser.email,
          avatar: otherUser.equippedAvatar || otherUser.profileImage,
          createdAt: f.createdAt
        };
        if (f.recipient?._id?.toString() === studentId.toString()) {
          pendingIncoming.push(item);
        } else {
          pendingOutgoing.push(item);
        }
      }
    });

    // Discover peers from shared batches who aren't friends or pending
    let discoverPeers = [];
    try {
      const myEnrollments = await Enrollment.find({ studentId, status: 'approved' }).select('batchId').lean();
      const batchIds = myEnrollments.map(e => e.batchId).filter(Boolean);

      if (batchIds.length > 0) {
        const peerEnrollments = await Enrollment.find({
          batchId: { $in: batchIds },
          status: 'approved',
          studentId: { $nin: Array.from(friendOrPendingIds) }
        }).select('studentId').lean();

        const peerIds = [...new Set(peerEnrollments.map(e => e.studentId.toString()))];

        discoverPeers = await User.find({
          _id: { $in: peerIds },
          role: 'student'
        })
          .select('name rollNumber email profileImage equippedAvatar level league')
          .limit(20)
          .lean();
      }
    } catch (peerErr) {
      console.warn('Error fetching discover peers:', peerErr.message);
    }

    // Cooldown check (7 days)
    const now = new Date();
    const oneWeekInMs = 7 * 24 * 60 * 60 * 1000;
    const lastShared = req.user.lastSharedCoinsDate ? new Date(req.user.lastSharedCoinsDate) : null;
    let canShareCoins = true;
    let cooldownDaysRemaining = 0;

    if (lastShared && (now - lastShared) < oneWeekInMs) {
      canShareCoins = false;
      const cooldownRemaining = oneWeekInMs - (now - lastShared);
      cooldownDaysRemaining = Math.ceil(cooldownRemaining / (24 * 60 * 60 * 1000));
    }

    res.json({
      friends,
      pendingIncoming,
      pendingOutgoing,
      discoverPeers,
      userCoins: req.user.coins || 0,
      lastSharedCoinsDate: req.user.lastSharedCoinsDate,
      canShareCoins,
      cooldownDaysRemaining
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Send a friend request via Roll Number or User ID
// @route   POST /api/gamification/friends/request
// @access  Private
const sendFriendRequest = async (req, res) => {
  try {
    const { rollNumber, targetUserId } = req.body;
    let recipient = null;

    if (targetUserId && mongoose.Types.ObjectId.isValid(targetUserId)) {
      recipient = await User.findById(targetUserId);
    } else if (rollNumber) {
      const targetRoll = rollNumber.toString().trim();
      recipient = await User.findOne({ rollNumber: { $regex: new RegExp(`^${targetRoll}$`, 'i') } });
    }

    if (!recipient) {
      return res.status(404).json({ message: 'No student found with that identifier.' });
    }

    if (recipient._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot add yourself as a friend.' });
    }

    // Check existing friendships or requests
    const existing = await Friendship.findOne({
      $or: [
        { requester: req.user._id, recipient: recipient._id },
        { requester: recipient._id, recipient: req.user._id }
      ]
    });

    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(400).json({ message: `You are already connected with ${recipient.name}.` });
      }
      if (existing.status === 'pending') {
        if (existing.requester.toString() === req.user._id.toString()) {
          return res.status(400).json({ message: 'Friend request already sent.' });
        } else {
          // Accept it directly if the other party already requested
          existing.status = 'accepted';
          await existing.save();

          // Real-time notification
          socketHandlers.emitToUser(recipient._id.toString(), 'friend-request-accepted', {
            friend: {
              _id: req.user._id,
              name: req.user.name,
              avatar: req.user.equippedAvatar || req.user.profileImage
            }
          });

          return res.json({ success: true, message: `Connected with ${recipient.name}! Private chat and coin sharing unlocked.` });
        }
      }
      // If rejected, reopen as pending
      existing.requester = req.user._id;
      existing.recipient = recipient._id;
      existing.status = 'pending';
      await existing.save();
    } else {
      await Friendship.create({
        requester: req.user._id,
        recipient: recipient._id,
        status: 'pending'
      });
    }

    // Real-time socket notification to recipient
    socketHandlers.emitToUser(recipient._id.toString(), 'friend-request-received', {
      requester: {
        _id: req.user._id,
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

// @desc    Accept or reject a friend request
// @route   POST /api/gamification/friends/respond
// @access  Private
const respondFriendRequest = async (req, res) => {
  try {
    const { requestId, action } = req.body; // action: 'accept' or 'reject'
    if (!requestId || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action parameter.' });
    }

    const friendship = await Friendship.findById(requestId);
    if (!friendship) {
      return res.status(404).json({ message: 'Friend request not found.' });
    }

    if (friendship.recipient.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Unauthorized response.' });
    }

    if (action === 'accept') {
      friendship.status = 'accepted';
      await friendship.save();

      // Real-time notification to requester
      socketHandlers.emitToUser(friendship.requester.toString(), 'friend-request-accepted', {
        friend: {
          _id: req.user._id,
          name: req.user.name,
          avatar: req.user.equippedAvatar || req.user.profileImage
        }
      });

      return res.json({ success: true, message: 'Friend request accepted! Private chat and coin sharing unlocked.' });
    } else {
      friendship.status = 'rejected';
      await friendship.save();
      return res.json({ success: true, message: 'Friend request declined.' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Remove an accepted friend or cancel an outgoing request
// @route   DELETE /api/gamification/friends/:id
// @access  Private
const removeFriend = async (req, res) => {
  try {
    const targetId = req.params.id;
    const currentUserId = req.user._id;

    // Could be friendshipId or friend's userId
    const friendship = await Friendship.findOne({
      $or: [
        { _id: mongoose.Types.ObjectId.isValid(targetId) ? targetId : null },
        { requester: currentUserId, recipient: targetId },
        { requester: targetId, recipient: currentUserId }
      ]
    });

    if (!friendship) {
      return res.status(404).json({ message: 'Connection not found.' });
    }

    // Verify current user is part of this friendship
    if (friendship.requester.toString() !== currentUserId.toString() &&
        friendship.recipient.toString() !== currentUserId.toString()) {
      return res.status(403).json({ message: 'Unauthorized.' });
    }

    const otherUserId = friendship.requester.toString() === currentUserId.toString()
      ? friendship.recipient.toString()
      : friendship.requester.toString();

    await Friendship.findByIdAndDelete(friendship._id);

    // Notify other user in real-time
    socketHandlers.emitToUser(otherUserId, 'friend-removed', {
      friendId: currentUserId
    });

    res.json({ success: true, message: 'Connection removed successfully.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Search students by name or roll number to connect
// @route   GET /api/gamification/friends/search
// @access  Private
const searchStudents = async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const q = (req.query.q || '').trim();

    if (!q || q.length < 2) {
      return res.json({ students: [] });
    }

    const regex = new RegExp(q, 'i');
    const students = await User.find({
      _id: { $ne: currentUserId },
      role: 'student',
      $or: [
        { name: { $regex: regex } },
        { rollNumber: { $regex: regex } }
      ]
    })
      .select('name rollNumber email profileImage equippedAvatar level league')
      .limit(15)
      .lean();

    if (students.length === 0) {
      return res.json({ students: [] });
    }

    const studentIds = students.map(s => s._id);

    // Fetch existing relationships
    const friendships = await Friendship.find({
      $or: [
        { requester: currentUserId, recipient: { $in: studentIds } },
        { requester: { $in: studentIds }, recipient: currentUserId }
      ]
    }).lean();

    const relationshipMap = new Map();
    friendships.forEach(f => {
      const otherId = f.requester.toString() === currentUserId.toString()
        ? f.recipient.toString()
        : f.requester.toString();
      
      if (f.status === 'accepted') {
        relationshipMap.set(otherId, 'friends');
      } else if (f.status === 'pending') {
        if (f.requester.toString() === currentUserId.toString()) {
          relationshipMap.set(otherId, 'pending_outgoing');
        } else {
          relationshipMap.set(otherId, 'pending_incoming');
        }
      }
    });

    const results = students.map(s => ({
      ...s,
      relationship: relationshipMap.get(s._id.toString()) || 'none'
    }));

    res.json({ students: results });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Share coins with an accepted friend
// @route   POST /api/gamification/friends/share-coins
// @access  Private
const shareCoins = async (req, res) => {
  try {
    const { friendId, amount } = req.body;
    const coinsToShare = Number(amount);

    if (!friendId || isNaN(coinsToShare) || coinsToShare <= 0) {
      return res.status(400).json({ message: 'Please specify a valid positive coins amount.' });
    }

    // STRICT CHECK: Verify friendship exists and is accepted
    const friendship = await Friendship.findOne({
      status: 'accepted',
      $or: [
        { requester: req.user._id, recipient: friendId },
        { requester: friendId, recipient: req.user._id }
      ]
    });

    if (!friendship) {
      return res.status(400).json({ message: 'You can only share coins with connected friends. Please send a friend request first!' });
    }

    const sender = await User.findById(req.user._id);
    const recipient = await User.findById(friendId);
    if (!sender || !recipient) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (sender.coins < coinsToShare) {
      return res.status(400).json({ message: `Insufficient coins. You only have ${sender.coins} coins.` });
    }

    // Enforce 1-week cooldown limit
    const now = new Date();
    const oneWeekInMs = 7 * 24 * 60 * 60 * 1000;
    if (sender.lastSharedCoinsDate && (now - sender.lastSharedCoinsDate) < oneWeekInMs) {
      const cooldownRemaining = oneWeekInMs - (now - sender.lastSharedCoinsDate);
      const remainingDays = Math.ceil(cooldownRemaining / (24 * 60 * 60 * 1000));
      return res.status(400).json({ 
        message: `Sharing limit reached. You can share coins again in ${remainingDays} day(s).` 
      });
    }

    // Execute coin transfer
    sender.coins -= coinsToShare;
    sender.lastSharedCoinsDate = now;
    addRewardHistory(sender, 'gift_sent', -coinsToShare, `Shared coins with ${recipient.name}`);

    recipient.coins += coinsToShare;
    addRewardHistory(recipient, 'gift_received', coinsToShare, `Received coins from ${sender.name}`);

    await sender.save();
    await recipient.save();

    // Log gamification events
    await GamificationEvent.create([
      {
        userId: sender._id,
        eventType: 'coins_spent',
        coinsChange: -coinsToShare,
        reason: `Shared coins with ${recipient.name} (${recipient.rollNumber})`,
        metadata: { recipientId: recipient._id }
      },
      {
        userId: recipient._id,
        eventType: 'coins_gained',
        coinsChange: coinsToShare,
        reason: `Received shared coins from ${sender.name} (${sender.rollNumber})`,
        metadata: { senderId: sender._id }
      }
    ]);

    // Real-time notification to recipient about coins received
    socketHandlers.emitToUser(recipient._id.toString(), 'coins-received', {
      sender: {
        _id: sender._id,
        name: sender.name,
        rollNumber: sender.rollNumber,
        avatar: sender.equippedAvatar || sender.profileImage
      },
      amount: coinsToShare,
      newCoins: recipient.coins
    });

    res.json({
      success: true,
      message: `Successfully shared ${coinsToShare} coins with ${recipient.name}!`,
      senderCoins: sender.coins,
      lastSharedCoinsDate: sender.lastSharedCoinsDate
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getFriends,
  sendFriendRequest,
  respondFriendRequest,
  removeFriend,
  searchStudents,
  shareCoins
};
