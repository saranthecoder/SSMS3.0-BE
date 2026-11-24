/**
 * SSMS Controlled SRE 150-Student Production Readiness Audit
 *
 * Tests:
 *  - Auth pre-warming & login burst
 *  - 25 VUs Controlled Mixed Workload
 *  - 50 VUs Controlled Mixed Workload
 *  - 100 VUs Controlled Mixed Workload
 *  - 150 VUs Controlled Mixed Workload
 *  - 150 Socket.IO live clients (Room join + message broadcast)
 *  - 150 Attendance check-ins in 10s window + Idempotency check
 *  - Database Integrity Audit
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.TARGET_URL || 'http://localhost:3000';
const isHttps = BASE_URL.startsWith('https');
const httpModule = isHttps ? https : http;

let ioClient = null;
try {
  ioClient = require(path.resolve(__dirname, '../../SSMS-FE/node_modules/socket.io-client'));
} catch (e) {
  console.warn('Socket.io-client not loaded:', e.message);
}

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

function makeRequest({ method = 'GET', path: reqPath, body = null, headers = {}, timeout = 25000 }) {
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

async function getServerHealth() {
  const res = await makeRequest({ method: 'GET', path: '/api/health', timeout: 5000 });
  return res.data || {};
}

const userSessions = [];

function makeUserHeaders(u) {
  if (!u) return {};
  const headers = {};
  if (u.cookie) headers['Cookie'] = u.cookie;
  if (u.userId) headers['x-user-id'] = u.userId;
  if (u.token) headers['Authorization'] = `Bearer ${u.token}`;
  return headers;
}

// ───────────────────────────────────────────────────────────────────
// STAGE 0: Authenticate 150 Students (Concurrently with chunked pacing)
// ───────────────────────────────────────────────────────────────────
async function prepareUserSessions(total = 150) {
  console.log(`\n======================================================`);
  console.log(`[STAGE 0] AUTHENTICATING ${total} STUDENTS`);
  console.log(`======================================================`);

  const chunkSize = 25;
  const startAll = Date.now();
  let authenticated = 0;

  for (let c = 0; c < total; c += chunkSize) {
    const chunk = [];
    for (let i = c + 1; i <= Math.min(c + chunkSize, total); i++) {
      const num = String(i).padStart(3, '0');
      const rollNumber = `LT_${num}`;
      const password = 'LoadTest@123';

      chunk.push(
        makeRequest({
          method: 'POST',
          path: '/api/auth/login',
          body: { rollNumber, password },
          timeout: 25000
        }).then(res => {
          if (res.status === 200 && res.data && res.data._id) {
            let token = res.data.token;
            const setCookie = res.headers['set-cookie'];
            if (!token && setCookie) {
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
            authenticated++;
          }
          return res;
        })
      );
    }
    await Promise.all(chunk);
    console.log(`  Authenticated ${authenticated}/${total} students...`);
  }

  const wallTime = Date.now() - startAll;
  console.log(`Authenticated ${authenticated}/${total} students in ${wallTime}ms.`);
  return { authenticated, wallTime };
}

// ───────────────────────────────────────────────────────────────────
// STAGES 1 - 4: Controlled Virtual User Loads (25, 50, 100, 150 VUs)
// ───────────────────────────────────────────────────────────────────
async function runVULoadStage(vuCount) {
  console.log(`\n======================================================`);
  console.log(`[LOAD STAGE] Testing ${vuCount} Virtual Users Concurrently`);
  console.log(`======================================================`);

  const users = userSessions.slice(0, vuCount);
  const requests = [];
  const startAll = Date.now();

  users.forEach((u) => {
    const headers = makeUserHeaders(u);
    // Realistic student dashboard session endpoints:
    // 1. Dashboard Mini-Analytics
    requests.push(makeRequest({ method: 'GET', path: `/api/analytics/student/${u.userId}?mini=true`, headers }));
    // 2. Leetcode Active Problems
    requests.push(makeRequest({ method: 'GET', path: '/api/leetcode/active', headers }));
    // 3. Attendance Summary
    requests.push(makeRequest({ method: 'GET', path: '/api/attendance/my-summary', headers }));
    // 4. Batch Notes
    requests.push(makeRequest({ method: 'GET', path: '/api/notes', headers }));
    // 5. Announcements
    requests.push(makeRequest({ method: 'GET', path: '/api/announcements', headers }));
  });

  const totalReqs = requests.length;
  console.log(`  Dispatching ${totalReqs} simultaneous API requests (${vuCount} students x 5 endpoints)...`);

  const results = await Promise.all(requests);
  const wallTime = Date.now() - startAll;

  const latencies = results.map(r => r.duration);
  const stats = calculatePercentiles(latencies);
  const successful = results.filter(r => r.status >= 200 && r.status < 400).length;
  const failed = results.filter(r => r.status >= 400 || r.status === 0).length;
  const timeouts = results.filter(r => r.error === 'TIMEOUT').length;
  const health = await getServerHealth();

  const rps = Number((totalReqs / (wallTime / 1000)).toFixed(1));
  const errorRate = Number(((failed / totalReqs) * 100).toFixed(2));

  console.log(`  Finished ${totalReqs} requests in ${wallTime}ms (${rps} req/sec)`);
  console.log(`  Success: ${successful}/${totalReqs} (${((successful / totalReqs) * 100).toFixed(1)}%) | Failed: ${failed} | Timeouts: ${timeouts}`);
  console.log(`  Latency: p50=${stats.p50}ms | p90=${stats.p90}ms | p95=${stats.p95}ms | p99=${stats.p99}ms | Max=${stats.max}ms`);
  console.log(`  Server Health: CPU=${health.cpuPercent || 0}%, Memory=${health.memoryPercent || 0}%`);

  return {
    vuCount,
    totalRequests: totalReqs,
    wallTimeMs: wallTime,
    successful,
    failed,
    timeouts,
    errorRate,
    rps,
    p50: stats.p50,
    p90: stats.p90,
    p95: stats.p95,
    p99: stats.p99,
    max: stats.max,
    cpuPercent: health.cpuPercent || 0,
    memoryPercent: health.memoryPercent || 0
  };
}

// ───────────────────────────────────────────────────────────────────
// STAGE 5: Socket.IO 150-Client Load
// ───────────────────────────────────────────────────────────────────
async function runSocketIOLoad(clientCount = 150) {
  console.log(`\n======================================================`);
  console.log(`[STAGE 5] SOCKET.IO LOAD: ${clientCount} Real Connected Clients`);
  console.log(`======================================================`);

  if (!ioClient) {
    console.warn('Socket.io client not available, skipping.');
    return { skipped: true };
  }

  const BATCH_ID = '6b023dc21e17f4adf3981c33';
  const users = userSessions.slice(0, clientCount);
  const sockets = [];
  const connectionLatencies = [];
  let messagesReceived = 0;
  let connectionErrors = 0;

  const startConnect = Date.now();
  console.log(`  Connecting ${clientCount} WebSocket clients...`);

  const connectPromises = users.map(u => {
    return new Promise(resolve => {
      let resolved = false;
      const connStart = Date.now();

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          connectionErrors++;
          resolve({ success: false, error: 'SOCKET_TIMEOUT' });
        }
      }, 15000);

      const socket = ioClient(BASE_URL, {
        transports: ['websocket', 'polling'],
        auth: { userId: u.userId, token: u.token },
        query: { userId: u.userId },
        timeout: 12000,
        reconnection: false
      });

      socket.on('connect', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          const duration = Date.now() - connStart;
          connectionLatencies.push(duration);
          socket.emit('join-batch-chat', BATCH_ID);
          resolve({ success: true, socket });
        }
      });

      socket.on('connect_error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          connectionErrors++;
          resolve({ success: false, error: err.message });
        }
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

  console.log(`  Connected: ${connectedCount}/${clientCount} in ${connectWallTime}ms`);
  const connStats = calculatePercentiles(connectionLatencies);
  console.log(`  Handshake Latency: p50=${connStats.p50}ms | p95=${connStats.p95}ms | Max=${connStats.max}ms`);

  // Broadcast test message
  if (connectedCount > 0) {
    const sender = sockets.find(s => s.connected);
    if (sender) {
      console.log(`  Emitting broadcast message to batch ${BATCH_ID}...`);
      sender.emit('send-chat-message', {
        batchId: BATCH_ID,
        text: `Automated load test verification at ${Date.now()}`
      });
      await new Promise(r => setTimeout(r, 2000));
      console.log(`  Broadcast deliveries confirmed: ${messagesReceived}`);
    }
  }

  sockets.forEach(s => {
    try { s.disconnect(); } catch {}
  });

  return {
    clientCount,
    connectedCount,
    connectionRate: (connectedCount / clientCount) * 100,
    handshakeP50: connStats.p50,
    handshakeP95: connStats.p95,
    messagesReceived,
    errors: connectionErrors
  };
}

// ───────────────────────────────────────────────────────────────────
// STAGE 6: Attendance Burst (150 students in 10s window) + Idempotency
// ───────────────────────────────────────────────────────────────────
async function runAttendanceBurst(studentCount = 150) {
  console.log(`\n======================================================`);
  console.log(`[STAGE 6] ATTENDANCE BURST: ${studentCount} Students in 10-Second Window`);
  console.log(`======================================================`);

  const users = userSessions.slice(0, studentCount);
  const windowMs = 10000;
  const startAll = Date.now();

  const checkinPromises = users.map(u => {
    const delay = Math.random() * windowMs;
    const headers = makeUserHeaders(u);
    return new Promise(resolve => {
      setTimeout(async () => {
        const res = await makeRequest({
          method: 'POST',
          path: '/api/attendance/checkin',
          headers,
          timeout: 25000
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

  console.log(`  Finished 10s check-in window in ${wallTime}ms`);
  console.log(`  Successful check-ins: ${successful}/${studentCount} (${((successful / studentCount) * 100).toFixed(1)}%) | Failed: ${failed}`);
  console.log(`  Latency: p50=${stats.p50}ms | p95=${stats.p95}ms | p99=${stats.p99}ms | Max=${stats.max}ms`);

  // Idempotency check: fire 150 duplicate requests at the exact same instant
  console.log(`\n  Testing idempotency: Firing 150 simultaneous duplicate check-in requests...`);
  const dupPromises = users.map(u => {
    return makeRequest({
      method: 'POST',
      path: '/api/attendance/checkin',
      headers: makeUserHeaders(u),
      timeout: 25000
    });
  });

  const dupResults = await Promise.all(dupPromises);
  const dupSuccessful = dupResults.filter(r => r.status === 200).length;
  console.log(`  Idempotent duplicate check-ins handled safely (Status 200): ${dupSuccessful}/${studentCount}`);

  return {
    studentCount,
    wallTimeMs: wallTime,
    successful,
    failed,
    p50: stats.p50,
    p95: stats.p95,
    p99: stats.p99,
    max: stats.max,
    idempotentPass: dupSuccessful === studentCount
  };
}

// ───────────────────────────────────────────────────────────────────
// STAGE 7: Database Integrity Verification in MongoDB Atlas
// ───────────────────────────────────────────────────────────────────
async function runDatabaseIntegrityAudit() {
  console.log(`\n======================================================`);
  console.log(`[STAGE 7] DATABASE INTEGRITY AUDIT`);
  console.log(`======================================================`);

  const mongoose = require('mongoose');
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const connectDB = require('../config/db');

  await connectDB();

  const Attendance = require('../models/Attendance');
  const User = require('../models/User');

  const testUsers = await User.find({ email: /^loadtest_std_/ }).select('_id').lean();
  const testUserIds = testUsers.map(u => u._id);

  const istTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const todayStr = `${istTime.getFullYear()}-${String(istTime.getMonth() + 1).padStart(2, '0')}-${String(istTime.getDate()).padStart(2, '0')}`;

  const totalRecordsToday = await Attendance.countDocuments({
    studentId: { $in: testUserIds },
    dateStr: todayStr
  });

  const distinctStudents = await Attendance.distinct('studentId', {
    studentId: { $in: testUserIds },
    dateStr: todayStr
  });

  const duplicates = await Attendance.aggregate([
    { $match: { studentId: { $in: testUserIds }, dateStr: todayStr } },
    { $group: { _id: '$studentId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]);

  console.log(`  Date String: ${todayStr}`);
  console.log(`  Total Attendance Records in DB: ${totalRecordsToday}`);
  console.log(`  Distinct Students Recorded: ${distinctStudents.length}`);
  console.log(`  Duplicate Records: ${duplicates.length}`);

  const passed = totalRecordsToday >= 150 && duplicates.length === 0;
  console.log(`  Integrity Result: ${passed ? 'PASSED (Zero Duplicate Records)' : 'FAILED'}`);

  await mongoose.disconnect();

  return {
    dateStr: todayStr,
    totalRecordsToday,
    distinctStudentsCount: distinctStudents.length,
    duplicatesCount: duplicates.length,
    passed
  };
}

// ───────────────────────────────────────────────────────────────────
// MASTER EXECUTION
// ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n******************************************************`);
  console.log(`STARTING CONTROLLED 150-STUDENT SRE PRODUCTION AUDIT`);
  console.log(`Target: ${BASE_URL} | Time: ${new Date().toISOString()}`);
  console.log(`******************************************************`);

  const report = {};

  try {
    report.stage0_auth = await prepareUserSessions(150);
    report.stage1_25vu = await runVULoadStage(25);
    report.stage2_50vu = await runVULoadStage(50);
    report.stage3_100vu = await runVULoadStage(100);
    report.stage4_150vu = await runVULoadStage(150);
    report.stage5_socket = await runSocketIOLoad(150);
    report.stage6_attendance = await runAttendanceBurst(150);
    report.stage7_integrity = await runDatabaseIntegrityAudit();

    fs.writeFileSync(
      path.join(__dirname, 'controlled-audit-results.json'),
      JSON.stringify(report, null, 2)
    );

    console.log(`\n******************************************************`);
    console.log(`AUDIT FINISHED! Results written to controlled-audit-results.json`);
    console.log(`******************************************************`);
  } catch (err) {
    console.error('Fatal audit failure:', err);
  }
}

main();
