const router = require('express').Router();
const { protect, admin } = require('../middleware/authMiddleware');
const {
  getGamificationStatus,
  claimDailyLogin,
  dailySpin,
  openChestEndpoint,
  buyChestEndpoint,
  getStreaks,
  getRewardHistory,
  getShopCatalog,
  unlockShopItem,
  equipItem,
  getMissions,
  claimMissionReward,
  getLeaderboard,
  getAchievements,
  setCustomAvatar,
  getPublicStudentProfile,
  getAdminShopCatalog,
  addShopItem,
  editShopItem,
  deleteShopItem
} = require('../controllers/gamificationController');

// Status & Profile
router.get('/status', protect, getGamificationStatus);
router.get('/profile/:id', protect, getPublicStudentProfile);
router.get('/streaks', protect, getStreaks);
router.get('/reward-history', protect, getRewardHistory);
router.get('/achievements', protect, getAchievements);

// Daily Systems
router.post('/daily-login', protect, claimDailyLogin);
router.post('/daily-spin', protect, dailySpin);
router.post('/open-chest', protect, openChestEndpoint);
router.post('/buy-chest', protect, buyChestEndpoint);

// Shop
router.get('/shop', protect, getShopCatalog);
router.post('/shop/unlock', protect, unlockShopItem);
router.post('/shop/equip', protect, equipItem);
router.post('/custom-avatar', protect, setCustomAvatar);

// Admin Shop Management
router.get('/admin/shop', protect, admin, getAdminShopCatalog);
router.post('/admin/shop', protect, admin, addShopItem);
router.put('/admin/shop/:id', protect, admin, editShopItem);
router.delete('/admin/shop/:id', protect, admin, deleteShopItem);

// Missions
router.get('/missions', protect, getMissions);
router.post('/missions/:id/claim', protect, claimMissionReward);

// Leaderboards
router.get('/leaderboards/:type', protect, getLeaderboard);

// Social (Friends & Sharing)
const {
  getFriends,
  sendFriendRequest,
  respondFriendRequest,
  shareCoins
} = require('../controllers/socialController');

router.get('/friends', protect, getFriends);
router.post('/friends/request', protect, sendFriendRequest);
router.post('/friends/respond', protect, respondFriendRequest);
router.post('/friends/share-coins', protect, shareCoins);

module.exports = router;
