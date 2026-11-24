const mongoose = require('mongoose');
const Announcement = require('../models/Announcement');
const Enrollment = require('../models/Enrollment');
const Batch = require('../models/Batch');
const socketHandlers = require('../sockets/socketHandlers');
const { getApprovedBatchIds } = require('../utils/studentBatchCache');

const announcementCache = new Map();
const ANNOUNCEMENT_CACHE_TTL_MS = 30000; // 30 seconds

// @desc    Get announcements scoped to current user
// @route   GET /api/announcements
// @access  Private
const getAnnouncements = async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.role;
    const now = new Date();

    let batchIds = [];
    if (role === 'student') {
      batchIds = await getApprovedBatchIds(userId);
    } else if (role === 'mentor') {
      const mentorBatches = await Batch.find({
        $or: [{ mentorId: userId }, { mentors: userId }]
      }).select('_id');
      batchIds = mentorBatches.map(b => b._id);
    }

    const cacheKey = `${role}_${batchIds.map(b => (b._id || b).toString()).sort().join('_') || 'all'}`;
    const cachedEntry = announcementCache.get(cacheKey);
    let announcements;

    if (cachedEntry && (Date.now() - cachedEntry.timestamp) < ANNOUNCEMENT_CACHE_TTL_MS) {
      announcements = cachedEntry.data;
    } else {
      // Build audience filter
      const audienceConditions = [
        { targetAudience: 'all' }
      ];

      if (role === 'admin') {
        // Admins see all announcements
      } else if (role === 'mentor') {
        audienceConditions.push({ targetAudience: 'mentors' });
        audienceConditions.push({ targetAudience: 'role' });
        if (batchIds.length > 0) {
          audienceConditions.push({ targetAudience: 'batch', batchId: { $in: batchIds } });
        }
      } else {
        // Students
        audienceConditions.push({ targetAudience: 'students' });
        if (batchIds.length > 0) {
          audienceConditions.push({ targetAudience: 'batch', batchId: { $in: batchIds } });
        }
      }

      const query = {
        $and: [
          role === 'admin' ? {} : { $or: audienceConditions },
          role === 'student' ? { status: 'published' } : {},
          {
            $or: [
              { expiresAt: null },
              { expiresAt: { $gt: now } }
            ]
          }
        ]
      };

      announcements = await Announcement.find(query)
        .populate('authorId', 'name email role profileImage equippedAvatar')
        .populate('batchId', 'batchName panelName')
        .sort({ priority: -1, createdAt: -1 })
        .lean();

      announcementCache.set(cacheKey, { data: announcements, timestamp: Date.now() });
    }

    const formatted = announcements.map(a => ({
      ...a,
      isRead: Array.isArray(a.readBy) && a.readBy.some(id => id.toString() === userId.toString()),
      readCount: Array.isArray(a.readBy) ? a.readBy.length : 0
    }));

    res.json(formatted);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a new announcement
