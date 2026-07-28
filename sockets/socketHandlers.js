const activeConnections = {}; // Map of userId -> Set of socket.ids
let ioInstance = null;

module.exports = (io) => {
  ioInstance = io;
  io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    if (userId) {
      socket.userId = userId;
      
      if (!activeConnections[userId]) {
        activeConnections[userId] = new Set();
      }
      activeConnections[userId].add(socket.id);
      
      // Notify user's contacts that user is online
      io.emit('user-online-status', { userId, isOnline: true });
      console.log(`User connected: ${userId} (socket: ${socket.id}, total connections: ${activeConnections[userId].size})`);
    } else {
      console.log(`User connected: ${socket.id}`);
    }

    // ----- DISCONNECT -----
    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${socket.id}`);
      if (socket.userId && activeConnections[socket.userId]) {
        const uId = socket.userId;
        activeConnections[uId].delete(socket.id);
        
        if (activeConnections[uId].size === 0) {
          delete activeConnections[uId];
          const lastSeenTime = new Date();
          io.emit('user-online-status', { userId: uId, isOnline: false, lastSeen: lastSeenTime });
          
          // Persist lastSeen to User document
          try {
            const User = require('../models/User');
            await User.findByIdAndUpdate(uId, { lastSeen: lastSeenTime });
          } catch (err) {
            console.error('Error updating lastSeen:', err.message);
          }
        }
      }
    });

    // ----- BATCH CHAT ROOMS -----
    socket.on('join-batch-chat', (batchId) => {
      if (batchId) socket.join(`batch_${batchId}`);
    });

    socket.on('leave-batch-chat', (batchId) => {
      if (batchId) socket.leave(`batch_${batchId}`);
    });

    // ----- DIRECT 1-ON-1 CHAT ROOMS -----
    socket.on('join-direct-chat', (otherUserId) => {
      if (!socket.userId || !otherUserId) return;
      const roomName = [socket.userId, otherUserId].sort().join('_direct_');
      socket.join(`direct_${roomName}`);
    });

    socket.on('leave-direct-chat', (otherUserId) => {
      if (!socket.userId || !otherUserId) return;
      const roomName = [socket.userId, otherUserId].sort().join('_direct_');
      socket.leave(`direct_${roomName}`);
    });

    // ----- REALTIME TYPING INDICATORS -----
    socket.on('typing', (data) => {
      const { batchId, recipientId, senderName } = data;
      if (batchId) {
        socket.to(`batch_${batchId}`).emit('user-typing', { batchId, senderId: socket.userId, senderName });
      } else if (recipientId) {
        const roomName = [socket.userId, recipientId].sort().join('_direct_');
        socket.to(`direct_${roomName}`).emit('user-typing', { recipientId, senderId: socket.userId, senderName });
      }
    });

    socket.on('stop-typing', (data) => {
      const { batchId, recipientId } = data;
      if (batchId) {
        socket.to(`batch_${batchId}`).emit('user-stop-typing', { batchId, senderId: socket.userId });
      } else if (recipientId) {
        const roomName = [socket.userId, recipientId].sort().join('_direct_');
        socket.to(`direct_${roomName}`).emit('user-stop-typing', { recipientId, senderId: socket.userId });
      }
    });

    // ----- SEND CHAT MESSAGE (Group or 1-on-1) -----
    socket.on('send-chat-message', async (data) => {
      const { 
        batchId, recipientId, senderId, text, senderName, senderRole, senderAvatar,
        isAnnouncement, announcementTitle, attachmentUrl, attachmentName, attachmentType 
      } = data;
      
      try {
        const Message = require('../models/Message');
        const newMessage = await Message.create({ 
          batchId: batchId || null,
          senderId,
          recipientId: recipientId || null,
          text: text || '',
          attachmentUrl: attachmentUrl || '',
          attachmentName: attachmentName || '',
          attachmentType: attachmentType || '',
          isAnnouncement: isAnnouncement || false,
          announcementTitle: announcementTitle || '',
          readBy: [senderId]
        });

        const formattedMsg = {
          _id: newMessage._id,
          batchId: newMessage.batchId,
          recipientId: newMessage.recipientId,
          text: newMessage.text,
          attachmentUrl: newMessage.attachmentUrl,
          attachmentName: newMessage.attachmentName,
          attachmentType: newMessage.attachmentType,
          isAnnouncement: newMessage.isAnnouncement,
          announcementTitle: newMessage.announcementTitle,
          createdAt: newMessage.createdAt,
          senderId: {
            _id: senderId,
            name: senderName,
            role: senderRole,
            equippedAvatar: senderAvatar,
            profileImage: senderAvatar
          }
        };

        if (batchId) {
          // Broadcast to batch chat room
          io.to(`batch_${batchId}`).emit('chat-message-received', formattedMsg);

          // If announcement, trigger real-time toast alert to entire batch
          if (isAnnouncement) {
            io.to(`batch_${batchId}`).emit('announcement-broadcast', {
              title: announcementTitle || 'New Announcement',
              text,
              senderName,
              batchId
            });
          }
        } else if (recipientId) {
          // Broadcast to direct 1-on-1 chat room
          const roomName = [senderId, recipientId].sort().join('_direct_');
          io.to(`direct_${roomName}`).emit('chat-message-received', formattedMsg);

          // Trigger real-time direct notification to recipient
          if (module.exports.emitToUser) {
            module.exports.emitToUser(recipientId, 'new-direct-message-notification', {
              senderId,
              senderName,
              senderAvatar,
              text: text || (attachmentType ? `Sent an ${attachmentType}` : 'Sent a message'),
              message: formattedMsg
            });
          }
        }
      } catch (err) {
        console.error('Error saving chat message:', err);
      }
    });
  });
};

module.exports.emitToUser = (userId, event, data) => {
  if (ioInstance && activeConnections[userId]) {
    for (const socketId of activeConnections[userId]) {
      ioInstance.to(socketId).emit(event, data);
    }
    return true;
  }
  return false;
};

module.exports.getActiveUserIds = () => {
  return Object.keys(activeConnections).filter(id => activeConnections[id] && activeConnections[id].size > 0);
};
