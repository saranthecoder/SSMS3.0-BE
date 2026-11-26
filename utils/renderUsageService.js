const RenderHostingUsage = require('../models/RenderHostingUsage');

/**
 * Calculates calendar period, reset dates, consumption metrics, and warning levels
 * strictly separating workspace-level pooled free allowance from individual services.
 */
function calculateUsageMetrics(usageDoc, options = {}) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed

  // Usage period: start of calendar month to end of calendar month (UTC)
  const periodStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const nextReset = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const totalDaysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const currentDayOfMonth = now.getUTCDate();
  const daysRemainingInMonth = Math.max(0, totalDaysInMonth - currentDayOfMonth);
  const msRemaining = Math.max(0, nextReset.getTime() - now.getTime());
  const hoursRemainingInPeriod = Math.floor(msRemaining / (1000 * 60 * 60));

  // Workspace Free Instance Hours
  const allowance = typeof usageDoc.workspaceAllowanceHours === 'number' ? usageDoc.workspaceAllowanceHours : 750;
  const activeServers = Array.isArray(options.activeRenderServers) ? options.activeRenderServers : null;
  const activeServicesCount = typeof options.activeRenderServicesCount === 'number'
    ? Math.max(0, options.activeRenderServicesCount)
    : (activeServers ? activeServers.length : 0);

  const rawLastUpdate = usageDoc.lastManualUpdate ? new Date(usageDoc.lastManualUpdate) : null;
  const hasCurrentMonthManualSync = Boolean(
    usageDoc.dataSource === 'manual_entry' &&
    rawLastUpdate &&
    !isNaN(rawLastUpdate.getTime()) &&
    rawLastUpdate.getTime() >= periodStart.getTime()
  );

  let consumed = typeof usageDoc.consumedHours === 'number' ? usageDoc.consumedHours : 0;
  let isEstimatedFromCluster = false;

  if (activeServers && activeServers.length > 0) {
    if (hasCurrentMonthManualSync) {
      // Live accrual since the admin's billing sync in this calendar month
      const hoursSinceSync = Math.max(0, (now.getTime() - rawLastUpdate.getTime()) / (1000 * 60 * 60));
      consumed = Number((consumed + (activeServicesCount * hoursSinceSync)).toFixed(1));
    } else {
      // Auto-calculate real cluster instance-hours accrued this UTC month from active servers
      let clusterHours = 0;
      for (const srv of activeServers) {
        const srvStartMs = srv.createdAt
          ? Math.max(periodStart.getTime(), new Date(srv.createdAt).getTime())
          : periodStart.getTime();
        const trackedHours = Math.max(0, (now.getTime() - srvStartMs) / (1000 * 60 * 60));
        const uptimeHours = typeof srv.uptimeSeconds === 'number' && srv.uptimeSeconds > 0
          ? Math.min(trackedHours || (srv.uptimeSeconds / 3600), srv.uptimeSeconds / 3600)
          : 0;
        clusterHours += Math.max(trackedHours, uptimeHours);
      }
      consumed = Number(clusterHours.toFixed(1));
      isEstimatedFromCluster = true;
    }
  }

  const remainingHours = Number(Math.max(0, allowance - consumed).toFixed(1));
  const usagePercent = allowance > 0 ? Number(((consumed / allowance) * 100).toFixed(1)) : 0;

  // Burn rate and projection
  const daysElapsed = Math.max(1, currentDayOfMonth);
  const hourlyBurnRate = Number((consumed / (daysElapsed * 24)).toFixed(2));
  const projectedTotalHours = Math.round(consumed + (hourlyBurnRate * 24 * daysRemainingInMonth));

  // Bandwidth metrics
  const bwLimit = typeof usageDoc.bandwidthLimitGB === 'number' ? usageDoc.bandwidthLimitGB : 100;
  const bwConsumed = typeof usageDoc.bandwidthConsumedGB === 'number' ? usageDoc.bandwidthConsumedGB : 0;
  const bwRemaining = Math.max(0, bwLimit - bwConsumed);
  const bwPercent = bwLimit > 0 ? Number(((bwConsumed / bwLimit) * 100).toFixed(1)) : 0;

  // Build pipeline metrics
  const buildLimit = typeof usageDoc.buildMinutesLimit === 'number' ? usageDoc.buildMinutesLimit : 500;
  const buildConsumed = typeof usageDoc.buildMinutesConsumed === 'number' ? usageDoc.buildMinutesConsumed : 0;
  const buildRemaining = Math.max(0, buildLimit - buildConsumed);
  const buildPercent = buildLimit > 0 ? Number(((buildConsumed / buildLimit) * 100).toFixed(1)) : 0;

  // Warning thresholds evaluation (70%, 85%, 95%)
  const thresholds = (usageDoc.warningThresholds && usageDoc.warningThresholds.length > 0)
    ? usageDoc.warningThresholds.slice().sort((a, b) => a - b)
    : [70, 85, 95];

  const warningReports = thresholds.map(t => {
    const triggerHours = Math.round((allowance * t) / 100);
    const isTriggered = usagePercent >= t;
    const hoursRemainingAtThreshold = Math.max(0, triggerHours - consumed);
    return {
      percent: t,
      triggerHours,
      isTriggered,
      hoursRemainingAtThreshold,
      status: isTriggered ? 'TRIGGERED' : 'OK'
    };
  });

  // Overall status level
  let alertLevel = 'normal';
  let alertStatusText = 'Normal — Within free monthly tier';
  if (usagePercent >= 95) {
    alertLevel = 'critical';
    alertStatusText = 'Critical — Free instance hours almost depleted (≥95%)';
  } else if (usagePercent >= 85) {
    alertLevel = 'high';
    alertStatusText = 'High Alert — Approaching monthly limit (≥85%)';
  } else if (usagePercent >= 70) {
    alertLevel = 'warning';
    alertStatusText = 'Warning — Exceeded 70% of free instance hours';
  }

  // Check staleness only for explicit manual entries older than 48h (live cluster estimates are always fresh)
  const lastUpdate = usageDoc.lastManualUpdate || usageDoc.updatedAt;
  const isStale = isEstimatedFromCluster
    ? false
    : (lastUpdate ? (now.getTime() - new Date(lastUpdate).getTime() > 48 * 60 * 60 * 1000) : false);

  // Live cluster burn rate & server capacity guidance (750h/mo shared across concurrent active Render free services)
  const estimatedDailyBurnHours = activeServicesCount * 24;
  const estimatedDaysRemainingAtCurrentRate = estimatedDailyBurnHours > 0
    ? Number((remainingHours / estimatedDailyBurnHours).toFixed(1))
    : null;
  const additionalServerHoursNeeded = daysRemainingInMonth * 24;
  const canAddNewServerInSameWorkspace = remainingHours > additionalServerHoursNeeded && alertLevel !== 'critical' && alertLevel !== 'high';

  let capacityRecommendation = 'Workspace pool has headroom to add another free server if needed.';
  if (activeServicesCount > 0 && estimatedDaysRemainingAtCurrentRate !== null && estimatedDaysRemainingAtCurrentRate < daysRemainingInMonth) {
    capacityRecommendation = `At ${activeServicesCount} active Render service${activeServicesCount > 1 ? 's' : ''} (${estimatedDailyBurnHours}h/day), remaining ${remainingHours}h will run out in ~${estimatedDaysRemainingAtCurrentRate} days (before cycle reset). Add new servers in a separate Render workspace/account or upgrade.`;
  } else if (alertLevel === 'critical' || alertLevel === 'high') {
    capacityRecommendation = `Pool usage is ${usagePercent}% (${remainingHours}h left). Avoid adding more free services to this Render workspace; use a new workspace/account if scaling out.`;
  } else if (activeServicesCount > 0) {
    capacityRecommendation = `${activeServicesCount} active Render service${activeServicesCount > 1 ? 's' : ''} (~${estimatedDailyBurnHours}h/day). ${remainingHours}h remaining covers the rest of this cycle.`;
  }

  return {
    allowanceHours: allowance,
    consumedHours: consumed,
    remainingHours,
    usagePercent,
    hourlyBurnRate,
    projectedTotalHours,
    isOverProjected: projectedTotalHours > allowance,
    bandwidth: {
      limitGB: bwLimit,
      consumedGB: bwConsumed,
      remainingGB: bwRemaining,
      percent: bwPercent
    },
    buildMinutes: {
      limitMin: buildLimit,
      consumedMin: buildConsumed,
      remainingMin: buildRemaining,
      percent: buildPercent
    },
    period: {
      start: periodStart.toISOString(),
      nextReset: nextReset.toISOString(),
      daysRemaining: daysRemainingInMonth,
      hoursRemaining: hoursRemainingInPeriod,
      totalDaysInMonth,
      currentDayOfMonth
    },
    warnings: {
      alertLevel,
      alertStatusText,
      reports: warningReports
    },
    audit: {
      lastManualUpdate: usageDoc.lastManualUpdate,
      lastUpdatedByName: isEstimatedFromCluster ? 'Live Cluster Tracker' : (usageDoc.lastUpdatedByName || 'Live Cluster Tracker'),
      dataSource: isEstimatedFromCluster ? 'cluster_live' : (usageDoc.dataSource || 'manual_entry'),
      isEstimatedFromCluster,
      hasCurrentMonthManualSync,
      isStale
    },
    clusterCapacity: {
      activeServicesCount,
      estimatedDailyBurnHours,
      estimatedDaysRemainingAtCurrentRate,
      canAddNewServerInSameWorkspace,
      capacityRecommendation
    }
  };
}

