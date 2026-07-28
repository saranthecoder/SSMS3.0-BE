// ═══════════════════════════════════════════════════
//  ADVANCED GAMIFICATION ENGINE
//  RPG-style leveling, leagues, streaks, chests, spin
// ═══════════════════════════════════════════════════

// ─── RPG Level Thresholds ───
const LEVEL_THRESHOLDS = [
  0,      // L1
  500,    // L2
  1200,   // L3
  2200,   // L4
  3500,   // L5
  5000,   // L6
  7000,   // L7
  9500,   // L8
  12500,  // L9
  16000,  // L10
  20000,  // L11
  24500,  // L12
  29500,  // L13
  35000,  // L14
  41000,  // L15
  48000,  // L16
  56000,  // L17
  65000,  // L18
  75000,  // L19
  86000   // L20
];
(() => {
  let current = 86000;
  let diff = 12000;
  for (let i = 21; i <= 100; i++) {
    current += diff;
    LEVEL_THRESHOLDS.push(current);
    diff += 1000;
  }
})();

const calculateLevel = (points) => {
  let level = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (points >= LEVEL_THRESHOLDS[i]) {
      level = i + 1;
    } else break;
  }
  const currentLevelXP = LEVEL_THRESHOLDS[level - 1] || 0;
  const nextLevelXP = LEVEL_THRESHOLDS[level] || currentLevelXP + 1000;
  const xpInLevel = points - currentLevelXP;
  const levelTargetXP = nextLevelXP - currentLevelXP;
  const pct = levelTargetXP > 0 ? Math.max(0, Math.min(100, Math.round((xpInLevel / levelTargetXP) * 100))) : 100;
  return { level, points, currentLevelXP, nextLevelXP, xpInLevel, levelTargetXP, pct };
};

// ─── League Thresholds (based on level) ───
const LEAGUES = [
  { name: 'Bronze',       minLevel: 1,  icon: '🥉', color: '#CD7F32' },
  { name: 'Silver',       minLevel: 6,  icon: '🥈', color: '#C0C0C0' },
  { name: 'Gold',         minLevel: 11, icon: '🥇', color: '#FFD700' },
  { name: 'Platinum',     minLevel: 15, icon: '💎', color: '#E5E4E2' }, // adjusted for new level scale
  { name: 'Diamond',      minLevel: 20, icon: '💠', color: '#B9F2FF' }, // Diamond starts at level 20 now (cap)
  { name: 'Master',       minLevel: 30, icon: '🏆', color: '#9B59B6' },
  { name: 'Grandmaster',  minLevel: 45, icon: '⚡', color: '#E74C3C' },
  { name: 'Legend',       minLevel: 60, icon: '👑', color: '#FF6B35' }
];

const getLeagueForLevel = (level) => {
  let league = LEAGUES[0];
  for (const l of LEAGUES) {
    if (level >= l.minLevel) league = l;
  }
  return league;
};

// ─── Daily Login Rewards (Flat 20 XP / 10 Coins, with week bonus chest/badge) ───
const DAILY_LOGIN_REWARDS = [
  { day: 1, coins: 10,  xp: 20  },
  { day: 2, coins: 10,  xp: 20  },
  { day: 3, coins: 10,  xp: 20  },
  { day: 4, coins: 10,  xp: 20  },
  { day: 5, coins: 10,  xp: 20  },
  { day: 6, coins: 10,  xp: 20  },
  { day: 7, coins: 10,  xp: 20, chest: 'Silver', badge: { name: 'Weekly Warrior', icon: '📅', description: '7-day login streak!' } }
];

// ─── Coding Streak Milestones ───
const CODING_STREAK_MILESTONES = [
  { days: 3,   coins: 50,   xp: 100 },
  { days: 7,   coins: 100,  xp: 250 },
  { days: 14,  coins: 250,  xp: 500 },
  { days: 21,  coins: 400,  xp: 900 },
  { days: 30,  coins: 700,  xp: 1500, badge: { name: 'Coding Legend', icon: '🔥', description: '30-day coding streak!', rarity: 'Epic' } },
  { days: 45,  coins: 1200, xp: 2500 },
  { days: 60,  coins: 2500, xp: 5000, badge: { name: 'Coding Master', icon: '💻', description: '60-day coding streak!', rarity: 'Legendary' } }
];

