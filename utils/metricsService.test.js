const test = require('node:test');
const assert = require('node:assert/strict');
const metricsService = require('./metricsService');

test('MetricsService initializes with zero counts and truthful initial state', () => {
  metricsService.reset();
  const snapshot = metricsService.getSnapshot();

  assert.equal(snapshot.totalRequests, 0);
  assert.equal(snapshot.appRequests, 0);
  assert.equal(snapshot.probeRequests, 0);
  assert.equal(snapshot.rpm, 0);
  assert.equal(snapshot.appRpm, 0);
  assert.equal(snapshot.probeRpm, 0);
  assert.equal(snapshot.avgProcessingLatencyMs, 0);
});

test('MetricsService separates actual app/student requests from health probes', () => {
  metricsService.reset();

  // 3 student API calls
  metricsService.recordRequest({ path: '/api/auth/profile', durationMs: 25, statusCode: 200 });
  metricsService.recordRequest({ path: '/api/tasks/list', durationMs: 40, statusCode: 200 });
  metricsService.recordRequest({ path: '/api/submissions/submit', durationMs: 65, statusCode: 201 });

  // 2 health / probe calls
  metricsService.recordRequest({ path: '/api/health/ready', durationMs: 2, statusCode: 200 });
  metricsService.recordRequest({ path: '/api/traffic/ping', durationMs: 5, statusCode: 200 });

  const snapshot = metricsService.getSnapshot();

  assert.equal(snapshot.totalRequests, 5);
  assert.equal(snapshot.appRequests, 3);
  assert.equal(snapshot.probeRequests, 2);
  assert.equal(snapshot.appRpm, 3);
  assert.equal(snapshot.probeRpm, 2);
  assert.equal(snapshot.rpm, 5);
});

test('MetricsService calculates latency average from real measurements', () => {
  metricsService.reset();

  metricsService.recordRequest({ path: '/api/tasks/1', durationMs: 10, statusCode: 200 });
  metricsService.recordRequest({ path: '/api/tasks/2', durationMs: 20, statusCode: 200 });
  metricsService.recordRequest({ path: '/api/tasks/3', durationMs: 30, statusCode: 200 });

  const snapshot = metricsService.getSnapshot();
  assert.equal(snapshot.avgProcessingLatencyMs, 20);
});

test('MetricsService purges requests older than 60 seconds from frequency calculation', () => {
  metricsService.reset();

  const now = Date.now();
  // Simulate an old request from 65 seconds ago
  metricsService.slidingWindow.push({ timestamp: now - 65000, isProbe: false });
  // Simulate a fresh request from 10 seconds ago
  metricsService.slidingWindow.push({ timestamp: now - 10000, isProbe: false });

  const snapshot = metricsService.getSnapshot();
  // Old request should be purged from RPM, leaving only the fresh request
  assert.equal(snapshot.appRpm, 1);
  assert.equal(snapshot.rpm, 1);
});
