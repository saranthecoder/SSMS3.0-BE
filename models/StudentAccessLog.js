const mongoose = require('mongoose');

const studentAccessLogSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  studentName: {
    type: String,
    required: true,
    trim: true
  },
  studentRollNumber: {
    type: String,
    default: '',
    trim: true
  },
  studentEmail: {
    type: String,
    default: '',
    trim: true
  },
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    default: null,
    index: true
  },
  batchName: {
    type: String,
    default: '',
    trim: true
  },
  action: {
    type: String,
    enum: ['block', 'suspend', 'restore'],
    required: true,
    index: true
  },
  reason: {
    type: String,
    default: '',
    trim: true
  },
  durationHours: {
    type: Number,
    default: null
  },
  suspendedUntil: {
    type: Date,
    default: null
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  performedByName: {
    type: String,
    required: true,
    trim: true
  },
  performedByRole: {
    type: String,
    enum: ['admin', 'mentor', 'system'],
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('StudentAccessLog', studentAccessLogSchema);