// ─── Attendance Milestones ───
const ATTENDANCE_MILESTONES = [
  { days: 7,  coins: 100,  xp: 200,  badge: { name: 'Punctual Student', icon: '⏰', description: '7-day attendance streak!' } },
  { days: 15, coins: 250,  xp: 500 },
  { days: 30, coins: 500,  xp: 1200, badge: { name: 'Perfect Attendance', icon: '📋', description: '30-day attendance streak!', rarity: 'Rare' } },
  { days: 60, coins: 1500, xp: 3000, badge: { name: 'Attendance Sovereign', icon: '👑', description: '60-day attendance streak!', rarity: 'Legendary' } }
];

// ─── Daily Caps (Anti-Cheat adjusted to daily activity maximums) ───
const DAILY_COIN_CAP = 300;
const DAILY_XP_CAP = 700;

const isSameDay = (d1, d2) => {
  if (!d1 || !d2) return false;
  const a = new Date(d1); const b = new Date(d2);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
};

const isYesterday = (date) => {
  if (!date) return false;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return isSameDay(date, yesterday);
};

const awardCoinsWithCap = (user, amount, reason, bypassCap = false) => {
  if (bypassCap) {
    user.coins += amount;
    addRewardHistory(user, 'coins', amount, reason);
    return amount;
  }
  const today = new Date();
  if (!isSameDay(user.dailyCoinsCap?.today, today)) {
    user.dailyCoinsCap = { today, earned: 0 };
  }
  const remaining = Math.max(0, DAILY_COIN_CAP - user.dailyCoinsCap.earned);
  const actual = Math.min(amount, remaining);
  if (actual > 0) {
    user.coins += actual;
    user.dailyCoinsCap.earned += actual;
    addRewardHistory(user, 'coins', actual, reason);
  }
  return actual;
};

const awardXPWithCap = (user, amount, reason, bypassCap = false) => {
  const today = new Date();
  let actual = amount;
  
  if (!bypassCap) {
    if (!isSameDay(user.dailyXPCap?.today, today)) {
      user.dailyXPCap = { today, earned: 0 };
    }
    const remaining = Math.max(0, DAILY_XP_CAP - user.dailyXPCap.earned);
    actual = Math.min(amount, remaining);
    if (actual > 0) {
      user.dailyXPCap.earned += actual;
    }
  }

  if (actual > 0) {
    user.points += actual;
    user.weeklyXP = (user.weeklyXP || 0) + actual;
    user.monthlyXP = (user.monthlyXP || 0) + actual;
    user.seasonXP = (user.seasonXP || 0) + actual;
    
    // Recalculate level
    const { level } = calculateLevel(user.points);
    const oldLevel = user.level || 1;
    user.level = level;
    
    // Update league
    const league = getLeagueForLevel(level);
    user.league = league.name;
    addRewardHistory(user, 'xp', actual, reason);
    return { actual, leveledUp: level > oldLevel, newLevel: level, league: league.name };
  }
  return { actual: 0, leveledUp: false };
};

const addRewardHistory = (user, type, amount, reason) => {
  if (!user.rewardHistory) user.rewardHistory = [];
  user.rewardHistory.unshift({ type, amount, reason, date: new Date() });
  // Keep only last 100 entries in user doc
  if (user.rewardHistory.length > 100) {
    user.rewardHistory = user.rewardHistory.slice(0, 100);
  }
};

// ─── Treasure Chests ───
const CHEST_TYPES = {
  Bronze:    { coins: [50, 150],   xp: [0, 0],   rareDrop: 0.05 },
  Silver:    { coins: [300, 700],  xp: [0, 0],   rareDrop: 0.10 },
  Gold:      { coins: [1000, 2500], xp: [0, 0],  rareDrop: 0.20 },
  Legendary: { coins: [0, 0],      xp: [0, 0],   rareDrop: 1.00 }
};

