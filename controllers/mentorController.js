const User = require('../models/User');
const Batch = require('../models/Batch');

// @desc    Create a new Mentor account
// @route   POST /api/mentors
// @access  Private/Admin
const createMentor = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    const normalizedEmail = email ? email.toLowerCase().trim() : '';

    if (!normalizedEmail || !password || !name) {
      return res.status(400).json({ message: 'Please fill all required fields (name, email, password)' });
    }

    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    const mentor = await User.create({
      name,
      email: normalizedEmail,
      password,
      role: 'mentor',
      phone: phone || ''
    });

    res.status(201).json({
      _id: mentor._id,
      name: mentor.name,
      email: mentor.email,
      role: mentor.role,
      phone: mentor.phone
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all mentors with assigned batches
// @route   GET /api/mentors
// @access  Private/Admin
const getMentors = async (req, res) => {
  try {
    const mentors = await User.find({ role: 'mentor' }).select('-password').lean();
    
    // Attach assigned batches to each mentor
    const mentorsWithBatches = await Promise.all(
      mentors.map(async (m) => {
        const assignedBatches = await Batch.find({ mentorId: m._id }).select('batchName status').lean();
        return {
          ...m,
          assignedBatches
        };
      })
    );

    res.json(mentorsWithBatches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update a mentor profile/password
// @route   PUT /api/mentors/:id
// @access  Private/Admin
const updateMentor = async (req, res) => {
  try {
    const mentor = await User.findById(req.params.id);

    if (!mentor || mentor.role !== 'mentor') {
      return res.status(404).json({ message: 'Mentor not found' });
    }

    if (req.body.name) mentor.name = req.body.name;
    if (req.body.email) mentor.email = req.body.email.toLowerCase().trim();
    if (req.body.phone !== undefined) mentor.phone = req.body.phone;
    if (req.body.password && req.body.password.length >= 6) {
      mentor.password = req.body.password;
    }

    await mentor.save();

    res.json({
      _id: mentor._id,
      name: mentor.name,
      email: mentor.email,
      role: mentor.role,
      phone: mentor.phone
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete a mentor
// @route   DELETE /api/mentors/:id
// @access  Private/Admin
const deleteMentor = async (req, res) => {
  try {
    const mentor = await User.findById(req.params.id);

    if (!mentor || mentor.role !== 'mentor') {
      return res.status(404).json({ message: 'Mentor not found' });
    }

    // Unassign from batches
    await Batch.updateMany({ mentorId: mentor._id }, { mentorId: null });

    await mentor.deleteOne();
    res.json({ message: 'Mentor account deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createMentor,
  getMentors,
  updateMentor,
  deleteMentor
};
