const Leave = require('../models/Leave');
const Attendance = require('../models/Attendance');

// @desc    Apply for a leave
// @route   POST /api/leaves
// @access  Private (Student)
const applyLeave = async (req, res) => {
  try {
    const { date, reason, leaveType, startDate, endDate, startTime, endTime, attachmentUrl } = req.body;
    
    // Default to full_day if not provided
    const type = leaveType || 'full_day';
    const sDate = startDate || date;
    
    // Basic validation
    if (!sDate || !reason) {
      return res.status(400).json({ message: 'Start date and reason are required.' });
    }
    if (!attachmentUrl) {
      return res.status(400).json({ message: 'Please upload a PDF leave application letter.' });
    }

    const leave = await Leave.create({
      studentId: req.user._id,
      date: sDate, // for backwards compatibility
      startDate: sDate,
      endDate: type === 'multiple_days' ? endDate : undefined,
      startTime: type === 'hours' ? startTime : undefined,
      endTime: type === 'hours' ? endTime : undefined,
      leaveType: type,
      reason,
      attachmentUrl
    });

    res.status(201).json(leave);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get my leaves
// @route   GET /api/leaves/my
// @access  Private (Student)
const getMyLeaves = async (req, res) => {
  try {
    const leaves = await Leave.find({ studentId: req.user._id }).sort({ date: -1 });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all leave requests
// @route   GET /api/leaves
// @access  Private/Admin
const getAllLeaves = async (req, res) => {
  try {
    let query = {};
    if (req.user.role === 'mentor') {
      const Batch = require('../models/Batch');
      const Enrollment = require('../models/Enrollment');
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id').lean();
      const mentorBatchIds = mentorBatches.map(b => b._id);
      const enrollments = await Enrollment.find({ batchId: { $in: mentorBatchIds }, status: 'approved' }).select('studentId').lean();
      const studentIds = enrollments.map(e => e.studentId);
      query.studentId = { $in: studentIds };
    }

    const leaves = await Leave.find(query)
      .populate('studentId', 'name email rollNumber batch')
      .sort({ createdAt: -1 });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update leave status (Approve/Reject)
// @route   PUT /api/leaves/:id/status
// @access  Private/Admin
const updateLeaveStatus = async (req, res) => {
  try {
    const { status, adminResponse } = req.body;
    const leave = await Leave.findById(req.params.id);

    if (!leave) {
      return res.status(404).json({ message: 'Leave not found' });
    }

    leave.status = status;
    if (adminResponse !== undefined) {
      leave.adminResponse = adminResponse;
    }
    await leave.save();

    // If approved, create or update Attendance record(s)
    if (status === 'approved') {
      if (leave.leaveType === 'full_day' || leave.leaveType === 'multiple_days') {
        const start = new Date(leave.startDate);
        const end = leave.leaveType === 'multiple_days' && leave.endDate ? new Date(leave.endDate) : start;
        
        // Loop through each day
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().split('T')[0];
          const startOfDay = new Date(d);
          startOfDay.setUTCHours(0, 0, 0, 0);

          let attendance = await Attendance.findOne({
            studentId: leave.studentId,
            dateStr: dateStr
          });

          if (attendance) {
            attendance.isLeave = true;
            attendance.status = 'Leave';
            await attendance.save();
          } else {
            await Attendance.create({
              studentId: leave.studentId,
              dateStr: dateStr,
              checkInTime: startOfDay,
              lastCheckInTime: startOfDay,
              checkOutTime: startOfDay,
              sessionDurationSeconds: 0,
              isActive: false,
              isLeave: true,
              status: 'Leave'
            });
          }
        }
      } else if (leave.leaveType === 'hours') {
        // Calculate hours diff
        let [startH, startM] = leave.startTime.split(':').map(Number);
        let [endH, endM] = leave.endTime.split(':').map(Number);
        
        // Auto-correct 12-hour format to 24-hour format for PM hours
        if (endH < startH && endH < 12) {
          endH += 12;
        }

        const diffHours = Math.max(0, (endH + endM/60) - (startH + startM/60));
        
        const dateStr = new Date(leave.startDate).toISOString().split('T')[0];
        const startOfDay = new Date(leave.startDate);
        startOfDay.setUTCHours(0, 0, 0, 0);

        let attendance = await Attendance.findOne({
          studentId: leave.studentId,
          dateStr: dateStr
        });

        if (attendance) {
          attendance.leaveHours = diffHours;
          attendance.isLeave = true;
          
          // Re-evaluate status: if they already checked in and completed adjusted hours, mark Present
          const checkedInHours = (attendance.sessionDurationSeconds || 0) / 3600;
          const minRequired = Math.max(0, 8 - diffHours);
          
          if (checkedInHours >= minRequired && checkedInHours > 0) {
            attendance.status = 'Present';
          } else {
            attendance.status = 'Leave';
          }
          
          await attendance.save();
        } else {
          // Create dummy record so leaveHours is stored even if they haven't checked in yet
          await Attendance.create({
            studentId: leave.studentId,
            dateStr: dateStr,
            checkInTime: startOfDay,
            lastCheckInTime: startOfDay,
            checkOutTime: startOfDay,
            sessionDurationSeconds: 0,
            isActive: false,
            isLeave: true,
            leaveHours: diffHours,
            status: 'Leave'
          });
        }
      }
    }

    res.json(leave);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Check if currently on active leave
// @route   GET /api/leaves/active-status
// @access  Private (Student)
const getActiveLeaveStatus = async (req, res) => {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const currentTimeStr = today.toTimeString().substring(0, 5); // "HH:MM"
    
    // Find any approved leaves that might overlap with today
    const leaves = await Leave.find({
      studentId: req.user._id,
      status: 'approved',
      $or: [
        { startDate: todayStr },
        { date: todayStr }, // Backward compatibility
        { 
          leaveType: 'multiple_days',
          startDate: { $lte: todayStr },
          endDate: { $gte: todayStr }
        }
      ]
    });

    let activeLeave = null;

    for (const leave of leaves) {
      if (!leave.leaveType || leave.leaveType === 'full_day' || leave.leaveType === 'multiple_days') {
        activeLeave = leave;
        break;
      } else if (leave.leaveType === 'hours') {
        if (currentTimeStr >= leave.startTime && currentTimeStr <= leave.endTime) {
          activeLeave = leave;
          break;
        }
      }
    }

    if (activeLeave) {
      let message = '';
      if (activeLeave.leaveType === 'hours') {
        message = `You are on approved leave today from ${activeLeave.startTime} to ${activeLeave.endTime}.`;
      } else if (activeLeave.leaveType === 'multiple_days') {
        message = `You are on approved leave from ${activeLeave.startDate} to ${activeLeave.endDate}.`;
      } else {
        message = `You are on approved leave for today (${activeLeave.startDate || activeLeave.date}).`;
      }
      
      return res.json({ isOnLeave: true, message, leave: activeLeave });
    }

    res.json({ isOnLeave: false });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  applyLeave,
  getMyLeaves,
  getAllLeaves,
  updateLeaveStatus,
  getActiveLeaveStatus
};
