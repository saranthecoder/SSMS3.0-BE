const express = require('express');
const router = express.Router();
const {
  getAllMonitorAccess,
  createMonitorAccess,
  updateMonitorAccess,
  deleteMonitorAccess,
  verifyMonitorPin
} = require('../controllers/monitorAccessController');
const { protect, admin } = require('../middleware/authMiddleware');

// Public verification
router.post('/verify', verifyMonitorPin);

// Admin-only management
router.use(protect);
router.use(admin);

router.route('/')
  .get(getAllMonitorAccess)
  .post(createMonitorAccess);

router.route('/:id')
  .put(updateMonitorAccess)
  .delete(deleteMonitorAccess);

module.exports = router;