const openChest = (chestType) => {
  const chest = CHEST_TYPES[chestType] || CHEST_TYPES.Bronze;
  const coins = randomInRange(chest.coins[0], chest.coins[1]);
  const xp = randomInRange(chest.xp[0], chest.xp[1]);
  const rewards = { coins, xp, items: [] };

  if (chestType === 'Legendary') {
    // Guaranteed drops
    const legendaryItems = [
      { type: 'pet', name: 'Phoenix Pet', icon: '🐦', value: 'Phoenix' },
      { type: 'border', name: 'Galaxy Border', icon: '🖼️', value: 'galaxy-swirl' },
      { type: 'badge', name: 'Legendary Opener', icon: '🏆', description: 'Opened a Legendary Chest!' }
    ];
    rewards.items.push(legendaryItems[Math.floor(Math.random() * legendaryItems.length)]);
  } else {
    // Chance for rare item drop
    if (Math.random() < chest.rareDrop) {
      const rareItems = [
        { type: 'spinTicket', name: 'Spin Ticket', icon: '🎟️' },
        { type: 'title', name: getRandomTitle(), icon: '🏷️' },
        { type: 'border', name: getRandomBorder(), icon: '🖼️' }
      ];
      rewards.items.push(rareItems[Math.floor(Math.random() * rareItems.length)]);
    }
  }
  return rewards;
};

const randomInRange = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const getRandomTitle = () => {
  const titles = ['Problem Solver', 'React Ninja', 'Bug Hunter', 'Night Owl', 'Early Bird', 'Code Wizard'];
  return titles[Math.floor(Math.random() * titles.length)];
};

const getRandomBorder = () => {
  const borders = ['bronze-glow', 'silver-pulse', 'gold-shimmer', 'fire-ring', 'lightning-arc', 'galaxy-swirl'];
  return borders[Math.floor(Math.random() * borders.length)];
};

// ─── Spin Wheel ───
const SPIN_WHEEL_SEGMENTS = [
  { label: '10 Coins',   reward: { coins: 10 },   weight: 25, color: '#3B82F6' },
  { label: '20 Coins',   reward: { coins: 20 },   weight: 20, color: '#8B5CF6' },
  { label: '50 Coins',   reward: { coins: 50 },   weight: 12, color: '#F59E0B' },
  { label: '100 Coins',  reward: { coins: 100 },  weight: 5,  color: '#EF4444' },
  { label: '25 XP',      reward: { xp: 25 },      weight: 18, color: '#10B981' },
  { label: '50 XP',      reward: { xp: 50 },      weight: 10, color: '#06B6D4' },
  { label: 'Spin Ticket', reward: { spinTicket: 1 }, weight: 3, color: '#EC4899' },
  { label: 'Nothing 😅',  reward: {},               weight: 7, color: '#6B7280' }
];

const spinWheel = () => {
  const totalWeight = SPIN_WHEEL_SEGMENTS.reduce((acc, s) => acc + s.weight, 0);
  let rand = Math.random() * totalWeight;
  for (let i = 0; i < SPIN_WHEEL_SEGMENTS.length; i++) {
    rand -= SPIN_WHEEL_SEGMENTS[i].weight;
    if (rand <= 0) {
      return { segmentIndex: i, ...SPIN_WHEEL_SEGMENTS[i] };
    }
  }
  return { segmentIndex: 0, ...SPIN_WHEEL_SEGMENTS[0] };
};