/**
 * Queries Render REST API for registered services in workspace if RENDER_API_KEY is configured.
 * Strictly operates server-side, never exposes token, and applies bounded timeout and caching.
 */
async function fetchRenderServicesIfConfigured(usageDoc, forceRefresh = false) {
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) {
    return {
      hasApiKey: false,
      isLiveApi: false,
      services: usageDoc.cachedRenderServices || [],
      error: 'RENDER_API_KEY environment variable not configured. Free instance hours and usage are tracked via manual input from the Render Billing Dashboard.'
    };
  }

  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minute server-side cache
  const now = Date.now();
  if (!forceRefresh && usageDoc.lastRenderApiFetch && (now - new Date(usageDoc.lastRenderApiFetch).getTime() < CACHE_TTL_MS)) {
    return {
      hasApiKey: true,
      isLiveApi: true,
      fromCache: true,
      services: usageDoc.cachedRenderServices || [],
      error: null
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout

    const res = await fetch('https://api.render.com/v1/services?limit=50', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const errMsg = `Render API responded with HTTP ${res.status}: ${errText.slice(0, 150)}`;
      usageDoc.renderApiError = errMsg;
      await usageDoc.save();
      return {
        hasApiKey: true,
        isLiveApi: false,
        services: usageDoc.cachedRenderServices || [],
        error: errMsg
      };
    }

    const rawList = await res.json();
    const parsedServices = Array.isArray(rawList) ? rawList.map(item => {
      const s = item.service || item;
      return {
        id: s.id || '',
        name: s.name || 'Unnamed Service',
        type: s.type || 'web_service',
        repo: s.repo || '',
        plan: s.serviceDetails?.plan || s.plan || 'free',
        status: s.suspended === 'suspended' ? 'suspended' : 'active',
        updatedAt: s.updatedAt || new Date().toISOString()
      };
    }) : [];

    usageDoc.cachedRenderServices = parsedServices;
    usageDoc.lastRenderApiFetch = new Date();
    usageDoc.renderApiError = null;
    usageDoc.dataSource = 'hybrid';
    await usageDoc.save();

    return {
      hasApiKey: true,
      isLiveApi: true,
      fromCache: false,
      services: parsedServices,
      error: null
    };
  } catch (err) {
    const errMsg = err.name === 'AbortError' ? 'Render API request timed out (6s)' : err.message;
    usageDoc.renderApiError = errMsg;
    await usageDoc.save();
    return {
      hasApiKey: true,
      isLiveApi: false,
      services: usageDoc.cachedRenderServices || [],
      error: errMsg
    };
  }
}

