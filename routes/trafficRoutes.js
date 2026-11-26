const express = require('express');
const router = express.Router();
const os = require('os');
const { protect, admin } = require('../middleware/authMiddleware');
const BackendServer = require('../models/BackendServer');
const TrafficConfig = require('../models/TrafficConfig');

const metricsService = require('../utils/metricsService');
const RenderHostingUsage = require('../models/RenderHostingUsage');
const {
  calculateUsageMetrics,
  calculateServerFreeUsage,
  fetchRenderServicesIfConfigured,
  getOrInitUsageDoc
} = require('../utils/renderUsageService');

// @route   GET /api/traffic/public-config
// @desc    Get active servers and routing policy (Public endpoint for client Axios)
// @access  Public
router.get('/public-config', async (req, res) => {
  try {
    const servers = await BackendServer.find({ isActive: true });
    
    // Auto-heal/correct primary server URL if it points to localhost but is requested via a public domain name
    const primaryServer = servers.find(s => s.isPrimary);
    if (primaryServer && primaryServer.url.includes('localhost')) {
      const requestHost = req.get('host');
      if (requestHost && !requestHost.includes('localhost') && !requestHost.includes('127.0.0.1')) {
        const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        const currentUrl = `${isSecure ? 'https' : 'http'}://${requestHost}`;
        
        // Save correction to database
        await BackendServer.updateOne({ _id: primaryServer._id }, { $set: { url: currentUrl } });
        primaryServer.url = currentUrl;
        console.log(`Auto-corrected primary server URL from localhost to: ${currentUrl}`);
      }
    }

    const config = await TrafficConfig.findOne();
    const liveMetrics = metricsService.getSnapshot();
    const STALE_HEALTH_MS = 15 * 60 * 1000; // 15 minutes
    const now = Date.now();

    const reqHost = (req.get('host') || '').toLowerCase();

    res.json({
      apiVersion: BACKEND_API_VERSION,
      policy: config ? config.policy : 'round-robin',
      cpuThreshold: config ? config.cpuThreshold : 80,
      manualSelectedServerId: config ? config.manualSelectedServerId : null,
      servers: servers.map(s => {
        const isStale = s.lastHealthCheck ? (now - new Date(s.lastHealthCheck).getTime() > STALE_HEALTH_MS) : true;
        const effectiveStatus = isStale ? 'unknown' : s.status;
        const isOnline = effectiveStatus === 'online';
        const isCurrentInstance = s.url.includes('localhost') || (reqHost && s.url.toLowerCase().includes(reqHost));
        
        const rpm = isOnline && isCurrentInstance ? liveMetrics.appRpm : (s.reqPerMin || 0);
        const appReqs = isOnline && isCurrentInstance ? liveMetrics.appRequests : (s.requestCount || 0);
        const cpu = isOnline && isCurrentInstance ? liveMetrics.cpuPercent : (s.cpuUsage != null ? s.cpuUsage : null);
        const mem = isOnline && isCurrentInstance ? liveMetrics.memoryPercent : (s.memoryUsage != null ? s.memoryUsage : null);
        const processingLatency = isOnline && isCurrentInstance ? liveMetrics.avgProcessingLatencyMs : (s.avgProcessingLatencyMs || 0);

        return {
          id: s._id,
          _id: s._id,
          name: s.name,
          url: s.url,
          isPrimary: s.isPrimary,
          status: effectiveStatus,
          isStale,
          lastHealthCheck: s.lastHealthCheck,
          responseTime: s.responseTime || 0,           // Backend probe round-trip latency (ms)
          avgProcessingLatencyMs: processingLatency,   // Internal server execution latency (ms)
          cpuUsage: cpu,
          memoryUsage: mem,
          requestCount: appReqs,                       // Actual student/app requests
          reqPerMin: rpm,                              // Real 1-minute frequency
          activeConnections: rpm
        };
      })
    });
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving public traffic config', error: error.message });
  }
});