// ─── Expanded Badge Definitions ───
const badgesList = [
  // Login Badges
  { name: 'First Login',        icon: '🌟', description: 'Log in for the first time', rarity: 'Common',    check: (u) => (u.dailyLoginStreak || 0) >= 1 },
  { name: 'Weekly Warrior',     icon: '📅', description: '7-day login streak',        rarity: 'Common',    check: (u) => (u.dailyLoginStreak || 0) >= 7 },
  { name: 'Monthly Devotee',    icon: '📆', description: '30-day login streak',       rarity: 'Rare',      check: (u) => (u.dailyLoginStreak || 0) >= 30 },

  // Coding Badges
  { name: 'First Code',         icon: '💡', description: 'Solve your first coding problem',     rarity: 'Common',    check: (u) => (u.totalProblemsSolved || u.totalLeetcodeSubmissions || 0) >= 1 },
  { name: 'Problem Solver',     icon: '🧩', description: 'Solve 10 coding problems',            rarity: 'Common',    check: (u) => (u.totalProblemsSolved || u.totalLeetcodeSubmissions || 0) >= 10 },
  { name: 'Century Coder',      icon: '💯', description: 'Solve 100 coding problems',           rarity: 'Rare',      check: (u) => (u.totalProblemsSolved || u.totalLeetcodeSubmissions || 0) >= 100 },
  { name: 'Code Warrior',       icon: '⚔️', description: 'Solve 500 coding problems',           rarity: 'Epic',      check: (u) => (u.totalProblemsSolved || u.totalLeetcodeSubmissions || 0) >= 500 },
  { name: 'Coding Titan',       icon: '🗡️', description: 'Solve 1000 coding problems',          rarity: 'Legendary', check: (u) => (u.totalProblemsSolved || u.totalLeetcodeSubmissions || 0) >= 1000 },

  // Streak Badges
  { name: 'Streak Rookie',      icon: '🔥', description: '5-day coding streak',                rarity: 'Common',    check: (u) => (u.codingStreak || u.leetcodeStreak || 0) >= 5 },
  { name: 'Streak Master',      icon: '⚡', description: '15-day coding streak',               rarity: 'Rare',      check: (u) => (u.codingStreak || u.leetcodeStreak || 0) >= 15 },
  { name: 'Coding Legend',      icon: '🔥', description: '30-day coding streak',               rarity: 'Epic',      check: (u) => (u.codingStreak || u.leetcodeStreak || 0) >= 30 },
  { name: 'Coding Master',      icon: '💻', description: '100-day coding streak',              rarity: 'Legendary', check: (u) => (u.codingStreak || u.leetcodeStreak || 0) >= 100 },

  // Attendance Badges
  { name: 'Punctual Student',   icon: '⏰', description: '7-day attendance streak',            rarity: 'Common',    check: (u) => (u.attendanceStreak || 0) >= 7 },
  { name: 'Perfect Attendance', icon: '📋', description: '30-day attendance streak',           rarity: 'Rare',      check: (u) => (u.attendanceStreak || 0) >= 30 },

  // Wealth Badges
  { name: 'Coin Collector',     icon: '🪙', description: 'Accumulate 100 coins',               rarity: 'Common',    check: (u) => (u.coins || 0) >= 100 },
  { name: 'Rich Student',       icon: '💰', description: 'Accumulate 500 coins',               rarity: 'Common',    check: (u) => (u.coins || 0) >= 500 },
  { name: 'Treasure Hunter',    icon: '💎', description: 'Accumulate 2000 coins',              rarity: 'Rare',      check: (u) => (u.coins || 0) >= 2000 },
  { name: 'Millionaire',        icon: '🤑', description: 'Accumulate 10000 coins',             rarity: 'Epic',      check: (u) => (u.coins || 0) >= 10000 },

  // Level Badges
  { name: 'Level 5',            icon: '⭐', description: 'Reach Level 5',                      rarity: 'Common',    check: (u) => (u.level || 1) >= 5 },
  { name: 'Level 10',           icon: '🌟', description: 'Reach Level 10',                     rarity: 'Common',    check: (u) => (u.level || 1) >= 10 },
  { name: 'Level 25',           icon: '✨', description: 'Reach Level 25',                     rarity: 'Rare',      check: (u) => (u.level || 1) >= 25 },
  { name: 'Level 50',           icon: '🌠', description: 'Reach Level 50',                     rarity: 'Epic',      check: (u) => (u.level || 1) >= 50 },

  // Shop Badges
  { name: 'Shopaholic',         icon: '🛍️', description: 'Unlock 5 or more items',             rarity: 'Common',    check: (u) => (u.unlockedAvatars || []).length >= 5 },
  { name: 'Collector',          icon: '🎭', description: 'Unlock 15 items total',              rarity: 'Rare',      check: (u) => {
    const total = (u.unlockedAvatars || []).length + (u.unlockedBorders || []).length + (u.unlockedTitles || []).length;
    return total >= 15;
  }},

  // Mentor Badges
  { name: 'Appreciated',        icon: '🌺', description: 'Receive 10 mentor appreciation points', rarity: 'Common', check: (u) => (u.mentorPoints || 0) >= 10 },
  { name: "Mentor's Choice",    icon: '👨‍🏫', description: 'Receive 50 mentor appreciation points', rarity: 'Rare',   check: (u) => (u.mentorPoints || 0) >= 50 },

  // League Badges
  { name: 'Silver League',      icon: '🥈', description: 'Reach Silver league',                rarity: 'Common',    check: (u) => ['Silver','Gold','Platinum','Diamond','Master','Grandmaster','Legend'].includes(u.league) },
  { name: 'Gold League',        icon: '🥇', description: 'Reach Gold league',                  rarity: 'Rare',      check: (u) => ['Gold','Platinum','Diamond','Master','Grandmaster','Legend'].includes(u.league) },
  { name: 'Diamond League',     icon: '💠', description: 'Reach Diamond league',               rarity: 'Epic',      check: (u) => ['Diamond','Master','Grandmaster','Legend'].includes(u.league) },
  { name: 'Legend League',      icon: '👑', description: 'Reach Legend league',                 rarity: 'Legendary', check: (u) => u.league === 'Legend' }
];

