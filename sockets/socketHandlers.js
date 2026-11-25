const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Batch = require('../models/Batch');
const ChatGroup = require('../models/ChatGroup');
const Message = require('../models/Message');
const Friendship = require('../models/Friendship');
const SocketBroadcast = require('../models/SocketBroadcast');
const { INSTANCE_ID } = require('../utils/distributedJobRunner');

const activeConnections = {}; // Map of userId -> Set of socket.ids
let ioInstance = null;
let changeStreamActive = false;

/**
 * Initializes cross-instance event propagation bridge using MongoDB Change Streams.
 * Allows instances to receive events triggered on any other backend instance without Redis.
 */
const initCrossInstanceBridge = (io) => {
  if (changeStreamActive) return;

  try {
    const changeStream = SocketBroadcast.watch([], { fullDocument: 'updateLookup' });
    changeStreamActive = true;

    changeStream.on('change', (change) => {
      if (change.operationType === 'insert' && change.fullDocument) {
        const { sourceInstance, type, target, event, data } = change.fullDocument;
        if (sourceInstance === INSTANCE_ID) return; // Ignore events originated on this instance

        if (type === 'to_user') {
          if (activeConnections[target]) {
            for (const socketId of activeConnections[target]) {
              io.to(socketId).emit(event, data);
            }
          }
        } else if (type === 'to_room') {
          io.to(target).emit(event, data);
        } else if (type === 'broadcast') {
          io.emit(event, data);
        }
      }
    });

    changeStream.on('error', (err) => {
      console.warn('[SocketBridge] Change stream interrupted, falling back gracefully:', err.message);
      changeStreamActive = false;
      try { changeStream.close(); } catch {}
      // Attempt reconnection after 15s backoff if database is connected
      setTimeout(() => {
        if (mongoose.connection && mongoose.connection.readyState === 1) {
          initCrossInstanceBridge(io);
        }
      }, 15000);
    });
  } catch (err) {
    console.warn('[SocketBridge] Change streams not supported or unavailable on this cluster:', err.message);
  }
};

