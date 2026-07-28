const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');

// Load env vars
dotenv.config();

// Connect to database
connectDB().then(() => {
  const seedTraffic = require('./utils/seedTraffic');
  seedTraffic();
});

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, true),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  }
});

// Import socket handlers
require('./sockets/socketHandlers')(io);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
}));

// Live Traffic Telemetry Counter Middleware
let globalRequestCount = 124;
let requestCounterWindow = 18;
let lastWindowReset = Date.now();

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    globalRequestCount++;
    requestCounterWindow++;

    if (Date.now() - lastWindowReset > 60000) {
      requestCounterWindow = 1;
      lastWindowReset = Date.now();
    }

    app.set('liveTrafficStats', {
      total: globalRequestCount,
      rpm: requestCounterWindow,
      lastUpdated: Date.now()
    });
  }
  next();
});

// Route files
const authRoutes = require('./routes/authRoutes');
const batchRoutes = require('./routes/batchRoutes');
const enrollmentRoutes = require('./routes/enrollmentRoutes');
const taskRoutes = require('./routes/taskRoutes');
const submissionRoutes = require('./routes/submissionRoutes');
const gradeRoutes = require('./routes/gradeRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const chatRoutes = require('./routes/chatRoutes');
const leetcodeRoutes = require('./routes/leetcodeRoutes');
const leaveRoutes = require('./routes/leaveRoutes');
const publicRoutes = require('./routes/publicRoutes');
const mockDriveRoutes = require('./routes/mockDriveRoutes');
const checkInAccessRoutes = require('./routes/checkInAccessRoutes');
const trafficRoutes = require('./routes/trafficRoutes');
const gamificationRoutes = require('./routes/gamificationRoutes');
const noteRoutes = require('./routes/noteRoutes');
const mentorRoutes = require('./routes/mentorRoutes');
const path = require('path');

app.use('/api/auth', authRoutes);
app.use('/api/batches', batchRoutes);
app.use('/api/enrollments', enrollmentRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/grades', gradeRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/leetcode', leetcodeRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/mock-drives', mockDriveRoutes);
app.use('/api/checkin-access', checkInAccessRoutes);
app.use('/api/traffic', trafficRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/mentors', mentorRoutes);

// Custom Domain Proxy Route: Serves Cloudinary / MongoDB / Disk files under your domain name
const Upload = require('./models/Upload');
app.get('/uploads/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    const dbFile = await Upload.findOne({ filename });
    if (dbFile) {
      res.setHeader('Content-Type', dbFile.contentType);

      // 1. If stored on Cloudinary, proxy the file stream seamlessly under your custom domain
      if (dbFile.cloudinaryUrl) {
        const cldRes = await fetch(dbFile.cloudinaryUrl);
        if (cldRes.ok) {
          const arrayBuffer = await cldRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          return res.send(buffer);
        }
      }

      // 2. If stored in MongoDB
      if (dbFile.data) {
        return res.send(dbFile.data);
      }
    }

    // 3. Fallback to physical disk file (for backward compatibility)
    const filePath = path.join(__dirname, 'uploads', filename);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }

    // 4. Not found
    return res.status(404).send('Cannot GET ' + req.originalUrl);
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).send('Server Error');
  }
});

// Root route
app.get('/', (req, res) => {
  res.send('LMS API is running');
});

let PORT = process.env.PORT || 3000;
if (process.env.RENDER === 'true') {
  // Render's dashboard config defaults/expects port 5000 if auto-detected from 'PORT || 5000',
  // but Render still injects PORT=10000 into the env variables. Force port 5000 to match routing.
  PORT = 3000;
}

// Setup node-cron for LeetCode streak logic
const cron = require('node-cron');
const Leetcode = require('./models/Leetcode');
const LeetcodeSubmission = require('./models/LeetcodeSubmission');
const Enrollment = require('./models/Enrollment');
const User = require('./models/User');
const Attendance = require('./models/Attendance');

