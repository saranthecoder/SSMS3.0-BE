const mongoose = require('mongoose');

const checkInAccessSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dateStr: {
    type: String, // format YYYY-MM-DD
    required: true
  },
  accessType: {
    type: String,
    enum: ['on-site', 'wfh'],
    required: true,
    default: 'on-site'
  },
  workHours: {
    type: Number,
    default: 4 // Mentor day-wise specified work hours (default 4h)
  },
  minHours: {
    type: Number,
    default: 4
  },
  maxHours: {
    type: Number,
    default: 10
  },
  onsiteAllocated: {
    type: Boolean,
    default: false
  },
  onsiteMinHours: {
    type: Number,
    default: 2
  },
  onsiteMaxHours: {
    type: Number,
    default: 10
  },
  wfhAllocated: {
    type: Boolean,
    default: false
  },
  wfhMinHours: {
    type: Number,
    default: 3
  },
  wfhMaxHours: {
    type: Number,
    default: 10
  },
  grantedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    required: true
  }
}, {
  timestamps: true
});

// Compound unique index so a student can only have one check-in access record per batch per day
checkInAccessSchema.index({ studentId: 1, batchId: 1, dateStr: 1 }, { unique: true });

module.exports = mongoose.model('CheckInAccess', checkInAccessSchema);
