const mongoose = require('mongoose');

const weeklyMissionSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  type: {
    type: String, required: true,
    enum: ['solve_problems', 'complete_tasks', 'attend_classes', 'submit_assignments', 'login_daily', 'earn_xp', 'custom']
  },
  target: { type: Number, required: true },            // e.g. solve 5 problems
  reward: {
    coins: { type: Number, default: 0 },
    xp: { type: Number, default: 0 },
    badge: { name: String, icon: String, description: String },
    chestType: { type: String, enum: ['Bronze','Silver','Gold','Diamond','Legendary'], default: null }
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  isActive: { type: Boolean, default: true },
  scope: { type: String, default: 'weekly', enum: ['weekly', 'monthly', 'semester'] },
  participants: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    progress: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    claimed: { type: Boolean, default: false }
  }]
}, {
  timestamps: true
});

weeklyMissionSchema.index({ isActive: 1, startDate: 1, endDate: 1 });
weeklyMissionSchema.index({ 'participants.userId': 1 });

module.exports = mongoose.model('WeeklyMission', weeklyMissionSchema);
