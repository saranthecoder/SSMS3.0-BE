const mongoose = require('mongoose');

const jobLockSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. 'attendance_midnight_reset'
  lockedBy: { type: String, required: true },
  lockedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  lastRunAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

module.exports = mongoose.model('JobLock', jobLockSchema);