/**
 * Returns existing RenderHostingUsage document or creates clean zero-baseline doc,
 * automatically rolling over expired prior-month manual figures on the 1st of the UTC month.
 */
async function getOrInitUsageDoc() {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

  let doc = await RenderHostingUsage.findOne();
  if (!doc) {
    doc = await RenderHostingUsage.create({
      workspaceAllowanceHours: 750,
      consumedHours: 0,
      bandwidthLimitGB: 100,
      bandwidthConsumedGB: 0,
      buildMinutesLimit: 500,
      buildMinutesConsumed: 0,
      warningThresholds: [70, 85, 95],
      lastManualUpdate: null,
      lastUpdatedByName: 'Live Cluster Tracker',
      dataSource: 'manual_entry'
    });
  } else if (doc.lastManualUpdate && new Date(doc.lastManualUpdate).getTime() < periodStart.getTime()) {
    // Auto-reset expired figures from a previous billing month so stale numbers never bleed forward
    doc.consumedHours = 0;
    doc.bandwidthConsumedGB = 0;
    doc.buildMinutesConsumed = 0;
    doc.lastManualUpdate = null;
    doc.lastUpdatedByName = 'Monthly Auto-Reset';
    await doc.save();
  }
  return doc;
}

/**
 * Computes individual Render free-tier usage (750h/mo default) for a single registered server.
 * Automatically resets at 1st of each UTC month and accrues live hours while active/online.
 */
