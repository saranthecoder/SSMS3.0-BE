const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config();

const User = require('./models/User');

async function checkUser() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');

  const users = await User.find({ role: 'student' }).limit(10);
  console.log('Students in database:', users.map(u => ({ name: u.name, email: u.email })));
  
  const user = await User.findOne({ name: /Chethan/i });
  if (!user) {
    console.log('User not found');
  } else {
    const req = { user: { _id: user._id, role: 'student' } };
    const res = {
      json: (data) => console.log('Gamification Status Response:', JSON.stringify(data, null, 2)),
      status: (code) => ({ json: (data) => console.log(`API Error ${code}:`, data) })
    };
    const { getGamificationStatus } = require('./controllers/gamificationController');
    try {
      await getGamificationStatus(req, res);
    } catch (err) {
      console.error('CRASH ERROR:', err);
    }
  }
  await mongoose.disconnect();
}

checkUser();