// @route   GET /api/traffic/servers
// @desc    Get all servers with operational metrics
// @access  Private/Admin
router.get('/servers', protect, admin, async (req, res) => {
  try {
    const servers = await BackendServer.find().sort({ isPrimary: -1, createdAt: 1 });
    const liveMetrics = metricsService.getSnapshot();
    const STALE_HEALTH_MS = 15 * 60 * 1000;
    const now = Date.now();
    const reqHost = (req.get('host') || '').toLowerCase();

    const mappedServers = servers.map(s => {
      const isStale = s.lastHealthCheck ? (now - new Date(s.lastHealthCheck).getTime() > STALE_HEALTH_MS) : true;
      const isOnline = s.isActive && s.status === 'online' && !isStale;
      const isCurrentInstance = s.url.includes('localhost') || (reqHost && s.url.toLowerCase().includes(reqHost));
      
      const appRpm = isOnline && isCurrentInstance ? liveMetrics.appRpm : (s.reqPerMin || 0);
      const appReqs = isOnline && isCurrentInstance ? liveMetrics.appRequests : (s.requestCount || 0);
      const totalReqs = isOnline && isCurrentInstance ? liveMetrics.totalRequests : (s.totalRequests || appReqs);
      const cpu = isOnline && isCurrentInstance ? liveMetrics.cpuPercent : (s.cpuUsage != null ? s.cpuUsage : null);
      const mem = isOnline && isCurrentInstance ? liveMetrics.memoryPercent : (s.memoryUsage != null ? s.memoryUsage : null);
      const processingLatency = isOnline && isCurrentInstance ? liveMetrics.avgProcessingLatencyMs : (s.avgProcessingLatencyMs || 0);
      const uptimeSec = isOnline && isCurrentInstance ? Math.floor(process.uptime()) : (s.uptimeSeconds || 0);

      const serverObj = {
        ...s.toObject(),
        status: s.isActive ? (isStale ? 'unknown' : s.status) : 'offline',
        isStale,
        responseTime: s.responseTime || 0,           // Backend probe latency
        avgProcessingLatencyMs: processingLatency,   // Server internal latency
        cpuUsage: cpu,
        memoryUsage: mem,
        uptimeSeconds: uptimeSec,
        requestCount: appReqs,                       // Actual application/student requests
        reqPerMin: appRpm,                           // Real student request frequency
        totalRequests: totalReqs,                    // Total including probes
        probeCount: isOnline && isCurrentInstance ? liveMetrics.probeRequests : 0
      };
      serverObj.renderUsage = calculateServerFreeUsage(serverObj, new Date(now));
      return serverObj;
    });

    res.json(mappedServers);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching servers', error: error.message });
  }
});

// @route   GET /api/traffic/metrics
// @desc    Get comprehensive operational metrics for current host
// @access  Private/Admin
router.get('/metrics', protect, admin, (req, res) => {
  try {
    res.json(metricsService.getSnapshot());
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving metrics', error: error.message });
  }
});

// @route   POST /api/traffic/servers
// @desc    Add a new server
// @access  Private/Admin
router.post('/servers', protect, admin, async (req, res) => {
  try {
    const { name, url, isActive } = req.body;
    
    // Normalize URL (strip trailing slash if exists)
    let formattedUrl = url.trim();
    if (formattedUrl.endsWith('/')) {
      formattedUrl = formattedUrl.slice(0, -1);
    }

    const serverExists = await BackendServer.findOne({ url: formattedUrl });
    if (serverExists) {
      return res.status(400).json({ message: 'Server with this URL already exists' });
    }

    const server = await BackendServer.create({
      name: name.trim(),
      url: formattedUrl,
      isActive: isActive !== undefined ? isActive : true,
      status: 'unknown',
      responseTime: 0,
      cpuUsage: null,
      memoryUsage: null,
      isPrimary: false
    });

    res.status(201).json(server);
  } catch (error) {
    res.status(500).json({ message: 'Error creating server', error: error.message });
  }
});

// @route   PUT /api/traffic/servers/:id
// @desc    Update server properties (or toggle isActive status)
// @access  Private/Admin
router.put('/servers/:id', protect, admin, async (req, res) => {
  try {
    const { name, url, isActive, status, responseTime, cpuUsage, memoryUsage } = req.body;
    const server = await BackendServer.findById(req.params.id);

    if (!server) {
      return res.status(404).json({ message: 'Server not found' });
    }

    if (name) server.name = name.trim();
    if (url) {
      let formattedUrl = url.trim();
      if (formattedUrl.endsWith('/')) {
        formattedUrl = formattedUrl.slice(0, -1);
      }
      server.url = formattedUrl;
    }
    if (isActive !== undefined) {
      if (server.isPrimary && !isActive) {
        return res.status(400).json({ message: 'Cannot deactivate the primary server' });
      }
      server.isActive = isActive;
    }
    if (status) server.status = status;
    if (responseTime !== undefined) server.responseTime = responseTime;
    if (cpuUsage !== undefined) server.cpuUsage = cpuUsage;
    if (memoryUsage !== undefined) server.memoryUsage = memoryUsage;

    const updatedServer = await server.save();
    res.json(updatedServer);
  } catch (error) {
    res.status(500).json({ message: 'Error updating server', error: error.message });
  }
});