// @route   POST /api/announcements
// @access  Private/Admin or Mentor
const createAnnouncement = async (req, res) => {
  try {
    const {
      title,
      content,
      targetAudience = 'all',
      batchId,
      priority = 'normal',
      attachmentUrl,
      attachmentName,
      attachmentType,
      status = 'published',
      expiresAt
    } = req.body;

    const authorId = req.user._id;
    const authorRole = req.user.role;

    if (authorRole !== 'admin' && authorRole !== 'mentor') {
      return res.status(403).json({ message: 'Only administrators and mentors can publish announcements' });
    }

    if (!title?.trim() || !content?.trim()) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    const announcement = await Announcement.create({
      title: title.trim(),
      content: content.trim(),
      authorId,
      targetAudience,
      batchId: batchId || null,
      priority,
      attachmentUrl: attachmentUrl || '',
      attachmentName: attachmentName || '',
      attachmentType: attachmentType || '',
      status,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      readBy: [authorId]
    });

    const populated = await Announcement.findById(announcement._id)
      .populate('authorId', 'name email role profileImage equippedAvatar')
      .populate('batchId', 'batchName panelName');

    // Real-time broadcast
    if (status === 'published') {
      const broadcastPayload = {
        _id: populated._id,
        title: populated.title,
        content: populated.content,
        priority: populated.priority,
        targetAudience: populated.targetAudience,
        batchId: populated.batchId,
        author: populated.authorId?.name || req.user.name,
        createdAt: populated.createdAt
      };

      if (batchId) {
        socketHandlers.publishCrossInstance('to_room', `batch_${batchId}`, 'announcement-broadcast', broadcastPayload);
      } else {
        socketHandlers.publishCrossInstance('broadcast', '', 'announcement-broadcast', broadcastPayload);
      }
    }

    announcementCache.clear();
    res.status(201).json(populated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Update an announcement
// @route   PUT /api/announcements/:id
// @access  Private
const updateAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    const isAuthor = announcement.authorId.toString() === req.user._id.toString();
    if (!isAuthor && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only the author or an admin can edit this announcement' });
    }

    const {
      title,
      content,
      targetAudience,
      batchId,
      priority,
      attachmentUrl,
      attachmentName,
      attachmentType,
      status,
      expiresAt
    } = req.body;

    if (title) announcement.title = title.trim();
    if (content) announcement.content = content.trim();
    if (targetAudience) announcement.targetAudience = targetAudience;
    if (batchId !== undefined) announcement.batchId = batchId || null;
    if (priority) announcement.priority = priority;
    if (attachmentUrl !== undefined) announcement.attachmentUrl = attachmentUrl;
    if (attachmentName !== undefined) announcement.attachmentName = attachmentName;
    if (attachmentType !== undefined) announcement.attachmentType = attachmentType;
    if (status) announcement.status = status;
    if (expiresAt !== undefined) announcement.expiresAt = expiresAt ? new Date(expiresAt) : null;

    await announcement.save();

    const updated = await Announcement.findById(announcement._id)
      .populate('authorId', 'name email role profileImage equippedAvatar')
      .populate('batchId', 'batchName panelName');

    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete an announcement
// @route   DELETE /api/announcements/:id
// @access  Private
const deleteAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    const isAuthor = announcement.authorId.toString() === req.user._id.toString();
    if (!isAuthor && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only the author or an admin can delete this announcement' });
    }

    await announcement.deleteOne();
    res.json({ message: 'Announcement deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Mark announcement as read
// @route   POST /api/announcements/:id/read
// @access  Private
const markAnnouncementAsRead = async (req, res) => {
  try {
    const userId = req.user._id;
    const announcement = await Announcement.findByIdAndUpdate(
      req.params.id,
      { $addToSet: { readBy: userId } },
      { new: true }
    );

    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    res.json({ message: 'Announcement marked as read', id: announcement._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get unread announcement count
// @route   GET /api/announcements/unread-count
// @access  Private
const getUnreadAnnouncementCount = async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.role;
    const now = new Date();

    let batchIds = [];
    if (role === 'student') {
      const enrollments = await Enrollment.find({ studentId: userId, status: 'approved' }).select('batchId');
      batchIds = enrollments.map(e => e.batchId).filter(Boolean);
    }

    const audienceConditions = [{ targetAudience: 'all' }];
    if (role === 'student') {
      audienceConditions.push({ targetAudience: 'students' });
      if (batchIds.length > 0) {
        audienceConditions.push({ targetAudience: 'batch', batchId: { $in: batchIds } });
      }
    } else if (role === 'mentor') {
      audienceConditions.push({ targetAudience: 'mentors' }, { targetAudience: 'role' });
    }

    const count = await Announcement.countDocuments({
      status: 'published',
      $or: audienceConditions,
      readBy: { $ne: userId },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    });

    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  markAnnouncementAsRead,
  getUnreadAnnouncementCount
};
