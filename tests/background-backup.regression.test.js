const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BACKGROUND_PATH = path.join(__dirname, '..', 'background.js');

function extractSnippet(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label} start not found`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${label} end not found`);
  return source.slice(start, end);
}

function buildRetryHarness(fetchImpl) {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const snippet = extractSnippet(
    src,
    'function waitMs(ms) {',
    'function extractItemsFromPayload(payload) {',
    'background backup retry snippet'
  );

  const timers = [];
  const context = {
    BACKUP_FETCH_MAX_ATTEMPTS: 4,
    BACKUP_FETCH_RETRY_BASE_MS: 1500,
    BACKUP_FETCH_RETRY_MAX_MS: 15000,
    Date,
    Math,
    performBackupPageFetch: fetchImpl,
    sanitizeString(value, maxLen = 4096) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
    },
    parseTimestampMs(value) {
      const parsed = Date.parse(String(value || ''));
      return Number.isFinite(parsed) ? parsed : 0;
    },
    setTimeout(fn, ms) {
      timers.push(ms);
      fn();
      return timers.length;
    },
    clearTimeout() {},
  };

  vm.createContext(context);
  vm.runInContext(
    `
${snippet}
globalThis.__backupFetchJson = backupFetchJson;
globalThis.__timers = ${JSON.stringify([])};
`,
    context,
    { filename: 'background-backup-retry-harness.js' }
  );

  return {
    backupFetchJson: context.__backupFetchJson,
    timers,
  };
}

function buildManifestHarness(pickBackupMediaSourceImpl) {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const snippet = extractSnippet(
    src,
    'function getBackupItemId(kind, item) {',
    'function createBackupRunRecord(scopes, headers, pageTabId = 0) {',
    'background backup manifest snippet'
  );

  const context = {
    BACKUP_DOWNLOAD_FOLDER: 'Sora Backup',
    BACKUP_ORIGIN: 'https://sora.chatgpt.com',
    MAX_HARVEST_CAST_NAMES: 32,
    isPlainObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value);
    },
    sanitizeString(value, maxLen = 4096) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
    },
    sanitizeIdToken(value, maxLen = 128) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
    },
    sanitizeNumber(value, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.min(max, Math.max(min, n));
    },
    normalizeCurrentUser(value) {
      return value && typeof value === 'object'
        ? { handle: String(value.handle || value.username || '').trim(), id: String(value.id || value.user_id || '').trim() }
        : { handle: '', id: '' };
    },
    extractOwnerIdentity(value) {
      const root = value?.post && typeof value.post === 'object' ? value.post : value;
      const owner = root?.owner || value?.owner || value?.author || value?.profile || {};
      return {
        handle: String(owner.handle || owner.username || value?.user_handle || '').trim(),
        id: String(owner.id || owner.user_id || root?.shared_by || value?.user_id || '').trim(),
      };
    },
    pickBackupMediaSource: pickBackupMediaSourceImpl,
    makeBackupItemKey(runId, kind, id) {
      return `${runId}:${kind}:${id}`;
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `
${snippet}
globalThis.__buildBackupManifestItem = buildBackupManifestItem;
`,
    context,
    { filename: 'background-backup-manifest-harness.js' }
  );

  return {
    buildBackupManifestItem: context.__buildBackupManifestItem,
  };
}

