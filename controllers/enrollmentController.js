const Enrollment = require('../models/Enrollment');
const Batch = require('../models/Batch');

// @desc    Request batch enrollment
// @route   POST /api/enrollments/request
// @access  Private (Student)
const requestEnrollment = async (req, res) => {
  try {
    const { batchId } = req.body;

    const batch = await Batch.findById(batchId);
    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    const enrollmentExists = await Enrollment.findOne({
      studentId: req.user._id,
      batchId
    });

    if (enrollmentExists) {
      return res.status(400).json({ message: 'Already requested or enrolled in this batch' });
    }

    const enrollment = await Enrollment.create({
      studentId: req.user._id,
      batchId,
      status: 'pending'
    });

    res.status(201).json(enrollment);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get pending enrollments
// @route   GET /api/enrollments/pending
// @access  Private/Admin
const getPendingEnrollments = async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ status: 'pending' })
      .populate('studentId', 'name email profileImage')
      .populate('batchId', 'batchName');

    res.json(enrollments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Approve enrollment
// @route   PUT /api/enrollments/:id/approve
// @access  Private/Admin
const approveEnrollment = async (req, res) => {
  try {
    const enrollment = await Enrollment.findById(req.params.id);

    if (enrollment) {
      enrollment.status = 'approved';
      const updatedEnrollment = await enrollment.save();
      res.json(updatedEnrollment);
    } else {
      res.status(404).json({ message: 'Enrollment request not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Reject enrollment
// @route   PUT /api/enrollments/:id/reject
// @access  Private/Admin
const rejectEnrollment = async (req, res) => {
  try {
    const enrollment = await Enrollment.findById(req.params.id);

    if (enrollment) {
      enrollment.status = 'rejected';
      const updatedEnrollment = await enrollment.save();
      res.json(updatedEnrollment);
    } else {
      res.status(404).json({ message: 'Enrollment request not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get my enrollments
// @route   GET /api/enrollments/my
// @access  Private (Student)
const getMyEnrollments = async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ studentId: req.user._id })
      .populate({
        path: 'batchId',
        populate: {
          path: 'mentorId',
          select: 'name email phone profileImage equippedAvatar'
        }
      });

    res.json(enrollments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all approved enrollments for a specific batch
// @route   GET /api/enrollments/batch/:batchId
// @access  Private/Admin
const getBatchEnrollments = async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ 
      batchId: req.params.batchId,
      status: 'approved'
    }).populate('studentId', 'name email profileImage');

    res.json(enrollments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Remove/Delete an enrollment
// @route   DELETE /api/enrollments/:id
// @access  Private/Admin
const removeEnrollment = async (req, res) => {
  try {
    const enrollment = await Enrollment.findById(req.params.id);

    if (enrollment) {
      await enrollment.deleteOne();
      res.json({ message: 'Enrollment removed' });
    } else {
      res.status(404).json({ message: 'Enrollment not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  requestEnrollment,
  getPendingEnrollments,
  approveEnrollment,
  rejectEnrollment,
  getMyEnrollments,
  getBatchEnrollments,
  removeEnrollment
};
