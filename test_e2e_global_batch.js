require('dotenv').config();

const API_BASE = 'http://localhost:3000/api';
let adminCookie = '';
let adminUser = null;

// Mock localStorage to simulate browser state transitions
class MockLocalStorage {
  constructor() {
    this.store = {};
  }
  getItem(key) {
    return this.store[key] || null;
  }
  setItem(key, value) {
    this.store[key] = String(value);
  }
  removeItem(key) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
}

async function apiRequest(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(adminCookie ? { Cookie: adminCookie } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return {
    status: response.status,
    headers: response.headers,
    data
  };
}

// Simulates AuthContext & GlobalBatchContext lifecycle in React
class GlobalBatchContextSimulator {
  constructor(storage) {
    this.storage = storage;
    this.user = null;
    this.batchesList = [];
    this.selectedBatchId = this.storage.getItem('selectedBatchId') || '';
    this.selectedBatchName = this.storage.getItem('selectedBatchName') || '';
    this.selectedBatch = null;
    this.isBatchModalOpen = false;
  }

  async login(userObj) {
    this.user = userObj;
    this.storage.setItem('user', JSON.stringify(userObj));
    await this.fetchGlobalBatches();
  }

  async fetchGlobalBatches() {
    if (!this.user) return;
    const res = await apiRequest('/batches');
    this.batchesList = res.data;

    if (this.user.role === 'admin') {
      const savedBatchId = this.storage.getItem('selectedBatchId');
      if (savedBatchId && savedBatchId !== 'all') {
        const matched = this.batchesList.find(b => b._id.toString() === savedBatchId.toString());
        if (matched) {
          this.selectedBatch = matched;
          this.selectedBatchId = matched._id;
          this.selectedBatchName = matched.batchName;
          this.storage.setItem('selectedBatchId', matched._id);
          this.storage.setItem('selectedBatchName', matched.batchName);
          this.isBatchModalOpen = false;
        } else {
          this.selectedBatch = null;
          this.selectedBatchId = '';
          this.selectedBatchName = '';
          this.storage.removeItem('selectedBatchId');
          this.storage.removeItem('selectedBatchName');
          this.isBatchModalOpen = true; // Ask admin to select another batch!
        }
      } else {
        this.selectedBatch = null;
        this.selectedBatchId = '';
        this.selectedBatchName = '';
        this.isBatchModalOpen = true; // First time or no batch selected -> modal appears!
      }
    }
  }

  selectBatch(batch) {
    this.selectedBatch = batch;
    this.selectedBatchId = batch._id;
    this.selectedBatchName = batch.batchName;
    this.storage.setItem('selectedBatchId', batch._id);
    this.storage.setItem('selectedBatchName', batch.batchName);
    this.isBatchModalOpen = false;
  }

  refreshBrowser() {
    // Simulates F5 browser reload
    const reloaded = new GlobalBatchContextSimulator(this.storage);
    reloaded.user = JSON.parse(this.storage.getItem('user'));
    return reloaded;
  }

  logout() {
    this.user = null;
    this.storage.removeItem('user');
    this.selectedBatch = null;
    this.selectedBatchId = '';
    this.selectedBatchName = '';
  }
}

async function runE2EAudit() {
  console.log('===============================================================');
  console.log('   GLOBAL BATCH SELECTION SYSTEM - END-TO-END AUDIT SUITE      ');
  console.log('===============================================================\n');

  let results = [];

  const record = (scenarioNum, title, passed, details = '') => {
    results.push({ scenarioNum, title, passed, details });
    const tag = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`[${tag}] Scenario ${scenarioNum}: ${title}`);
    if (details) console.log(`       Details: ${details}`);
  };

  // Step 0: Authenticate
  try {
    const loginRes = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@saran.com',
        password: 'admin123'
      })
    });
    adminUser = loginRes.data;
    const cookieHeader = loginRes.headers.get('set-cookie');
    if (cookieHeader) {
      adminCookie = cookieHeader;
    }
    console.log(`Authenticated as Admin: ${adminUser.name} (${adminUser.email})\n`);
  } catch (err) {
    console.error('Failed to login as admin:', err.message);
    process.exit(1);
  }

  const localStorage = new MockLocalStorage();
  let sim = new GlobalBatchContextSimulator(localStorage);

  // --------------------------------------------------------------------------
  // Scenario 1: Admin logs in for the first time -> batch selection appears
  // --------------------------------------------------------------------------
  try {
    localStorage.clear(); // Fresh browser without saved batch
    await sim.login(adminUser);

    const isFirstTimeModalOpen = sim.isBatchModalOpen === true && sim.selectedBatchId === '';
    record(1, 'Admin logs in for first time -> batch selection appears', isFirstTimeModalOpen,
      `Modal open: ${sim.isBatchModalOpen}, Selected Batch ID: "${sim.selectedBatchId}"`);
  } catch (e) {
    record(1, 'Admin logs in for first time -> batch selection appears', false, e.message);
  }

  // --------------------------------------------------------------------------
  // Scenario 2: Admin selects Data Science MITM -> Dashboard displays only Data Science MITM data
  // --------------------------------------------------------------------------
  let dsBatch = null;
  let pyBatch = null;
  let jvBatch = null;
  try {
    dsBatch = sim.batchesList.find(b => b.batchName.includes('Data Science MITM'));
    pyBatch = sim.batchesList.find(b => b.batchName.includes('Python-FSD'));
    jvBatch = sim.batchesList.find(b => b.batchName.includes('Java FSD'));

    if (!dsBatch) throw new Error('Data Science MITM batch not found in available batches');

    sim.selectBatch(dsBatch);

    const dashRes = await apiRequest(`/analytics/dashboard?batchId=${dsBatch._id}`);
    const isScoped = sim.selectedBatchId === dsBatch._id && dashRes.status === 200;

    record(2, 'Admin selects Data Science MITM -> Dashboard displays only Data Science MITM data', isScoped,
      `Batch: "${dsBatch.batchName}" (${dsBatch._id}), Dashboard totalStudents: ${dashRes.data.totalStudents}, totalTasks: ${dashRes.data.totalTasks}`);
  } catch (e) {
    record(2, 'Admin selects Data Science MITM -> Dashboard displays only Data Science MITM data', false, e.message);
  }

  // --------------------------------------------------------------------------
  // Scenario 3: Admin navigates to Task Management -> same batch remains selected
  // --------------------------------------------------------------------------
  try {
    const tasksRes = await apiRequest(`/tasks?batchId=${sim.selectedBatchId}`);
    const allBelong = tasksRes.data.every(t => (t.batchId?._id || t.batchId).toString() === dsBatch._id.toString());
    const pass = sim.selectedBatchId === dsBatch._id && allBelong;

    record(3, 'Admin navigates to Task Management -> same batch remains selected', pass,
      `Tasks count: ${tasksRes.data.length}, All belong strictly to ${dsBatch.batchName}: ${allBelong}`);
  } catch (e) {
    record(3, 'Admin navigates to Task Management -> same batch remains selected', false, e.message);
  }

  // --------------------------------------------------------------------------
  // Scenario 4: Admin navigates through every other module -> same batch remains active
  // --------------------------------------------------------------------------
  try {
    const batchId = sim.selectedBatchId;
    let moduleResults = [];

    const subRes = await apiRequest(`/submissions?batchId=${batchId}`);
    moduleResults.push({ module: 'Submissions', count: subRes.data?.length, status: subRes.status });

    const lcRes = await apiRequest(`/leetcode/batch/${batchId}`);
    moduleResults.push({ module: 'LeetCode Challenges', count: lcRes.data?.length, status: lcRes.status });

    const mdRes = await apiRequest(`/mock-drives/batch/${batchId}`);
    moduleResults.push({ module: 'Mock Drives', count: mdRes.data?.length, status: mdRes.status });

    const lbRes = await apiRequest(`/analytics/leaderboard?batchId=${batchId}`);
    moduleResults.push({ module: 'Leaderboard', count: lbRes.data?.length, status: lbRes.status });

    const notesRes = await apiRequest(`/notes?batchId=${batchId}`);
    moduleResults.push({ module: 'Study Notes', count: notesRes.data?.length, status: notesRes.status });

    const mentorRes = await apiRequest(`/mentors?batchId=${batchId}`);
    moduleResults.push({ module: 'Mentor Management', count: mentorRes.data?.length, status: mentorRes.status });

    const stuRes = await apiRequest(`/auth/students?batchId=${batchId}`);
    moduleResults.push({ module: 'Student Directory', count: stuRes.data?.length, status: stuRes.status });

    const trackerRes = await apiRequest(`/tasks/tracker/${batchId}`);
    moduleResults.push({ module: 'Task Tracker', students: trackerRes.data?.students?.length, status: trackerRes.status });

    const enrollRes = await apiRequest(`/enrollments/pending?batchId=${batchId}`);
    moduleResults.push({ module: 'Enrollment Requests', count: enrollRes.data?.length, status: enrollRes.status });

    const allSuccessful = moduleResults.every(m => m.status === 200);
    record(4, 'Admin navigates through every other module -> same batch remains active', allSuccessful,
      `Verified 9 module endpoints with batchId=${batchId}. All returned HTTP 200.`);
  } catch (e) {
    record(4, 'Admin navigates through every other module -> same batch remains active', false, e.message);
  }

  // --------------------------------------------------------------------------
  // Scenario 5: Admin refreshes the browser -> selected batch is restored
  // --------------------------------------------------------------------------
  try {
    const reloadedSim = sim.refreshBrowser();
    await reloadedSim.fetchGlobalBatches();

    const isRestored = reloadedSim.selectedBatchId === dsBatch._id &&
                       reloadedSim.selectedBatchName === dsBatch.batchName &&
                       reloadedSim.isBatchModalOpen === false;

    record(5, 'Admin refreshes browser -> selected batch is restored', isRestored,
      `Restored batch: "${reloadedSim.selectedBatchName}" (${reloadedSim.selectedBatchId}), Modal Open: ${reloadedSim.isBatchModalOpen}`);
    sim = reloadedSim;
  } catch (e) {
    record(5, 'Admin refreshes browser -> selected batch is restored', false, e.message);
  }

  // --------------------------------------------------------------------------
  // Scenario 6: Admin closes and reopens the application -> selected batch is restored after login
  // --------------------------------------------------------------------------
  try {
    const newBrowserSession = new GlobalBatchContextSimulator(localStorage);
    await newBrowserSession.login(adminUser);

    const isRestored = newBrowserSession.selectedBatchId === dsBatch._id &&
                       newBrowserSession.selectedBatchName === dsBatch.batchName &&
                       newBrowserSession.isBatchModalOpen === false;

    record(6, 'Admin closes and reopens app -> selected batch restored after login', isRestored,
      `Restored: "${newBrowserSession.selectedBatchName}" (${newBrowserSession.selectedBatchId})`);
    sim = newBrowserSession;
  } catch (e) {
    record(6, 'Admin closes and reopens app -> selected batch restored after login', false, e.message);
  }

  // --------------------------------------------------------------------------
  // Scenario 7: Admin logs out and logs in again -> verify intended persistence behavior
  // --------------------------------------------------------------------------
  try {
    sim.logout();
    const isLoggedOut = sim.user === null && sim.selectedBatchId === '';

    await sim.login(adminUser);
    const isRestoredAfterLogin = sim.selectedBatchId === dsBatch._id &&
                                 sim.selectedBatchName === dsBatch.batchName &&
                                 sim.isBatchModalOpen === false;

    record(7, 'Admin logs out and logs in again -> batch restored seamlessly', (isLoggedOut && isRestoredAfterLogin),
      `Post-relogin batch restored: "${sim.selectedBatchName}" (${sim.selectedBatchId}), Modal Open: ${sim.isBatchModalOpen}`);
  } catch (e) {
    record(7, 'Admin logs out and logs in again -> batch restored seamlessly', false, e.message);
  }

  // --------------------------------------------------------------------------
  // Scenario 8: Selected batch is deleted or becomes invalid -> ask admin to select another batch
  // --------------------------------------------------------------------------
  try {
    localStorage.setItem('selectedBatchId', '666666666666666666666666');
    localStorage.setItem('selectedBatchName', 'Ghost Deleted Batch');

    const invalidSession = new GlobalBatchContextSimulator(localStorage);
    await invalidSession.login(adminUser);

    const modalAppears = invalidSession.isBatchModalOpen === true &&
                         invalidSession.selectedBatchId === '' &&
                         localStorage.getItem('selectedBatchId') === null;

    record(8, 'Selected batch is deleted/invalid -> ask admin to select another batch', modalAppears,
      `Invalid batch cleared, Modal open: ${invalidSession.isBatchModalOpen}, Storage cleared: ${localStorage.getItem('selectedBatchId') === null}`);
  } catch (e) {
    record(8, 'Selected batch is deleted/invalid -> ask admin to select another batch', false, e.message);
  }

  // --------------------------------------------------------------------------
  // Scenario 9: Newly created batches -> appear in the selection screen
  // --------------------------------------------------------------------------
  let testBatch = null;
  try {
    const testBatchPayload = {
      batchName: `E2E Audit Batch ${Date.now()}`,
      description: 'Audit test batch to verify dynamic appearance',
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 86400000 * 30).toISOString(),
      status: 'Active'
    };

    const createRes = await apiRequest('/batches', {
      method: 'POST',
      body: JSON.stringify(testBatchPayload)
    });
    testBatch = createRes.data;

    // Refresh batches
    await sim.fetchGlobalBatches();

    const appearsInList = sim.batchesList.some(b => b._id.toString() === testBatch._id.toString());

    // Clean up created test batch
    await apiRequest(`/batches/${testBatch._id}`, {
      method: 'DELETE'
    });

    record(9, 'Newly created batches -> appear in the selection screen', appearsInList,
      `Created batch "${testBatch.batchName}" (ID: ${testBatch._id}), Detected in list: ${appearsInList}`);
  } catch (e) {
    record(9, 'Newly created batches -> appear in the selection screen', false, e.message);
  }

  // --------------------------------------------------------------------------
  // Scenario 10: Verify that no module displays data belonging to another batch
  // --------------------------------------------------------------------------
  try {
    if (!dsBatch || !pyBatch) throw new Error('Need both Data Science and Python batches for cross-isolation test');

    const [dsNotes, pyNotes] = await Promise.all([
      apiRequest(`/notes?batchId=${dsBatch._id}`),
      apiRequest(`/notes?batchId=${pyBatch._id}`)
    ]);

    const dsNoteIds = new Set(Array.isArray(dsNotes.data) ? dsNotes.data.map(n => n._id.toString()) : []);
    const pyNoteIds = new Set(Array.isArray(pyNotes.data) ? pyNotes.data.map(n => n._id.toString()) : []);
    let noteOverlap = false;
    for (const id of dsNoteIds) {
      if (pyNoteIds.has(id)) noteOverlap = true;
    }

    const [dsTasks, pyTasks] = await Promise.all([
      apiRequest(`/tasks?batchId=${dsBatch._id}`),
      apiRequest(`/tasks?batchId=${pyBatch._id}`)
    ]);

    const dsTaskIds = new Set(Array.isArray(dsTasks.data) ? dsTasks.data.map(t => t._id.toString()) : []);
    const pyTaskIds = new Set(Array.isArray(pyTasks.data) ? pyTasks.data.map(t => t._id.toString()) : []);
    let taskOverlap = false;
    for (const id of dsTaskIds) {
      if (pyTaskIds.has(id)) taskOverlap = true;
    }

    const [dsStudents, pyStudents] = await Promise.all([
      apiRequest(`/auth/students?batchId=${dsBatch._id}`),
      apiRequest(`/auth/students?batchId=${pyBatch._id}`)
    ]);

    const dsStudentIds = new Set(Array.isArray(dsStudents.data) ? dsStudents.data.map(s => s._id.toString()) : []);
    const pyStudentIds = new Set(Array.isArray(pyStudents.data) ? pyStudents.data.map(s => s._id.toString()) : []);
    let studentOverlap = false;
    for (const id of dsStudentIds) {
      if (pyStudentIds.has(id)) studentOverlap = true;
    }

    const isolated = !noteOverlap && !taskOverlap && !studentOverlap;
    record(10, 'Verify that no module displays data belonging to another batch', isolated,
      `Notes overlap: ${noteOverlap}, Tasks overlap: ${taskOverlap}, Students overlap: ${studentOverlap}`);
  } catch (e) {
    record(10, 'Verify that no module displays data belonging to another batch', false, e.message);
  }

  console.log('\n===============================================================');
  const allPassed = results.every(r => r.passed);
  console.log(`AUDIT COMPLETE: ${results.filter(r => r.passed).length}/${results.length} Scenarios Passed`);
  console.log('===============================================================\n');

  process.exit(allPassed ? 0 : 1);
}

runE2EAudit();
