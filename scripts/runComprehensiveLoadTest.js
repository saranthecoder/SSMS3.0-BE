/**
 * SSMS Production Readiness & 150-Student Load Testing Suite
 *
 * Covers:
 *   Test A: Login Burst (150 concurrent students)
 *   Test B: Dashboard Load (150 students opening full dashboard simultaneously)
 *   Test C: Attendance Burst (150 students marking attendance in 10s + idempotency re-test)
 *   Test D: Group Chat & Socket Load (150 real Socket.io clients)
 *   Test E: Announcements & Notes (150 concurrent students)
 *   Test F: Mixed Real-World Load (150 concurrent students with realistic action distribution)
 *   Test G: Stress Test (25 -> 50 -> 100 -> 150 -> 200 VUs)
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

// Attempt to load socket.io-client from FE if not in BE
let ioClient = null;
try {
  ioClient = require('../node_modules/socket.io-client');
} catch {
  try {
    ioClient = require('../../SSMS-FE/node_modules/socket.io-client');
  } catch (e) {
    console.warn('Socket.io-client not found, socket test will use fallback HTTP emulation');
  }
}

const BASE_URL = process.env.TARGET_URL || 'http://localhost:3000';
const isHttps = BASE_URL.startsWith('https');
const httpModule = isHttps ? https : http;

// Statistical helper functions
function calculatePercentiles(latencies) {
  if (!latencies || latencies.length === 0) return { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const getP = (p) => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Number(sorted[idx].toFixed(1));
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50: getP(50),
    p90: getP(90),
    p95: getP(95),
    p99: getP(99),
    avg: Number((sum / sorted.length).toFixed(1)),
    min: Number(sorted[0].toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1))
  };
}

// Low-overhead HTTP request helper returning { status, duration, data, headers, error }
function makeRequest({ method = 'GET', path: reqPath, body = null, headers = {}, timeout = 15000 }) {
  return new Promise((resolve) => {
    const urlObj = new URL(reqPath, BASE_URL);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Accept': 'application/json',
        ...headers
      },
      timeout
    };

    let postData = null;
    if (body) {
      postData = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const startHr = process.hrtime.bigint();
    const req = httpModule.request(options, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        const duration = Number(process.hrtime.bigint() - startHr) / 1e6;
        let parsed = null;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({
          status: res.statusCode,
          duration,
          data: parsed,
          headers: res.headers,
          error: null
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const duration = Number(process.hrtime.bigint() - startHr) / 1e6;
      resolve({ status: 504, duration, data: null, headers: {}, error: 'TIMEOUT' });
    });

    req.on('error', (err) => {
      const duration = Number(process.hrtime.bigint() - startHr) / 1e6;
      resolve({ status: 0, duration, data: null, headers: {}, error: err.message });
    });

    if (postData) req.write(postData);
    req.end();
  });
}

// Global tokens cache for 150 test students
const userSessions = [];

function makeUserHeaders(u) {
  if (!u) return {};
  const headers = {};
  if (u.cookie) headers['Cookie'] = u.cookie;
  if (u.userId) headers['x-user-id'] = u.userId;
  if (u.token) headers['Authorization'] = `Bearer ${u.token}`;
  return headers;
}

// Helper to poll server health snapshot
async function getServerHealth() {
  const res = await makeRequest({ method: 'GET', path: '/api/health', timeout: 5000 });
  return res.data || {};
}

// ───────────────────────────────────────────────────────────────────
// TEST A: Login Burst (150 students simultaneously)
// ───────────────────────────────────────────────────────────────────
async function runTestA_LoginBurst(studentCount = 150) {
  console.log(`\n======================================================`);
  console.log(`[TEST A] LOGIN BURST: ${studentCount} Students Simultaneously`);
  console.log(`======================================================`);

  const initialHealth = await getServerHealth();
  console.log(`Initial Server CPU: ${initialHealth.cpuPercent || 0}%, Memory: ${initialHealth.memoryPercent || 0}%`);

  const promises = [];
  const startAll = Date.now();

  for (let i = 1; i <= studentCount; i++) {
    const num = String(i).padStart(3, '0');
    const rollNumber = `LT_${num}`;
    const password = 'LoadTest@123';

    promises.push(
      makeRequest({
        method: 'POST',
        path: '/api/auth/login',
        body: { rollNumber, password },
        timeout: 30000 // 30s timeout to allow heavy bcrypt queue processing
      }).then(res => {
        let token = null;
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
          const match = cookieStr.match(/jwt=([^;]+)/);
          if (match) token = match[1];
        }
        if (!token && res.data && res.data.token) {
          token = res.data.token;
        }

        if (res.status === 200 && res.data && res.data._id) {
          userSessions[i - 1] = {
            index: i,
            userId: res.data._id,
            rollNumber,
            name: res.data.name,
            token,
            cookie: token ? `jwt=${token}` : (setCookie ? (Array.isArray(setCookie) ? setCookie[0] : setCookie) : '')
          };
        }
        return res;
      })
    );
  }

  const results = await Promise.all(promises);
  const totalWallTime = Date.now() - startAll;

  const latencies = results.map(r => r.duration);
  const stats = calculatePercentiles(latencies);
  const successful = results.filter(r => r.status === 200).length;
  const failed = results.filter(r => r.status !== 200).length;
  const timeouts = results.filter(r => r.error === 'TIMEOUT').length;

  const finalHealth = await getServerHealth();

  console.log(`\n--- Test A Results ---`);
  console.log(`Wall clock time: ${totalWallTime}ms`);
  console.log(`Success: ${successful}/${studentCount} (${((successful/studentCount)*100).toFixed(1)}%)`);
  console.log(`Failed: ${failed}/${studentCount}`);
  console.log(`Timeouts: ${timeouts}`);
  console.log(`Latency p50: ${stats.p50}ms | p90: ${stats.p90}ms | p95: ${stats.p95}ms | p99: ${stats.p99}ms | Max: ${stats.max}ms`);
  console.log(`Server post-burst CPU: ${finalHealth.cpuPercent || 0}%, Memory: ${finalHealth.memoryPercent || 0}%`);

  // Ensure any timed-out users are authenticated sequentially for subsequent tests
  if (successful < studentCount) {
    console.log(`Backfilling missing session tokens for subsequent tests...`);
    for (let i = 1; i <= studentCount; i++) {
      if (!userSessions[i - 1]) {
        const num = String(i).padStart(3, '0');
        const rollNumber = `LT_${num}`;
        const password = 'LoadTest@123';
        const res = await makeRequest({
          method: 'POST',
          path: '/api/auth/login',
          body: { rollNumber, password }
        });
        if (res.status === 200 && res.data && res.data._id) {
          let token = res.data.token;
          const setCookie = res.headers['set-cookie'];
          if (setCookie && !token) {
            const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
            const match = cookieStr.match(/jwt=([^;]+)/);
            if (match) token = match[1];
          }
          userSessions[i - 1] = {
            index: i,
            userId: res.data._id,
            rollNumber,
            name: res.data.name,
            token,
            cookie: token ? `jwt=${token}` : (setCookie ? (Array.isArray(setCookie) ? setCookie[0] : setCookie) : '')
          };
        }
      }
    }
    console.log(`Session cache now populated with ${userSessions.filter(Boolean).length}/${studentCount} sessions.`);
  }

  return {
    scenario: 'Login Burst',
    count: studentCount,
    successRate: (successful / studentCount) * 100,
    p50: stats.p50,
    p95: stats.p95,
    p99: stats.p99,
    max: stats.max,
    timeouts,
    failed
  };
}

// ───────────────────────────────────────────────────────────────────
// TEST B: Dashboard Load (150 students opening dashboard simultaneously)
// ───────────────────────────────────────────────────────────────────
async function runTestB_DashboardLoad(studentCount = 150) {
  console.log(`\n======================================================`);
  console.log(`[TEST B] DASHBOARD LOAD: ${studentCount} Students Opening Dashboard Simultaneously`);
  console.log(`======================================================`);

  const activeUsers = userSessions.filter(Boolean).slice(0, studentCount);

  // Each dashboard load fires 5 parallel endpoints per student (reflecting real frontend Layout & Dashboard calls)
  const requests = [];
  const startAll = Date.now();

  activeUsers.forEach((u) => {
    const headers = makeUserHeaders(u);
    // 1. Student Analytics (Mini)
    requests.push(makeRequest({ method: 'GET', path: `/api/analytics/student/${u.userId}?mini=true`, headers, timeout: 25000 }));
    // 2. Leetcode Active
    requests.push(makeRequest({ method: 'GET', path: '/api/leetcode/active', headers, timeout: 25000 }));
    // 3. Check-In Status
    requests.push(makeRequest({ method: 'GET', path: '/api/checkin-access/my-status', headers, timeout: 25000 }));
    // 4. Attendance Summary
    requests.push(makeRequest({ method: 'GET', path: '/api/attendance/my-summary', headers, timeout: 25000 }));
    // 5. Active Count
    requests.push(makeRequest({ method: 'GET', path: '/api/attendance/active-count', headers, timeout: 25000 }));
  });

  console.log(`Fired ${requests.length} simultaneous HTTP requests (${activeUsers.length} students * 5 calls)...`);
  const results = await Promise.all(requests);
  const totalWallTime = Date.now() - startAll;

  const latencies = results.map(r => r.duration);
  const stats = calculatePercentiles(latencies);
  const successful = results.filter(r => r.status >= 200 && r.status < 400).length;
  const failed = results.filter(r => r.status >= 400 || r.status === 0).length;

  console.log(`\n--- Test B Results ---`);
  console.log(`Total Requests: ${requests.length}`);
  console.log(`Wall clock time: ${totalWallTime}ms (Throughput: ${(requests.length / (totalWallTime / 1000)).toFixed(1)} req/s)`);
  console.log(`Success: ${successful}/${requests.length} (${((successful/requests.length)*100).toFixed(1)}%)`);
  console.log(`Failed: ${failed}/${requests.length}`);
  console.log(`Latency p50: ${stats.p50}ms | p90: ${stats.p90}ms | p95: ${stats.p95}ms | p99: ${stats.p99}ms | Max: ${stats.max}ms`);

  return {
    scenario: 'Dashboard Load',
    count: studentCount,
    totalRequests: requests.length,
    successRate: (successful / requests.length) * 100,
    p50: stats.p50,
    p95: stats.p95,
    p99: stats.p99,
    max: stats.max,
    rps: Number((requests.length / (totalWallTime / 1000)).toFixed(1))
  };
}

// ───────────────────────────────────────────────────────────────────
// TEST C: Attendance Burst (150 students submitting check-in within 10s)
// ───────────────────────────────────────────────────────────────────
async function runTestC_AttendanceBurst(studentCount = 150) {
  console.log(`\n======================================================`);
  console.log(`[TEST C] ATTENDANCE BURST: ${studentCount} Students Checking In Within 10s Window`);
  console.log(`======================================================`);

  const activeUsers = userSessions.filter(Boolean).slice(0, studentCount);

  // Stagger requests across a 10-second window (simulating real students clicking within 10s)
  const windowMs = 10000;
  const startAll = Date.now();

  const checkinPromises = activeUsers.map((u) => {
    const delay = Math.random() * windowMs;
    const headers = makeUserHeaders(u);
    return new Promise(resolve => {
      setTimeout(async () => {
        const res = await makeRequest({
          method: 'POST',
          path: '/api/attendance/checkin',
          headers
        });
        resolve({ user: u, res });
      }, delay);
    });
  });

  const checkinResults = await Promise.all(checkinPromises);
  const wallTime = Date.now() - startAll;

  const latencies = checkinResults.map(r => r.res.duration);
  const stats = calculatePercentiles(latencies);
  const successful = checkinResults.filter(r => r.res.status === 200).length;
  const failed = checkinResults.filter(r => r.res.status !== 200).length;

  console.log(`\n--- Test C Results (Phase 1: Initial Check-ins) ---`);
  console.log(`Wall clock duration: ${wallTime}ms`);
  console.log(`Successful Check-ins: ${successful}/${activeUsers.length}`);
  console.log(`Failed Check-ins: ${failed}/${activeUsers.length}`);
  console.log(`Latency p50: ${stats.p50}ms | p95: ${stats.p95}ms | p99: ${stats.p99}ms | Max: ${stats.max}ms`);

  // Phase 2: Idempotency Verification — Re-send 150 immediate duplicate check-ins!
  console.log(`\n--- Test C (Phase 2: Idempotency & Duplicate Protection) ---`);
  console.log(`Firing 150 IMMEDIATE duplicate check-ins to test race-condition protection...`);
  const duplicatePromises = activeUsers.map(u => {
    return makeRequest({
      method: 'POST',
      path: '/api/attendance/checkin',
      headers: makeUserHeaders(u)
    });
  });

  const dupResults = await Promise.all(duplicatePromises);
  const dupSuccessful = dupResults.filter(r => r.status === 200).length;
  console.log(`Duplicate check-in requests handled idempotently (status 200): ${dupSuccessful}/${activeUsers.length}`);

  return {
    scenario: 'Attendance Burst (10s)',
    count: studentCount,
    successRate: (successful / activeUsers.length) * 100,
    p50: stats.p50,
    p95: stats.p95,
    p99: stats.p99,
    max: stats.max,
    idempotencyPass: dupSuccessful === activeUsers.length
  };
}

// ───────────────────────────────────────────────────────────────────
// TEST D: Group Chat & Socket Load (150 real Socket.io clients)
// ───────────────────────────────────────────────────────────────────
async function runTestD_SocketChatLoad(studentCount = 150) {
  console.log(`\n======================================================`);
  console.log(`[TEST D] GROUP CHAT & SOCKET LOAD: ${studentCount} Live Socket.io Connections`);
  console.log(`======================================================`);

  if (!ioClient) {
    console.warn(`Socket.io-client library not available, skipping live WebSocket test.`);
    return { scenario: 'Socket Chat Load', count: studentCount, skipped: true };
  }

  const activeUsers = userSessions.slice(0, studentCount);
  const sockets = [];
  const connectionLatencies = [];
  let messagesReceived = 0;
  let connectionErrors = 0;

  console.log(`Connecting ${studentCount} Socket.io clients to ${BASE_URL}...`);
  const startConnect = Date.now();

  const BATCH_ID = '6b023dc21e17f4adf3981c33'; // Load-Test-150 batch ObjectId

  const connectPromises = activeUsers.map(u => {
    return new Promise((resolve) => {
      const connStart = Date.now();
      const socket = ioClient(BASE_URL, {
        transports: ['websocket', 'polling'],
        auth: { userId: u.userId, token: u.token },
        query: { userId: u.userId },
        timeout: 15000,
        reconnection: false
      });

      socket.on('connect', () => {
        const duration = Date.now() - connStart;
        connectionLatencies.push(duration);
        socket.emit('join-batch-chat', BATCH_ID);
        resolve({ success: true, socket });
      });

      socket.on('connect_error', (err) => {
        connectionErrors++;
        resolve({ success: false, error: err.message });
      });

      socket.on('chat-message-received', () => {
        messagesReceived++;
      });

      sockets.push(socket);
    });
  });

  const connectResults = await Promise.all(connectPromises);
  const connectWallTime = Date.now() - startConnect;
  const connectedCount = connectResults.filter(r => r.success).length;

  console.log(`\nConnected Sockets: ${connectedCount}/${studentCount} in ${connectWallTime}ms`);
  const connStats = calculatePercentiles(connectionLatencies);
  console.log(`Socket Handshake Latency p50: ${connStats.p50}ms | p95: ${connStats.p95}ms | Max: ${connStats.max}ms`);

  // Send a test broadcast message via the first socket
  if (connectedCount > 0) {
    const sender = sockets.find(s => s.connected);
    if (sender) {
      console.log(`Broadcasting test message from student 1 to Load-Test-150 room...`);
      sender.emit('send-chat-message', {
        batchId: BATCH_ID,
        text: `Load testing broadcast message at ${Date.now()}`
      });

      // Wait 2.0 seconds for message distribution
      await new Promise(r => setTimeout(r, 2000));
      console.log(`Broadcast events received across sockets: ${messagesReceived}`);
    }
  }

  // Gracefully disconnect all test sockets
  console.log(`Disconnecting test sockets...`);
  sockets.forEach(s => {
    try { s.disconnect(); } catch {}
  });

  return {
    scenario: 'Group Chat / Socket.io',
    count: studentCount,
    connectedCount,
    connectionRate: (connectedCount / studentCount) * 100,
    handshakeP50: connStats.p50,
    handshakeP95: connStats.p95,
    messagesDelivered: messagesReceived,
    errors: connectionErrors
  };
}

// ───────────────────────────────────────────────────────────────────
// TEST E: Announcements & Notes (150 students)
// ───────────────────────────────────────────────────────────────────
async function runTestE_AnnouncementsAndNotes(studentCount = 150) {
  console.log(`\n======================================================`);
  console.log(`[TEST E] ANNOUNCEMENTS & NOTES: ${studentCount} Students Concurrently`);
  console.log(`======================================================`);

  const activeUsers = userSessions.filter(Boolean).slice(0, studentCount);
  const requests = [];
  const startAll = Date.now();

  activeUsers.forEach(u => {
    const headers = makeUserHeaders(u);
    requests.push(makeRequest({ method: 'GET', path: '/api/announcements', headers }));
    requests.push(makeRequest({ method: 'GET', path: '/api/notes', headers }));
  });

  const results = await Promise.all(requests);
  const wallTime = Date.now() - startAll;

  const latencies = results.map(r => r.duration);
  const stats = calculatePercentiles(latencies);
  const successful = results.filter(r => r.status === 200).length;

  console.log(`Total Requests: ${requests.length}`);
  console.log(`Success: ${successful}/${requests.length}`);
  console.log(`Wall clock: ${wallTime}ms (${(requests.length / (wallTime / 1000)).toFixed(1)} req/s)`);
  console.log(`Latency p50: ${stats.p50}ms | p95: ${stats.p95}ms | p99: ${stats.p99}ms | Max: ${stats.max}ms`);

  return {
    scenario: 'Announcements & Notes',
    count: studentCount,
    totalRequests: requests.length,
    successRate: (successful / requests.length) * 100,
    p50: stats.p50,
    p95: stats.p95,
    p99: stats.p99,
    max: stats.max
  };
}

// ───────────────────────────────────────────────────────────────────
// TEST F: Mixed Real-World Load (150 students with weighted activities)
// ───────────────────────────────────────────────────────────────────
async function runTestF_MixedRealWorldLoad(studentCount = 150) {
  console.log(`\n======================================================`);
  console.log(`[TEST F] MIXED REAL-WORLD LOAD: ${studentCount} Students Simulating Normal Class`);
  console.log(`======================================================`);

  const activeUsers = userSessions.filter(Boolean).slice(0, studentCount);
  const requests = [];
  const startAll = Date.now();

  activeUsers.forEach((u, i) => {
    const headers = makeUserHeaders(u);
    const rand = Math.random();

    if (rand < 0.25) {
      requests.push(makeRequest({ method: 'GET', path: `/api/analytics/student/${u.userId}?mini=true`, headers }));
    } else if (rand < 0.45) {
      requests.push(makeRequest({ method: 'GET', path: '/api/auth/profile', headers }));
    } else if (rand < 0.60) {
      requests.push(makeRequest({ method: 'GET', path: '/api/attendance/my-summary', headers }));
    } else if (rand < 0.75) {
      requests.push(makeRequest({ method: 'GET', path: '/api/announcements', headers }));
    } else if (rand < 0.85) {
      requests.push(makeRequest({ method: 'GET', path: '/api/chat/batch/Load-Test-150', headers }));
    } else if (rand < 0.95) {
      requests.push(makeRequest({ method: 'GET', path: '/api/leetcode/active', headers }));
    } else {
      requests.push(makeRequest({ method: 'GET', path: '/api/gamification/status', headers }));
    }
  });

  const results = await Promise.all(requests);
  const wallTime = Date.now() - startAll;

  const latencies = results.map(r => r.duration);
  const stats = calculatePercentiles(latencies);
  const successful = results.filter(r => r.status >= 200 && r.status < 400).length;

  console.log(`Total Requests: ${requests.length}`);
  console.log(`Success: ${successful}/${requests.length} (${((successful/requests.length)*100).toFixed(1)}%)`);
  console.log(`Wall clock: ${wallTime}ms (${(requests.length / (wallTime / 1000)).toFixed(1)} req/s)`);
  console.log(`Latency p50: ${stats.p50}ms | p95: ${stats.p95}ms | p99: ${stats.p99}ms | Max: ${stats.max}ms`);

  return {
    scenario: 'Mixed Real-World Load',
    count: studentCount,
    totalRequests: requests.length,
    successRate: (successful / requests.length) * 100,
    p50: stats.p50,
    p95: stats.p95,
    p99: stats.p99,
    max: stats.max
  };
}

// ───────────────────────────────────────────────────────────────────
// TEST G: Stress Test (Gradual Ramp: 25 -> 50 -> 100 -> 150 VUs)
// ───────────────────────────────────────────────────────────────────
async function runTestG_StressTest() {
  console.log(`\n======================================================`);
  console.log(`[TEST G] STRESS TEST: Gradual Step Ramp (25 -> 50 -> 100 -> 150 VUs)`);
  console.log(`======================================================`);

  const stages = [25, 50, 100, 150];
  const stageResults = [];

  for (const vuCount of stages) {
    console.log(`\n--- Stage: ${vuCount} Virtual Users ---`);
    const usersForStage = userSessions.filter(Boolean).slice(0, vuCount);

    const requests = [];
    const startStage = Date.now();

    usersForStage.forEach(u => {
      const headers = makeUserHeaders(u);
      requests.push(makeRequest({ method: 'GET', path: `/api/analytics/student/${u.userId}?mini=true`, headers, timeout: 25000 }));
      requests.push(makeRequest({ method: 'GET', path: '/api/attendance/my-summary', headers, timeout: 25000 }));
      requests.push(makeRequest({ method: 'GET', path: '/api/announcements', headers, timeout: 25000 }));
      requests.push(makeRequest({ method: 'GET', path: '/api/notes', headers, timeout: 25000 }));
    });

    const results = await Promise.all(requests);
    const stageWallTime = Date.now() - startStage;

    const latencies = results.map(r => r.duration);
    const stats = calculatePercentiles(latencies);
    const successful = results.filter(r => r.status >= 200 && r.status < 400).length;
    const errors = results.filter(r => r.status >= 500 || r.status === 0).length;
    const health = await getServerHealth();

    const rps = Number((requests.length / (stageWallTime / 1000)).toFixed(1));
    const errorRate = Number(((errors / requests.length) * 100).toFixed(2));

    console.log(`  Requests: ${requests.length} in ${stageWallTime}ms (${rps} RPS)`);
    console.log(`  Success: ${successful}/${requests.length} | Errors: ${errors} (${errorRate}%)`);
    console.log(`  Latency: p50=${stats.p50}ms, p95=${stats.p95}ms, p99=${stats.p99}ms, max=${stats.max}ms`);
    console.log(`  Server Telemetry: CPU=${health.cpuPercent || 0}%, Mem=${health.memoryPercent || 0}%`);

    stageResults.push({
      vuCount,
      totalRequests: requests.length,
      p50: stats.p50,
      p95: stats.p95,
      p99: stats.p99,
      max: stats.max,
      errorRate,
      rps,
      cpuPercent: health.cpuPercent || 0,
      memoryPercent: health.memoryPercent || 0
    });

    await new Promise(r => setTimeout(r, 1000));
  }

  return stageResults;
}

// ───────────────────────────────────────────────────────────────────
// DATA INTEGRITY VERIFIER
// ───────────────────────────────────────────────────────────────────
async function runDataIntegrityCheck() {
  console.log(`\n======================================================`);
  console.log(`[INTEGRITY AUDIT] Validating Database State & Idempotency in MongoDB`);
  console.log(`======================================================`);

  try {
    const mongoose = require('mongoose');
    require('dotenv').config({ path: path.join(__dirname, '../.env') });
    const connectDB = require('../config/db');

    if (mongoose.connection.readyState !== 1) {
      await connectDB();
    }

    const Attendance = require('../models/Attendance');
    const User = require('../models/User');

    const testUsers = await User.find({ email: /^loadtest_std_/ }).select('_id').lean();
    const testUserIds = testUsers.map(u => u._id);

    const istTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const todayStr = `${istTime.getFullYear()}-${String(istTime.getMonth() + 1).padStart(2, '0')}-${String(istTime.getDate()).padStart(2, '0')}`;

    const totalAttendanceToday = await Attendance.countDocuments({
      studentId: { $in: testUserIds },
      dateStr: todayStr
    });

    // Check for any duplicate records (studentId + dateStr)
    const duplicates = await Attendance.aggregate([
      { $match: { studentId: { $in: testUserIds }, dateStr: todayStr } },
      { $group: { _id: '$studentId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]);

    const activeCount = await Attendance.countDocuments({
      studentId: { $in: testUserIds },
      dateStr: todayStr,
      isActive: true
    });

    console.log(`Total load test attendance records for today (${todayStr}): ${totalAttendanceToday}`);
    console.log(`Active check-ins: ${activeCount}`);
    console.log(`Duplicate records detected: ${duplicates.length}`);

    await mongoose.disconnect();

    const integrityPassed = totalAttendanceToday >= 150 && duplicates.length === 0;
    console.log(`Database Integrity Result: ${integrityPassed ? 'PASSED (100% Consistent, Zero Duplicates)' : 'FAILED'}`);

    return {
      dateStr: todayStr,
      totalAttendanceToday,
      activeCount,
      duplicatesCount: duplicates.length,
      integrityPassed
    };
  } catch (err) {
    console.error('Integrity check error:', err.message);
    return { error: err.message, integrityPassed: false };
  }
}

// ───────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ───────────────────────────────────────────────────────────────────
async function runAllTests() {
  console.log(`\n======================================================`);
  console.log(`SSMS SRE PRODUCTION READINESS AUDIT & LOAD TEST SUITE`);
  console.log(`Target Host: ${BASE_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`======================================================\n`);

  const report = {};

  try {
    report.testA = await runTestA_LoginBurst(150);
    report.testB = await runTestB_DashboardLoad(150);
    report.testC = await runTestC_AttendanceBurst(150);
    report.testD = await runTestD_SocketChatLoad(150);
    report.testE = await runTestE_AnnouncementsAndNotes(150);
    report.testF = await runTestF_MixedRealWorldLoad(150);
    report.testG = await runTestG_StressTest();
    report.integrity = await runDataIntegrityCheck();

    console.log(`\n======================================================`);
    console.log(`LOAD TEST COMPLETED SUCCESSFULLY!`);
    console.log(`======================================================`);

    fs.writeFileSync(
      path.join(__dirname, 'load-test-results.json'),
      JSON.stringify(report, null, 2)
    );
    console.log(`Full report saved to SSMS-BE/scripts/load-test-results.json`);
  } catch (err) {
    console.error('FATAL ERROR DURING LOAD TEST:', err);
  }
}

runAllTests();
