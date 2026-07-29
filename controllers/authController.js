const User = require('../models/User');
const LeetcodeSubmission = require('../models/LeetcodeSubmission');
const generateToken = require('../utils/generateToken');

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

    // Search by rollNumber (case-insensitive exact match) or email
    const user = await User.findOne({
      $or: [
        { rollNumber: { $regex: new RegExp(`^${inputId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
        { email: inputId.toLowerCase() }
      ]
    }).select('+password');

    if (user && (await user.matchPassword(password))) {
      generateToken(res, user._id);

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
      user.rollNumber = req.body.rollNumber !== undefined ? req.body.rollNumber : user.rollNumber;
      user.github = req.body.github !== undefined ? req.body.github : user.github;
      user.linkedin = req.body.linkedin !== undefined ? req.body.linkedin : user.linkedin;
      user.portfolio = req.body.portfolio !== undefined ? req.body.portfolio : user.portfolio;
      user.leetcode = req.body.leetcode !== undefined ? req.body.leetcode : user.leetcode;
      user.hackerrank = req.body.hackerrank !== undefined ? req.body.hackerrank : user.hackerrank;
      
      if (req.body.email && req.body.email.trim() !== '') {
        const newEmail = req.body.email.toLowerCase().trim();
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
    const { batchId } = req.query;
    
    let query = { role: 'student' };
    
    if (batchId) {
      const Enrollment = require('../models/Enrollment');
      const enrollments = await Enrollment.find({ batchId, status: 'approved' });
      const studentIds = enrollments.map(e => e.studentId);
      query._id = { $in: studentIds };
    } else if (req.user && req.user.role === 'mentor') {
      const Batch = require('../models/Batch');
      const mentorBatches = await Batch.find({ mentorId: req.user._id });
      const batchIds = mentorBatches.map(b => b._id);
      const Enrollment = require('../models/Enrollment');
      const enrollments = await Enrollment.find({ batchId: { $in: batchIds }, status: 'approved' });
      const studentIds = enrollments.map(e => e.studentId);
      query._id = { $in: studentIds };
    }
    
    const students = await User.find(query).select('-password');
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
    const user = await User.findById(req.params.id);

    if (user && user.role === 'student') {
      if (!req.body.password || req.body.password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters long' });
      }

      user.password = req.body.password;
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

module.exports = {
  loginUser,
  registerUser,
  logoutUser,
  getUserProfile,
  updateUserProfile,
  getAllStudents,
  adminUpdateStudentPassword,
  adminUpdateStudentProfile,
};