function buildDiscoveryProgressHarness() {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const snippet = extractSnippet(
    src,
    'function shouldInterruptBackupDiscovery(run) {',
    'function getSelectedBackupBuckets(scopes) {',
    'background backup discovery progress snippet'
  );

  const calls = [];
  let storedRun = null;
  const context = {
    calls,
    backupRunInterrupts: new Map(),
    BACKUP_RUNS_STORE: 'runs',
    normalizeRunStatus(value) {
      return typeof value === 'string' && value.trim() ? value.trim() : 'idle';
    },
    isTerminalRunStatus(value) {
      return value === 'completed' || value === 'failed' || value === 'cancelled';
    },
    cloneBackupCounts(counts) {
      return JSON.parse(JSON.stringify(counts || {}));
    },
    cloneBackupBucketCounts(counts) {
      return JSON.parse(JSON.stringify(counts || {}));
    },
    normalizeCurrentUser(value) {
      return value && typeof value === 'object'
        ? { handle: String(value.handle || '').trim(), id: String(value.id || '').trim() }
        : { handle: '', id: '' };
    },
    sanitizeString(value, maxLen = 4096) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
    },
    updateBackupRunStatus: async (_runId, updater, eventType = 'status') => {
      calls.push({ eventType, before: JSON.parse(JSON.stringify(storedRun || null)) });
      const next = typeof updater === 'function' ? updater({ ...(storedRun || {}) }) : { ...(storedRun || {}), ...(updater || {}) };
      storedRun = next;
      return next;
    },
    backupDbGet: async () => storedRun,
    __setStoredRun(value) {
      storedRun = JSON.parse(JSON.stringify(value));
    },
    __getStoredRun() {
      return storedRun;
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `
${snippet}
globalThis.__shouldInterruptBackupDiscovery = shouldInterruptBackupDiscovery;
globalThis.__markBackupRunInterrupted = markBackupRunInterrupted;
globalThis.__saveBackupDiscoveryProgress = saveBackupDiscoveryProgress;
`,
    context,
    { filename: 'background-backup-discovery-progress-harness.js' }
  );

  return {
    shouldInterruptBackupDiscovery: context.__shouldInterruptBackupDiscovery,
    markBackupRunInterrupted: context.__markBackupRunInterrupted,
    saveBackupDiscoveryProgress: context.__saveBackupDiscoveryProgress,
    setStoredRun(value) {
      context.__setStoredRun(value);
    },
    getStoredRun() {
      return context.__getStoredRun();
    },
    calls,
  };
}

function buildPageTabSyncHarness() {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const snippet = extractSnippet(
    src,
    'async function saveBackupRun(run, eventType = \'status\') {',
    'function buildBackupHeaders(run, overrideHeaders = {}) {',
    'background backup page tab sync snippet'
  );

  let storedRun = null;
  let getSequence = [];
  const puts = [];
  const events = [];
  const context = {
    BACKUP_RUNS_STORE: 'runs',
    backupRunInterrupts: new Map(),
    backupRunSaveQueues: new Map(),
    backupDbGet: async () => {
      if (getSequence.length) return JSON.parse(JSON.stringify(getSequence.shift()));
      return storedRun ? JSON.parse(JSON.stringify(storedRun)) : null;
    },
    backupDbPut: async (_store, value) => {
      storedRun = JSON.parse(JSON.stringify(value));
      puts.push(JSON.parse(JSON.stringify(value)));
    },
    broadcastBackupRunEvent: async (event) => {
      events.push(JSON.parse(JSON.stringify(event)));
    },
    summarizeBackupRunForClient(run) {
      return JSON.parse(JSON.stringify(run));
    },
    normalizeRunStatus(value) {
      return typeof value === 'string' && value.trim() ? value.trim() : 'idle';
    },
    cloneBackupCounts(counts) {
      return JSON.parse(JSON.stringify(counts || {}));
    },
    cloneBackupBucketCounts(counts) {
      return JSON.parse(JSON.stringify(counts || {}));
    },
    sanitizeString(value, maxLen = 4096) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
    },
    Date,
    __setStoredRun(value) {
      storedRun = JSON.parse(JSON.stringify(value));
    },
    __setGetSequence(values) {
      getSequence = Array.isArray(values)
        ? values.map((value) => JSON.parse(JSON.stringify(value)))
        : [];
    },
    __setInterrupt(runId, status) {
      const key = String(runId || '');
      const normalized = typeof status === 'string' ? status.trim() : '';
      if (!key || !normalized) {
        context.backupRunInterrupts.delete(key);
        return;
      }
      context.backupRunInterrupts.set(key, normalized);
    },
    __getStoredRun() {
      return storedRun ? JSON.parse(JSON.stringify(storedRun)) : null;
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `
${snippet}
globalThis.__saveBackupRun = saveBackupRun;
globalThis.__syncBackupRunPageTabId = syncBackupRunPageTabId;
`,
    context,
    { filename: 'background-backup-page-tab-sync-harness.js' }
  );

  return {
    saveBackupRun: context.__saveBackupRun,
    syncBackupRunPageTabId: context.__syncBackupRunPageTabId,
    setStoredRun(value) {
      context.__setStoredRun(value);
    },
    setGetSequence(values) {
      context.__setGetSequence(values);
    },
    setInterrupt(runId, status) {
      context.__setInterrupt(runId, status);
    },
    getStoredRun() {
      return context.__getStoredRun();
    },
    puts,
    events,
  };
}