// @route   PUT /api/traffic/servers/:id/render-usage
// @desc    Update an individual server's monthly free-tier Render usage baseline
// @access  Private/Admin
router.put('/servers/:id/render-usage', protect, admin, async (req, res) => {
  try {
    const server = await BackendServer.findById(req.params.id);
    if (!server) {
      return res.status(404).json({ message: 'Server not found' });
    }
    const { consumedHours, monthlyLimitHours } = req.body;
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    if (monthlyLimitHours !== undefined) {
      const limitVal = Number(monthlyLimitHours);
      if (isNaN(limitVal) || limitVal < 0) {
        return res.status(400).json({ message: 'Monthly limit hours must be a non-negative number.' });
      }
      server.renderMonthlyLimitHours = limitVal;
    }
    if (consumedHours !== undefined) {
      const consumedVal = Number(consumedHours);
      if (isNaN(consumedVal) || consumedVal < 0) {
        return res.status(400).json({ message: 'Consumed hours must be a non-negative number.' });
      }
      server.renderConsumedHours = consumedVal;
    }
    server.renderUsageMonth = monthKey;
    server.renderUsageSyncedAt = now;
    await server.save();

    const obj = server.toObject();
    obj.renderUsage = calculateServerFreeUsage(obj, now);
    res.json(obj);
  } catch (error) {
    res.status(500).json({ message: 'Error updating server usage', error: error.message });
  }
});

// @route   PUT /api/traffic/servers/:id/set-primary
// @desc    Set a backend server node as primary
// @access  Private/Admin
router.put('/servers/:id/set-primary', protect, admin, async (req, res) => {
  try {
    const targetServer = await BackendServer.findById(req.params.id);
    if (!targetServer) {
      return res.status(404).json({ message: 'Server not found' });
    }

    // Unset primary from all servers
    await BackendServer.updateMany({}, { $set: { isPrimary: false } });

    // Set target server as primary & active
    targetServer.isPrimary = true;
    targetServer.isActive = true;
    await targetServer.save();

    const allServers = await BackendServer.find().sort({ isPrimary: -1, createdAt: 1 });
    res.json(allServers);
  } catch (error) {
    res.status(500).json({ message: 'Error setting primary server', error: error.message });
  }
});

// @route   DELETE /api/traffic/servers/:id
// @desc    Delete a server
// @access  Private/Admin
router.delete('/servers/:id', protect, admin, async (req, res) => {
  try {
    const server = await BackendServer.findById(req.params.id);
    if (!server) {
      return res.status(404).json({ message: 'Server not found' });
    }

    if (server.isPrimary) {
      return res.status(400).json({ message: 'Cannot delete the primary backend server' });
    }

    await BackendServer.deleteOne({ _id: req.params.id });
    res.json({ message: 'Server deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting server', error: error.message });
  }
});

// @route   GET /api/traffic/config
// @desc    Get traffic routing config
// @access  Private/Admin
router.get('/config', protect, admin, async (req, res) => {
  try {
    let config = await TrafficConfig.findOne();
    if (!config) {
      config = await TrafficConfig.create({
        policy: 'round-robin',
        cpuThreshold: 80,
        manualSelectedServerId: null,
        pingIntervalMinutes: 5,
        pingIntervalSeconds: 300,
        requestsPerPing: 1
      });
    }
    res.json(config);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching traffic config', error: error.message });
  }
});

// @route   POST /api/traffic/config
// @desc    Update traffic routing config (policy/cpuThreshold/manual server selection/ping interval/requests count)
// @access  Private/Admin
router.post('/config', protect, admin, async (req, res) => {
  try {
    const { policy, cpuThreshold, manualSelectedServerId, pingIntervalMinutes, pingIntervalSeconds, requestsPerPing } = req.body;
    let config = await TrafficConfig.findOne();
    if (!config) {
      config = new TrafficConfig();
    }

    if (policy) config.policy = policy;
    if (cpuThreshold !== undefined) config.cpuThreshold = Number(cpuThreshold);
    if (manualSelectedServerId !== undefined) {
      config.manualSelectedServerId = manualSelectedServerId;
    }
    if (pingIntervalSeconds !== undefined) {
      config.pingIntervalSeconds = Math.max(5, Number(pingIntervalSeconds));
      config.pingIntervalMinutes = Math.round(config.pingIntervalSeconds / 60) || 1;
    } else if (pingIntervalMinutes !== undefined) {
      config.pingIntervalMinutes = Number(pingIntervalMinutes);
      config.pingIntervalSeconds = config.pingIntervalMinutes * 60;
    }
    if (requestsPerPing !== undefined) {
      config.requestsPerPing = Math.max(1, Math.min(20, Number(requestsPerPing)));
    }

    const updatedConfig = await config.save();
    res.json(updatedConfig);
  } catch (error) {
    res.status(500).json({ message: 'Error updating traffic config', error: error.message });
  }
});

