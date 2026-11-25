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
    default: true
  },
  onsiteMinHours: {
    type: Number,
    default: 4
  },
  onsiteMaxHours: {
    type: Number,
    default: 10
  },
  wfhAllocated: {
    type: Boolean,
    default: true
  },
  wfhMinHours: {
    type: Number,
    default: 4
  },
  wfhMaxHours: {
    type: Number,
    default: 10
  },
  autoWfhEnabled: {
    type: Boolean,
    default: true
  },
  autoWfhTime: {
    type: String, // HH:mm format, e.g. "19:00"
    default: '19:00'
  },
  autoWfhGranted: {
    type: Boolean,
    default: false
  },
  autoOnsiteCheckoutEnabled: {
    type: Boolean,
    default: true
  },
  autoOnsiteCheckoutTime: {
    type: String, // HH:mm format, e.g. "17:00"
    default: '17:00'
  },
  autoOnsiteCheckoutDone: {
    type: Boolean,
    default: false
  },
  notes: {
    type: String,
    default: ''
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