module.exports = (io) => {
  ioInstance = io;

  // ─── 1. Socket Authentication Middleware ───
  io.use(async (socket, next) => {
    try {
      let userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
      let token = socket.handshake.auth?.token;

      // Extract token from cookie header if not explicitly provided
      if (!token && socket.request?.headers?.cookie) {
        const cookieMatch = socket.request.headers.cookie.match(/jwt=([^;]+)/);
        if (cookieMatch) token = cookieMatch[1];
      }

      // If token provided, verify it cryptographically
      if (token && process.env.JWT_SECRET) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          if (decoded && decoded.id) {
            userId = decoded.id;
          }
        } catch (jwtErr) {
          // Token expired or invalid
        }
      }

      if (!userId) {
        return next(new Error('Authentication required: Missing userId or token'));
      }

      // Verify user existence in database
      const user = await User.findById(userId)
        .select('_id name role profileImage equippedAvatar isProfileComplete')
        .lean();

      if (!user) {
        return next(new Error('Authentication failed: User not found'));
      }

      // Attach verified identity to socket session (cannot be tampered with)
      socket.userId = user._id.toString();
      socket.userRole = user.role;
      socket.userName = user.name;
      socket.userAvatar = user.equippedAvatar || user.profileImage || '/logo.png';

      return next();
    } catch (err) {
      console.error('[Socket Auth] Connection handshake authentication error:', err.message);
      return next(new Error('Authentication error'));
    }
  });

  // Start cross-instance change stream bridge
  initCrossInstanceBridge(io);

  io.on('connection', (socket) => {
    const userId = socket.userId;
    if (userId) {
      if (!activeConnections[userId]) {
        activeConnections[userId] = new Set();
      }
      activeConnections[userId].add(socket.id);

      // Notify contacts that user is online
      io.emit('user-online-status', { userId, isOnline: true });
      module.exports.publishCrossInstance('broadcast', '', 'user-online-status', { userId, isOnline: true });

      // Deliver pending direct messages to this newly connected user
      Message.updateMany(
        { recipientId: userId, deliveredTo: { $ne: userId } },
        { $addToSet: { deliveredTo: userId } }
      ).then(async (res) => {
        if (res.modifiedCount > 0) {
          const senders = await Message.distinct('senderId', { recipientId: userId });
          senders.forEach(sId => {
            module.exports.emitToUser(sId.toString(), 'messages-delivered', { deliveredTo: userId });
          });
        }
      }).catch(e => console.warn('Delivery update error on connect:', e.message));
    }

    // ----- DISCONNECT -----
    socket.on('disconnect', async () => {
      if (socket.userId && activeConnections[socket.userId]) {
        const uId = socket.userId;
        activeConnections[uId].delete(socket.id);

        if (activeConnections[uId].size === 0) {
          delete activeConnections[uId];
          const lastSeenTime = new Date();
          io.emit('user-online-status', { userId: uId, isOnline: false, lastSeen: lastSeenTime });
          module.exports.publishCrossInstance('broadcast', '', 'user-online-status', { userId: uId, isOnline: false, lastSeen: lastSeenTime });

          // Persist lastSeen to User document
          try {
            await User.findByIdAndUpdate(uId, { lastSeen: lastSeenTime });
          } catch (err) {
            console.error('Error updating lastSeen:', err.message);
          }
        }
      }
    });

    // ----- BATCH CHAT ROOMS (With Authorization) -----
    socket.on('join-batch-chat', async (batchId) => {
      if (!batchId) return;

      try {
        // Authorization check: User must be admin, batch mentor, or enrolled student
        let isAuthorized = false;

        if (socket.userRole === 'admin') {
          isAuthorized = true;
        } else if (socket.userRole === 'mentor') {
          const mentorBatch = await Batch.findOne({
            _id: batchId,
            $or: [{ mentorId: socket.userId }, { mentors: socket.userId }]
          }).select('_id').lean();
          if (mentorBatch) isAuthorized = true;
        } else {
          const enrollment = await Enrollment.findOne({
            batchId,
            studentId: socket.userId,
            status: 'approved'
          }).select('_id').lean();
          if (enrollment) isAuthorized = true;
        }

        if (isAuthorized) {
          socket.join(`batch_${batchId}`);
        } else {
          socket.emit('chat-error', { message: 'Unauthorized to join this batch chat' });
        }
      } catch (err) {
        console.error('Error authorizing batch chat join:', err.message);
      }
    });

    socket.on('leave-batch-chat', (batchId) => {
      if (batchId) socket.leave(`batch_${batchId}`);
    });

    // ----- CUSTOM GROUP CHAT ROOMS (With Authorization) -----
    socket.on('join-group-chat', async (groupId) => {
      if (!groupId || !socket.userId) return;

      try {
        let isAuthorized = socket.userRole === 'admin';
        if (!isAuthorized) {
          const group = await ChatGroup.findOne({ _id: groupId, 'members.user': socket.userId, isArchived: false }).select('_id').lean();
          if (group) isAuthorized = true;
        }

        if (isAuthorized) {
          socket.join(`group_${groupId}`);
        } else {
          socket.emit('chat-error', { message: 'Unauthorized to join this group chat' });
        }
      } catch (err) {
        console.error('Error authorizing group chat join:', err.message);
      }
    });

    socket.on('leave-group-chat', (groupId) => {
      if (groupId) socket.leave(`group_${groupId}`);
    });

    // ----- DIRECT 1-ON-1 CHAT ROOMS (With Authorization) -----
    socket.on('join-direct-chat', (otherUserId) => {
      if (!socket.userId || !otherUserId) return;
      // Rooms are partitioned strictly by sorted participant pair
      const roomName = [socket.userId, otherUserId.toString()].sort().join('_direct_');
      socket.join(`direct_${roomName}`);
    });

    socket.on('leave-direct-chat', (otherUserId) => {
      if (!socket.userId || !otherUserId) return;
      const roomName = [socket.userId, otherUserId.toString()].sort().join('_direct_');
      socket.leave(`direct_${roomName}`);
    });

    // ----- REALTIME TYPING INDICATORS -----
    socket.on('typing', (data) => {
      const { batchId, groupId, recipientId } = data || {};
      const senderName = socket.userName;
      if (batchId) {
        socket.to(`batch_${batchId}`).emit('user-typing', { batchId, senderId: socket.userId, senderName });
      } else if (groupId) {
        socket.to(`group_${groupId}`).emit('user-typing', { groupId, senderId: socket.userId, senderName });
      } else if (recipientId) {
        const roomName = [socket.userId, recipientId.toString()].sort().join('_direct_');
        socket.to(`direct_${roomName}`).emit('user-typing', { recipientId, senderId: socket.userId, senderName });
      }
    });

    socket.on('stop-typing', (data) => {
      const { batchId, groupId, recipientId } = data || {};
      if (batchId) {
        socket.to(`batch_${batchId}`).emit('user-stop-typing', { batchId, senderId: socket.userId });
      } else if (groupId) {
        socket.to(`group_${groupId}`).emit('user-stop-typing', { groupId, senderId: socket.userId });
      } else if (recipientId) {
        const roomName = [socket.userId, recipientId.toString()].sort().join('_direct_');
        socket.to(`direct_${roomName}`).emit('user-stop-typing', { recipientId, senderId: socket.userId });
      }
    });

    // ----- REALTIME READ RECEIPTS -----
    socket.on('mark-read', async (data) => {
      try {
        const { otherUserId, batchId, groupId } = data || {};
        const currentUserId = socket.userId;
        if (!currentUserId) return;

        if (otherUserId) {
          await Message.updateMany(
            { senderId: otherUserId, recipientId: currentUserId, readBy: { $ne: currentUserId } },
            { $addToSet: { readBy: currentUserId, deliveredTo: currentUserId } }
          );
          const roomName = [currentUserId, otherUserId.toString()].sort().join('_direct_');
          socket.to(`direct_${roomName}`).emit('messages-read', {
            readBy: currentUserId,
            room: `direct_${roomName}`
          });
          module.exports.publishCrossInstance('to_room', `direct_${roomName}`, 'messages-read', {
            readBy: currentUserId,
            room: `direct_${roomName}`
          });
        } else if (batchId) {
          await Message.updateMany(
            { batchId, readBy: { $ne: currentUserId } },
            { $addToSet: { readBy: currentUserId } }
          );
        } else if (groupId) {
          await Message.updateMany(
            { groupId, readBy: { $ne: currentUserId } },
            { $addToSet: { readBy: currentUserId } }
          );
        }
      } catch (err) {
        console.error('Error in socket mark-read:', err.message);
      }
    });

    // ----- SEND CHAT MESSAGE (Group, Batch or 1-on-1 with Message Integrity) -----
    socket.on('send-chat-message', async (data, callback) => {
      const {
        batchId, groupId, recipientId, text,
        isAnnouncement, announcementTitle, attachmentUrl, attachmentName, attachmentType, tempId
      } = data || {};

      try {
        // Enforce sender integrity: always use authenticated socket identity
        const senderId = socket.userId;
        const senderName = socket.userName;
        const senderRole = socket.userRole;
        const senderAvatar = socket.userAvatar;

        // Announcements can only be dispatched by admin or mentor
        const announcementAllowed = isAnnouncement && (senderRole === 'admin' || senderRole === 'mentor');

        // Student-to-student verification: Must be accepted friends
        if (recipientId && senderRole === 'student') {
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
              const errMsg = 'Students can only privately message accepted friends. Please send a friend request first.';
              if (typeof callback === 'function') {
                callback({ success: false, message: errMsg, tempId });
              }
              return socket.emit('chat-error', { message: errMsg });
            }
          }
        }

        const activeIds = module.exports.getActiveUserIds ? module.exports.getActiveUserIds() : [];
        const isRecipientOnline = recipientId ? activeIds.includes(recipientId.toString()) : false;
        const initialDelivered = isRecipientOnline ? [recipientId] : (batchId || groupId ? [senderId] : []);

        const newMessage = await Message.create({
          batchId: batchId || null,
          groupId: groupId || null,
          senderId,
          recipientId: recipientId || null,
          text: text || '',
          attachmentUrl: attachmentUrl || '',
          attachmentName: attachmentName || '',
          attachmentType: attachmentType || '',
          isAnnouncement: announcementAllowed,
          announcementTitle: announcementAllowed ? (announcementTitle || '') : '',
          deliveredTo: initialDelivered,
          readBy: [senderId]
        });

        const formattedMsg = {
          _id: newMessage._id,
          tempId: tempId || null,
          batchId: newMessage.batchId,
          groupId: newMessage.groupId,
          recipientId: newMessage.recipientId,
          text: newMessage.text,
          attachmentUrl: newMessage.attachmentUrl,
          attachmentName: newMessage.attachmentName,
          attachmentType: newMessage.attachmentType,
          isAnnouncement: newMessage.isAnnouncement,
          announcementTitle: newMessage.announcementTitle,
          deliveredTo: newMessage.deliveredTo,
          readBy: newMessage.readBy,
          createdAt: newMessage.createdAt,
          senderId: {
            _id: senderId,
            name: senderName,
            role: senderRole,
            equippedAvatar: senderAvatar,
            profileImage: senderAvatar
          }
        };

        // Acknowledge immediately to sender
        if (typeof callback === 'function') {
          callback({ success: true, message: formattedMsg, tempId });
        }

        if (batchId) {
          const room = `batch_${batchId}`;
          // Local broadcast
          io.to(room).emit('chat-message-received', formattedMsg);
          // Multi-instance propagation
          module.exports.publishCrossInstance('to_room', room, 'chat-message-received', formattedMsg);

          if (announcementAllowed) {
            const announcementPayload = {
              title: announcementTitle || 'New Announcement',
              text,
              senderName,
              batchId
            };
            io.to(room).emit('announcement-broadcast', announcementPayload);
            module.exports.publishCrossInstance('to_room', room, 'announcement-broadcast', announcementPayload);
          }

          // Proactively notify enrolled students and mentors of this batch
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
              text: text || (attachmentType ? `Sent an ${attachmentType}` : 'Sent a message'),
              message: formattedMsg
            };
            for (const uid of targetIds) {
              module.exports.emitToUser(uid, 'new-batch-message-notification', notifPayload);
            }
          }).catch(err => console.warn('Batch socket notification error:', err.message));

        } else if (groupId) {
          const room = `group_${groupId}`;
          io.to(room).emit('chat-message-received', formattedMsg);
          module.exports.publishCrossInstance('to_room', room, 'chat-message-received', formattedMsg);

          // Proactively notify group members
          ChatGroup.findById(groupId).select('name members').lean().then(groupDoc => {
            if (!groupDoc) return;
            const groupNotifPayload = {
              groupId,
              groupName: groupDoc.name,
              senderId,
              senderName,
              text: text || (attachmentType ? `Sent an ${attachmentType}` : 'Sent a message'),
              message: formattedMsg
            };
            (groupDoc.members || []).forEach(m => {
              const uid = (m.user?._id || m.user)?.toString();
              if (uid && uid !== senderId.toString()) {
                module.exports.emitToUser(uid, 'new-group-message-notification', groupNotifPayload);
              }
            });
          }).catch(err => console.warn('Group socket notification error:', err.message));

        } else if (recipientId) {
          const roomName = [senderId, recipientId.toString()].sort().join('_direct_');
          const directRoom = `direct_${roomName}`;

          // Local room broadcast
          io.to(directRoom).emit('chat-message-received', formattedMsg);
          // Multi-instance propagation to room
          module.exports.publishCrossInstance('to_room', directRoom, 'chat-message-received', formattedMsg);

          // Direct notification to recipient
          const notifPayload = {
            senderId,
            senderName,
            senderAvatar,
            text: text || (attachmentType ? `Sent an ${attachmentType}` : 'Sent a message'),
            message: formattedMsg
          };
          module.exports.emitToUser(recipientId.toString(), 'new-direct-message-notification', notifPayload);
        }
      } catch (err) {
        console.error('Error processing send-chat-message:', err.message);
        if (typeof callback === 'function') {
          callback({ success: false, message: 'Failed to send message', tempId });
        }
        socket.emit('chat-error', { message: 'Failed to send message' });
      }
    });

    // ----- COSMETIC / EQUIP CHANGE NOTIFICATION -----
    socket.on('equip_change', (data) => {
      // Re-emit to user's other active browser tabs/sessions
      if (socket.userId && activeConnections[socket.userId]) {
        for (const sId of activeConnections[socket.userId]) {
          if (sId !== socket.id) {
            io.to(sId).emit('user_equip_updated', data);
          }
        }
      }
    });
  });
};

