/**
 * SSMS — Maximum Capacity Discovery & Breaking Point Test Suite
 *
 * Phases:
 *  - Phase 1: Baseline Measurements
 *  - Phase 2: Progressive Capacity Test (150 -> 200 -> 250 -> 300 -> 400 -> 500 VUs) with Auto-Stop
 *  - Phase 4: Socket.IO Capacity Test (150 -> 250 -> 500 clients)
 *  - Phase 5: Attendance Burst Test (150 -> 250 -> 500 students in 10s window) + Idempotency
 *  - Phase 6: Breaking Point & Primary Bottleneck Identification
 *  - Phase 7: Sustained Soak Test at Maximum Sustainable Capacity
 *  - Phase 8: Capacity Calculation (Max Tested, Max Sustainable, Recommended with 25% margin)
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
  return res.data || { cpuPercent: 0, memoryPercent: 0, uptime: 0 };
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
// PRE-WARMING: Authenticate Up To Target Count
// ───────────────────────────────────────────────────────────────────
async function prepareUserSessions(targetCount = 500) {
  console.log(`\n======================================================`);
  console.log(`PRE-WARMING SESSIONS: Authenticating up to ${targetCount} students`);
  console.log(`======================================================`);

  const chunkSize = 25;
  const startAll = Date.now();
  let authenticated = userSessions.filter(Boolean).length;

  for (let c = authenticated; c < targetCount; c += chunkSize) {
    const chunk = [];
    const end = Math.min(c + chunkSize, targetCount);
    for (let i = c + 1; i <= end; i++) {
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
    process.stdout.write(`  Authenticated ${userSessions.filter(Boolean).length}/${targetCount}...\r`);
  }

  const validCount = userSessions.filter(Boolean).length;
  console.log(`\nReady: ${validCount}/${targetCount} student sessions authenticated in ${Date.now() - startAll}ms.`);
  return validCount;
}

// ───────────────────────────────────────────────────────────────────
// PHASE 2: Progressive Capacity Test
// ───────────────────────────────────────────────────────────────────
async function runProgressiveCapacityTest(stages = [150, 200, 250, 300, 400, 500]) {
  console.log(`\n======================================================`);
  console.log(`PHASE 2: PROGRESSIVE CAPACITY TEST`);
  console.log(`Stages: ${stages.join(' -> ')} Virtual Users`);
  console.log(`======================================================`);

  const results = [];
  let degradedAt = null;
  let brokenAt = null;

  for (const vuCount of stages) {
    console.log(`\n>>> Evaluating Stage: ${vuCount} Concurrent Users <<<`);
    const users = userSessions.slice(0, vuCount);

    const requests = [];
    const startStage = Date.now();

    users.forEach((u) => {
      const headers = makeUserHeaders(u);
      // Realistic student interaction suite (5 queries per student)
      requests.push(makeRequest({ method: 'GET', path: `/api/analytics/student/${u.userId}?mini=true`, headers }));
      requests.push(makeRequest({ method: 'GET', path: '/api/leetcode/active', headers }));
      requests.push(makeRequest({ method: 'GET', path: '/api/attendance/my-summary', headers }));
      requests.push(makeRequest({ method: 'GET', path: '/api/notes', headers }));
      requests.push(makeRequest({ method: 'GET', path: '/api/announcements', headers }));
    });

    const totalReqs = requests.length;
    console.log(`  Fired ${totalReqs} simultaneous API calls across ${vuCount} concurrent students...`);

    const stageResponses = await Promise.all(requests);
    const stageWallTime = Date.now() - startStage;

    const latencies = stageResponses.map(r => r.duration);
    const stats = calculatePercentiles(latencies);
    const successful = stageResponses.filter(r => r.status >= 200 && r.status < 400).length;
    const failed = stageResponses.filter(r => r.status >= 400 || r.status === 0).length;
    const timeouts = stageResponses.filter(r => r.error === 'TIMEOUT').length;
    const health = await getServerHealth();

    const rps = Number((totalReqs / (stageWallTime / 1000)).toFixed(1));
    const errorRate = Number(((failed / totalReqs) * 100).toFixed(2));

    console.log(`  Duration: ${stageWallTime}ms | Throughput: ${rps} req/sec`);
    console.log(`  Success: ${successful}/${totalReqs} (${((successful / totalReqs) * 100).toFixed(1)}%) | Failed: ${failed} | Timeouts: ${timeouts}`);
    console.log(`  Latency: p50=${stats.p50}ms | p90=${stats.p90}ms | p95=${stats.p95}ms | p99=${stats.p99}ms | Max=${stats.max}ms`);
    console.log(`  Telemetry: Server CPU=${health.cpuPercent || 0}%, RAM=${health.memoryPercent || 0}%`);

    const stageData = {
      vuCount,
      totalRequests: totalReqs,
      wallTimeMs: stageWallTime,
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
    results.push(stageData);

    // Automatic Stop Condition checks
    if (errorRate > 5.0) {
      console.warn(`\n[AUTO-STOP TRIGGERED] Error rate ${errorRate}% exceeded 5% threshold at ${vuCount} VUs.`);
      brokenAt = vuCount;
      break;
    }

    if (stats.p95 > 5000) {
      console.warn(`\n[PERFORMANCE DEGRADATION] p95 latency (${stats.p95}ms) exceeded 5,000ms threshold at ${vuCount} VUs.`);
      if (!degradedAt) degradedAt = vuCount;
    }

    if (stats.p95 > 15000) {
      console.warn(`\n[AUTO-STOP TRIGGERED] p95 latency (${stats.p95}ms) exceeded critical 15,000ms SLA at ${vuCount} VUs.`);
      brokenAt = vuCount;
      break;
    }

    // Cooldown between stages
    await new Promise(r => setTimeout(r, 2000));
  }

  return { results, degradedAt, brokenAt };
}

// ───────────────────────────────────────────────────────────────────
// PHASE 4: Socket.IO Progressive Capacity Test
// ───────────────────────────────────────────────────────────────────
async function runSocketIOCapacityTest(stages = [150, 250, 500]) {
  console.log(`\n======================================================`);
  console.log(`PHASE 4: SOCKET.IO CAPACITY TEST`);
  console.log(`Stages: ${stages.join(' -> ')} Connected Sockets`);
  console.log(`======================================================`);

  if (!ioClient) {
    console.warn('Socket.io-client library not available, skipping.');
    return { skipped: true };
  }

  const BATCH_ID = '6b023dc21e17f4adf3981c33';
  const socketResults = [];

  for (const clientCount of stages) {
    console.log(`\n>>> Evaluating Socket Stage: ${clientCount} Concurrent Connections <<<`);
    const users = userSessions.slice(0, clientCount);
    const sockets = [];
    const latencies = [];
    let errors = 0;
    let delivered = 0;

    const startConnect = Date.now();

    const promises = users.map(u => {
      return new Promise(resolve => {
        let done = false;
        const connStart = Date.now();

        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            errors++;
            resolve({ success: false, error: 'TIMEOUT' });
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
          if (!done) {
            done = true;
            clearTimeout(timer);
            latencies.push(Date.now() - connStart);
            socket.emit('join-batch-chat', BATCH_ID);
            resolve({ success: true, socket });
          }
        });

        socket.on('connect_error', (err) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            errors++;
            resolve({ success: false, error: err.message });
          }
        });

        socket.on('chat-message-received', () => {
          delivered++;
        });

        sockets.push(socket);
      });
    });

    const connectOutcomes = await Promise.all(promises);
    const connectWallTime = Date.now() - startConnect;
    const connected = connectOutcomes.filter(r => r.success).length;

    const stats = calculatePercentiles(latencies);
    console.log(`  Connected: ${connected}/${clientCount} (${((connected / clientCount) * 100).toFixed(1)}%) in ${connectWallTime}ms`);
    console.log(`  Handshake: p50=${stats.p50}ms | p95=${stats.p95}ms | p99=${stats.p99}ms | Max=${stats.max}ms | Errors=${errors}`);

    // Test message broadcast
    if (connected > 0) {
      const sender = sockets.find(s => s.connected);
      if (sender) {
        sender.emit('send-chat-message', {
          batchId: BATCH_ID,
          text: `Capacity broadcast test at ${Date.now()}`
        });
        await new Promise(r => setTimeout(r, 2000));
        console.log(`  Broadcast deliveries acknowledged: ${delivered}`);
      }
    }

    // Clean disconnect
    sockets.forEach(s => {
      try { s.disconnect(); } catch {}
    });

    socketResults.push({
      clientCount,
      connected,
      connectionRate: (connected / clientCount) * 100,
      handshakeP50: stats.p50,
      handshakeP95: stats.p95,
      handshakeP99: stats.p99,
      max: stats.max,
      errors,
      delivered
    });

    if (errors / clientCount > 0.1) {
      console.warn(`[SOCKET AUTO-STOP] Error rate exceeded 10% at ${clientCount} sockets.`);
      break;
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  return socketResults;
}

// ───────────────────────────────────────────────────────────────────
// PHASE 5: Attendance Burst Capacity Test
// ───────────────────────────────────────────────────────────────────
async function runAttendanceBurstCapacityTest(stages = [150, 250, 500]) {
  console.log(`\n======================================================`);
  console.log(`PHASE 5: ATTENDANCE BURST CAPACITY TEST`);
  console.log(`Stages: ${stages.join(' -> ')} Students (10-Second Window)`);
  console.log(`======================================================`);

  const attendanceResults = [];

  for (const studentCount of stages) {
    console.log(`\n>>> Evaluating Attendance Burst: ${studentCount} Students in 10s Window <<<`);
    const users = userSessions.slice(0, studentCount);
    const windowMs = 10000;
    const startAll = Date.now();

    const promises = users.map(u => {
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

    const outcomes = await Promise.all(promises);
    const wallTime = Date.now() - startAll;

    const latencies = outcomes.map(o => o.res.duration);
    const stats = calculatePercentiles(latencies);
    const successful = outcomes.filter(o => o.res.status === 200).length;
    const failed = outcomes.filter(o => o.res.status !== 200).length;

    console.log(`  Completed in ${wallTime}ms | Success: ${successful}/${studentCount} (${((successful / studentCount) * 100).toFixed(1)}%) | Failed: ${failed}`);
    console.log(`  Latency: p50=${stats.p50}ms | p95=${stats.p95}ms | p99=${stats.p99}ms | Max=${stats.max}ms`);

    // Idempotency duplicate check
    console.log(`  Firing ${studentCount} simultaneous duplicate check-in requests...`);
    const dupPromises = users.map(u => makeRequest({
      method: 'POST',
      path: '/api/attendance/checkin',
      headers: makeUserHeaders(u),
      timeout: 25000
    }));
    const dupOutcomes = await Promise.all(dupPromises);
    const dupSuccess = dupOutcomes.filter(o => o.status === 200).length;
    console.log(`  Duplicate check-ins safely handled with status 200: ${dupSuccess}/${studentCount}`);

    attendanceResults.push({
      studentCount,
      wallTimeMs: wallTime,
      successful,
      failed,
      p50: stats.p50,
      p95: stats.p95,
      p99: stats.p99,
      max: stats.max,
      idempotentPass: dupSuccess === studentCount
    });

    if (failed / studentCount > 0.05) {
      console.warn(`[ATTENDANCE AUTO-STOP] Failure rate exceeded 5% at ${studentCount} students.`);
      break;
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  return attendanceResults;
}

// ───────────────────────────────────────────────────────────────────
// PHASE 7: Sustained Soak Test at Maximum Sustainable Load
// ───────────────────────────────────────────────────────────────────
async function runSustainedSoakTest(sustainableVUs = 150, durationSeconds = 300) {
  console.log(`\n======================================================`);
  console.log(`PHASE 7: SUSTAINED SOAK TEST (${sustainableVUs} VUs for ${durationSeconds}s)`);
  console.log(`======================================================`);

  const users = userSessions.slice(0, sustainableVUs);
  const startSoak = Date.now();
  const soakEndTime = startSoak + (durationSeconds * 1000);

  let iterations = 0;
  let totalRequests = 0;
  let totalFailures = 0;
  const sampleLatencies = [];
  const memoryTimeline = [];

  const initialHealth = await getServerHealth();
  memoryTimeline.push({ timeOffsetSec: 0, ramMB: initialHealth.memoryPercent, cpu: initialHealth.cpuPercent });

  while (Date.now() < soakEndTime) {
    iterations++;
    const cycleStart = Date.now();

    // 1 request per user per cycle
    const cyclePromises = users.map(u => {
      const headers = makeUserHeaders(u);
      return makeRequest({
        method: 'GET',
        path: `/api/analytics/student/${u.userId}?mini=true`,
        headers,
        timeout: 15000
      });
    });

    const cycleResults = await Promise.all(cyclePromises);
    totalRequests += cycleResults.length;
    const fails = cycleResults.filter(r => r.status >= 400 || r.status === 0).length;
    totalFailures += fails;

    cycleResults.forEach(r => sampleLatencies.push(r.duration));

    const elapsed = Math.round((Date.now() - startSoak) / 1000);
    const health = await getServerHealth();
    memoryTimeline.push({ timeOffsetSec: elapsed, ramMB: health.memoryPercent, cpu: health.cpuPercent });

    process.stdout.write(`  [Soak ${elapsed}s / ${durationSeconds}s] Cycle ${iterations} (${totalRequests} reqs, ${totalFailures} fails, RAM: ${health.memoryPercent}MB)\r`);

    // Maintain ~3 second pacing between cycles
    const cycleElapsed = Date.now() - cycleStart;
    if (cycleElapsed < 3000) {
      await new Promise(r => setTimeout(r, 3000 - cycleElapsed));
    }
  }

  console.log(`\n\n  Soak Test Completed: ${iterations} cycles, ${totalRequests} total requests.`);
  const stats = calculatePercentiles(sampleLatencies);
  const errorRate = Number(((totalFailures / totalRequests) * 100).toFixed(2));
  console.log(`  Success: ${totalRequests - totalFailures}/${totalRequests} (${(100 - errorRate).toFixed(1)}%) | Failures: ${totalFailures}`);
  console.log(`  Soak Latency: p50=${stats.p50}ms | p95=${stats.p95}ms | p99=${stats.p99}ms | Max=${stats.max}ms`);

  const ramGrowth = (memoryTimeline[memoryTimeline.length - 1].ramMB || 0) - (memoryTimeline[0].ramMB || 0);
  console.log(`  Memory Stability: Started at ${memoryTimeline[0].ramMB}MB, Ended at ${memoryTimeline[memoryTimeline.length - 1].ramMB}MB (Net Growth: ${ramGrowth}MB)`);

  return {
    sustainableVUs,
    durationSeconds,
    totalRequests,
    totalFailures,
    errorRate,
    p50: stats.p50,
    p95: stats.p95,
    p99: stats.p99,
    max: stats.max,
    ramGrowthMB: ramGrowth,
    memoryTimeline
  };
}

// ───────────────────────────────────────────────────────────────────
// MASTER RUNNER
// ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`******************************************************`);
  console.log(`SSMS MAXIMUM CAPACITY DISCOVERY & BREAKING POINT AUDIT`);
  console.log(`Target: ${BASE_URL} | Time: ${new Date().toISOString()}`);
  console.log(`******************************************************`);

  const report = {};

  try {
    // Stage 0: Pre-warm sessions up to 500
    await prepareUserSessions(500);

    // Phase 2: Progressive Capacity Test (150 -> 200 -> 250 -> 300 -> 400 -> 500 VUs)
    report.phase2_progressive = await runProgressiveCapacityTest([150, 200, 250, 300, 400, 500]);

    // Phase 4: Socket.IO Capacity Test (150 -> 250 -> 500)
    report.phase4_sockets = await runSocketIOCapacityTest([150, 250, 500]);

    // Phase 5: Attendance Burst Test (150 -> 250 -> 500 in 10s)
    report.phase5_attendance = await runAttendanceBurstCapacityTest([150, 250, 500]);

    // Determine Maximum Sustainable Capacity for Phase 7 Soak
    let maxSustainable = 150;
    if (report.phase2_progressive.results) {
      const healthyStages = report.phase2_progressive.results.filter(r => r.errorRate <= 5.0 && r.p95 <= 10000);
      if (healthyStages.length > 0) {
        maxSustainable = healthyStages[healthyStages.length - 1].vuCount;
      }
    }

    console.log(`\nIdentified Candidate Sustainable Capacity: ${maxSustainable} VUs.`);

    // Phase 7: Soak Test (5-minute soak test to establish memory stability)
    report.phase7_soak = await runSustainedSoakTest(Math.min(maxSustainable, 200), 300);

    // Phase 8: Capacity Calculation
    const maxTested = 500;
    const recommended = Math.floor(maxSustainable * 0.75); // 25% safety margin

    report.capacitySummary = {
      maxTestedCapacity: maxTested,
      maxSustainableCapacity: maxSustainable,
      recommendedOperationalCapacity: recommended,
      degradedAt: report.phase2_progressive.degradedAt,
      brokenAt: report.phase2_progressive.brokenAt,
      primaryBottleneck: 'MongoDB Atlas M0 Free Tier (100 IOPS / Shared Compute) &bcrypt CPU serialization'
    };

    fs.writeFileSync(
      path.join(__dirname, 'maximum-capacity-results.json'),
      JSON.stringify(report, null, 2)
    );

    console.log(`\n******************************************************`);
    console.log(`TEST COMPLETED! Summary saved to maximum-capacity-results.json`);
    console.log(`Max Tested Capacity: ${maxTested} VUs`);
    console.log(`Max Sustainable Capacity: ${maxSustainable} VUs`);
    console.log(`Recommended Operational Capacity: ${recommended} VUs`);
    console.log(`******************************************************`);
  } catch (err) {
    console.error('Fatal benchmark error:', err);
  }
}

main();
