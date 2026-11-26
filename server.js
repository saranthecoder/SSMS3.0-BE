const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const zlib = require('zlib');
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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-id', 'x-request-id', 'X-Request-Id', 'Accept', 'Cookie', 'Origin'],
    credentials: true,
  }
});

// Import socket handlers
require('./sockets/socketHandlers')(io);

// Global Allow-All CORS & Preflight OPTIONS Middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-user-id, x-request-id, X-Request-Id, Accept, Cookie, Origin, Access-Control-Allow-Origin');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Total-Count');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Lightweight zero-dependency gzip compression for JSON/text payloads (> 1 KB)
app.use((req, res, next) => {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (!acceptEncoding.includes('gzip')) return next();

  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.headersSent) return origJson(body);
    try {
      const jsonStr = JSON.stringify(body);
      if (!jsonStr || Buffer.byteLength(jsonStr, 'utf8') < 1024) {
        return origJson(body);
      }
      const compressed = zlib.gzipSync(jsonStr, { level: 6 });
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.removeHeader('Content-Length');
      return res.send(compressed);
    } catch {
      return origJson(body);
    }
  };
  next();
});
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-id', 'x-request-id', 'X-Request-Id', 'Accept', 'Cookie', 'Origin'],
  exposedHeaders: ['X-Request-Id', 'X-Total-Count'],
}));

const crypto = require('crypto');
const metricsService = require('./utils/metricsService');