// ─── Secret Achievements ───
const SECRET_ACHIEVEMENTS = [
  { name: 'Night Owl',      icon: '🦉', description: 'Log in after midnight for 7 days',        rarity: 'Rare' },
  { name: 'Weekend Warrior', icon: '🏋️', description: 'Complete tasks on 10 weekends',           rarity: 'Rare' },
  { name: 'Bug Hunter',     icon: '🐛', description: 'Fix 50 bugs (rejected then accepted)',    rarity: 'Epic' },
  { name: 'Marathon Coder',  icon: '🏃', description: '8-hour continuous coding session',        rarity: 'Epic' },
  { name: 'Perfectionist',  icon: '💯', description: 'Score 100% on 20 tasks',                 rarity: 'Legendary' },
  { name: 'Never Give Up',  icon: '💪', description: 'Fail 5 mock drives then pass one',       rarity: 'Epic' },
  { name: 'Silent Genius',  icon: '🤫', description: 'Top 5 rank with perfect attendance',     rarity: 'Legendary' }
];

const checkAndAwardBadges = (user) => {
  let newBadges = [];
  const currentBadgeNames = new Set((user.badges || []).map(b => b.name));

  badgesList.forEach(badge => {
    if (!currentBadgeNames.has(badge.name) && badge.check(user)) {
      const newBadge = {
        name: badge.name,
        icon: badge.icon,
        description: badge.description,
        rarity: badge.rarity || 'Common',
        unlockedAt: new Date()
      };
      user.badges.push(newBadge);
      newBadges.push(newBadge);
    }
  });

  return newBadges;
};

// ─── All Available Titles ───
const ALL_TITLES = [
  'Beginner', 'Problem Solver', 'React Ninja', 'SQL Expert',
  'Java Wizard', 'Python Hero', 'Bug Hunter', 'DSA King',
  'Mock Interview Star', 'Placement Ready', 'Top Performer',
  'Code Wizard', 'Night Owl', 'Early Bird', 'Full Stack Dev'
];

// ─── All Available Borders ───
const ALL_BORDERS = [
  { id: 'bronze-glow',    name: 'Bronze Glow',    rarity: 'Common',    css: 'border-2 border-amber-700 shadow-amber-700/50 shadow-md' },
  { id: 'silver-pulse',   name: 'Silver Pulse',   rarity: 'Common',    css: 'border-2 border-slate-400 shadow-slate-400/50 shadow-md animate-pulse' },
  { id: 'gold-shimmer',   name: 'Gold Shimmer',   rarity: 'Rare',      css: 'border-2 border-yellow-400 shadow-yellow-400/50 shadow-lg' },
  { id: 'diamond-sparkle', name: 'Diamond Sparkle', rarity: 'Rare',     css: 'border-2 border-cyan-300 shadow-cyan-300/60 shadow-lg' },
  { id: 'fire-ring',      name: 'Fire Ring',      rarity: 'Epic',      css: 'border-2 border-red-500 shadow-red-500/60 shadow-xl animate-pulse' },
  { id: 'lightning-arc',  name: 'Lightning Arc',  rarity: 'Epic',      css: 'border-2 border-violet-500 shadow-violet-500/60 shadow-xl' },
  { id: 'galaxy-swirl',   name: 'Galaxy Swirl',   rarity: 'Legendary', css: 'border-3 border-transparent bg-gradient-to-r from-purple-500 via-pink-500 to-cyan-500 shadow-2xl' }
];

