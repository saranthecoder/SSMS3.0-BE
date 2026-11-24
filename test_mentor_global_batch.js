require('dotenv').config();

const API_BASE = 'http://localhost:3000/api';
let mentorCookie = '';
let mentorUser = null;

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
    ...(mentorCookie ? { Cookie: mentorCookie } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, headers: response.headers, data };
}

class MentorGlobalBatchSimulator {
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

    if (this.user.role === 'admin' || this.user.role === 'mentor') {
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
          this.isBatchModalOpen = true; // Ask mentor to select another batch!
        }
      } else {
        this.selectedBatch = null;
        this.selectedBatchId = '';
        this.selectedBatchName = '';
        this.isBatchModalOpen = true; // Mandatory selection for mentor!
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
    const reloaded = new MentorGlobalBatchSimulator(this.storage);
    reloaded.user = JSON.parse(this.storage.getItem('user'));
    return reloaded;
  }

  getPanelName() {
    if (this.user?.role === 'admin') return 'SRAC 2.0';
    if (this.user?.role === 'mentor') return 'SSMS - Saran Students Management System';
    return this.selectedBatch?.panelName || '';
  }

  logout() {
    this.user = null;
    this.storage.removeItem('user');
    this.selectedBatch = null;
    this.selectedBatchId = '';
    this.selectedBatchName = '';
  }
}

async function runMentorAudit() {
  console.log('===============================================================');
  console.log('   MENTOR GLOBAL BATCH & FIXED PANEL NAME AUDIT SUITE         ');
  console.log('===============================================================\n');

  let results = [];
  const record = (num, title, passed, details = '') => {
    results.push({ num, title, passed, details });
    const tag = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`[${tag}] Scenario ${num}: ${title}`);
    if (details) console.log(`       Details: ${details}`);
  };

  // Step 0: Authenticate as mentor
  try {
    const loginRes = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'aspiringmind05@gmail.com', password: 'Password@123' })
    });
    mentorUser = loginRes.data;
    const cookieHeader = loginRes.headers.get('set-cookie');
    if (cookieHeader) mentorCookie = cookieHeader;
    console.log(`Authenticated as Mentor: ${mentorUser.name} (${mentorUser.email})\n`);
  } catch (err) {
    console.error('Failed to login as mentor:', err.message);
    process.exit(1);
  }

  const localStorage = new MockLocalStorage();
  let sim = new MentorGlobalBatchSimulator(localStorage);

  // Scenario 1: Mentor logs in for first time -> batch selection appears with assigned batches
  try {
    localStorage.clear();
    await sim.login(mentorUser);
    const assignedBatchNames = sim.batchesList.map(b => b.batchName);
    const pass = sim.isBatchModalOpen === true && sim.selectedBatchId === '' && assignedBatchNames.length >= 2;
    record(1, 'Mentor first login -> Batch selection modal appears with assigned batches', pass,
      `Modal open: ${sim.isBatchModalOpen}, Assigned batches count: ${assignedBatchNames.length} (${assignedBatchNames.join(', ')})`);
  } catch (e) {
    record(1, 'Mentor first login -> Batch selection modal appears', false, e.message);
  }

  // Scenario 2: Mentor selects batch -> batch is activated
  let pythonBatch = null;
  let javaBatch = null;
  try {
    pythonBatch = sim.batchesList.find(b => b.batchName === 'Python-FSD');
    javaBatch = sim.batchesList.find(b => b.batchName === 'Java FSD MIT Mysore');
    sim.selectBatch(pythonBatch);

    const pass = sim.selectedBatchId === pythonBatch._id && sim.isBatchModalOpen === false;
    record(2, 'Mentor selects Python-FSD -> Selected batch is active and modal closes', pass,
      `Active batch: "${sim.selectedBatchName}" (ID: ${sim.selectedBatchId}), Modal open: ${sim.isBatchModalOpen}`);
  } catch (e) {
    record(2, 'Mentor selects batch -> batch is activated', false, e.message);
  }

  // Scenario 3: Fixed panel name for mentors is always SSMS - Saran Students Management System
  try {
    const panelName = sim.getPanelName();
    const pass = panelName === 'SSMS - Saran Students Management System';
    record(3, 'Fixed Mentor panel name -> SSMS - Saran Students Management System', pass,
      `Resolved panel name: "${panelName}"`);
  } catch (e) {
    record(3, 'Fixed Mentor panel name', false, e.message);
  }

  // Scenario 4: Page refresh restores selected batch
  try {
    const reloaded = sim.refreshBrowser();
    await reloaded.fetchGlobalBatches();
    const pass = reloaded.selectedBatchId === pythonBatch._id && reloaded.isBatchModalOpen === false;
    record(4, 'Page refresh -> Selected batch restored without re-prompting', pass,
      `Restored batch: "${reloaded.selectedBatchName}" (ID: ${reloaded.selectedBatchId})`);
    sim = reloaded;
  } catch (e) {
    record(4, 'Page refresh -> Selected batch restored', false, e.message);
  }

  // Scenario 5: Mentor switches batch -> Java FSD MIT Mysore
  try {
    sim.selectBatch(javaBatch);
    const pass = sim.selectedBatchId === javaBatch._id && sim.selectedBatchName === javaBatch.batchName;
    record(5, 'Mentor switches batch to Java FSD MIT Mysore -> Context updates', pass,
      `Switched to: "${sim.selectedBatchName}" (${sim.selectedBatchId})`);
  } catch (e) {
    record(5, 'Mentor switches batch', false, e.message);
  }

  // Scenario 6: Re-login preserves remembered batch
  try {
    sim.logout();
    await sim.login(mentorUser);
    const pass = sim.selectedBatchId === javaBatch._id && sim.isBatchModalOpen === false;
    record(6, 'Re-login -> Remembered batch restored automatically', pass,
      `Restored batch: "${sim.selectedBatchName}" (${sim.selectedBatchId})`);
  } catch (e) {
    record(6, 'Re-login -> Remembered batch restored', false, e.message);
  }

  // Scenario 7: Invalid or unassigned batch triggers modal prompt
  try {
    localStorage.setItem('selectedBatchId', '555555555555555555555555');
    const invalidSim = new MentorGlobalBatchSimulator(localStorage);
    await invalidSim.login(mentorUser);
    const pass = invalidSim.isBatchModalOpen === true && invalidSim.selectedBatchId === '';
    record(7, 'Invalid batch selection -> Modal triggers to select a valid batch', pass,
      `Modal open: ${invalidSim.isBatchModalOpen}, Cleared batch ID: "${invalidSim.selectedBatchId}"`);
  } catch (e) {
    record(7, 'Invalid batch selection -> Modal triggers', false, e.message);
  }

  console.log('\n===============================================================');
  const allPassed = results.every(r => r.passed);
  console.log(`MENTOR AUDIT: ${results.filter(r => r.passed).length}/${results.length} Tests Passed`);
  console.log('===============================================================\n');

  process.exit(allPassed ? 0 : 1);
}

runMentorAudit();