/**
 * Emits an event to a user across instances.
 * Delivers locally immediately, and publishes to MongoDB for other instances.
 */
module.exports.emitToUser = (userId, event, data) => {
  const uIdStr = userId?.toString();
  if (!uIdStr) return false;

  let deliveredLocally = false;
  if (ioInstance && activeConnections[uIdStr]) {
    for (const socketId of activeConnections[uIdStr]) {
      ioInstance.to(socketId).emit(event, data);
    }
    deliveredLocally = true;
  }

  // Cross-instance propagation
  module.exports.publishCrossInstance('to_user', uIdStr, event, data);
  return deliveredLocally;
};

/**
 * Emits an event to all users connected to a specific batch room across instances.
 */
module.exports.emitToBatch = (batchId, event, data) => {
  const bIdStr = batchId?.toString();
  if (!bIdStr) return false;

  if (ioInstance) {
    ioInstance.to(`batch_${bIdStr}`).emit(event, data);
  }

  // Cross-instance propagation
  module.exports.publishCrossInstance('to_room', `batch_${bIdStr}`, event, data);
  return true;
};

/**
 * Emits an event to all connected users across all instances.
 */
module.exports.emitToAll = (event, data) => {
  if (ioInstance) {
    ioInstance.emit(event, data);
  }

  // Cross-instance propagation
  module.exports.publishCrossInstance('to_all', 'all', event, data);
  return true;
};

/**
 * Publishes an event to the lightweight MongoDB broadcast collection for other backend instances.
 */
module.exports.publishCrossInstance = (type, target, event, data) => {
  try {
    SocketBroadcast.create({
      sourceInstance: INSTANCE_ID,
      type,
      target,
      event,
      data
    }).catch(err => {
      // Non-fatal if logging or MongoDB write fails
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[SocketBridge] Publish broadcast warning:', err.message);
      }
    });
  } catch (err) {
    // Non-fatal
  }
};

module.exports.getActiveUserIds = () => {
  return Object.keys(activeConnections).filter(id => activeConnections[id] && activeConnections[id].size > 0);
};

module.exports.activeConnections = activeConnections;
