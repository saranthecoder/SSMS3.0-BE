const Note = require('../models/Note');
const Enrollment = require('../models/Enrollment');

// @desc    Get notes (all for admin, batch-specific + global for students)
// @route   GET /api/notes
// @access  Private
const getNotes = async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const notes = await Note.find({})
        .populate('batchId', 'name batchName')
        .populate('uploadedBy', 'name')
        .sort({ createdAt: -1 });
      return res.json(notes);
    }

    if (req.user.role === 'mentor') {
      const Batch = require('../models/Batch');
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id');
      const mentorBatchIds = mentorBatches.map(b => b._id);
      
      const notes = await Note.find({ batchId: { $in: mentorBatchIds } })
        .populate('batchId', 'name batchName')
        .populate('uploadedBy', 'name')
        .sort({ createdAt: -1 });
      return res.json(notes);
    }

    // If student, get approved enrollment batch
    const enrollment = await Enrollment.findOne({ studentId: req.user._id, status: 'approved' });
    const batchId = enrollment ? enrollment.batchId : null;

    // Fetch notes matching student's batch OR global notes (batchId: null)
    const query = {
      $or: [
        { batchId: null },
        ...(batchId ? [{ batchId }] : [])
      ]
    };

    const notes = await Note.find(query)
      .populate('batchId', 'name batchName')
      .populate('uploadedBy', 'name')
      .sort({ createdAt: -1 });

    res.json(notes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Add a note
// @route   POST /api/notes
// @access  Private/Admin
const addNote = async (req, res) => {
  try {
    const { title, description, url, batchId } = req.body;

    if (!title || !url) {
      return res.status(400).json({ message: 'Title and URL are required' });
    }

    let targetBatch = batchId || null;
    if (req.user.role === 'mentor') {
      const Batch = require('../models/Batch');
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id');
      const mentorBatchIds = mentorBatches.map(b => b._id.toString());
      if (!targetBatch || !mentorBatchIds.includes(targetBatch.toString())) {
        if (mentorBatchIds.length > 0) {
          targetBatch = mentorBatchIds[0];
        } else {
          return res.status(400).json({ message: 'Mentors must assign notes to one of their active batches.' });
        }
      }
    }

    const note = await Note.create({
      title,
      description: description || '',
      url,
      batchId: targetBatch,
      uploadedBy: req.user._id
    });

    const populatedNote = await Note.findById(note._id)
      .populate('batchId', 'name batchName')
      .populate('uploadedBy', 'name');

    res.status(201).json(populatedNote);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Edit a note
// @route   PUT /api/notes/:id
// @access  Private/Admin
const editNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, url, batchId } = req.body;

    const note = await Note.findById(id);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    if (req.user.role === 'mentor') {
      const Batch = require('../models/Batch');
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id');
      const mentorBatchIds = mentorBatches.map(b => b._id.toString());
      const newBatchId = batchId ? batchId.toString() : null;
      if (!newBatchId || !mentorBatchIds.includes(newBatchId)) {
        return res.status(400).json({ message: 'Mentors cannot assign notes to global scope or unassigned batches.' });
      }
    }

    note.title = title !== undefined ? title : note.title;
    note.description = description !== undefined ? description : note.description;
    note.url = url !== undefined ? url : note.url;
    note.batchId = batchId !== undefined ? (batchId || null) : note.batchId;

    await note.save();

    const populatedNote = await Note.findById(note._id)
      .populate('batchId', 'name batchName')
      .populate('uploadedBy', 'name');

    res.json(populatedNote);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete a note
// @route   DELETE /api/notes/:id
// @access  Private/Admin
const deleteNote = async (req, res) => {
  try {
    const { id } = req.params;
    const note = await Note.findByIdAndDelete(id);

    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    res.json({ message: 'Note deleted successfully', id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getNotes,
  addNote,
  editNote,
  deleteNote
};
