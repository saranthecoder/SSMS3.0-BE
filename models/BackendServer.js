const mongoose = require('mongoose');

const backendServerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a server name'],
    trim: true
  },
  url: {
    type: String,
    required: [true, 'Please add a server URL'],
    trim: true,
    unique: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  status: {
    type: String,
    enum: ['online', 'offline', 'unknown'],
    default: 'unknown'
  },
  responseTime: {
    type: Number,
    default: 0
  },
  cpuUsage: {
    type: Number,
    default: null
  },
  memoryUsage: {
    type: Number,
    default: null
  },
  avgProcessingLatencyMs: {
    type: Number,
    default: 0
  },
  totalRequests: {
    type: Number,
    default: 0
  },
  probeCount: {
    type: Number,
    default: 0
  },
  requestRate: {
    type: Number,
    default: 0
  },
  requestCount: {
    type: Number,
    default: 0
  },
  reqPerMin: {
    type: Number,
    default: 0
  },
  activeConnections: {
    type: Number,
    default: 0
  },
  isPrimary: {
    type: Boolean,
    default: false
  },
  consecutiveFailures: {
    type: Number,
    default: 0
  },
  consecutiveSuccesses: {
    type: Number,
    default: 0
  },
  lastHealthCheck: {
    type: Date,
    default: null
  },
  failureReason: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('BackendServer', backendServerSchema);
