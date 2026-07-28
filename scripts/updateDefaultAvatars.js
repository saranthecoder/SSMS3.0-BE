const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');

const updateDefaultAvatars = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://saranthecodder:saransaran@cluster0.hz2ibvp.mongodb.net/lms';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB for avatar update...');

    // Find all users whose profileImage or equippedAvatar is default.jpg or dicebear/bottts
    const result = await User.updateMany(
      {
        $or: [
          { equippedAvatar: { $regex: /dicebear|bottts|default\.jpg/i } },
          { profileImage: { $regex: /dicebear|bottts|default\.jpg/i } },
          { equippedAvatar: '' },
          { profileImage: '' }
        ]
      },
      {
        $set: {
          equippedAvatar: '/logo.png',
          profileImage: '/logo.png'
        }
      }
    );

    console.log(`Updated ${result.modifiedCount || result.nModified || 0} user profile(s) to use /logo.png as default avatar!`);
    process.exit(0);
  } catch (err) {
    console.error('Error updating avatars:', err);
    process.exit(1);
  }
};

updateDefaultAvatars();
