const os = require('os');

/**
 * Bounded In-Memory Operational Metrics & Request Telemetry Service
 *
 * Truthful, bounded, zero-external-dependency metrics collector.
 * Avoids constant database writes by keeping high-frequency counters in memory.
 */

// Bounded sliding window for requests in the last 60 seconds
const MAX_SLIDING_WINDOW_ENTRIES = 5000;
const MAX_RECENT_LATENCIES = 100;

class MetricsService {
  constructor() {
    this.bootTime = Date.now();
    this.totalRequests = 0;
    this.appRequests = 0;
    this.probeRequests = 0;

    // Sliding timestamps: array of { timestamp: number, isProbe: boolean }
    this.slidingWindow = [];

    // Bounded array of recent processing latencies (in milliseconds)
    this.recentLatencies = [];

    // CPU sampling state
    this.numCpus = os.cpus().length || 1;
    this.lastCpuSampleTime = process.hrtime.bigint();
    this.lastCpuUsage = process.cpuUsage();
    this.currentCpuPercent = 0;

    // Sample CPU every 2 seconds
    this.cpuInterval = setInterval(() => {
      this._sampleCpu();
    }, 2000);

    // Prevent interval from blocking Node exit in tests
    if (this.cpuInterval.unref) {
      this.cpuInterval.unref();
    }
  }

  /**
   * Determine if a route path is an internal probe/health check or a student/app API call
   */
  isProbePath(path) {
    if (!path || typeof path !== 'string') return false;
    const clean = path.split('?')[0]; // Strip query string
    return (
      clean === '/health' ||
      clean === '/health/live' ||
      clean === '/health/ready' ||
      clean.startsWith('/api/health') ||
      clean === '/api/traffic/ping' ||
      clean === '/api/traffic/servers' ||
      clean === '/api/traffic/config' ||
      clean === '/api/traffic/public-config' ||
      clean === '/'
    );
  }

  /**
   * Samples CPU usage using process.cpuUsage() delta
   */
  _sampleCpu() {
    try {
      const currentHrTime = process.hrtime.bigint();
      const currentUsage = process.cpuUsage();

      const timeDiffUs = Number(currentHrTime - this.lastCpuSampleTime) / 1000; // microseconds
      if (timeDiffUs <= 0) return;

      const userDiffUs = currentUsage.user - this.lastCpuUsage.user;
      const sysDiffUs = currentUsage.system - this.lastCpuUsage.system;
      const totalCpuUs = userDiffUs + sysDiffUs;

      // CPU percent normalized across cores
      const cpuPercent = Math.min(100, Math.max(0, Math.round((totalCpuUs / (timeDiffUs * this.numCpus)) * 100)));
      this.currentCpuPercent = cpuPercent;

      this.lastCpuSampleTime = currentHrTime;
      this.lastCpuUsage = currentUsage;
    } catch {
      // Keep previous sample on error
    }
  }

  /**
   * Record an incoming request once completed
   */
  recordRequest({ path, durationMs, statusCode }) {
    const now = Date.now();
    const isProbe = this.isProbePath(path);

    this.totalRequests += 1;
    if (isProbe) {
      this.probeRequests += 1;
    } else {
      this.appRequests += 1;
    }

    // Add to sliding window
    if (this.slidingWindow.length < MAX_SLIDING_WINDOW_ENTRIES) {
      this.slidingWindow.push({ timestamp: now, isProbe });
    }

    // Record latency for application requests (and probes if duration provided)
    if (typeof durationMs === 'number' && !isNaN(durationMs) && durationMs >= 0) {
      this.recentLatencies.push(Math.round(durationMs * 10) / 10);
      if (this.recentLatencies.length > MAX_RECENT_LATENCIES) {
        this.recentLatencies.shift();
      }
    }

    this._purgeStaleWindow(now);
  }

  /**
   * Purges sliding window entries older than 60 seconds
   */
  _purgeStaleWindow(now = Date.now()) {
    const cutoff = now - 60000;
    // Window is chronologically sorted, find first valid index
    let validIndex = 0;
    while (validIndex < this.slidingWindow.length && this.slidingWindow[validIndex].timestamp < cutoff) {
      validIndex++;
    }
    if (validIndex > 0) {
      this.slidingWindow.splice(0, validIndex);
    }
  }

  /**
   * Returns current operational metrics snapshot
   */
  getSnapshot() {
    const now = Date.now();
    this._purgeStaleWindow(now);

    // Count real request frequency in the last 60 seconds
    let appRequestsInLastMinute = 0;
    let probeRequestsInLastMinute = 0;

    for (let i = 0; i < this.slidingWindow.length; i++) {
      if (this.slidingWindow[i].isProbe) {
        probeRequestsInLastMinute++;
      } else {
        appRequestsInLastMinute++;
      }
    }

    const totalRequestsInLastMinute = appRequestsInLastMinute + probeRequestsInLastMinute;

    // Calculate latency metrics
    let avgLatencyMs = 0;
    let p95LatencyMs = 0;
    if (this.recentLatencies.length > 0) {
      const sum = this.recentLatencies.reduce((acc, val) => acc + val, 0);
      avgLatencyMs = Math.round((sum / this.recentLatencies.length) * 10) / 10;

      const sorted = [...this.recentLatencies].sort((a, b) => a - b);
      const p95Idx = Math.floor(sorted.length * 0.95);
      p95LatencyMs = sorted[p95Idx] || sorted[sorted.length - 1];
    }

    // Memory metrics
    const memUsage = process.memoryUsage();
    const totalSysMem = os.totalmem();
    const freeSysMem = os.freemem();
    const sysMemPercent = totalSysMem > 0 ? Math.round(((totalSysMem - freeSysMem) / totalSysMem) * 100) : 0;
    const processRssMb = Math.round(memUsage.rss / (1024 * 1024));
    const heapUsedMb = Math.round(memUsage.heapUsed / (1024 * 1024));
    const heapTotalMb = Math.round(memUsage.heapTotal / (1024 * 1024));

    return {
      serverUptimeSeconds: Math.floor((now - this.bootTime) / 1000),
      timestamp: now,
      // Request counts (lifetime of current process)
      totalRequests: this.totalRequests,
      appRequests: this.appRequests,
      probeRequests: this.probeRequests,
      // Frequency (real timestamps from the past 60 seconds)
      rpm: totalRequestsInLastMinute,
      appRpm: appRequestsInLastMinute,
      probeRpm: probeRequestsInLastMinute,
      // Internal processing latency
      avgProcessingLatencyMs: avgLatencyMs,
      p95ProcessingLatencyMs: p95LatencyMs,
      recentLatencySamples: this.recentLatencies.length,
      // Host / Process utilization
      cpuPercent: this.currentCpuPercent,
      memoryPercent: sysMemPercent,
      processRssMb,
      heapUsedMb,
      heapTotalMb
    };
  }

  /**
   * Reset counters (useful for unit testing)
   */
  reset() {
    this.bootTime = Date.now();
    this.totalRequests = 0;
    this.appRequests = 0;
    this.probeRequests = 0;
    this.slidingWindow = [];
    this.recentLatencies = [];
    this.currentCpuPercent = 0;
  }
}

// Export singleton instance
const metricsService = new MetricsService();
module.exports = metricsService;
