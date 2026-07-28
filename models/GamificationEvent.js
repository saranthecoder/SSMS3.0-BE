const mongoose = require('mongoose');

const gamificationEventSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  eventType: {
    type: String,
    required: true,
    enum: [
      'coins_earned', 'coins_spent', 'xp_earned',
      'badge_unlocked', 'level_up', 'league_change',
      'daily_login', 'daily_spin', 'chest_opened',
      'item_purchased', 'item_equipped',
      'streak_milestone', 'mission_completed',
      'mentor_appreciation', 'admin_adjustment',
      'attendance_reward', 'coding_reward'
    ]
  },
  coinsChange: { type: Number, default: 0 },
  xpChange: { type: Number, default: 0 },
  reason: { type: String, required: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } // for admin adjustments
}, {
  timestamps: true
});

gamificationEventSchema.index({ userId: 1, createdAt: -1 });
gamificationEventSchema.index({ eventType: 1, createdAt: -1 });

module.exports = mongoose.model('GamificationEvent', gamificationEventSchema);
