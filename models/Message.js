const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    default: null
  },
  groupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatGroup',
    default: null
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  text: {
    type: String,
    default: ''
  },
  attachmentUrl: {
    type: String,
    default: ''
  },
  attachmentName: {
    type: String,
    default: ''
  },
  attachmentType: {
    type: String,
    default: ''
  },
  isAnnouncement: {
    type: Boolean,
    default: false
  },
  announcementTitle: {
    type: String,
    default: ''
  },
  deliveredTo: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  readBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }]
}, {
  timestamps: true
});

messageSchema.index({ batchId: 1, createdAt: -1 });
messageSchema.index({ batchId: 1, createdAt: 1 });
messageSchema.index({ groupId: 1, createdAt: -1 });
messageSchema.index({ groupId: 1, createdAt: 1 });
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: 1 });
messageSchema.index({ recipientId: 1, senderId: 1, createdAt: -1 });
messageSchema.index({ recipientId: 1, senderId: 1, createdAt: 1 });
messageSchema.index({ recipientId: 1, senderId: 1, readBy: 1 });
messageSchema.index({ recipientId: 1, readBy: 1 });
messageSchema.index({ recipientId: 1, createdAt: -1 });
messageSchema.index({ groupId: 1, readBy: 1 });
messageSchema.index({ batchId: 1, readBy: 1 });

module.exports = mongoose.model('Message', messageSchema);
