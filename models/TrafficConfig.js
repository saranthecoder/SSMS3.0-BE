const mongoose = require('mongoose');

const trafficConfigSchema = new mongoose.Schema({
  policy: {
    type: String,
    enum: ['round-robin', 'failover', 'latency', 'cpu-adaptive', 'manual'],
    default: 'failover'
  },
  cpuThreshold: {
    type: Number,
    default: 80
  },
  manualSelectedServerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BackendServer',
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('TrafficConfig', trafficConfigSchema);