const BACKEND_API_VERSION = '3.2.0';

/**
 * Probes all active registered backend servers using versioned health endpoints and updates DB telemetry.
 */
async function probeRegisteredServers(reqHost = '') {
  const servers = await BackendServer.find({ isActive: true });
  const config = await TrafficConfig.findOne();
  const requestsCount = config ? (config.requestsPerPing || 1) : 1;
  const pingResults = [];

  const localMetrics = metricsService.getSnapshot();
  const FAILURE_THRESHOLD = 2;
  const PROBE_TIMEOUT_MS = 5000;
  const normalizedHost = (reqHost || '').toLowerCase();

  for (const server of servers) {
    let totalLatency = 0;
    let successfulReqs = 0;
    let lastFailureReason = '';
    let latestHealthData = null;
    let incompatibleVersionReason = '';
    const cleanUrl = server.url.trim().endsWith('/') ? server.url.trim().slice(0, -1) : server.url.trim();
    const isCurrentInstance = server.url.includes('localhost') || (normalizedHost && server.url.toLowerCase().includes(normalizedHost));

    for (let i = 0; i < requestsCount; i++) {
      const startTime = Date.now();
      let probeSucceeded = false;
      let responseStatus = null;
      let candidateError = null;

      // Probe only versioned health endpoints so legacy or mismatched builds are flagged offline immediately
      const candidateEndpoints = [
        `${cleanUrl}/api/health/ready`,
        `${cleanUrl}/api/health`
      ];

      for (const endpoint of candidateEndpoints) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
          const response = await fetch(endpoint, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
          });
          clearTimeout(timeoutId);

          if (response && response.ok) {
            const data = await response.json().catch(() => null);
            const isHealthyStatus = data && (data.status === 'ok' || data.status === 'ready');
            if (isHealthyStatus) {
              // Enforce strict apiVersion match across remote nodes so rolling/legacy mismatches are quarantined immediately
              if (!isCurrentInstance && data.apiVersion !== BACKEND_API_VERSION) {
                incompatibleVersionReason = `Version mismatch (expected ${BACKEND_API_VERSION}, got ${data.apiVersion || 'legacy'}). Auto-quarantined until redeployed.`;
                break;
              }
              probeSucceeded = true;
              totalLatency += (Date.now() - startTime);
              successfulReqs++;
              latestHealthData = data;
              break;
            }
            responseStatus = 'Invalid health payload';
          } else if (response) {
            responseStatus = `HTTP ${response.status}`;
            if (response.status === 404 && endpoint.endsWith('/api/health')) {
              incompatibleVersionReason = `Outdated backend build (/api/health 404; expected ${BACKEND_API_VERSION}). Redeploy service from latest SSMS-BE.`;
            }
          }
        } catch (err) {
          candidateError = err.name === 'AbortError' ? `Probe timed out (${PROBE_TIMEOUT_MS / 1000}s)` : err.message;
        }
      }

      if (!probeSucceeded) {
        lastFailureReason = incompatibleVersionReason || responseStatus || candidateError || 'Unknown response';
      }
    }

    server.lastHealthCheck = new Date();

    if (successfulReqs > 0) {
      const avgResponseTime = Math.round(totalLatency / successfulReqs);
      server.consecutiveSuccesses = (server.consecutiveSuccesses || 0) + 1;
      server.consecutiveFailures = 0;
      server.failureReason = '';
      server.responseTime = avgResponseTime;

      if (isCurrentInstance) {
        server.cpuUsage = localMetrics.cpuPercent;
        server.memoryUsage = localMetrics.memoryPercent;
        server.avgProcessingLatencyMs = localMetrics.avgProcessingLatencyMs;
        server.uptimeSeconds = Math.floor(process.uptime());
        if (typeof localMetrics.appRequests === 'number') server.requestCount = localMetrics.appRequests;
        if (typeof localMetrics.appRpm === 'number') server.reqPerMin = localMetrics.appRpm;
      } else if (latestHealthData && typeof latestHealthData.cpuPercent === 'number') {
        server.cpuUsage = latestHealthData.cpuPercent;
        server.memoryUsage = typeof latestHealthData.memoryPercent === 'number' ? latestHealthData.memoryPercent : null;
        server.avgProcessingLatencyMs = typeof latestHealthData.avgProcessingLatencyMs === 'number' ? latestHealthData.avgProcessingLatencyMs : null;
        if (typeof latestHealthData.uptime === 'number') server.uptimeSeconds = Math.floor(latestHealthData.uptime);
        if (typeof latestHealthData.appRequests === 'number') server.requestCount = latestHealthData.appRequests;
        if (typeof latestHealthData.appRpm === 'number') server.reqPerMin = latestHealthData.appRpm;
      } else {
        server.cpuUsage = null;
        server.memoryUsage = null;
        server.avgProcessingLatencyMs = null;
      }

      server.status = 'online';
      await server.save();

      pingResults.push({
        id: server._id.toString(),
        _id: server._id.toString(),
        name: server.name,
        url: server.url,
        status: server.status,
        responseTime: avgResponseTime,
        avgProcessingLatencyMs: server.avgProcessingLatencyMs,
        consecutiveSuccesses: server.consecutiveSuccesses,
        consecutiveFailures: 0,
        lastHealthCheck: server.lastHealthCheck,
        cpuUsage: server.cpuUsage,
        memoryUsage: server.memoryUsage,
        requestsSent: requestsCount
      });
    } else {
      server.consecutiveFailures = (server.consecutiveFailures || 0) + 1;
      server.consecutiveSuccesses = 0;
      server.failureReason = lastFailureReason;
      server.cpuUsage = null;
      server.memoryUsage = null;
      server.avgProcessingLatencyMs = null;

      if (incompatibleVersionReason || server.consecutiveFailures >= FAILURE_THRESHOLD) {
        server.consecutiveFailures = Math.max(FAILURE_THRESHOLD, server.consecutiveFailures);
        server.status = 'offline';
        server.responseTime = 0;
      }

      await server.save();

      pingResults.push({
        id: server._id.toString(),
        _id: server._id.toString(),
        name: server.name,
        url: server.url,
        status: server.status,
        failureReason: lastFailureReason,
        responseTime: 0,
        avgProcessingLatencyMs: null,
        consecutiveFailures: server.consecutiveFailures,
        consecutiveSuccesses: 0,
        lastHealthCheck: server.lastHealthCheck,
        cpuUsage: null,
        memoryUsage: null,
        requestsSent: requestsCount
      });
    }
  }
  return pingResults;
}

