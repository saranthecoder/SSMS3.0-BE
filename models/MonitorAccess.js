const mongoose = require('mongoose');

const monitorAccessSchema = new mongoose.Schema({
  panelName: {
    type: String,
    required: true,
    trim: true
  },
  pin: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  allowedBatches: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch'
  }],
  isGlobal: {
    type: Boolean,
    default: false
  },
  description: {
    type: String,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  lastAccessedAt: {
    type: Date
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('MonitorAccess', monitorAccessSchema);
