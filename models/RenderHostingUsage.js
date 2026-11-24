const mongoose = require('mongoose');

const renderHostingUsageSchema = new mongoose.Schema({
  // Workspace-level instance hour metrics
  workspaceAllowanceHours: {
    type: Number,
    default: 750,
    min: 0
  },
  consumedHours: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Workspace outbound bandwidth (GB)
  bandwidthLimitGB: {
    type: Number,
    default: 100,
    min: 0
  },
  bandwidthConsumedGB: {
    type: Number,
    default: 0,
    min: 0
  },

  // Workspace build pipeline minutes
  buildMinutesLimit: {
    type: Number,
    default: 500,
    min: 0
  },
  buildMinutesConsumed: {
    type: Number,
    default: 0,
    min: 0
  },

  // Warning thresholds in percentage (defaults: 70%, 85%, 95%)
  warningThresholds: {
    type: [Number],
    default: [70, 85, 95]
  },

  // Audit metadata for manual entries
  lastManualUpdate: {
    type: Date,
    default: null
  },
  lastUpdatedByName: {
    type: String,
    default: null
  },
  lastUpdatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  // Data source tracking
  dataSource: {
    type: String,
    enum: ['manual_entry', 'render_api', 'hybrid'],
    default: 'manual_entry'
  },

  // Cache of services fetched from Render REST API if RENDER_API_KEY is supplied
  cachedRenderServices: [{
    id: String,
    name: String,
    type: String,
    repo: String,
    plan: String,
    status: String,
    updatedAt: String
  }],
  lastRenderApiFetch: {
    type: Date,
    default: null
  },
  renderApiError: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('RenderHostingUsage', renderHostingUsageSchema);