test('backupFetchJson retries a 429 response before succeeding', async () => {
  const calls = [];
  const { backupFetchJson, timers } = buildRetryHarness(async (run, pathname, params) => {
    calls.push({ run, pathname, params });
    if (calls.length === 1) {
      return {
        ok: false,
        status: 429,
        error: 'rate_limited',
      };
    }
    return {
      ok: true,
      status: 200,
      json: { ok: true },
    };
  });

  const out = await backupFetchJson({ headers: { Authorization: 'Bearer test-token' } }, '/backend/project_y/profile_feed/me', { cut: 'nf2' });

  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(timers.length, 1);
  assert.ok(timers[0] >= 1500 && timers[0] <= 1850);
});

test('buildBackupManifestItem keeps accepted items queued even when discovery has no media URL yet', () => {
  const { buildBackupManifestItem } = buildManifestHarness(() => null);

  const item = buildBackupManifestItem(
    { id: 'backup_run_1', run_stamp: '2026-03-25_04-33-30' },
    'ownPosts',
    'published',
    { post: { id: 'post_123', title: 'Test post' } },
    null,
    0
  );

  assert.ok(item);
  assert.equal(item.status, 'queued');
  assert.equal(item.media_url, '');
  assert.equal(item.filename, 'Sora Backup/2026-03-25_04-33-30/ownPosts/post_123.mp4');
  assert.equal(item.last_error, '');
});

test('saveBackupDiscoveryProgress preserves a cancelled run instead of overwriting it', async () => {
  const harness = buildDiscoveryProgressHarness();
  harness.setStoredRun({
    id: 'backup_run_1',
    status: 'cancelled',
    counts: { discovered: 40, queued: 40, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 0, ownPosts: 40, castInPosts: 0, castInDrafts: 0 },
    current_user: { handle: 'aidaredevils', id: 'user_123' },
    completed_at: 0,
    cancelled_at: 1234567890,
    last_error: '',
    summary_text: 'Backup cancelled.',
  });

  const out = await harness.saveBackupDiscoveryProgress({
    id: 'backup_run_1',
    status: 'discovering',
    counts: { discovered: 60, queued: 60, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 0, ownPosts: 60, castInPosts: 0, castInDrafts: 0 },
    current_user: { handle: 'aidaredevils', id: 'user_123' },
    completed_at: 0,
    last_error: '',
    summary_text: 'Discovering ownPosts: page 3, accepted 60',
  });

  assert.equal(out.status, 'cancelled');
  assert.equal(out.summary_text, 'Backup cancelled.');
  assert.equal(out.counts.discovered, 40);
  assert.equal(harness.calls.length, 1);
});

test('saveBackupDiscoveryProgress stops immediately when the run has an in-memory interrupt', async () => {
  const harness = buildDiscoveryProgressHarness();
  harness.setStoredRun({
    id: 'backup_run_3',
    status: 'discovering',
    counts: { discovered: 10, queued: 10, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 10, ownPosts: 0, castInPosts: 0, castInDrafts: 0 },
    current_user: { handle: 'aidaredevils', id: 'user_123' },
    completed_at: 0,
    cancelled_at: 0,
    last_error: '',
    summary_text: 'Discovering ownDrafts: page 1, accepted 10',
  });
  harness.markBackupRunInterrupted('backup_run_3', 'cancelled');

  const out = await harness.saveBackupDiscoveryProgress({
    id: 'backup_run_3',
    status: 'discovering',
    counts: { discovered: 20, queued: 20, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 20, ownPosts: 0, castInPosts: 0, castInDrafts: 0 },
    current_user: { handle: 'aidaredevils', id: 'user_123' },
    completed_at: 0,
    last_error: '',
    summary_text: 'Discovering ownDrafts: page 2, accepted 20',
  });

  assert.equal(out.status, 'discovering');
  assert.equal(out.counts.discovered, 10);
  assert.equal(harness.calls.length, 0);
});

