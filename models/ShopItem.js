const mongoose = require('mongoose');

const shopItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: {
    type: String, required: true,
    enum: ['avatar', 'border', 'title', 'theme', 'effect', 'pet', 'namecolor', 'emoji']
  },
  rarity: {
    type: String, default: 'Common',
    enum: ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic']
  },
  cost: { type: Number, required: true, default: 0 },
  isPurchasable: { type: Boolean, default: true },
  achievementRequired: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  value: { type: String, default: '' },  // The actual CSS class, URL, or title string
  description: { type: String, default: '' },
  isLimited: { type: Boolean, default: false },
  availableUntil: { type: Date, default: null },
  isActive: { type: Boolean, default: true },
  requiredLevel: { type: Number, default: 1 },
  sortOrder: { type: Number, default: 0 }
}, {
  timestamps: true
});

shopItemSchema.index({ category: 1, isActive: 1 });

module.exports = mongoose.model('ShopItem', shopItemSchema);
