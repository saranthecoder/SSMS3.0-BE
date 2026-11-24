const SyllabusTrack = require('../models/SyllabusTrack');
const Batch = require('../models/Batch');
const Enrollment = require('../models/Enrollment');

// Helper to format Date to YYYY-MM-DD (IST / UTC aware)
const formatDateStr = (d) => {
  const dateObj = d ? new Date(d) : new Date();
  if (isNaN(dateObj.getTime())) return new Date().toISOString().split('T')[0];
  return dateObj.toISOString().split('T')[0];
};

// @desc    Create / Upload daily completed syllabus
// @route   POST /api/syllabus
// @access  Private (Mentor, Admin)
const createSyllabusEntry = async (req, res) => {
  try {
    const { 
      batchId, 
      date, 
      title, 
      subtopics, 
      description, 
      resources, 
      assignmentsAssigned, 
      hoursSpent, 
      completionPercentage,
      status 
    } = req.body;

    if (!batchId) {
      return res.status(400).json({ message: 'Batch ID is required' });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Topic or chapter title is required' });
    }

    const batch = await Batch.findById(batchId);
    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    // If caller is mentor, verify they are assigned to this batch (lead or co-mentor)
    if (req.user.role === 'mentor') {
      const isLead = batch.mentorId && batch.mentorId.toString() === req.user._id.toString();
      const isCoMentor = Array.isArray(batch.mentors) && batch.mentors.some(m => m.toString() === req.user._id.toString());
      if (!isLead && !isCoMentor) {
        return res.status(403).json({ message: 'You are not assigned to this batch' });
      }
    }

    // Format subtopics if string was passed
    let parsedSubtopics = [];
    if (Array.isArray(subtopics)) {
      parsedSubtopics = subtopics.map(s => String(s).trim()).filter(Boolean);
    } else if (typeof subtopics === 'string' && subtopics.trim()) {
      parsedSubtopics = subtopics.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    }

    // Format resources
    let parsedResources = [];
    if (Array.isArray(resources)) {
      parsedResources = resources.filter(r => r && (r.title || r.url)).map(r => ({
        title: (r.title || r.url || '').trim(),
        url: (r.url || '').trim()
      }));
    }

    const entryDate = date ? new Date(date) : new Date();
    const entryDateStr = formatDateStr(entryDate);

    const newTrack = await SyllabusTrack.create({
      batchId: batch._id,
      batchName: batch.batchName,
      mentorId: req.user._id,
      mentorName: req.user.name || 'Mentor',
      date: entryDate,
      dateStr: entryDateStr,
      title: title.trim(),
      subtopics: parsedSubtopics,
      description: (description || '').trim(),
      resources: parsedResources,
      assignmentsAssigned: (assignmentsAssigned || '').trim(),
      hoursSpent: Number(hoursSpent) >= 0 ? Number(hoursSpent) : 1,
      completionPercentage: Number(completionPercentage) >= 0 ? Math.min(100, Number(completionPercentage)) : 100,
      status: status || 'completed'
    });

    // Notify connected sockets if available
    try {
      const { getIO } = require('../sockets/socketHandlers');
      const io = getIO();
      if (io) {
        io.emit('syllabus-updated', {
          action: 'created',
          batchId: batch._id.toString(),
          entry: newTrack
        });
      }
    } catch (sockErr) {
      // Non-critical socket notification
    }

    res.status(201).json({
      success: true,
      message: 'Daily syllabus progress uploaded successfully!',
      syllabus: newTrack
    });
  } catch (error) {
    console.error('Error creating syllabus entry:', error);
    res.status(500).json({ message: error.message || 'Failed to upload syllabus progress' });
  }
};

// @desc    Get syllabus tracker entries (scoped by user role: admin, mentor, student)
// @route   GET /api/syllabus
// @access  Private (All authenticated roles)
const getSyllabusEntries = async (req, res) => {
  try {
    const { batchId, search, startDate, endDate, limit = 150 } = req.query;
    let query = {};

    if (req.user.role === 'student') {
      // Find student's enrolled batch
      const enrollment = await Enrollment.findOne({ studentId: req.user._id, status: 'approved' }).lean();
      const studentBatchId = enrollment?.batchId || req.user.batchId;
      if (!studentBatchId) {
        return res.json([]);
      }
      query.batchId = studentBatchId;
    } else if (req.user.role === 'mentor') {
      if (batchId) {
        query.batchId = batchId;
      } else {
        const mentorBatches = await Batch.find({
          $or: [
            { mentorId: req.user._id },
            { mentors: req.user._id }
          ]
        }).select('_id').lean();
        const batchIds = mentorBatches.map(b => b._id);
        query.batchId = { $in: batchIds };
      }
    } else if (req.user.role === 'admin') {
      if (batchId) {
        query.batchId = batchId;
      }
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.date.$lte = end;
      }
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [
        { title: regex },
        { subtopics: regex },
        { description: regex },
        { mentorName: regex },
        { batchName: regex }
      ];
    }

    const entries = await SyllabusTrack.find(query)
      .populate('batchId', 'batchName courseName')
      .populate('mentorId', 'name email profileImage')
      .sort({ date: -1, createdAt: -1 })
      .limit(Math.min(Number(limit) || 150, 300))
      .lean();

    res.json(entries);
  } catch (error) {
    console.error('Error fetching syllabus entries:', error);
    res.status(500).json({ message: 'Failed to fetch syllabus records' });
  }
};

