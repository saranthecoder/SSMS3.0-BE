const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  // ─── Core Profile ───
  name: { type: String, required: [true, 'Please add a name'] },
  email: {
    type: String, required: [true, 'Please add an email'], unique: true, lowercase: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please add a valid email']
  },
  password: { type: String, required: [true, 'Please add a password'], minlength: 6, select: false },
  role: { type: String, enum: ['student', 'mentor', 'admin'], default: 'student' },
  rollNumber: { type: String, default: '', index: true },
  isProfileComplete: { type: Boolean, default: false },
  profileImage: { type: String, default: '/logo.png' },
  phone: { type: String, default: '' },
  github: { type: String, default: '' },
  linkedin: { type: String, default: '' },
  portfolio: { type: String, default: '' },
  leetcode: { type: String, default: '' },
  hackerrank: { type: String, default: '' },

  // ─── LeetCode Tracking ───
  leetcodeStreak: { type: Number, default: 0 },
  lastLeetcodeSubmissionDate: { type: Date, default: null },
  totalLeetcodeSubmissions: { type: Number, default: 0 },

  // ─── Gamification Core ───
  coins: { type: Number, default: 0 },
  points: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  league: { type: String, default: 'Bronze', enum: ['Bronze','Silver','Gold','Platinum','Diamond','Master','Grandmaster','Legend'] },

  // ─── Equipped Cosmetics ───
  equippedAvatar: { type: String, default: '/logo.png' },
  currentTitle: { type: String, default: '' },
  profileBorder: { type: String, default: '' },
  currentTheme: { type: String, default: 'Emerald' },
  currentNamecolor: { type: String, default: '' },
  equippedPet: { type: String, default: '' },
  equippedEffect: { type: String, default: '' },

  // ─── Inventory (unlocked items by category) ───
  unlockedAvatars: { type: [String], default: ['/logo.png'] },
  unlockedBorders: { type: [String], default: [] },
  unlockedTitles: { type: [String], default: [] },
  unlockedThemes: { type: [String], default: ['Emerald'] },
  unlockedEffects: { type: [String], default: [] },
  unlockedNamecolors: { type: [String], default: [] },
  unlockedPets: { type: [String], default: [] },
  unlockedEmojis: { type: [String], default: [] },

  // ─── Badges ───
  badges: [{
    name: String,
    icon: String,
    description: String,
    rarity: { type: String, default: 'Common', enum: ['Common','Rare','Epic','Legendary','Mythic'] },
    unlockedAt: { type: Date, default: Date.now }
  }],

  // ─── Daily Login System ───
  dailyLoginStreak: { type: Number, default: 0 },
  lastLoginReward: { type: Date, default: null },

  // ─── Coding Streak ───
  codingStreak: { type: Number, default: 0 },
  maxCodingStreak: { type: Number, default: 0 },
  lastSolvedDate: { type: Date, default: null },

  // ─── Attendance Streak ───
  attendanceStreak: { type: Number, default: 0 },
  lastAttendanceDate: { type: Date, default: null },

  // ─── Totals ───
  totalProblemsSolved: { type: Number, default: 0 },
  totalProjectsCompleted: { type: Number, default: 0 },

  // ─── XP Breakdown ───
  weeklyXP: { type: Number, default: 0 },
  monthlyXP: { type: Number, default: 0 },
  seasonXP: { type: Number, default: 0 },

  // ─── Treasure Chests ───
  treasureChests: [{
    type: { type: String, enum: ['Bronze','Silver','Gold','Diamond','Legendary'] },
    earnedAt: { type: Date, default: Date.now },
    opened: { type: Boolean, default: false }
  }],

  // ─── Spin Wheel ───
  spinTickets: { type: Number, default: 0 },
  lastDailySpinDate: { type: Date, default: null },

  // ─── Mentor Appreciation ───
  mentorPoints: { type: Number, default: 0 },

  // ─── Milestones Claimed ───
  claimedCodingMilestones: { type: [Number], default: [] },
  claimedAttendanceMilestones: { type: [Number], default: [] },

  // ─── Last Seen (Chat) ───
  lastSeen: { type: Date, default: null },

  // ─── Social / Sharing ───
  lastSharedCoinsDate: { type: Date, default: null },

  // ─── Anti-Cheat / Fair Play ───
  fairPlayScore: { type: Number, default: 100 },
  dailyCoinsCap: {
    today: { type: Date, default: null },
    earned: { type: Number, default: 0 }
  },
  dailyXPCap: {
    today: { type: Date, default: null },
    earned: { type: Number, default: 0 }
  },

  // ─── Achievement Progress (key = achievementId, value = progress 0-100) ───
  achievementProgress: { type: Map, of: Number, default: {} },

  // ─── Secret Achievements ───
  secretAchievements: [{ name: String, icon: String, description: String, unlockedAt: Date }],

  // ─── Reward History (last 100 entries kept in user doc for quick access) ───
  rewardHistory: [{
    type: { type: String },
    amount: Number,
    reason: String,
    date: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

userSchema.index({ role: 1 });

// Encrypt password using bcrypt
userSchema.pre('save', async function() {
  if (!this.isModified('password')) {
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Match user entered password to hashed password in database
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