test('saveBackupDiscoveryProgress merges discovery progress into an active run', async () => {
  const harness = buildDiscoveryProgressHarness();
  harness.setStoredRun({
    id: 'backup_run_2',
    status: 'discovering',
    counts: { discovered: 0, queued: 0, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 0, ownPosts: 0, castInPosts: 0, castInDrafts: 0 },
    current_user: { handle: '', id: '' },
    completed_at: 0,
    cancelled_at: 0,
    last_error: '',
    summary_text: 'Starting discovery…',
  });

  const out = await harness.saveBackupDiscoveryProgress({
    id: 'backup_run_2',
    status: 'discovering',
    counts: { discovered: 20, queued: 20, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 0, ownPosts: 20, castInPosts: 0, castInDrafts: 0 },
    current_user: { handle: 'aidaredevils', id: 'user_123' },
    completed_at: 0,
    last_error: '',
    summary_text: 'Discovering ownPosts: page 1, accepted 20',
  });

  assert.equal(out.status, 'discovering');
  assert.equal(out.summary_text, 'Discovering ownPosts: page 1, accepted 20');
  assert.equal(out.counts.discovered, 20);
  assert.equal(out.current_user.handle, 'aidaredevils');
});

test('syncBackupRunPageTabId preserves a cancelled run while updating the preferred tab id', async () => {
  const harness = buildPageTabSyncHarness();
  harness.setStoredRun({
    id: 'backup_run_4',
    status: 'cancelled',
    interrupt_status: 'cancelled',
    page_tab_id: 12,
    counts: { discovered: 150, queued: 150, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 0, ownPosts: 0, castInPosts: 150, castInDrafts: 0 },
    cancelled_at: 1234567890,
    paused_at: 0,
    summary_text: 'Backup cancelled.',
    last_error: '',
  });

  const out = await harness.syncBackupRunPageTabId({
    id: 'backup_run_4',
    status: 'discovering',
    interrupt_status: '',
    page_tab_id: 0,
    counts: { discovered: 200, queued: 200, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 0, ownPosts: 0, castInPosts: 200, castInDrafts: 0 },
    cancelled_at: 0,
    paused_at: 0,
    summary_text: 'Discovering castInPosts: page 29, accepted 200',
    last_error: '',
  }, 99);

  assert.equal(out.status, 'cancelled');
  assert.equal(out.interrupt_status, 'cancelled');
  assert.equal(out.page_tab_id, 99);
  assert.equal(out.counts.discovered, 150);
  assert.equal(out.summary_text, 'Backup cancelled.');
  assert.equal(harness.getStoredRun().status, 'cancelled');
  assert.equal(harness.getStoredRun().page_tab_id, 99);
});

test('saveBackupRun honors a live cancel interrupt over a stale discovery save', async () => {
  const harness = buildPageTabSyncHarness();
  const discovering = {
    id: 'backup_run_5',
    status: 'discovering',
    interrupt_status: '',
    page_tab_id: 5,
    counts: { discovered: 32, queued: 32, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 0, ownPosts: 0, castInPosts: 32, castInDrafts: 0 },
    cancelled_at: 0,
    paused_at: 0,
    summary_text: 'Discovering castInPosts: page 3, accepted 32',
    last_error: '',
  };
  harness.setStoredRun(discovering);
  harness.setInterrupt('backup_run_5', 'cancelled');

  const out = await harness.saveBackupRun({
    ...discovering,
    counts: { discovered: 40, queued: 40, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 0, ownPosts: 0, castInPosts: 40, castInDrafts: 0 },
    summary_text: 'Discovering castInPosts: page 4, accepted 40',
  }, 'status');

  assert.equal(out.status, 'cancelled');
  assert.equal(out.interrupt_status, 'cancelled');
  assert.equal(out.summary_text, 'Backup cancelled.');
  assert.equal(harness.getStoredRun().status, 'cancelled');
});
