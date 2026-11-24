const mongoose = require('mongoose');

const dailyWorkloadSchema = new mongoose.Schema({
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    required: true
  },
  dateStr: {
    type: String, // format YYYY-MM-DD
    required: true
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
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// One daily workload record per batch per day
dailyWorkloadSchema.index({ batchId: 1, dateStr: 1 }, { unique: true });

module.exports = mongoose.model('DailyWorkload', dailyWorkloadSchema);
