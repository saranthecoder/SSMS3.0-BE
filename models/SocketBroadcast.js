const mongoose = require('mongoose');

const socketBroadcastSchema = new mongoose.Schema({
  sourceInstance: { type: String, required: true },
  type: { type: String, enum: ['to_user', 'to_room', 'broadcast'], required: true },
  target: { type: String, default: '' }, // userId or roomName
  event: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, expires: 60 } // Automatically reclaimed after 60 seconds
});

module.exports = mongoose.model('SocketBroadcast', socketBroadcastSchema);
