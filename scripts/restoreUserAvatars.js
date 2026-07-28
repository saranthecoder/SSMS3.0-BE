const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');

const restoreUserAvatars = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://saranthecodder:saransaran@cluster0.hz2ibvp.mongodb.net/lms';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB for restoring user avatars...');

    const users = await User.find({});
    let restoredCount = 0;

    for (let u of users) {
      // Find valid unlocked avatar if present (e.g. /avatars/tom.png)
      const validUnlocked = (u.unlockedAvatars || []).filter(
        a => a && !a.includes('dicebear') && !a.includes('bottts') && a !== '/logo.png' && a !== 'default.jpg'
      );

      let targetAvatar = null;

      // Priority 1: User's profileImage if it's a real custom upload
      if (u.profileImage && u.profileImage !== '/logo.png' && u.profileImage !== 'default.jpg' && !u.profileImage.includes('dicebear')) {
        targetAvatar = u.profileImage;
      } 
      // Priority 2: Equipped avatar if valid custom photo/avatar
      else if (u.equippedAvatar && u.equippedAvatar !== '/logo.png' && u.equippedAvatar !== 'default.jpg' && !u.equippedAvatar.includes('dicebear')) {
        targetAvatar = u.equippedAvatar;
      } 
      // Priority 3: Last unlocked custom avatar from gamification inventory
      else if (validUnlocked.length > 0) {
        targetAvatar = validUnlocked[validUnlocked.length - 1];
      }

      if (targetAvatar) {
        u.equippedAvatar = targetAvatar;
        if (!u.profileImage || u.profileImage === '/logo.png' || u.profileImage === 'default.jpg') {
          u.profileImage = targetAvatar;
        }
        await u.save();
        restoredCount++;
        console.log(`Restored avatar for ${u.name} (${u.email}): ${targetAvatar}`);
      }
    }

    console.log(`Successfully restored custom profile avatars for ${restoredCount} users!`);
    process.exit(0);
  } catch (err) {
    console.error('Error restoring user avatars:', err);
    process.exit(1);
  }
};

restoreUserAvatars();
