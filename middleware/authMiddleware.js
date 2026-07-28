const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let userId = req.headers['x-user-id'] || req.query.userId;

  if (!userId && req.cookies && req.cookies.jwt) {
    try {
      const decoded = jwt.verify(req.cookies.jwt, process.env.JWT_SECRET);
      userId = decoded.id;
    } catch (error) {}
  }

  if (userId) {
    try {
      req.user = await User.findById(userId).select('-password');
      if (req.user) {
        return next();
      }
    } catch (error) {
      console.error(error);
    }
  }
  
  res.status(401).json({ message: 'Not authorized, no valid user ID or token' });
};

// Admin middleware
const admin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Not authorized as an admin' });
  }
};

// Mentor middleware
const mentor = (req, res, next) => {
  if (req.user && req.user.role === 'mentor') {
    next();
  } else {
    res.status(403).json({ message: 'Not authorized as a mentor' });
  }
};

// Admin or Mentor middleware
const mentorOrAdmin = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'mentor')) {
    next();
  } else {
    res.status(403).json({ message: 'Not authorized as admin or mentor' });
  }
};

module.exports = { protect, admin, mentor, mentorOrAdmin };
