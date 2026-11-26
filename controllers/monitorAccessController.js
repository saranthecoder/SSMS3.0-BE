const MonitorAccess = require('../models/MonitorAccess');
const Batch = require('../models/Batch');

// Default initial seeds if none exist
const seedDefaultsIfNeeded = async () => {
  const count = await MonitorAccess.countDocuments();
  if (count === 0) {
    try {
      await MonitorAccess.create([
        {
          panelName: 'Executive Command Center',
          pin: 'SA123',
          isGlobal: true,
          allowedBatches: [],
          description: 'Master key with global scope across all institution batches'
        }
      ]);
    } catch (e) {
      console.warn('Default monitor PINs seed notice:', e.message);
    }
  }
};

// @desc    Get all monitor access PINs
// @route   GET /api/monitor-access
// @access  Private (Admin)
const getAllMonitorAccess = async (req, res) => {
  try {
    await seedDefaultsIfNeeded();
    const list = await MonitorAccess.find()
      .populate('allowedBatches', 'batchName panelName status startDate endDate')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();
    res.json(list);
  } catch (error) {
    console.error('Error fetching monitor access list:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a new monitor access PIN
// @route   POST /api/monitor-access
// @access  Private (Admin)
const createMonitorAccess = async (req, res) => {
  try {
    const { panelName, pin, allowedBatches, isGlobal, description } = req.body;

    if (!panelName || !panelName.trim()) {
      return res.status(400).json({ message: 'Monitor panel name is required.' });
    }

    if (!pin || !pin.trim()) {
      return res.status(400).json({ message: 'Unique PIN is required.' });
    }

    const cleanPin = pin.trim().toUpperCase();

    const existing = await MonitorAccess.findOne({ pin: cleanPin });
    if (existing) {
      return res.status(400).json({ message: `A monitor pass with PIN "${cleanPin}" already exists. Please choose a different PIN.` });
    }

    const newRecord = await MonitorAccess.create({
      panelName: panelName.trim(),
      pin: cleanPin,
      allowedBatches: isGlobal ? [] : (Array.isArray(allowedBatches) ? allowedBatches : []),
      isGlobal: Boolean(isGlobal),
      description: (description || '').trim(),
      createdBy: req.user?._id || null,
      isActive: true
    });

    const populated = await MonitorAccess.findById(newRecord._id)
      .populate('allowedBatches', 'batchName panelName status startDate endDate')
      .lean();

    res.status(201).json(populated);
  } catch (error) {
    console.error('Error creating monitor access:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update a monitor access PIN
// @route   PUT /api/monitor-access/:id
// @access  Private (Admin)
const updateMonitorAccess = async (req, res) => {
  try {
    const { id } = req.params;
    const { panelName, pin, allowedBatches, isGlobal, description, isActive } = req.body;

    const record = await MonitorAccess.findById(id);
    if (!record) {
      return res.status(404).json({ message: 'Monitor access pass not found.' });
    }

    if (pin) {
      const cleanPin = pin.trim().toUpperCase();
      const existing = await MonitorAccess.findOne({ pin: cleanPin, _id: { $ne: id } });
      if (existing) {
        return res.status(400).json({ message: `PIN "${cleanPin}" is already assigned to another panel.` });
      }
      record.pin = cleanPin;
    }

    if (panelName !== undefined) record.panelName = panelName.trim();
    if (description !== undefined) record.description = description.trim();
    if (isGlobal !== undefined) record.isGlobal = Boolean(isGlobal);
    if (allowedBatches !== undefined) {
      record.allowedBatches = record.isGlobal ? [] : (Array.isArray(allowedBatches) ? allowedBatches : []);
    }
    if (isActive !== undefined) record.isActive = Boolean(isActive);

    await record.save();

    const updated = await MonitorAccess.findById(id)
      .populate('allowedBatches', 'batchName panelName status startDate endDate')
      .lean();

    res.json(updated);
  } catch (error) {
    console.error('Error updating monitor access:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete a monitor access PIN
// @route   DELETE /api/monitor-access/:id
// @access  Private (Admin)
const deleteMonitorAccess = async (req, res) => {
  try {
    const { id } = req.params;
    const record = await MonitorAccess.findById(id);
    if (!record) {
      return res.status(404).json({ message: 'Monitor access pass not found.' });
    }

    await MonitorAccess.findByIdAndDelete(id);
    res.json({ message: 'Monitor access pass deleted successfully.' });
  } catch (error) {
    console.error('Error deleting monitor access:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Verify a PIN for public monitor portal access
// @route   POST /api/public/monitor/verify-pin
// @access  Public
const verifyMonitorPin = async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !pin.trim()) {
      return res.status(400).json({ valid: false, message: 'Please provide a monitoring PIN.' });
    }

    const cleanPin = pin.trim().toUpperCase();

    // 1. Search database
    let access = await MonitorAccess.findOne({ pin: cleanPin, isActive: true })
      .populate('allowedBatches', 'batchName panelName status startDate endDate')
      .lean();

    // 2. If not in DB yet, check fallback master key
    if (!access) {
      if (cleanPin === 'SA123') {
        access = {
          panelName: 'Executive Command Center',
          pin: 'SA123',
          isGlobal: true,
          allowedBatches: [],
          description: 'Master key with global scope'
        };
      }
    } else {
      // Update lastAccessedAt in background
      MonitorAccess.updateOne({ _id: access._id }, { $set: { lastAccessedAt: new Date() } }).exec();
    }

    if (!access) {
      return res.status(401).json({
        valid: false,
        message: 'Invalid or inactive monitoring PIN. Please check your credentials or contact administrator.'
      });
    }

    // Start warming monitor dashboard cache immediately before the client fetches /api/public/monitor
    try {
      const { prewarmMonitorDashboard } = require('./publicController');
      prewarmMonitorDashboard(access.pin);
    } catch (_) {}

    res.json({
      valid: true,
      panelName: access.panelName,
      pin: access.pin,
      isGlobal: Boolean(access.isGlobal),
      allowedBatches: access.allowedBatches || [],
      description: access.description || ''
    });
  } catch (error) {
    console.error('Error verifying monitor PIN:', error);
    res.status(500).json({ valid: false, message: error.message });
  }
};

module.exports = {
  getAllMonitorAccess,
  createMonitorAccess,
  updateMonitorAccess,
  deleteMonitorAccess,
  verifyMonitorPin,
  seedDefaultsIfNeeded
};