const checkAndAwardStreakMilestones = (user) => {
  const now = new Date();
  let coinsAwardedTotal = 0;
  let xpAwardedTotal = 0;
  const newItems = [];
  const newBadges = [];

  const GamificationEvent = require('../models/GamificationEvent');

  // 1. Check Coding Streak Milestones
  const codingStreak = user.codingStreak || user.leetcodeStreak || 0;
  if (!user.claimedCodingMilestones) user.claimedCodingMilestones = [];
  
  for (const milestone of CODING_STREAK_MILESTONES) {
    if (codingStreak >= milestone.days && !user.claimedCodingMilestones.includes(milestone.days)) {
      // Award!
      const coins = awardCoinsWithCap(user, milestone.coins, `Coding streak ${milestone.days}-day milestone`, true);
      const xpRes = awardXPWithCap(user, milestone.xp, `Coding streak ${milestone.days}-day milestone`, true);
      coinsAwardedTotal += coins;
      xpAwardedTotal += xpRes.actual;
      
      user.claimedCodingMilestones.push(milestone.days);

      if (milestone.badge) {
        const existing = (user.badges || []).find(b => b.name === milestone.badge.name);
        if (!existing) {
          user.badges.push({ ...milestone.badge, unlockedAt: now });
          newBadges.push(milestone.badge);
        }
      }

      // Award a chest
      if (milestone.days >= 14) {
        const chestType = milestone.days >= 60 ? 'Legendary' : milestone.days >= 30 ? 'Gold' : 'Silver';
        user.treasureChests.push({ type: chestType, earnedAt: now, opened: false });
        newItems.push(`${chestType} Chest`);
      }
      
      // Create Event
      GamificationEvent.create({
        userId: user._id,
        eventType: 'streak_milestone',
        coinsChange: coins,
        xpChange: xpRes.actual,
        reason: `Reached ${milestone.days}-day coding streak milestone`,
        metadata: { type: 'coding', days: milestone.days }
      }).catch(err => console.error('Failed to log coding milestone event:', err));
    }
  }

  // 2. Check Attendance Streak Milestones
  const attendanceStreak = user.attendanceStreak || 0;
  if (!user.claimedAttendanceMilestones) user.claimedAttendanceMilestones = [];

  for (const milestone of ATTENDANCE_MILESTONES) {
    if (attendanceStreak >= milestone.days && !user.claimedAttendanceMilestones.includes(milestone.days)) {
      // Award!
      const coins = awardCoinsWithCap(user, milestone.coins, `Attendance ${milestone.days}-day streak milestone`, true);
      const xpRes = awardXPWithCap(user, milestone.xp, `Attendance ${milestone.days}-day streak milestone`, true);
      coinsAwardedTotal += coins;
      xpAwardedTotal += xpRes.actual;

      user.claimedAttendanceMilestones.push(milestone.days);

      if (milestone.badge) {
        const existing = (user.badges || []).find(b => b.name === milestone.badge.name);
        if (!existing) {
          user.badges.push({ ...milestone.badge, rarity: milestone.badge.rarity || 'Common', unlockedAt: now });
          newBadges.push(milestone.badge);
        }
      }

      // Create Event
      GamificationEvent.create({
        userId: user._id,
        eventType: 'streak_milestone',
        coinsChange: coins,
        xpChange: xpRes.actual,
        reason: `Reached ${milestone.days}-day attendance streak milestone`,
        metadata: { type: 'attendance', days: milestone.days }
      }).catch(err => console.error('Failed to log attendance milestone event:', err));
    }
  }

  return { coinsAwardedTotal, xpAwardedTotal, newItems, newBadges };
};

module.exports = {
  LEVEL_THRESHOLDS,
  calculateLevel,
  LEAGUES,
  getLeagueForLevel,
  DAILY_LOGIN_REWARDS,
  CODING_STREAK_MILESTONES,
  ATTENDANCE_MILESTONES,
  DAILY_COIN_CAP,
  DAILY_XP_CAP,
  isSameDay,
  isYesterday,
  awardCoinsWithCap,
  awardXPWithCap,
  addRewardHistory,
  CHEST_TYPES,
  openChest,
  SPIN_WHEEL_SEGMENTS,
  spinWheel,
  badgesList,
  SECRET_ACHIEVEMENTS,
  checkAndAwardBadges,
  ALL_TITLES,
  ALL_BORDERS,
  checkAndAwardStreakMilestones
};
