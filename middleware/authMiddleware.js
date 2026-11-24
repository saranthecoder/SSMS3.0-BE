const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Bounded in-memory user lookup cache to eliminate redundant User.findById queries during concurrent bursts
const userCache = new Map();
const USER_CACHE_TTL_MS = 30000; // 30 seconds

const invalidateUserCache = (userId) => {
  if (userId) {
    userCache.delete(userId.toString());
  } else {
    userCache.clear();
  }
};

const getCachedUser = async (userId) => {
  const now = Date.now();
  const cached = userCache.get(userId);
  if (cached && (now - cached.timestamp) < USER_CACHE_TTL_MS) {
    return cached.user;
  }

  const user = await User.findById(userId).select('-password').lean();
  if (user) {
    // Keep cache bounded to at most 1,000 entries
    if (userCache.size > 1000) {
      const oldestKey = userCache.keys().next().value;
      userCache.delete(oldestKey);
    }
    userCache.set(userId, { user, timestamp: now });
  }
  return user;
};

const protect = async (req, res, next) => {
  let userId = req.headers['x-user-id'] || req.query.userId;

  if (!userId && req.cookies && req.cookies.jwt) {
    try {
      const decoded = jwt.verify(req.cookies.jwt, process.env.JWT_SECRET);
      userId = decoded.id;
    } catch (error) {}
  }

  // Also accept Authorization: Bearer <token>
  if (!userId && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.id;
    } catch (error) {}
  }

  if (userId) {
    try {
      const user = await getCachedUser(userId);
      if (user) {
        // Enforce student panel blocking and temporary suspensions
        if (user.role === 'student') {
          // 1. Permanent block
          if (user.isBlocked) {
            return res.status(403).json({
              message: `Your student panel access has been blocked by a mentor/admin: ${user.blockReason || 'Disciplinary hold'}`,
              isBlocked: true,
              blockReason: user.blockReason,
              blockedAt: user.blockedAt
            });
          }

          // 2. Temporary suspension check
          if (user.isSuspended && user.suspendedUntil) {
            const now = new Date();
            if (new Date(user.suspendedUntil) > now) {
              return res.status(403).json({
                message: `Your student panel access has been suspended until ${new Date(user.suspendedUntil).toLocaleString()}. Reason: ${user.suspensionReason || 'Disciplinary hold'}`,
                isSuspended: true,
                suspendedUntil: user.suspendedUntil,
                suspensionReason: user.suspensionReason,
                suspendedAt: user.suspendedAt
              });
            } else {
              // Suspension time elapsed! Auto-lift suspension
              User.findByIdAndUpdate(user._id, {
                isSuspended: false,
                suspendedUntil: null,
                suspensionReason: '',
                suspendedAt: null,
                suspendedBy: null
              }).exec().catch(() => {});
              invalidateUserCache(user._id);
              user.isSuspended = false;
              user.suspendedUntil = null;
              user.suspensionReason = '';
            }
          }
        }

        req.user = user;
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

module.exports = { protect, admin, mentor, mentorOrAdmin, invalidateUserCache };