// @route   POST /api/traffic/ping
// @desc    Triggers background ping test on all active servers from the backend perspective
// @access  Private/Admin
router.post('/ping', protect, admin, async (req, res) => {
  try {
    const pingResults = await probeRegisteredServers(req.get('host') || '');
    res.json(pingResults);
  } catch (error) {
    res.status(500).json({ message: 'Error performing ping checks', error: error.message });
  }
});

async function getActiveRenderClusterContext(serviceResult) {
  const activeNodes = await BackendServer.find({ isActive: true, status: { $ne: 'offline' } })
    .select('name url status uptimeSeconds reqPerMin requestCount createdAt')
    .lean();
  const renderNodes = activeNodes.filter(n => (n.url || '').toLowerCase().includes('onrender.com'));
  const targetNodes = renderNodes.length > 0 ? renderNodes : activeNodes;

  if (serviceResult && Array.isArray(serviceResult.services) && serviceResult.services.length > 0) {
    const apiActiveCount = serviceResult.services.filter(s => s.status !== 'suspended' && (s.plan || 'free').toLowerCase() === 'free').length;
    return {
      activeRenderServicesCount: Math.max(apiActiveCount, targetNodes.length),
      activeRenderServers: targetNodes
    };
  }
  return {
    activeRenderServicesCount: targetNodes.length,
    activeRenderServers: targetNodes
  };
}

