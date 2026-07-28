const mongoose = require('mongoose');

const leaveSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  date: {
    type: String, // Kept for backwards compatibility (YYYY-MM-DD)
    required: false
  },
  leaveType: {
    type: String,
    enum: ['full_day', 'multiple_days', 'hours'],
    default: 'full_day'
  },
  startDate: {
    type: String, // YYYY-MM-DD
    required: true
  },
  endDate: {
    type: String, // YYYY-MM-DD
  },
  startTime: {
    type: String, // HH:MM
  },
  endTime: {
    type: String, // HH:MM
  },
  reason: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  adminResponse: {
    type: String,
    required: false
  },
  attachmentUrl: {
    type: String,
    required: [true, 'Please upload a PDF leave application letter']
  }
}, { timestamps: true });

leaveSchema.index({ studentId: 1, startDate: -1 });
leaveSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Leave', leaveSchema);
