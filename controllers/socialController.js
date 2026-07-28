const User = require('../models/User');
const Friendship = require('../models/Friendship');
const GamificationEvent = require('../models/GamificationEvent');
const { addRewardHistory } = require('../utils/gamification');

// @desc    Get student's friends list and pending requests
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
      .populate('requester', 'name rollNumber equippedAvatar level league')
      .populate('recipient', 'name rollNumber equippedAvatar level league')
      .lean();

    const friends = [];
    const pendingIncoming = [];
    const pendingOutgoing = [];

    friendships.forEach(f => {
      const otherUser = f.requester._id.toString() === studentId.toString() ? f.recipient : f.requester;
      
      if (f.status === 'accepted') {
        friends.push({
          friendshipId: f._id,
          friendId: otherUser._id,
          name: otherUser.name,
          rollNumber: otherUser.rollNumber,
          avatar: otherUser.equippedAvatar,
          level: otherUser.level,
          league: otherUser.league
        });
      } else if (f.status === 'pending') {
        const item = {
          requestId: f._id,
          friendId: otherUser._id,
          name: otherUser.name,
          rollNumber: otherUser.rollNumber,
          avatar: otherUser.equippedAvatar
        };
        if (f.recipient._id.toString() === studentId.toString()) {
          pendingIncoming.push(item);
        } else {
          pendingOutgoing.push(item);
        }
      }
    });

    res.json({
      friends,
      pendingIncoming,
      pendingOutgoing,
      lastSharedCoinsDate: req.user.lastSharedCoinsDate
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Send a friend request via Roll Number
// @route   POST /api/gamification/friends/request
// @access  Private
const sendFriendRequest = async (req, res) => {
  try {
    const { rollNumber } = req.body;
    if (!rollNumber) {
      return res.status(400).json({ message: 'Please enter a Roll Number.' });
    }

    const targetRoll = rollNumber.toString().trim();
    const recipient = await User.findOne({ rollNumber: { $regex: new RegExp(`^${targetRoll}$`, 'i') } });
    if (!recipient) {
      return res.status(404).json({ message: 'No student found with that Roll Number.' });
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
        return res.status(400).json({ message: 'You are already friends with this student.' });
      }
      if (existing.status === 'pending') {
        if (existing.requester.toString() === req.user._id.toString()) {
          return res.status(400).json({ message: 'Friend request already sent.' });
        } else {
          return res.status(400).json({ message: 'This student has already sent you a friend request. Accept it below!' });
        }
      }
      // If rejected, let's reopen it as pending
      existing.requester = req.user._id;
      existing.recipient = recipient._id;
      existing.status = 'pending';
      await existing.save();
      return res.json({ message: 'Friend request sent successfully!' });
    }

    await Friendship.create({
      requester: req.user._id,
      recipient: recipient._id,
      status: 'pending'
    });

    res.status(201).json({ message: 'Friend request sent successfully!' });
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
      return res.json({ message: 'Friend request accepted!' });
    } else {
      friendship.status = 'rejected';
      await friendship.save();
      return res.json({ message: 'Friend request rejected.' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Share coins with a friend
// @route   POST /api/gamification/friends/share-coins
// @access  Private
const shareCoins = async (req, res) => {
  try {
    const { friendId, amount } = req.body;
    const coinsToShare = Number(amount);

    if (!friendId || isNaN(coinsToShare) || coinsToShare <= 0) {
      return res.status(400).json({ message: 'Please specify a valid positive coins amount.' });
    }

    // Verify friendship exists and is accepted
    const friendship = await Friendship.findOne({
      status: 'accepted',
      $or: [
        { requester: req.user._id, recipient: friendId },
        { requester: friendId, recipient: req.user._id }
      ]
    });

    if (!friendship) {
      return res.status(400).json({ message: 'You can only share coins with accepted friends.' });
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
        message: `Sharing limit reached. You can share coins again in ${remainingDays} days.` 
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
  shareCoins
};