// @route   GET /api/traffic/render-usage
// @desc    Get Render hosting usage metrics, remaining free hours, warnings, and services
// @access  Private/Admin
router.get('/render-usage', protect, admin, async (req, res) => {
  try {
    const doc = await getOrInitUsageDoc();
    const serviceResult = await fetchRenderServicesIfConfigured(doc, false);
    const clusterCtx = await getActiveRenderClusterContext(serviceResult);
    const metrics = calculateUsageMetrics(doc, clusterCtx);

    res.json({
      metrics,
      renderServices: serviceResult.services,
      hasApiKey: serviceResult.hasApiKey,
      isLiveApi: serviceResult.isLiveApi,
      apiError: serviceResult.error,
      billingDashboardUrl: 'https://dashboard.render.com/billing'
    });
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving hosting usage metrics', error: error.message });
  }
});

// @route   POST /api/traffic/render-usage
// @desc    Update observed usage and free limits manually from Render billing dashboard
// @access  Private/Admin
router.post('/render-usage', protect, admin, async (req, res) => {
  try {
    const {
      workspaceAllowanceHours,
      consumedHours,
      bandwidthLimitGB,
      bandwidthConsumedGB,
      buildMinutesLimit,
      buildMinutesConsumed,
      warningThresholds
    } = req.body;

    const doc = await getOrInitUsageDoc();

    if (workspaceAllowanceHours !== undefined) {
      const val = Number(workspaceAllowanceHours);
      if (isNaN(val) || val < 0) {
        return res.status(400).json({ message: 'Workspace allowance hours must be a non-negative number.' });
      }
      doc.workspaceAllowanceHours = val;
    }

    if (consumedHours !== undefined) {
      const val = Number(consumedHours);
      if (isNaN(val) || val < 0) {
        return res.status(400).json({ message: 'Consumed hours must be a non-negative number.' });
      }
      doc.consumedHours = val;
    }

    if (bandwidthLimitGB !== undefined) {
      const val = Number(bandwidthLimitGB);
      if (!isNaN(val) && val >= 0) doc.bandwidthLimitGB = val;
    }

    if (bandwidthConsumedGB !== undefined) {
      const val = Number(bandwidthConsumedGB);
      if (!isNaN(val) && val >= 0) doc.bandwidthConsumedGB = val;
    }

    if (buildMinutesLimit !== undefined) {
      const val = Number(buildMinutesLimit);
      if (!isNaN(val) && val >= 0) doc.buildMinutesLimit = val;
    }

    if (buildMinutesConsumed !== undefined) {
      const val = Number(buildMinutesConsumed);
      if (!isNaN(val) && val >= 0) doc.buildMinutesConsumed = val;
    }

    if (Array.isArray(warningThresholds) && warningThresholds.length > 0) {
      doc.warningThresholds = warningThresholds.map(Number).filter(n => !isNaN(n) && n > 0 && n <= 100);
    }

    doc.lastManualUpdate = new Date();
    doc.lastUpdatedBy = req.user._id;
    doc.lastUpdatedByName = req.user.name || 'Admin';
    doc.dataSource = 'manual_entry';

    await doc.save();

    const serviceResult = await fetchRenderServicesIfConfigured(doc, false);
    const clusterCtx = await getActiveRenderClusterContext(serviceResult);
    const metrics = calculateUsageMetrics(doc, clusterCtx);

    res.json({
      message: 'Render hosting usage and free limits updated successfully.',
      metrics,
      renderServices: serviceResult.services,
      hasApiKey: serviceResult.hasApiKey,
      isLiveApi: serviceResult.isLiveApi,
      apiError: serviceResult.error,
      billingDashboardUrl: 'https://dashboard.render.com/billing'
    });
  } catch (error) {
    res.status(500).json({ message: 'Error updating hosting usage metrics', error: error.message });
  }
});

// @route   POST /api/traffic/render-usage/refresh
// @desc    Force refresh Render services list and recalculate metrics
// @access  Private/Admin
router.post('/render-usage/refresh', protect, admin, async (req, res) => {
  try {
    const doc = await getOrInitUsageDoc();
    const serviceResult = await fetchRenderServicesIfConfigured(doc, true); // Force refresh
    const clusterCtx = await getActiveRenderClusterContext(serviceResult);
    const metrics = calculateUsageMetrics(doc, clusterCtx);

    res.json({
      metrics,
      renderServices: serviceResult.services,
      hasApiKey: serviceResult.hasApiKey,
      isLiveApi: serviceResult.isLiveApi,
      apiError: serviceResult.error,
      billingDashboardUrl: 'https://dashboard.render.com/billing'
    });
  } catch (error) {
    res.status(500).json({ message: 'Error refreshing hosting usage', error: error.message });
  }
});

router.BACKEND_API_VERSION = BACKEND_API_VERSION;
router.probeRegisteredServers = probeRegisteredServers;

module.exports = router;
