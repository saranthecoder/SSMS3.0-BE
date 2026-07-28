const User = require('../models/User');
const ShopItem = require('../models/ShopItem');
const GamificationEvent = require('../models/GamificationEvent');
const WeeklyMission = require('../models/WeeklyMission');
const {
  calculateLevel, getLeagueForLevel, LEAGUES,
  DAILY_LOGIN_REWARDS, isSameDay, isYesterday,
  awardCoinsWithCap, awardXPWithCap, addRewardHistory,
  checkAndAwardBadges, openChest, spinWheel,
  SPIN_WHEEL_SEGMENTS, ALL_TITLES, ALL_BORDERS,
  CODING_STREAK_MILESTONES, ATTENDANCE_MILESTONES
} = require('../utils/gamification');

const getISTDateStr = (date = new Date()) => {
  const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' };
  const dtf = new Intl.DateTimeFormat('en-IN', options);
  const [{ value: day }, , { value: month }, , { value: year }] = dtf.formatToParts(date);
  return `${year}-${month}-${day}`;
};

// ════════════════════════════════════════════════
//  STATUS & PROFILE
// ════════════════════════════════════════════════

// @desc    Get full gamification status
// @route   GET /api/gamification/status
const getGamificationStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Fail-safe: Award streak milestones retroactively or if skipped
    const { checkAndAwardStreakMilestones } = require('../utils/gamification');
    const milestoneResults = checkAndAwardStreakMilestones(user);

    const newBadges = checkAndAwardBadges(user);
    if (milestoneResults.coinsAwardedTotal > 0 || milestoneResults.xpAwardedTotal > 0 || newBadges.length > 0) {
      await user.save();
    }

    const levelStats = calculateLevel(user.points || 0);
    const league = getLeagueForLevel(levelStats.level);

    // Import lazily or at module level to check rank
    const { isStudentRankOne } = require('./analyticsController');
    const isRankOne = await isStudentRankOne(user._id);

    const Attendance = require('../models/Attendance');
    const todayStr = getISTDateStr();
    const todayCheckIn = await Attendance.findOne({ studentId: user._id, dateStr: todayStr });
    const hasCheckedInToday = !!todayCheckIn;

    res.json({
      coins: user.coins || 0,
      points: user.points || 0,
      level: levelStats.level,
      league: league.name,
      leagueIcon: league.icon,
      leagueColor: league.color,
      equippedAvatar: user.equippedAvatar,
      currentTitle: user.currentTitle || '',
      profileBorder: user.profileBorder || '',
      currentTheme: user.currentTheme || 'Emerald',
      currentNamecolor: user.currentNamecolor || '',
      equippedPet: user.equippedPet || '',
      equippedEffect: user.equippedEffect || '',
      unlockedAvatars: user.unlockedAvatars || [],
      unlockedBorders: user.unlockedBorders || [],
      unlockedTitles: user.unlockedTitles || [],
      unlockedThemes: user.unlockedThemes?.length ? user.unlockedThemes : ['Emerald'],
      unlockedNamecolors: user.unlockedNamecolors || [],
      unlockedPets: user.unlockedPets || [],
      badges: user.badges || [],
      dailyLoginStreak: user.dailyLoginStreak || 0,
      codingStreak: user.codingStreak || user.leetcodeStreak || 0,
      leetcodeStreak: user.leetcodeStreak || 0,
      maxCodingStreak: user.maxCodingStreak || 0,
      attendanceStreak: user.attendanceStreak || 0,
      totalProblemsSolved: user.totalProblemsSolved || user.totalLeetcodeSubmissions || 0,
      treasureChests: (user.treasureChests || []).filter(c => !c.opened),
      spinTickets: user.spinTickets || 0,
      canClaimDailyLogin: user.role === 'admin' ? true : (!isSameDay(user.lastLoginReward, new Date()) && hasCheckedInToday),
      hasCheckedInToday,
      canSpin: user.role === 'admin' ? true : (!isSameDay(user.lastDailySpinDate, new Date()) || (user.spinTickets || 0) > 0),
      weeklyXP: user.weeklyXP || 0,
      monthlyXP: user.monthlyXP || 0,
      isRankOne,
      ...levelStats,
      newBadges
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════
//  DAILY LOGIN REWARDS
// ════════════════════════════════════════════════

// @desc    Claim daily login reward
// @route   POST /api/gamification/daily-login
const claimDailyLogin = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const now = new Date();

    const Attendance = require('../models/Attendance');
    const todayStr = getISTDateStr();
    const isAdmin = user.role === 'admin';
    const todayCheckIn = await Attendance.findOne({ studentId: user._id, dateStr: todayStr });
    if (!todayCheckIn && !isAdmin) {
      return res.status(400).json({ message: 'Please check in for attendance first before claiming your daily reward!' });
    }

    if (isSameDay(user.lastLoginReward, now) && !isAdmin) {
      return res.status(400).json({ message: 'Already claimed today', alreadyClaimed: true });
    }

    // Check streak continuity
    if (isYesterday(user.lastLoginReward)) {
      user.dailyLoginStreak = (user.dailyLoginStreak || 0) + 1;
    } else {
      user.dailyLoginStreak = 1; // Reset streak
    }

    const dayIndex = ((user.dailyLoginStreak - 1) % 7); // 0-6 cyclic
    const reward = DAILY_LOGIN_REWARDS[dayIndex];

    const coinsAwarded = awardCoinsWithCap(user, reward.coins, 'Daily login reward');
    const xpResult = awardXPWithCap(user, reward.xp, 'Daily login reward');

    user.lastLoginReward = now;

    // Day 7 bonus chest
    let chestAwarded = null;
    if (reward.chest) {
      user.treasureChests.push({ type: reward.chest, earnedAt: now, opened: false });
      chestAwarded = reward.chest;
    }

    // Day 7 badge
    let badgeAwarded = null;
    if (reward.badge) {
      const existing = (user.badges || []).find(b => b.name === reward.badge.name);
      if (!existing) {
        user.badges.push({ ...reward.badge, unlockedAt: now });
        badgeAwarded = reward.badge;
      }
    }

    // Check all badges
    const newBadges = checkAndAwardBadges(user);
    await user.save();

    // Audit log
    await GamificationEvent.create({
      userId: user._id,
      eventType: 'daily_login',
      coinsChange: coinsAwarded,
      xpChange: xpResult.actual,
      reason: `Day ${user.dailyLoginStreak} login reward`,
      metadata: { streak: user.dailyLoginStreak, dayIndex }
    });

    res.json({
      success: true,
      streak: user.dailyLoginStreak,
      dayIndex,
      coinsAwarded,
      xpAwarded: xpResult.actual,
      leveledUp: xpResult.leveledUp,
      newLevel: xpResult.newLevel,
      chestAwarded,
      badgeAwarded,
      newBadges,
      totalCoins: user.coins,
      weekRewards: DAILY_LOGIN_REWARDS
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════
//  SPIN WHEEL
// ════════════════════════════════════════════════

// @desc    Spin the daily wheel
// @route   POST /api/gamification/daily-spin
const dailySpin = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const now = new Date();
    const usedTicket = isSameDay(user.lastDailySpinDate, now) && user.role !== 'admin';

    if (usedTicket && (user.spinTickets || 0) <= 0) {
      return res.status(400).json({ message: 'No spins available. Come back tomorrow!', canSpin: false });
    }

    // Use ticket or mark daily free spin
    if (usedTicket) {
      user.spinTickets -= 1;
    } else {
      user.lastDailySpinDate = now;
    }

    const result = spinWheel();
    let coinsWon = 0, xpWon = 0, ticketWon = 0;

    if (result.reward.coins) {
      coinsWon = awardCoinsWithCap(user, result.reward.coins, `Spin wheel: ${result.label}`);
    }
    if (result.reward.xp) {
      xpWon = awardXPWithCap(user, result.reward.xp, `Spin wheel: ${result.label}`).actual;
    }
    if (result.reward.spinTicket) {
      user.spinTickets = (user.spinTickets || 0) + result.reward.spinTicket;
      ticketWon = result.reward.spinTicket;
    }

    await user.save();

    await GamificationEvent.create({
      userId: user._id,
      eventType: 'daily_spin',
      coinsChange: coinsWon,
      xpChange: xpWon,
      reason: `Spin wheel: ${result.label}`,
      metadata: { segmentIndex: result.segmentIndex, ticketWon }
    });

    res.json({
      success: true,
      segmentIndex: result.segmentIndex,
      label: result.label,
      coinsWon,
      xpWon,
      ticketWon,
      totalCoins: user.coins,
      segments: SPIN_WHEEL_SEGMENTS.map(s => ({ label: s.label, color: s.color })),
      canSpinAgain: (user.spinTickets || 0) > 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════
//  TREASURE CHESTS
// ════════════════════════════════════════════════

// @desc    Open a treasure chest
// @route   POST /api/gamification/open-chest
const openChestEndpoint = async (req, res) => {
  try {
    const { chestIndex } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const unopened = (user.treasureChests || []).filter(c => !c.opened);
    const idx = typeof chestIndex === 'number' ? chestIndex : 0;
    if (idx < 0 || idx >= unopened.length) {
      return res.status(400).json({ message: 'No chest available at that index' });
    }

    // Find the actual chest in the full array
    let found = 0;
    let actualIdx = -1;
    for (let i = 0; i < user.treasureChests.length; i++) {
      if (!user.treasureChests[i].opened) {
        if (found === idx) { actualIdx = i; break; }
        found++;
      }
    }

    const chestType = user.treasureChests[actualIdx].type;
    const loot = openChest(chestType);

    user.treasureChests[actualIdx].opened = true;

    const coinsAwarded = awardCoinsWithCap(user, loot.coins, `Opened ${chestType} chest`);
    const xpResult = awardXPWithCap(user, loot.xp, `Opened ${chestType} chest`);

    // Process rare item drops
    for (const item of loot.items) {
      if (item.type === 'spinTicket') {
        user.spinTickets = (user.spinTickets || 0) + 1;
      } else if (item.type === 'title') {
        const val = item.value || item.name;
        if (!user.unlockedTitles.includes(val)) {
          user.unlockedTitles.push(val);
        }
      } else if (item.type === 'border') {
        const val = item.value || item.name;
        if (!user.unlockedBorders.includes(val)) {
          user.unlockedBorders.push(val);
        }
      } else if (item.type === 'avatar') {
        const val = item.value || item.name;
        if (!user.unlockedAvatars.includes(val)) {
          user.unlockedAvatars.push(val);
        }
      } else if (item.type === 'pet') {
        const val = item.value || item.name;
        if (!user.unlockedPets.includes(val)) {
          user.unlockedPets.push(val);
        }
      } else if (item.type === 'badge') {
        const existing = (user.badges || []).find(b => b.name === item.name);
        if (!existing) {
          user.badges.push({
            name: item.name,
            icon: item.icon || '🏅',
            description: item.description || 'Rare chest achievement'
          });
        }
      }
    }

    checkAndAwardBadges(user);
    await user.save();

    await GamificationEvent.create({
      userId: user._id,
      eventType: 'chest_opened',
      coinsChange: coinsAwarded,
      xpChange: xpResult.actual,
      reason: `Opened ${chestType} chest`,
      metadata: { chestType, loot }
    });

    res.json({
      success: true,
      chestType,
      coinsAwarded,
      xpAwarded: xpResult.actual,
      rareItems: loot.items,
      leveledUp: xpResult.leveledUp,
      totalCoins: user.coins,
      remainingChests: user.treasureChests.filter(c => !c.opened).length
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Buy a treasure chest
// @route   POST /api/gamification/buy-chest
const buyChestEndpoint = async (req, res) => {
  try {
    const { chestType } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const prices = {
      Bronze: 100,
      Silver: 500,
      Gold: 1500,
      Legendary: 5000
    };

    const cost = user.role === 'admin' ? 0 : prices[chestType];
    if (!cost && cost !== 0) {
      return res.status(400).json({ message: 'Invalid chest type' });
    }

    if (user.coins < cost) {
      return res.status(400).json({ message: `Insufficient coins. Need ${cost} coins.` });
    }

    user.coins -= cost;
    user.treasureChests.push({ type: chestType, earnedAt: new Date(), opened: false });
    await user.save();

    await GamificationEvent.create({
      userId: user._id,
      eventType: 'coins_spent',
      coinsChange: -cost,
      reason: `Purchased ${chestType} Chest`,
      metadata: { chestType }
    });

    res.json({
      success: true,
      message: `Successfully purchased a ${chestType} Chest!`,
      coins: user.coins,
      chestsCount: user.treasureChests.filter(c => !c.opened).length
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════
//  STREAKS
// ════════════════════════════════════════════════

// @desc    Get all streak data
// @route   GET /api/gamification/streaks
const getStreaks = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({
      dailyLoginStreak: user.dailyLoginStreak || 0,
      codingStreak: user.codingStreak || user.leetcodeStreak || 0,
      maxCodingStreak: user.maxCodingStreak || 0,
      attendanceStreak: user.attendanceStreak || 0,
      lastLoginReward: user.lastLoginReward,
      lastSolvedDate: user.lastSolvedDate || user.lastLeetcodeSubmissionDate,
      lastAttendanceDate: user.lastAttendanceDate,
      codingMilestones: CODING_STREAK_MILESTONES,
      attendanceMilestones: ATTENDANCE_MILESTONES
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════
//  REWARD HISTORY
// ════════════════════════════════════════════════

// @desc    Get paginated reward history
// @route   GET /api/gamification/reward-history
const getRewardHistory = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const events = await GamificationEvent.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const total = await GamificationEvent.countDocuments({ userId: req.user._id });

    res.json({
      events,
      page,
      totalPages: Math.ceil(total / limit),
      total
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════
//  SHOP — DATABASE-DRIVEN
// ════════════════════════════════════════════════

// @desc    Get shop catalog by category
// @route   GET /api/gamification/shop
const getShopCatalog = async (req, res) => {
  try {
    const { category } = req.query;
    const filter = { isActive: true };
    if (category) filter.category = category;

    const items = await ShopItem.find(filter).sort({ sortOrder: 1, cost: 1 }).lean();
    const user = await User.findById(req.user._id).lean();

    // Determine which items the user has unlocked
    const unlockedSets = {
      avatar: new Set(user?.unlockedAvatars || []),
      border: new Set(user?.unlockedBorders || []),
      title: new Set(user?.unlockedTitles || []),
      theme: new Set(user?.unlockedThemes || []),
      effect: new Set(user?.unlockedEffects || []),
      namecolor: new Set(user?.unlockedNamecolors || []),
      pet: new Set(user?.unlockedPets || []),
      emoji: new Set(user?.unlockedEmojis || [])
    };

    const userBadges = new Set((user?.badges || []).map(b => b.name));

    const catalog = items.map(item => {
      let isUnlocked = (unlockedSets[item.category] || new Set()).has(item.value) || (item.cost === 0 && !item.achievementRequired) || user.role === 'admin';
      
      if (item.achievementRequired) {
        isUnlocked = userBadges.has(item.achievementRequired) || user.role === 'admin';
      }

      const cost = user.role === 'admin' ? 0 : item.cost;

      return {
        ...item,
        cost,
        isUnlocked,
        isEquipped:
          (item.category === 'avatar' && user?.equippedAvatar === item.value) ||
          (item.category === 'border' && user?.profileBorder === item.value) ||
          (item.category === 'title' && user?.currentTitle === item.value) ||
          (item.category === 'theme' && user?.currentTheme === item.value) ||
          (item.category === 'namecolor' && user?.currentNamecolor === item.value) ||
          (item.category === 'pet' && user?.equippedPet === item.value) ||
          (item.category === 'effect' && user?.equippedEffect === item.value)
      };
    });

    res.json(catalog);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Unlock/buy a shop item
// @route   POST /api/gamification/shop/unlock
const unlockShopItem = async (req, res) => {
  try {
    const { itemId } = req.body;
    const item = await ShopItem.findById(itemId);
    if (!item || !item.isActive) return res.status(404).json({ message: 'Item not found' });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const isAdmin = user.role === 'admin';

    // Verify achievement requirement
    if (item.achievementRequired && !isAdmin) {
      const hasBadge = (user.badges || []).some(b => b.name === item.achievementRequired);
      const hasSecret = (user.secretAchievements || []).some(s => s.name === item.achievementRequired);
      if (!hasBadge && !hasSecret) {
        return res.status(400).json({ message: `Requires "${item.achievementRequired}" achievement.` });
      }
    }

    // Check if already unlocked
    const unlockArrayMap = {
      avatar: 'unlockedAvatars',
      border: 'unlockedBorders',
      title: 'unlockedTitles',
      theme: 'unlockedThemes',
      effect: 'unlockedEffects',
      namecolor: 'unlockedNamecolors',
      pet: 'unlockedPets',
      emoji: 'unlockedEmojis'
    };
    const arrayKey = unlockArrayMap[item.category];
    if (arrayKey && (user[arrayKey] || []).includes(item.value)) {
      return res.status(400).json({ message: 'Item already unlocked' });
    }

    // Check level requirement
    if (item.requiredLevel && (user.level || 1) < item.requiredLevel && !isAdmin) {
      return res.status(400).json({ message: `Requires Level ${item.requiredLevel}` });
    }

    // Check coins
    const cost = isAdmin ? 0 : item.cost;
    if ((user.coins || 0) < cost) {
      return res.status(400).json({ message: `Insufficient coins. Need ${cost}` });
    }

    user.coins -= cost;
    if (arrayKey) {
      if (!user[arrayKey]) user[arrayKey] = [];
      user[arrayKey].push(item.value);
    }

    addRewardHistory(user, 'purchase', -item.cost, `Bought ${item.name}`);
    checkAndAwardBadges(user);
    await user.save();

    await GamificationEvent.create({
      userId: user._id,
      eventType: 'item_purchased',
      coinsChange: -item.cost,
      reason: `Purchased ${item.name} (${item.category})`,
      metadata: { itemId: item._id, category: item.category }
    });

    res.json({
      success: true,
      message: `${item.name} unlocked!`,
      coins: user.coins
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Equip an unlocked item
// @route   POST /api/gamification/shop/equip
const equipItem = async (req, res) => {
  try {
    const { category, value } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const equipMap = {
      avatar: { field: 'equippedAvatar', unlockArray: 'unlockedAvatars' },
      border: { field: 'profileBorder', unlockArray: 'unlockedBorders' },
      title: { field: 'currentTitle', unlockArray: 'unlockedTitles' },
      theme: { field: 'currentTheme', unlockArray: 'unlockedThemes' },
      namecolor: { field: 'currentNamecolor', unlockArray: 'unlockedNamecolors' },
      pet: { field: 'equippedPet', unlockArray: 'unlockedPets' },
      effect: { field: 'equippedEffect', unlockArray: 'unlockedEffects' }
    };

    const mapping = equipMap[category];
    if (!mapping) return res.status(400).json({ message: 'Invalid category' });

    // Allow unequipping (empty value)
    if (!value || value === '') {
      user[mapping.field] = '';
      await user.save();
      return res.json({ success: true, message: `${category} unequipped` });
    }

    // Special cases for Theme category: Emerald (default free) and Custom
    if (category === 'theme') {
      if (value === 'Emerald') {
        user.currentTheme = 'Emerald';
        await user.save();
        return res.json({ success: true, message: 'Emerald theme equipped!', equipped: 'Emerald' });
      }
      if (value === 'Custom') {
        const { isStudentRankOne } = require('./analyticsController');
        const isRankOne = await isStudentRankOne(user._id);
        const userBadges = (user.badges || []).map(b => b.name);
        const isAllowed = isRankOne || userBadges.includes('Coding Master') || userBadges.includes('Legend League') || user.role === 'admin' || user.role === 'mentor';
        if (!isAllowed) {
          return res.status(400).json({ message: 'Custom theme is locked. Requires Rank #1 or special badge.' });
        }
        user.currentTheme = 'Custom';
        await user.save();
        return res.json({ success: true, message: 'Custom theme equipped!', equipped: 'Custom' });
      }
    }

    // Check if unlocked in user arrays
    const isUnlockedInArray = (user[mapping.unlockArray] || []).includes(value);

    // Find the item in the database to verify if it is free or earned via achievements
    const shopItem = await ShopItem.findOne({ category, value });
    const isFree = shopItem && shopItem.cost === 0 && !shopItem.achievementRequired;

    let hasAchievement = false;
    if (shopItem && shopItem.achievementRequired) {
      hasAchievement = (user.badges || []).some(b => b.name === shopItem.achievementRequired);
    }

    if (!isUnlockedInArray && !isFree && !hasAchievement && user.role !== 'admin' && user.role !== 'mentor') {
      return res.status(400).json({ message: 'Item not unlocked yet' });
    }

    user[mapping.field] = value;
    await user.save();

    res.json({ success: true, message: `${category} equipped!`, equipped: value });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════
//  MISSIONS
// ════════════════════════════════════════════════

// @desc    Get active missions for current user
// @route   GET /api/gamification/missions
const getMissions = async (req, res) => {
  try {
    const now = new Date();
    const scope = req.query.scope || 'weekly';

    const missions = await WeeklyMission.find({
      isActive: true,
      scope,
      startDate: { $lte: now },
      endDate: { $gte: now }
    }).lean();

    // Attach user progress
    const result = missions.map(m => {
      const participant = (m.participants || []).find(p => p.userId?.toString() === req.user._id.toString());
      return {
        _id: m._id,
        title: m.title,
        description: m.description,
        type: m.type,
        target: m.target,
        reward: m.reward,
        startDate: m.startDate,
        endDate: m.endDate,
        scope: m.scope,
        progress: participant?.progress || 0,
        completed: participant?.completed || false,
        claimed: participant?.claimed || false
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Claim a completed mission reward
// @route   POST /api/gamification/missions/:id/claim
const claimMissionReward = async (req, res) => {
  try {
    const mission = await WeeklyMission.findById(req.params.id);
    if (!mission) return res.status(404).json({ message: 'Mission not found' });

    const participant = mission.participants.find(p => p.userId.toString() === req.user._id.toString());
    if (!participant || !participant.completed) {
      return res.status(400).json({ message: 'Mission not completed' });
    }
    if (participant.claimed) {
      return res.status(400).json({ message: 'Already claimed' });
    }

    const user = await User.findById(req.user._id);
    const reward = mission.reward;

    const coinsAwarded = awardCoinsWithCap(user, reward.coins || 0, `Mission: ${mission.title}`);
    const xpResult = awardXPWithCap(user, reward.xp || 0, `Mission: ${mission.title}`);

    if (reward.badge && reward.badge.name) {
      const exists = user.badges.find(b => b.name === reward.badge.name);
      if (!exists) {
        user.badges.push({ ...reward.badge, unlockedAt: new Date() });
      }
    }

    if (reward.chestType) {
      user.treasureChests.push({ type: reward.chestType, earnedAt: new Date(), opened: false });
    }

    participant.claimed = true;
    checkAndAwardBadges(user);
    await user.save();
    await mission.save();

    await GamificationEvent.create({
      userId: user._id,
      eventType: 'mission_completed',
      coinsChange: coinsAwarded,
      xpChange: xpResult.actual,
      reason: `Completed mission: ${mission.title}`,
      metadata: { missionId: mission._id }
    });

    res.json({
      success: true,
      coinsAwarded,
      xpAwarded: xpResult.actual,
      leveledUp: xpResult.leveledUp,
      totalCoins: user.coins
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════
//  LEADERBOARDS
// ════════════════════════════════════════════════

// @desc    Get leaderboard by type
// @route   GET /api/gamification/leaderboards/:type
const getLeaderboard = async (req, res) => {
  try {
    const { type } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    let sortField;
    switch (type) {
      case 'coins':      sortField = { coins: -1 }; break;
      case 'xp':         sortField = { points: -1 }; break;
      case 'coding':     sortField = { totalLeetcodeSubmissions: -1 }; break;
      case 'attendance': sortField = { attendanceStreak: -1 }; break;
      case 'weekly':     sortField = { weeklyXP: -1 }; break;
      case 'monthly':    sortField = { monthlyXP: -1 }; break;
      default:           sortField = { points: -1 }; break;
    }

    const students = await User.find({ role: 'student' })
      .select('name equippedAvatar currentTitle profileBorder currentNamecolor equippedPet equippedEffect league level coins points totalLeetcodeSubmissions attendanceStreak weeklyXP monthlyXP badges')
      .sort(sortField)
      .limit(limit)
      .lean();

    const leaderboard = students.map((s, i) => ({
      rank: i + 1,
      _id: s._id,
      name: s.name,
      equippedAvatar: s.equippedAvatar,
      currentTitle: s.currentTitle,
      profileBorder: s.profileBorder,
      currentNamecolor: s.currentNamecolor || '',
      equippedPet: s.equippedPet || '',
      equippedEffect: s.equippedEffect || '',
      league: s.league,
      level: s.level,
      coins: s.coins || 0,
      value: type === 'coins' ? s.coins
           : type === 'coding' ? s.totalLeetcodeSubmissions
           : type === 'attendance' ? s.attendanceStreak
           : type === 'weekly' ? s.weeklyXP
           : type === 'monthly' ? s.monthlyXP
           : s.points,
      badgeCount: (s.badges || []).length
    }));

    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════
//  ACHIEVEMENTS
// ════════════════════════════════════════════════

// @desc    Get all achievements with progress
// @route   GET /api/gamification/achievements
const getAchievements = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { badgesList, SECRET_ACHIEVEMENTS } = require('../utils/gamification');

    const achievements = badgesList.map(badge => {
      const unlocked = (user.badges || []).find(b => b.name === badge.name);
      return {
        name: badge.name,
        icon: badge.icon,
        description: badge.description,
        rarity: badge.rarity || 'Common',
        unlocked: !!unlocked,
        unlockedAt: unlocked?.unlockedAt || null,
        isSecret: false
      };
    });

    // Secret achievements — only show name/icon if unlocked
    const secretAchievements = SECRET_ACHIEVEMENTS.map(sa => {
      const unlocked = (user.secretAchievements || []).find(s => s.name === sa.name);
      return {
        name: unlocked ? sa.name : '???',
        icon: unlocked ? sa.icon : '❓',
        description: unlocked ? sa.description : 'Hidden achievement',
        rarity: sa.rarity,
        unlocked: !!unlocked,
        unlockedAt: unlocked?.unlockedAt || null,
        isSecret: true
      };
    });

    const all = [...achievements, ...secretAchievements];
    const totalUnlocked = all.filter(a => a.unlocked).length;

    res.json({
      achievements: all,
      totalUnlocked,
      totalAchievements: all.length,
      completionPct: Math.round((totalUnlocked / all.length) * 100)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const setCustomAvatar = async (req, res) => {
  try {
    const { avatarUrl } = req.body;
    if (!avatarUrl) {
      return res.status(400).json({ message: 'Avatar URL is required' });
    }

    const { isStudentRankOne } = require('./analyticsController');
    const isRankOne = await isStudentRankOne(req.user._id);

    if (!isRankOne) {
      return res.status(403).json({ message: 'Only Rank #1 on the leaderboard is allowed to keep/use a custom photo.' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.equippedAvatar = avatarUrl;
    await user.save();

    res.json({ message: 'Custom photo equipped successfully!', equippedAvatar: user.equippedAvatar });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getPublicStudentProfile = async (req, res) => {
  try {
    const student = await User.findById(req.params.id);
    if (!student) return res.status(404).json({ message: 'Student not found' });

    const levelStats = calculateLevel(student.points || 0);
    const league = getLeagueForLevel(levelStats.level);

    // Count total unlocked shop items
    const totalUnlockedItems = 
      (student.unlockedAvatars || []).length +
      (student.unlockedBorders || []).length +
      (student.unlockedTitles || []).length +
      (student.unlockedThemes || []).length +
      (student.unlockedEffects || []).length +
      (student.unlockedNamecolors || []).length +
      (student.unlockedPets || []).length;

    res.json({
      name: student.name,
      email: student.email,
      role: student.role,
      coins: student.coins || 0,
      points: student.points || 0,
      level: levelStats.level,
      league: league.name,
      leagueIcon: league.icon,
      leagueColor: league.color,
      equippedAvatar: student.equippedAvatar || '',
      currentTitle: student.currentTitle || '',
      profileBorder: student.profileBorder || '',
      currentTheme: student.currentTheme || '',
      currentNamecolor: student.currentNamecolor || '',
      equippedPet: student.equippedPet || '',
      equippedEffect: student.equippedEffect || '',
      badges: student.badges || [],
      codingStreak: student.codingStreak || student.leetcodeStreak || 0,
      totalProblemsSolved: student.totalProblemsSolved || student.totalLeetcodeSubmissions || 0,
      totalUnlockedItems,
      ...levelStats
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Admin CRUD on Shop Items
// @desc    Get all shop catalog for Admin (both active and inactive)
// @route   GET /api/gamification/admin/shop
const getAdminShopCatalog = async (req, res) => {
  try {
    const items = await ShopItem.find({}).sort({ category: 1, sortOrder: 1, cost: 1 }).lean();
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Add a shop item
// @route   POST /api/gamification/admin/shop
const addShopItem = async (req, res) => {
  try {
    const {
      name,
      category,
      rarity,
      cost,
      isPurchasable,
      achievementRequired,
      imageUrl,
      value,
      description,
      isLimited,
      availableUntil,
      isActive,
      requiredLevel,
      sortOrder
    } = req.body;

    const newItem = await ShopItem.create({
      name,
      category,
      rarity,
      cost,
      isPurchasable: isPurchasable !== undefined ? isPurchasable : true,
      achievementRequired: achievementRequired || '',
      imageUrl: imageUrl || '',
      value: value || '',
      description: description || '',
      isLimited: isLimited !== undefined ? isLimited : false,
      availableUntil: availableUntil || null,
      isActive: isActive !== undefined ? isActive : true,
      requiredLevel: requiredLevel || 1,
      sortOrder: sortOrder || 0
    });

    res.status(201).json(newItem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Edit a shop item
// @route   PUT /api/gamification/admin/shop/:id
const editShopItem = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await ShopItem.findById(id);

    if (!item) {
      return res.status(404).json({ message: 'Shop item not found' });
    }

    const updatedFields = { ...req.body };
    delete updatedFields._id;
    delete updatedFields.__v;
    delete updatedFields.createdAt;
    delete updatedFields.updatedAt;
    
    // Explicitly update fields to handle booleans & updated values
    Object.keys(updatedFields).forEach(key => {
      if (updatedFields[key] !== undefined) {
        item[key] = updatedFields[key];
      }
    });

    const updatedItem = await item.save();
    res.json(updatedItem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete a shop item
// @route   DELETE /api/gamification/admin/shop/:id
const deleteShopItem = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await ShopItem.findByIdAndDelete(id);

    if (!item) {
      return res.status(404).json({ message: 'Shop item not found' });
    }

    res.json({ message: 'Shop item deleted successfully', id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
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
};
