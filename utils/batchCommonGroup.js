const mongoose = require('mongoose');
const ChatGroup = require('../models/ChatGroup');
const Batch = require('../models/Batch');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');

// In-memory cache for batch sync cooldown to avoid re-aggregating on every single HTTP GET
const batchSyncCooldown = new Map();
const COOLDOWN_MS = 60000; // 60 seconds

/**
 * Ensures an official Common Chat Group exists for a given batch,
 * and synchronizes all enrolled students, assigned mentors, and admins as members.
 *
 * @param {string|mongoose.Types.ObjectId} batchId
 * @returns {Promise<ChatGroup|null>}
 */
const ensureBatchCommonGroup = async (batchId) => {
  if (!batchId || !mongoose.Types.ObjectId.isValid(batchId)) return null;
  const bIdStr = batchId.toString();

  // Fast path: if recently synced and group exists, return immediately
  const lastSync = batchSyncCooldown.get(bIdStr);
  if (lastSync && (Date.now() - lastSync < COOLDOWN_MS)) {
    const existingGroup = await ChatGroup.findOne({ batchId, isBatchCommon: true }).lean();
    if (existingGroup) return existingGroup;
  }

  try {
    const batch = await Batch.findById(batchId).lean();
    if (!batch) return null;

    // Collect all mentors
    const mentorIds = [];
    if (batch.mentorId) mentorIds.push(batch.mentorId.toString());
    if (Array.isArray(batch.mentors)) {
      batch.mentors.forEach(m => {
        if (m) mentorIds.push(m.toString());
      });
    }

    // Collect all admins
    const admins = await User.find({ role: 'admin' }).select('_id').lean();
    const adminIds = admins.map(a => a._id.toString());

    // Collect all approved enrolled students
    const enrollments = await Enrollment.find({ batchId: batch._id, status: 'approved' }).select('studentId').lean();
    const enrolledStudentIds = enrollments.map(e => e.studentId?.toString()).filter(Boolean);

    // Also collect students having user.batchId set
    const batchUsers = await User.find({ batchId: batch._id, role: 'student' }).select('_id').lean();
    batchUsers.forEach(u => {
      const idStr = u._id.toString();
      if (!enrolledStudentIds.includes(idStr)) enrolledStudentIds.push(idStr);
    });

    // Build the desired member list
    const memberMap = new Map();

    // Mentors are group admins
    mentorIds.forEach(id => {
      if (mongoose.Types.ObjectId.isValid(id)) {
        memberMap.set(id, { user: new mongoose.Types.ObjectId(id), role: 'admin' });
      }
    });

    // System Admins are group admins
    adminIds.forEach(id => {
      if (mongoose.Types.ObjectId.isValid(id)) {
        memberMap.set(id, { user: new mongoose.Types.ObjectId(id), role: 'admin' });
      }
    });

    // Students are members
    enrolledStudentIds.forEach(id => {
      if (mongoose.Types.ObjectId.isValid(id) && !memberMap.has(id)) {
        memberMap.set(id, { user: new mongoose.Types.ObjectId(id), role: 'member' });
      }
    });

    const membersArray = Array.from(memberMap.values());

    // Creator ID: batch mentor, or first admin, or fallback
    let creatorId = batch.mentorId;
    if (!creatorId && mentorIds.length > 0) creatorId = mentorIds[0];
    if (!creatorId && adminIds.length > 0) creatorId = adminIds[0];
    if (!creatorId) {
      const anyAdmin = await User.findOne({ role: 'admin' }).select('_id');
      creatorId = anyAdmin ? anyAdmin._id : null;
    }

    const groupName = `${batch.batchName} (Official)`;
    const description = `Official common classroom group for ${batch.batchName}. All enrolled students and faculty are included.`;

    // Find existing common group for this batch
    let group = await ChatGroup.findOne({ batchId: batch._id, isBatchCommon: true });

    if (!group) {
      // Also check if an existing group is linked to this batch without isBatchCommon
      group = await ChatGroup.findOne({ batchId: batch._id });
      if (group) {
        group.isBatchCommon = true;
      }
    }

    if (!group) {
      group = await ChatGroup.create({
        name: groupName,
        description,
        batchId: batch._id,
        creatorId: creatorId || new mongoose.Types.ObjectId(),
        isBatchCommon: true,
        members: membersArray
      });
    } else {
      // Sync members: merge existing members with new ones
      const existingUserIds = new Set(group.members.map(m => m.user?.toString()));
      let hasChanges = false;

      if (!group.isBatchCommon) {
        group.isBatchCommon = true;
        hasChanges = true;
      }

      for (const [userId, memObj] of memberMap.entries()) {
        if (!existingUserIds.has(userId)) {
          group.members.push(memObj);
          hasChanges = true;
        }
      }

      if (hasChanges) {
        await group.save();
      }
    }

    batchSyncCooldown.set(bIdStr, Date.now());
    return group;
  } catch (error) {
    console.error(`ensureBatchCommonGroup error for batch ${batchId}:`, error.message);
    return null;
  }
};

/**
 * Ensures common groups exist for all active/given batches
 */
const ensureAllBatchCommonGroups = async (batchIds = null) => {
  try {
    let query = { status: 'Active' };
    if (batchIds && Array.isArray(batchIds) && batchIds.length > 0) {
      query = { _id: { $in: batchIds } };
    }
    const batches = await Batch.find(query).select('_id');
    for (const b of batches) {
      await ensureBatchCommonGroup(b._id);
    }
  } catch (err) {
    console.error('ensureAllBatchCommonGroups error:', err.message);
  }
};

module.exports = {
  ensureBatchCommonGroup,
  ensureAllBatchCommonGroups
};