// @desc    Get single syllabus entry
// @route   GET /api/syllabus/:id
// @access  Private
const getSyllabusById = async (req, res) => {
  try {
    const entry = await SyllabusTrack.findById(req.params.id)
      .populate('batchId', 'batchName')
      .populate('mentorId', 'name email profileImage')
      .lean();

    if (!entry) {
      return res.status(404).json({ message: 'Syllabus record not found' });
    }

    res.json(entry);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update syllabus entry
// @route   PUT /api/syllabus/:id
// @access  Private (Mentor, Admin)
const updateSyllabusEntry = async (req, res) => {
  try {
    const entry = await SyllabusTrack.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ message: 'Syllabus record not found' });
    }

    // Authorization: Mentor must be creator or assigned to batch, or Admin
    if (req.user.role === 'mentor') {
      const isCreator = entry.mentorId.toString() === req.user._id.toString();
      const batch = await Batch.findById(entry.batchId).lean();
      const isBatchMentor = batch && batch.mentorId && batch.mentorId.toString() === req.user._id.toString();
      if (!isCreator && !isBatchMentor) {
        return res.status(403).json({ message: 'Not authorized to edit this syllabus record' });
      }
    }

    const { 
      title, 
      subtopics, 
      description, 
      resources, 
      assignmentsAssigned, 
      hoursSpent, 
      completionPercentage,
      status,
      date 
    } = req.body;

    if (title !== undefined) entry.title = title.trim();
    if (description !== undefined) entry.description = description.trim();
    if (assignmentsAssigned !== undefined) entry.assignmentsAssigned = assignmentsAssigned.trim();
    if (hoursSpent !== undefined) entry.hoursSpent = Number(hoursSpent);
    if (completionPercentage !== undefined) entry.completionPercentage = Math.min(100, Math.max(0, Number(completionPercentage)));
    if (status !== undefined) entry.status = status;
    if (date) {
      entry.date = new Date(date);
      entry.dateStr = formatDateStr(entry.date);
    }

    if (subtopics !== undefined) {
      if (Array.isArray(subtopics)) {
        entry.subtopics = subtopics.map(s => String(s).trim()).filter(Boolean);
      } else if (typeof subtopics === 'string') {
        entry.subtopics = subtopics.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      }
    }

    if (resources !== undefined && Array.isArray(resources)) {
      entry.resources = resources.filter(r => r && (r.title || r.url)).map(r => ({
        title: (r.title || r.url || '').trim(),
        url: (r.url || '').trim()
      }));
    }

    await entry.save();

    res.json({
      success: true,
      message: 'Syllabus entry updated successfully!',
      syllabus: entry
    });
  } catch (error) {
    console.error('Error updating syllabus entry:', error);
    res.status(500).json({ message: error.message || 'Failed to update syllabus entry' });
  }
};

// @desc    Delete syllabus entry
// @route   DELETE /api/syllabus/:id
// @access  Private (Mentor, Admin)
const deleteSyllabusEntry = async (req, res) => {
  try {
    const entry = await SyllabusTrack.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ message: 'Syllabus record not found' });
    }

    if (req.user.role === 'mentor') {
      const isCreator = entry.mentorId.toString() === req.user._id.toString();
      const batch = await Batch.findById(entry.batchId).lean();
      const isBatchMentor = batch && batch.mentorId && batch.mentorId.toString() === req.user._id.toString();
      if (!isCreator && !isBatchMentor) {
        return res.status(403).json({ message: 'Not authorized to delete this syllabus record' });
      }
    }

    await entry.deleteOne();

    res.json({ success: true, message: 'Syllabus entry deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createSyllabusEntry,
  getSyllabusEntries,
  getSyllabusById,
  updateSyllabusEntry,
  deleteSyllabusEntry
};