const getISTDateStr = (date = new Date()) => {
  const istTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const year = istTime.getFullYear();
  const month = String(istTime.getMonth() + 1).padStart(2, '0');
  const day = String(istTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Run every day at exactly 12:00 AM (midnight) for Attendance reset
cron.schedule('0 0 * * *', async () => {
  try {
    const now = new Date();
    const todayStr = getISTDateStr(now);

    // Find all 'In Progress' records from before today
    const activeRecords = await Attendance.find({ 
      status: 'In Progress',
      dateStr: { $lt: todayStr }
    });

    for (const record of activeRecords) {
      if (record.isActive) {
        // Since cron runs exactly at midnight, use 'now' as the cutoff
        const durationMs = now.getTime() - new Date(record.lastCheckInTime).getTime();
        record.sessionDurationSeconds += Math.floor(durationMs / 1000);
        record.checkOutTime = now;
        record.isActive = false;

        // The user will need to manually check-in again for the new day
      }

      // Compute final status for the past day
      if (record.isLeave && (record.leaveHours || 0) === 0) {
        record.status = 'Leave';
      } else {
        const hours = (record.sessionDurationSeconds || 0) / 3600;
        const minRequired = 8 - (record.leaveHours || 0);
        if (hours >= minRequired && hours <= 10) {
          record.status = 'Present';
        } else if (hours > 10) {
          record.status = 'Invalid';
        } else {
          record.status = 'Absent';
        }
      }

      await record.save();
    }
  } catch (error) {
    console.error('Error running cron job for Attendance reset:', error);
  }
});


// Leetcode Deadline Cron Job - runs every hour
cron.schedule('0 * * * *', async () => {
  try {
    const expiredProblems = await Leetcode.find({
      deadline: { $lt: new Date() },
      processed: false
    });

    for (const problem of expiredProblems) {
      const enrollments = await Enrollment.find({ batchId: problem.batchId, status: 'approved' });
      for (const enrollment of enrollments) {
        const studentId = enrollment.studentId;
        const submission = await LeetcodeSubmission.findOne({
          problemId: problem._id,
          studentId: studentId
        });

        // If no submission, reset coding streak
        if (!submission) {
          await User.findByIdAndUpdate(studentId, { codingStreak: 0 });
        }
      }
      problem.processed = true;
      await problem.save();
    }
  } catch (error) {
    console.error('Error running cron job for LeetCode streaks:', error);
  }
});

// Self-ping to keep server awake on Render free tier
const BackendServer = require('./models/BackendServer');
const selfPing = () => {
  // Render automatically injects RENDER_EXTERNAL_URL in environment variables
  const envUrl = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL;
  
  setInterval(async () => {
    try {
      let targetUrl = envUrl;

      // Fallback to primary server URL in DB if environment variable is not defined
      if (!targetUrl) {
        const primaryNode = await BackendServer.findOne({ isPrimary: true });
        if (primaryNode && primaryNode.url && !primaryNode.url.includes('localhost')) {
          targetUrl = primaryNode.url;
        }
      }

      if (targetUrl) {
        const cleanUrl = targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl;
        const pingEndpoint = `${cleanUrl}/api/traffic/public-config`;
        const res = await fetch(pingEndpoint);
        console.log(`Self-ping to keep awake [${pingEndpoint}]: Status ${res.status}`);
      }
    } catch (err) {
      console.error(`Self-ping keep-awake failed: ${err.message}`);
    }
  }, 14 * 60 * 1000); // Trigger every 14 minutes
};

// Initiate self-pinging routine
selfPing();

// Auto-Checkout Routine: Runs every 60 seconds for active batches
const { processBatchAutoCheckouts } = require('./controllers/attendanceController');
setInterval(() => {
  processBatchAutoCheckouts();
}, 60000);

// Auto Cloudinary Migration Routine
const migrateFilesToCloudinary = require('./scripts/migrateToCloudinary');
setTimeout(() => {
  migrateFilesToCloudinary();
}, 5000);

server.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});
