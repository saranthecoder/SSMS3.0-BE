const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dateStr: {
    type: String, // format YYYY-MM-DD
    required: true
  },
  checkInTime: {
    type: Date,
    required: true,
    default: Date.now
  },
  lastCheckInTime: {
    type: Date,
    required: true
  },
  checkOutTime: {
    type: Date
  },
  sessionDurationSeconds: {
    type: Number,
    default: 0
  },
  onsiteDurationSeconds: {
    type: Number,
    default: 0
  },
  wfhDurationSeconds: {
    type: Number,
    default: 0
  },
  onsiteMinHours: {
    type: Number,
    default: 4
  },
  onsiteMaxHours: {
    type: Number,
    default: 10
  },
  wfhMinHours: {
    type: Number,
    default: 4
  },
  wfhMaxHours: {
    type: Number,
    default: 10
  },
  onsiteAllocated: {
    type: Boolean,
    default: false
  },
  wfhAllocated: {
    type: Boolean,
    default: false
  },
  accessType: {
    type: String,
    enum: ['on-site', 'wfh'],
    default: 'on-site'
  },
  workHours: {
    type: Number,
    default: null
  },
  minRequiredHours: {
    type: Number,
    default: 4
  },
  maxValidHours: {
    type: Number,
    default: 10
  },
  isActive: {
    type: Boolean,
    default: false
  },
  isLeave: {
    type: Boolean,
    default: false
  },
  leaveHours: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['In Progress', 'Present', 'Absent', 'Invalid', 'Leave'],
    default: 'In Progress'
  }
}, {
  timestamps: true
});

attendanceSchema.index({ studentId: 1, dateStr: 1 }, { unique: true });
attendanceSchema.index({ studentId: 1, isActive: 1, dateStr: 1 });
attendanceSchema.index({ dateStr: 1 });
attendanceSchema.index({ isActive: 1, dateStr: 1 });
attendanceSchema.index({ dateStr: 1, isActive: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
