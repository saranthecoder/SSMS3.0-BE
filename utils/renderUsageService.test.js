const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateUsageMetrics, fetchRenderServicesIfConfigured } = require('./renderUsageService');

test('Render Usage: Calculates remaining hours, percentage, and burn rate correctly', () => {
  const mockDoc = {
    workspaceAllowanceHours: 750,
    consumedHours: 615,
    bandwidthLimitGB: 100,
    bandwidthConsumedGB: 20,
    buildMinutesLimit: 500,
    buildMinutesConsumed: 100,
    warningThresholds: [70, 85, 95],
    lastManualUpdate: new Date()
  };

  const metrics = calculateUsageMetrics(mockDoc);

  assert.equal(metrics.allowanceHours, 750);
  assert.equal(metrics.consumedHours, 615);
  assert.equal(metrics.remainingHours, 135);
  assert.equal(metrics.usagePercent, 82.0);

  // Bandwidth
  assert.equal(metrics.bandwidth.limitGB, 100);
  assert.equal(metrics.bandwidth.consumedGB, 20);
  assert.equal(metrics.bandwidth.remainingGB, 80);
  assert.equal(metrics.bandwidth.percent, 20.0);

  // Build Minutes
  assert.equal(metrics.buildMinutes.limitMin, 500);
  assert.equal(metrics.buildMinutes.consumedMin, 100);
  assert.equal(metrics.buildMinutes.remainingMin, 400);
  assert.equal(metrics.buildMinutes.percent, 20.0);

  // Warning thresholds
  assert.equal(metrics.warnings.alertLevel, 'warning'); // 82% is >= 70% and < 85%
  assert.equal(metrics.warnings.reports.length, 3);
  assert.equal(metrics.warnings.reports[0].percent, 70);
  assert.equal(metrics.warnings.reports[0].isTriggered, true);
  assert.equal(metrics.warnings.reports[1].percent, 85);
  assert.equal(metrics.warnings.reports[1].isTriggered, false);
  assert.equal(metrics.warnings.reports[2].percent, 95);
  assert.equal(metrics.warnings.reports[2].isTriggered, false);
});

test('Render Usage: Distinguishes workspace pool from individual services without subtracting single service', () => {
  const mockDoc = {
    workspaceAllowanceHours: 750,
    consumedHours: 615, // Combined workspace consumption
    bandwidthLimitGB: 100,
    bandwidthConsumedGB: 0,
    buildMinutesLimit: 500,
    buildMinutesConsumed: 0,
    cachedRenderServices: [
      { id: 'srv-1', name: 'SSMS-BE', plan: 'free', status: 'active' },
      { id: 'srv-2', name: 'Other-BE', plan: 'free', status: 'active' }
    ]
  };

  const metrics = calculateUsageMetrics(mockDoc);

  // Remaining workspace hours must be 750 - 615 = 135
  assert.equal(metrics.remainingHours, 135);
  assert.equal(metrics.allowanceHours, 750);
  // Verify workspace allowance is not mistakenly reduced by any single service
  assert.equal(metrics.consumedHours, 615);
});

test('Render Usage: Correctly triggers critical alert at or above 95%', () => {
  const mockDoc = {
    workspaceAllowanceHours: 750,
    consumedHours: 720, // 96%
    bandwidthLimitGB: 100,
    bandwidthConsumedGB: 0,
    buildMinutesLimit: 500,
    buildMinutesConsumed: 0,
    warningThresholds: [70, 85, 95]
  };

  const metrics = calculateUsageMetrics(mockDoc);

  assert.equal(metrics.remainingHours, 30);
  assert.equal(metrics.usagePercent, 96.0);
  assert.equal(metrics.warnings.alertLevel, 'critical');
  assert.equal(metrics.warnings.reports[2].isTriggered, true);
});

test('Render Usage: Correctly triggers high alert between 85% and 94.9%', () => {
  const mockDoc = {
    workspaceAllowanceHours: 750,
    consumedHours: 650, // 86.7%
    bandwidthLimitGB: 100,
    bandwidthConsumedGB: 0,
    buildMinutesLimit: 500,
    buildMinutesConsumed: 0,
    warningThresholds: [70, 85, 95]
  };

  const metrics = calculateUsageMetrics(mockDoc);

  assert.equal(metrics.warnings.alertLevel, 'high');
  assert.equal(metrics.warnings.reports[1].isTriggered, true);
  assert.equal(metrics.warnings.reports[2].isTriggered, false);
});

test('Render Usage: Handles edge cases (zero allowance, over-consumed, missing data)', () => {
  // Over-consumed
  const overDoc = {
    workspaceAllowanceHours: 750,
    consumedHours: 780, // Exceeded
    bandwidthLimitGB: 100,
    bandwidthConsumedGB: 120,
    buildMinutesLimit: 500,
    buildMinutesConsumed: 550
  };

  const overMetrics = calculateUsageMetrics(overDoc);
  assert.equal(overMetrics.remainingHours, 0);
  assert.equal(overMetrics.usagePercent, 104.0);
  assert.equal(overMetrics.bandwidth.remainingGB, 0);
  assert.equal(overMetrics.buildMinutes.remainingMin, 0);
  assert.equal(overMetrics.warnings.alertLevel, 'critical');

  // Zero allowance
  const zeroDoc = {
    workspaceAllowanceHours: 0,
    consumedHours: 0
  };
  const zeroMetrics = calculateUsageMetrics(zeroDoc);
  assert.equal(zeroMetrics.remainingHours, 0);
  assert.equal(zeroMetrics.usagePercent, 0);
});

test('Render Usage: Detects stale data older than 48 hours', () => {
  const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const staleDoc = {
    workspaceAllowanceHours: 750,
    consumedHours: 615,
    lastManualUpdate: threeDaysAgo
  };

  const metrics = calculateUsageMetrics(staleDoc);
  assert.equal(metrics.audit.isStale, true);

  const freshDoc = {
    workspaceAllowanceHours: 750,
    consumedHours: 615,
    lastManualUpdate: new Date()
  };
  const freshMetrics = calculateUsageMetrics(freshDoc);
  assert.equal(freshMetrics.audit.isStale, false);
});

test('Render Usage: Verifies calendar reset period matches UTC boundaries', () => {
  const metrics = calculateUsageMetrics({ workspaceAllowanceHours: 750, consumedHours: 0 });
  const periodStart = new Date(metrics.period.start);
  const nextReset = new Date(metrics.period.nextReset);

  assert.equal(periodStart.getUTCDate(), 1);
  assert.equal(periodStart.getUTCHours(), 0);
  assert.equal(nextReset.getUTCDate(), 1);
  assert.equal(nextReset.getUTCHours(), 0);
  assert.ok(nextReset.getTime() > periodStart.getTime());
});

test('Render API Fallback: Gracefully handles missing API key without throwing or exposing secrets', async () => {
  const prevKey = process.env.RENDER_API_KEY;
  delete process.env.RENDER_API_KEY;

  const mockDoc = { cachedRenderServices: [] };
  const res = await fetchRenderServicesIfConfigured(mockDoc);

  assert.equal(res.hasApiKey, false);
  assert.equal(res.isLiveApi, false);
  assert.ok(res.error.includes('RENDER_API_KEY'));

  // Restore env
  if (prevKey) process.env.RENDER_API_KEY = prevKey;
});