function calculateServerFreeUsage(server, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const periodStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const nextReset = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const daysRemainingInMonth = Math.max(0, new Date(Date.UTC(year, month + 1, 0)).getUTCDate() - now.getUTCDate());

  const limitHours = typeof server?.renderMonthlyLimitHours === 'number' && server.renderMonthlyLimitHours > 0
    ? server.renderMonthlyLimitHours
    : 750;

  const isSameMonthSync = Boolean(
    server?.renderUsageMonth === monthKey &&
    server?.renderUsageSyncedAt &&
    !isNaN(new Date(server.renderUsageSyncedAt).getTime())
  );

  let consumedHours = 0;
  let isManualSync = false;
  if (isSameMonthSync) {
    isManualSync = true;
    const baseConsumed = Number(server.renderConsumedHours || 0);
    const syncedAtMs = new Date(server.renderUsageSyncedAt).getTime();
    const isRunning = server.isActive !== false && server.status !== 'offline';
    const extraHours = isRunning ? Math.max(0, (now.getTime() - syncedAtMs) / (1000 * 60 * 60)) : 0;
    consumedHours = Number((baseConsumed + extraHours).toFixed(1));
  } else {
    const startMs = server?.createdAt
      ? Math.max(periodStart.getTime(), new Date(server.createdAt).getTime())
      : periodStart.getTime();
    const trackedHours = Math.max(0, (now.getTime() - startMs) / (1000 * 60 * 60));
    const uptimeHours = typeof server?.uptimeSeconds === 'number' && server.uptimeSeconds > 0
      ? Math.min(trackedHours || (server.uptimeSeconds / 3600), server.uptimeSeconds / 3600)
      : 0;
    consumedHours = Number(Math.max(trackedHours, uptimeHours).toFixed(1));
  }

  const remainingHours = Number(Math.max(0, limitHours - consumedHours).toFixed(1));
  const percent = limitHours > 0 ? Number(((consumedHours / limitHours) * 100).toFixed(1)) : 0;
  const daysLeftAt24h = Number((remainingHours / 24).toFixed(1));
  const alertLevel = percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : 'normal';

  return {
    limitHours,
    consumedHours,
    remainingHours,
    percent,
    daysLeftAt24h,
    alertLevel,
    monthKey,
    nextReset: nextReset.toISOString(),
    daysRemainingInMonth,
    isManualSync,
    lastSyncedAt: isSameMonthSync ? server.renderUsageSyncedAt : null
  };
}

module.exports = {
  calculateUsageMetrics,
  calculateServerFreeUsage,
  fetchRenderServicesIfConfigured,
  getOrInitUsageDoc
};