// Request ID, Response Time & Structured Telemetry Logging Middleware
app.use((req, res, next) => {
  const startHrTime = process.hrtime.bigint();

  // Propagate incoming X-Request-Id or assign a unique UUID
  const reqId = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = reqId;
  res.setHeader('X-Request-Id', reqId);

  // Hook response completion to record latency and emit structured logs
  res.on('finish', () => {
    const endHrTime = process.hrtime.bigint();
    const durationMs = Number(endHrTime - startHrTime) / 1e6;

    // Record truthful operational metrics
    const reqPath = req.originalUrl || req.path || '';
    metricsService.recordRequest({
      path: reqPath,
      durationMs,
      statusCode: res.statusCode
    });

    // Structured logging: log all mutating requests, slow requests (>500ms), and non-probe application traffic
    const isProbe = metricsService.isProbePath(reqPath);
    if (!isProbe || res.statusCode >= 400 || durationMs > 500) {
      console.log(`[REQ] ${reqId} ${req.method} ${reqPath} -> ${res.statusCode} (${durationMs.toFixed(1)}ms)`);
    }
  });

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
const announcementRoutes = require('./routes/announcementRoutes');
const leetcodeRoutes = require('./routes/leetcodeRoutes');
const leaveRoutes = require('./routes/leaveRoutes');
const publicRoutes = require('./routes/publicRoutes');
const mockDriveRoutes = require('./routes/mockDriveRoutes');
const checkInAccessRoutes = require('./routes/checkInAccessRoutes');
const trafficRoutes = require('./routes/trafficRoutes');
const gamificationRoutes = require('./routes/gamificationRoutes');
const noteRoutes = require('./routes/noteRoutes');
const mentorRoutes = require('./routes/mentorRoutes');
const monitorAccessRoutes = require('./routes/monitorAccessRoutes');
const syllabusRoutes = require('./routes/syllabusRoutes');
const reportRoutes = require('./routes/reportRoutes');
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
app.use('/api/announcements', announcementRoutes);
app.use('/api/leetcode', leetcodeRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/mock-drives', mockDriveRoutes);
app.use('/api/checkin-access', checkInAccessRoutes);
app.use('/api/traffic', trafficRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/mentors', mentorRoutes);
app.use('/api/monitor-access', monitorAccessRoutes);
app.use('/api/syllabus', syllabusRoutes);
app.use('/api/reports', reportRoutes);

// Custom Domain Proxy Route: Serves Cloudinary / MongoDB / Disk files under your domain name
const Upload = require('./models/Upload');
const serveUploadedFile = async (req, res) => {
  try {
    const { filename } = req.params;
    
    const dbFile = await Upload.findOne({ filename });
    if (dbFile) {
      res.setHeader('Content-Type', dbFile.contentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');

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
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(filePath);
    }

    // 4. Not found
    return res.status(404).send('Cannot GET ' + req.originalUrl);
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).send('Server Error');
  }
};

app.get('/uploads/:filename', serveUploadedFile);
app.get('/api/uploads/:filename', serveUploadedFile);

// Root route
app.get('/', (req, res) => {
  res.send('LMS API is running');
});

// Liveness probe (checks process responsiveness without dependencies)
app.get(['/health/live', '/api/health/live', '/health/liveness', '/api/health/liveness'], (req, res) => {
  res.status(200).json({
    status: 'alive',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// Readiness probe (verifies database dependency and reports basic operational telemetry)
app.get(['/health/ready', '/api/health/ready', '/health/readiness', '/api/health/readiness'], (req, res) => {
  const isDbReady = mongoose.connection.readyState === 1;
  const metrics = metricsService.getSnapshot();
  if (isDbReady) {
    return res.status(200).json({
      status: 'ready',
      apiVersion: trafficRoutes.BACKEND_API_VERSION || '3.2.0',
      uptime: Math.floor(process.uptime()),
      dependencies: { database: 'connected' },
      timestamp: Date.now(),
      cpuPercent: metrics.cpuPercent,
      memoryPercent: metrics.memoryPercent,
      appRequests: metrics.appRequests,
      appRpm: metrics.appRpm,
      avgProcessingLatencyMs: metrics.avgProcessingLatencyMs
    });
  } else {
    return res.status(503).json({
      status: 'not_ready',
      uptime: Math.floor(process.uptime()),
      dependencies: { database: 'disconnected' },
      timestamp: Date.now(),
      cpuPercent: metrics.cpuPercent,
      memoryPercent: metrics.memoryPercent,
      appRequests: metrics.appRequests,
      appRpm: metrics.appRpm,
      avgProcessingLatencyMs: metrics.avgProcessingLatencyMs
    });
  }
});

// Backward-compatible general health probe
app.get(['/health', '/api/health'], (req, res) => {
  const isDbReady = mongoose.connection.readyState === 1;
  const metrics = metricsService.getSnapshot();
  const statusCode = isDbReady ? 200 : 503;
  res.status(statusCode).json({
    status: isDbReady ? 'ok' : 'degraded',
    apiVersion: trafficRoutes.BACKEND_API_VERSION || '3.2.0',
    uptime: Math.floor(process.uptime()),
    ready: isDbReady,
    timestamp: Date.now(),
    cpuPercent: metrics.cpuPercent,
    memoryPercent: metrics.memoryPercent,
    appRequests: metrics.appRequests,
    appRpm: metrics.appRpm,
    avgProcessingLatencyMs: metrics.avgProcessingLatencyMs
  });
});

const PORT = process.env.PORT || 3000;

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

// Distributed background job coordinator
const { runDistributedJob } = require('./utils/distributedJobRunner');

// Run every day at exactly 12:00 AM (midnight) for Attendance reset (single instance lease)
cron.schedule('0 0 * * *', async () => {
  await runDistributedJob('attendance_midnight_reset', 300000, 3600000, async () => {
    const now = new Date();
    const todayStr = getISTDateStr(now);

    // Find all 'In Progress' records from before today
    const activeRecords = await Attendance.find({ 
      status: 'In Progress',
      dateStr: { $lt: todayStr }
    });

    const { evaluateAttendanceRecord } = require('./controllers/attendanceController');

    for (const record of activeRecords) {
      let elapsedSec = 0;
      if (record.isActive) {
        // Since cron runs exactly at midnight, use 'now' as the cutoff
        const durationMs = now.getTime() - new Date(record.lastCheckInTime).getTime();
        elapsedSec = Math.max(0, Math.floor(durationMs / 1000));
        record.checkOutTime = now;
        record.isActive = false;
      }

      // Compute final status for the past day maintaining On-Site and WFH records separately
      evaluateAttendanceRecord(record, elapsedSec);
      await record.save();
    }
  });
});


// Leetcode Deadline Cron Job - runs every hour (single instance lease)
cron.schedule('0 * * * *', async () => {
  await runDistributedJob('leetcode_hourly_streaks', 300000, 1800000, async () => {
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
  });
});

// Auto-Schedule WFH Access & On-Site Auto-Checkout Check - runs every minute
cron.schedule('* * * * *', async () => {
  try {
    const DailyWorkload = require('./models/DailyWorkload');
    const {
      triggerAutoWfhGrant,
      triggerAutoOnsiteCheckoutAndRevoke,
      getISTTimeStr,
      getISTDateStr
    } = require('./controllers/checkInAccessController');
    const dateStr = getISTDateStr();
    const currentISTTime = getISTTimeStr();

    const pendingWorkloads = await DailyWorkload.find({
      dateStr,
      autoWfhEnabled: true,
      autoWfhGranted: { $ne: true },
      autoWfhTime: { $lte: currentISTTime }
    });

    for (const dw of pendingWorkloads) {
      await triggerAutoWfhGrant(dw.batchId, dateStr);
    }

    const pendingOnsiteCheckouts = await DailyWorkload.find({
      dateStr,
      autoOnsiteCheckoutEnabled: true,
      autoOnsiteCheckoutDone: { $ne: true },
      autoOnsiteCheckoutTime: { $lte: currentISTTime }
    });

    for (const dw of pendingOnsiteCheckouts) {
      await triggerAutoOnsiteCheckoutAndRevoke(dw.batchId, dateStr);
    }
  } catch (err) {
    // silently handle background job errors
  }
});

// Self-ping to keep server awake on Render free tier
const selfPing = () => {
  // Only self-ping when running in deployed production environment on Render
  const envUrl = process.env.RENDER_EXTERNAL_URL;
  if (!envUrl) return; // Do not self-ping remote instances in local development
  
  setInterval(async () => {
    try {
      const cleanUrl = envUrl.endsWith('/') ? envUrl.slice(0, -1) : envUrl;
      const pingEndpoint = `${cleanUrl}/api/traffic/public-config`;
      const res = await fetch(pingEndpoint);
      console.log(`Self-ping to keep awake [${pingEndpoint}]: Status ${res.status}`);
    } catch (err) {
      console.error(`Self-ping keep-awake failed: ${err.message}`);
    }
  }, 14 * 60 * 1000); // Trigger every 14 minutes
};

// Initiate self-pinging routine
selfPing();

// Background cluster health probe (runs every 5 minutes via distributed lock so nodes never go stale when no admin tab is open)
if (typeof trafficRoutes.probeRegisteredServers === 'function') {
  const selfHost = (() => {
    try {
      return process.env.RENDER_EXTERNAL_URL ? new URL(process.env.RENDER_EXTERNAL_URL).host : '';
    } catch {
      return '';
    }
  })();
  setTimeout(() => {
    runDistributedJob('cluster_health_probe', 45000, 150000, async () => {
      await trafficRoutes.probeRegisteredServers(selfHost);
    });
  }, 3000);
  setInterval(async () => {
    await runDistributedJob('cluster_health_probe', 45000, 150000, async () => {
      await trafficRoutes.probeRegisteredServers(selfHost);
    });
  }, 3 * 60 * 1000);
}

// Auto-Checkout & Batch Lifecycle Routine: Runs every 60 seconds with distributed lock coordination across instances
const { processBatchAutoCheckouts, autoCloseAllOldSessions } = require('./controllers/attendanceController');
const { autoCloseExpiredBatches } = require('./controllers/batchController');
setInterval(async () => {
  await runDistributedJob('batch_auto_checkout', 55000, 45000, async () => {
    await processBatchAutoCheckouts();
    await autoCloseAllOldSessions();
    await autoCloseExpiredBatches();
  });
}, 60000);

// Auto Cloudinary Migration Routine (single execution across instances)
const migrateFilesToCloudinary = require('./scripts/migrateToCloudinary');
setTimeout(async () => {
  await runDistributedJob('cloudinary_migration', 600000, 86400000, async () => {
    await migrateFilesToCloudinary();
  });
}, 5000);

server.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});
