const mongoose = require('mongoose');
const User = require('../models/User');
const LeetcodeSubmission = require('../models/LeetcodeSubmission');
const Enrollment = require('../models/Enrollment');
const Batch = require('../models/Batch');
const StudentAccessLog = require('../models/StudentAccessLog');
const generateToken = require('../utils/generateToken');
const socketHandlers = require('../sockets/socketHandlers');
const { invalidateUserCache } = require('../middleware/authMiddleware');

// @desc    Auth user & get token
// @route   POST /api/auth/login
// @access  Public
const loginUser = async (req, res) => {
  try {
    const { email, rollNumber, registerNumber, identifier, password } = req.body;
    const inputId = (identifier || rollNumber || registerNumber || email || '').toString().trim();

    if (!inputId || !password) {
      return res.status(400).json({ message: 'Please provide Register Number / Email and password' });
    }

    // Search by indexed equality first (O(1) index seek for rollNumber/email)
    const cleanId = inputId.trim();
    let user = await User.findOne({
      $or: [
        { rollNumber: cleanId },
        { rollNumber: cleanId.toUpperCase() },
        { rollNumber: cleanId.toLowerCase() },
        { email: cleanId.toLowerCase() }
      ]
    }).select('+password');

    // Fallback to case-insensitive regex only if direct index seek did not match
    if (!user) {
      user = await User.findOne({
        $or: [
          { rollNumber: { $regex: new RegExp(`^${cleanId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
          { email: cleanId.toLowerCase() }
        ]
      }).select('+password');
    }

    if (user && (await user.matchPassword(password))) {
      // Check block & suspension status for student accounts
      if (user.role === 'student') {
        if (user.isBlocked) {
          return res.status(403).json({
            message: `Account Blocked: Your access to the student panel has been revoked by a mentor/admin. Reason: ${user.blockReason || 'Disciplinary hold'}`,
            isBlocked: true,
            blockReason: user.blockReason,
            blockedAt: user.blockedAt
          });
        }

        if (user.isSuspended && user.suspendedUntil) {
          const now = new Date();
          if (new Date(user.suspendedUntil) > now) {
            return res.status(403).json({
              message: `Account Suspended: You are temporarily suspended from accessing the student panel until ${new Date(user.suspendedUntil).toLocaleString()}. Reason: ${user.suspensionReason || 'Disciplinary hold'}`,
              isSuspended: true,
              suspendedUntil: user.suspendedUntil,
              suspensionReason: user.suspensionReason,
              suspendedAt: user.suspendedAt
            });
          } else {
            // Expired, clear suspension
            user.isSuspended = false;
            user.suspendedUntil = null;
            user.suspensionReason = '';
            user.suspendedAt = null;
            user.suspendedBy = null;
            await user.save();
          }
        }
      }

      const token = generateToken(res, user._id);

      res.json({
        _id: user._id,
        token,
        name: user.name,
        email: user.email,
        role: user.role,
        profileImage: user.profileImage,
        equippedAvatar: user.equippedAvatar,
        rollNumber: user.rollNumber,
        isProfileComplete: user.isProfileComplete,
        phone: user.phone,
        github: user.github,
        linkedin: user.linkedin,
        portfolio: user.portfolio,
        leetcode: user.leetcode,
        hackerrank: user.hackerrank,
        leetcodeStreak: user.leetcodeStreak,
        totalLeetcodeSubmissions: user.totalLeetcodeSubmissions,
      });
    } else {
      res.status(401).json({ message: 'Invalid credentials. Please check your Register Number / Email and password.' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
const registerUser = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const normalizedEmail = email ? email.toLowerCase().trim() : '';

    const userExists = await User.findOne({ email: normalizedEmail });

    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const user = await User.create({
      name,
      email: normalizedEmail,
      password,
      role: role || 'student',
    });

    if (user) {
      generateToken(res, user._id);

      const totalSubmissions = await LeetcodeSubmission.countDocuments({ studentId: user._id });
      // Update the user document if it's out of sync
      if (user.totalLeetcodeSubmissions !== totalSubmissions) {
        user.totalLeetcodeSubmissions = totalSubmissions;
        await user.save();
      }

      res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        profileImage: user.profileImage,
        equippedAvatar: user.equippedAvatar,
        rollNumber: user.rollNumber,
        isProfileComplete: user.isProfileComplete,
        phone: user.phone,
        github: user.github,
        linkedin: user.linkedin,
        portfolio: user.portfolio,
        leetcode: user.leetcode,
        hackerrank: user.hackerrank,
        leetcodeStreak: user.leetcodeStreak,
        totalLeetcodeSubmissions: totalSubmissions,
      });
    } else {
      res.status(400).json({ message: 'Invalid user data' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Logout user / clear cookie
// @route   POST /api/auth/logout
// @access  Public
const logoutUser = (req, res) => {
  res.cookie('jwt', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    expires: new Date(0),
  });
  res.status(200).json({ message: 'Logged out successfully' });
};

// @desc    Get user profile
// @route   GET /api/auth/profile
// @access  Private
const getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (user) {
      const totalSubmissions = await LeetcodeSubmission.countDocuments({ studentId: user._id });
      if (user.totalLeetcodeSubmissions !== totalSubmissions) {
        user.totalLeetcodeSubmissions = totalSubmissions;
        await user.save();
      }

      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        profileImage: user.profileImage,
        equippedAvatar: user.equippedAvatar,
        rollNumber: user.rollNumber,
        isProfileComplete: user.isProfileComplete,
        phone: user.phone,
        github: user.github,
        linkedin: user.linkedin,
        portfolio: user.portfolio,
        leetcode: user.leetcode,
        hackerrank: user.hackerrank,
        leetcodeStreak: user.leetcodeStreak,
        totalLeetcodeSubmissions: totalSubmissions,
      });
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
const updateUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (user) {
      user.name = req.body.name || user.name;
      user.phone = req.body.phone !== undefined ? req.body.phone : user.phone;

      // Roll Number is the permanent primary key for students - prevent mutation by students
      if (user.role !== 'student' && req.body.rollNumber !== undefined) {
        user.rollNumber = req.body.rollNumber;
      }

      user.github = req.body.github !== undefined ? req.body.github : user.github;
      user.linkedin = req.body.linkedin !== undefined ? req.body.linkedin : user.linkedin;
      user.portfolio = req.body.portfolio !== undefined ? req.body.portfolio : user.portfolio;
      user.leetcode = req.body.leetcode !== undefined ? req.body.leetcode : user.leetcode;
      user.hackerrank = req.body.hackerrank !== undefined ? req.body.hackerrank : user.hackerrank;
      
      if (req.body.email && req.body.email.trim() !== '') {
        const newEmail = req.body.email.toLowerCase().trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(newEmail)) {
          return res.status(400).json({ message: 'Please provide a valid email address.' });
        }
        if (newEmail !== user.email) {
          const emailExists = await User.findOne({ email: newEmail, _id: { $ne: user._id } });
          if (emailExists) {
            return res.status(400).json({ message: 'This email address is already in use by another user' });
          }
          user.email = newEmail;
        }
      }
      
      if (req.body.isProfileComplete !== undefined) {
        user.isProfileComplete = req.body.isProfileComplete;
      }
      
      if (req.body.profileImage) {
        user.profileImage = req.body.profileImage;
        user.equippedAvatar = req.body.profileImage;
      }

      if (req.body.password) {
        user.password = req.body.password;
      }

      const updatedUser = await user.save();

      res.json({
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        profileImage: updatedUser.profileImage,
        equippedAvatar: updatedUser.equippedAvatar,
        rollNumber: updatedUser.rollNumber,
        isProfileComplete: updatedUser.isProfileComplete,
        phone: updatedUser.phone,
        github: updatedUser.github,
        linkedin: updatedUser.linkedin,
        portfolio: updatedUser.portfolio,
        leetcode: updatedUser.leetcode,
        hackerrank: updatedUser.hackerrank,
        leetcodeStreak: updatedUser.leetcodeStreak,
        totalLeetcodeSubmissions: updatedUser.totalLeetcodeSubmissions,
      });
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all students
// @route   GET /api/auth/students
// @access  Private/Admin
const getAllStudents = async (req, res) => {
  try {
    const { batchId, page: pageQuery, limit: limitQuery, paginated } = req.query;
    
    let query = { role: 'student' };
    const Enrollment = require('../models/Enrollment');
    const Batch = require('../models/Batch');
    
    if (batchId && batchId !== 'all') {
      const enrollments = await Enrollment.find({ batchId, status: { $regex: /^approved$/i } }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);
      query._id = { $in: studentIds };
    } else if (req.user && req.user.role === 'mentor') {
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id').lean();
      const batchIds = mentorBatches.map(b => b._id);
      const enrollments = await Enrollment.find({ batchId: { $in: batchIds }, status: { $regex: /^approved$/i } }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);
      query._id = { $in: studentIds };
    }
    
    const page = parseInt(pageQuery, 10);
    const limit = parseInt(limitQuery, 10);
    const projection = '-password -rewardHistory -secretAchievements -achievementProgress -dailyCoinsCap -dailyXPCap';

    if (page > 0 && limit > 0) {
      const skip = (page - 1) * limit;
      const [students, total] = await Promise.all([
        User.find(query).select(projection).skip(skip).limit(limit).lean(),
        User.countDocuments(query)
      ]);
      res.setHeader('X-Total-Count', total);
      if (paginated === 'true') {
        return res.json({ students, total, page, totalPages: Math.ceil(total / limit) });
      }
      return res.json(students);
    }
    
    const students = await User.find(query).select(projection).lean();
    res.setHeader('X-Total-Count', students.length);
    res.json(students);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Admin update student password
// @route   PUT /api/auth/students/:id/password
// @access  Private/Admin
const adminUpdateStudentPassword = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('+password');

    if (user && user.role === 'student') {
      const newPass = (req.body.password || '').toString().trim();
      if (!newPass || newPass.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters long' });
      }

      user.password = newPass;
      await user.save();

      res.json({ message: 'Student password updated successfully' });
    } else {
      res.status(404).json({ message: 'Student not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const adminUpdateStudentProfile = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (user && user.role === 'student') {
      if (req.body.leetcodeStreak !== undefined) {
        user.leetcodeStreak = Number(req.body.leetcodeStreak);
        user.codingStreak = Number(req.body.leetcodeStreak);
      }
      if (req.body.name !== undefined) {
        user.name = req.body.name;
      }
      if (req.body.email !== undefined) {
        user.email = req.body.email;
      }
      if (req.body.phone !== undefined) {
        user.phone = req.body.phone;
      }
      if (req.body.rollNumber !== undefined) {
        user.rollNumber = req.body.rollNumber;
      }
      if (req.body.coins !== undefined) {
        user.coins = Number(req.body.coins);
      }
      if (req.body.points !== undefined) {
        user.points = Number(req.body.points);
      }

      await user.save();
      res.json({ success: true, message: 'Student profile updated successfully', user });
    } else {
      res.status(404).json({ message: 'Student not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update student panel access (block, suspend for hours/days, or restore)
// @route   PUT /api/auth/students/:id/access-status
// @access  Private/MentorOrAdmin
const updateStudentAccessStatus = async (req, res) => {
  try {
    const student = await User.findById(req.params.id);
    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student account not found' });
    }

    // If caller is mentor, verify that the student is in one of the mentor's batches
    if (req.user.role === 'mentor') {
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id').lean();
      const batchIds = mentorBatches.map(b => b._id);
      const isEnrolled = await Enrollment.findOne({
        batchId: { $in: batchIds },
        studentId: student._id
      }).lean();

      if (!isEnrolled) {
        return res.status(403).json({ message: 'You can only manage students in your assigned batches' });
      }
    }

    const { action, reason, durationHours, customUntil } = req.body;
    const callerName = req.user.name || (req.user.role === 'mentor' ? 'Mentor' : 'Administrator');

    // Lookup student's enrolled batch for persistent historical logging
    const enrollment = await Enrollment.findOne({ studentId: student._id, status: 'approved' })
      .populate('batchId', 'batchName')
      .lean();
    const batchId = enrollment?.batchId?._id || enrollment?.batchId || null;
    const batchName = enrollment?.batchId?.batchName || '';

    if (action === 'block') {
      student.isBlocked = true;
      student.blockReason = (reason || 'Access revoked by mentor').trim();
      student.blockedAt = new Date();
      student.blockedBy = req.user._id;
      // Clear any suspension
      student.isSuspended = false;
      student.suspendedUntil = null;
      student.suspensionReason = '';
      student.suspendedAt = null;
      student.suspendedBy = null;
      await student.save();

      // Persist access log entry
      try {
        await StudentAccessLog.create({
          studentId: student._id,
          studentName: student.name,
          studentRollNumber: student.rollNumber || '',
          studentEmail: student.email || '',
          batchId,
          batchName,
          action: 'block',
          reason: student.blockReason,
          durationHours: null,
          suspendedUntil: null,
          performedBy: req.user._id,
          performedByName: callerName,
          performedByRole: req.user.role
        });
      } catch (logErr) {
        console.warn('Failed to save StudentAccessLog on block:', logErr.message);
      }

      // Auto check-out active attendance session immediately if student is currently checked in
      try {
        const { autoCheckOutStudent } = require('./attendanceController');
        await autoCheckOutStudent(student._id, `Account blocked: ${student.blockReason}`);
      } catch (checkOutErr) {
        console.warn('Auto checkout failed on block:', checkOutErr.message);
      }

      invalidateUserCache(student._id);

      // Real-time socket kick-out
      try {
        const payload = {
          studentId: student._id,
          action: 'block',
          isBlocked: true,
          reason: student.blockReason,
          by: callerName,
          timestamp: new Date()
        };
        socketHandlers.emitToUser(student._id.toString(), 'account-access-restricted', payload);
        socketHandlers.emitToUser(student._id.toString(), 'force-checkout', { reason: student.blockReason });
      } catch (err) {
        console.warn('Socket notification error on block:', err.message);
      }

      return res.json({
        success: true,
        message: `${student.name}'s panel access has been blocked.`,
        student: {
          _id: student._id,
          name: student.name,
          isBlocked: student.isBlocked,
          blockReason: student.blockReason,
          isSuspended: student.isSuspended,
          suspendedUntil: student.suspendedUntil
        }
      });
    } else if (action === 'suspend') {
      let untilDate;
      if (customUntil) {
        untilDate = new Date(customUntil);
      } else {
        const hours = Number(durationHours) || 24;
        untilDate = new Date(Date.now() + hours * 3600 * 1000);
      }

      if (isNaN(untilDate.getTime()) || untilDate <= new Date()) {
        return res.status(400).json({ message: 'Please provide a valid suspension duration or future date' });
      }

      student.isSuspended = true;
      student.suspendedUntil = untilDate;
      student.suspensionReason = (reason || 'Disciplinary hold').trim();
      student.suspendedAt = new Date();
      student.suspendedBy = req.user._id;
      // Clear permanent block
      student.isBlocked = false;
      student.blockReason = '';
      student.blockedAt = null;
      student.blockedBy = null;
      await student.save();

      const calculatedHours = customUntil
        ? Math.max(1, Math.round((untilDate.getTime() - Date.now()) / (3600 * 1000)))
        : (Number(durationHours) || 24);

      // Persist access log entry
      try {
        await StudentAccessLog.create({
          studentId: student._id,
          studentName: student.name,
          studentRollNumber: student.rollNumber || '',
          studentEmail: student.email || '',
          batchId,
          batchName,
          action: 'suspend',
          reason: student.suspensionReason,
          durationHours: calculatedHours,
          suspendedUntil: untilDate,
          performedBy: req.user._id,
          performedByName: callerName,
          performedByRole: req.user.role
        });
      } catch (logErr) {
        console.warn('Failed to save StudentAccessLog on suspend:', logErr.message);
      }

      // Auto check-out active attendance session immediately if student is currently checked in
      try {
        const { autoCheckOutStudent } = require('./attendanceController');
        await autoCheckOutStudent(student._id, `Account suspended: ${student.suspensionReason}`);
      } catch (checkOutErr) {
        console.warn('Auto checkout failed on suspend:', checkOutErr.message);
      }

      invalidateUserCache(student._id);

      // Real-time socket kick-out
      try {
        const payload = {
          studentId: student._id,
          action: 'suspend',
          isSuspended: true,
          suspendedUntil: student.suspendedUntil,
          reason: student.suspensionReason,
          by: callerName,
          timestamp: new Date()
        };
        socketHandlers.emitToUser(student._id.toString(), 'account-access-restricted', payload);
        socketHandlers.emitToUser(student._id.toString(), 'force-checkout', { reason: student.suspensionReason });
      } catch (err) {
        console.warn('Socket notification error on suspend:', err.message);
      }

      return res.json({
        success: true,
        message: `${student.name} is suspended until ${untilDate.toLocaleString()}.`,
        student: {
          _id: student._id,
          name: student.name,
          isBlocked: student.isBlocked,
          blockReason: student.blockReason,
          isSuspended: student.isSuspended,
          suspendedUntil: student.suspendedUntil,
          suspensionReason: student.suspensionReason
        }
      });
    } else if (action === 'restore' || action === 'unblock') {
      student.isBlocked = false;
      student.blockReason = '';
      student.blockedAt = null;
      student.blockedBy = null;
      student.isSuspended = false;
      student.suspendedUntil = null;
      student.suspensionReason = '';
      student.suspendedAt = null;
      student.suspendedBy = null;
      await student.save();

      // Persist access log entry
      try {
        await StudentAccessLog.create({
          studentId: student._id,
          studentName: student.name,
          studentRollNumber: student.rollNumber || '',
          studentEmail: student.email || '',
          batchId,
          batchName,
          action: 'restore',
          reason: (reason || 'Access restored by mentor/admin').trim(),
          durationHours: null,
          suspendedUntil: null,
          performedBy: req.user._id,
          performedByName: callerName,
          performedByRole: req.user.role
        });
      } catch (logErr) {
        console.warn('Failed to save StudentAccessLog on restore:', logErr.message);
      }

      invalidateUserCache(student._id);

      // Real-time socket notification of access restoration
      try {
        socketHandlers.emitToUser(student._id.toString(), 'account-access-restored', {
          studentId: student._id,
          message: 'Your panel access has been restored by your mentor/admin.',
          by: callerName,
          timestamp: new Date()
        });
      } catch (err) {
        console.warn('Socket notification error on restore:', err.message);
      }

      return res.json({
        success: true,
        message: `${student.name}'s panel access has been successfully restored.`,
        student: {
          _id: student._id,
          name: student.name,
          isBlocked: false,
          isSuspended: false,
          suspendedUntil: null
        }
      });
    } else {
      return res.status(400).json({ message: 'Invalid action. Supported actions: block, suspend, restore' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get student access and suspension history logs
// @route   GET /api/auth/student-access-logs
// @access  Private (student, mentor, admin)
const getStudentAccessLogs = async (req, res) => {
  try {
    const userRole = req.user.role;
    let query = {};

    if (userRole === 'student') {
      // Student only sees their own logs
      query.studentId = req.user._id;
    } else if (userRole === 'mentor') {
      const uId = req.user._id;
      const uIdStr = uId ? uId.toString() : '';
      const uObjId = mongoose.Types.ObjectId.isValid(uId) ? new mongoose.Types.ObjectId(uId) : null;
      
      const orBatchQuery = [];
      if (uObjId) orBatchQuery.push({ mentorId: uObjId }, { mentors: uObjId });
      if (uIdStr) orBatchQuery.push({ mentorId: uIdStr }, { mentors: uIdStr });

      const mentorBatches = await Batch.find({ $or: orBatchQuery }).select('_id').lean();
      const batchIds = mentorBatches.map(b => b._id);
      const enrollments = await Enrollment.find({
        batchId: { $in: batchIds },
        status: { $regex: /^approved$/i }
      }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);

      query = {
        $or: [
          { batchId: { $in: batchIds } },
          { studentId: { $in: studentIds } },
          { performedBy: req.user._id }
        ]
      };

      if (req.query.batchId && req.query.batchId !== 'all') {
        const targetBatchId = req.query.batchId;
        const targetBatchObjId = mongoose.Types.ObjectId.isValid(targetBatchId) ? new mongoose.Types.ObjectId(targetBatchId) : null;
        query = {
          $and: [
            query,
            {
              $or: [
                { batchId: targetBatchId },
                ...(targetBatchObjId ? [{ batchId: targetBatchObjId }] : [])
              ]
            }
          ]
        };
      }

      if (req.query.studentId) {
        query = {
          $and: [
            query,
            { studentId: req.query.studentId }
          ]
        };
      }
    } else if (userRole === 'admin') {
      if (req.query.studentId) {
        query.studentId = req.query.studentId;
      }
      if (req.query.batchId && req.query.batchId !== 'all') {
        const targetBatchId = req.query.batchId;
        const targetBatchObjId = mongoose.Types.ObjectId.isValid(targetBatchId) ? new mongoose.Types.ObjectId(targetBatchId) : null;
        query.batchId = targetBatchObjId ? { $in: [targetBatchId, targetBatchObjId] } : targetBatchId;
      }
      if (req.query.action) {
        query.action = req.query.action;
      }
    } else {
      return res.status(403).json({ message: 'Access denied' });
    }

    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const logs = await StudentAccessLog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json(logs);
  } catch (error) {
    console.error('Error fetching student access logs:', error);
    res.status(500).json({ message: 'Failed to fetch access logs' });
  }
};

module.exports = {
  loginUser,
  registerUser,
  logoutUser,
  getUserProfile,
  updateUserProfile,
  getAllStudents,
  adminUpdateStudentPassword,
  adminUpdateStudentProfile,
  updateStudentAccessStatus,
  getStudentAccessLogs
};
