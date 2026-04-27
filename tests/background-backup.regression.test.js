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
    'function createBackupRunRecord(scopes, headers, pageTabId = 0, baselineManifest = null) {',
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
    cloneBackupBaselineManifestSummary(value) {
      return value ? JSON.parse(JSON.stringify(value)) : null;
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
    cloneBackupBaselineManifestSummary(value) {
      return value ? JSON.parse(JSON.stringify(value)) : null;
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

function buildIncrementalMatchHarness() {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const snippet = extractSnippet(
    src,
    'function createBackupBaselineLookup(baselineManifest) {',
    'function formatBackupDiscoveryProgressSummary(bucketKey, page, run) {',
    'background backup incremental matching snippet'
  );

  const context = {
    sanitizeString(value, maxLen = 4096) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
    },
    normalizeItemStatus(value) {
      return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'queued';
    },
    sanitizeBackupComparisonKey(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return /^[A-Za-z0-9_.-]+:[A-Za-z0-9:_./-]+$/.test(trimmed) ? trimmed : null;
    },
    buildBackupComparisonKey(kind, id) {
      const normalizedKind = String(kind || '').trim().toLowerCase();
      const normalizedId = String(id || '').trim();
      return normalizedKind && normalizedId ? `${normalizedKind}:${normalizedId}` : '';
    },
    cloneBackupBaselineManifestSummary(value) {
      return value ? JSON.parse(JSON.stringify(value)) : null;
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `
${snippet}
globalThis.__createBackupBaselineLookup = createBackupBaselineLookup;
globalThis.__maybeMarkBackupItemAlreadyBackedUp = maybeMarkBackupItemAlreadyBackedUp;
globalThis.__shouldStopBucketDiscoveryAfterItem = shouldStopBucketDiscoveryAfterItem;
`,
    context,
    { filename: 'background-backup-incremental-harness.js' }
  );

  return {
    createBackupBaselineLookup: context.__createBackupBaselineLookup,
    maybeMarkBackupItemAlreadyBackedUp: context.__maybeMarkBackupItemAlreadyBackedUp,
    shouldStopBucketDiscoveryAfterItem: context.__shouldStopBucketDiscoveryAfterItem,
  };
}

function buildDiscoverHarness(fetchPages) {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const snippet = extractSnippet(
    src,
    'function getSelectedBackupBuckets(scopes) {',
    'async function refreshBackupItemMedia(run, item) {',
    'background backup discover snippet'
  );

  const writes = [];
  const fetchCalls = [];
  const pagesByKey = new Map(Object.entries(fetchPages || {}).map(([key, pages]) => [key, Array.isArray(pages) ? pages.slice() : []]));
  const context = {
    BACKUP_DEFAULT_FEED_LIMIT: 20,
    BACKUP_DEFAULT_DRAFT_LIMIT: 50,
    normalizeBackupScopes(value) {
      const source = value && typeof value === 'object' ? value : {};
      return {
        ownDrafts: source.ownDrafts === true,
        ownPosts: source.ownPosts === true,
        castInPosts: source.castInPosts === true,
        castInDrafts: source.castInDrafts === true,
      };
    },
    isBackupRunInterrupted() {
      return false;
    },
    backupDbGet: async () => null,
    saveBackupDiscoveryProgress: async (run) => JSON.parse(JSON.stringify(run)),
    shouldInterruptBackupDiscovery() {
      return false;
    },
    backupFetchJson: async (_run, pathname, params = {}) => {
      const key = `${pathname}::${params.cut || ''}`;
      fetchCalls.push({ pathname, params: JSON.parse(JSON.stringify(params)) });
      const queue = pagesByKey.get(key) || [];
      if (!queue.length) return { items: [], next_cursor: null };
      const next = queue.shift();
      pagesByKey.set(key, queue);
      return JSON.parse(JSON.stringify(next));
    },
    resolveCurrentBackupUser: async () => ({ handle: 'aidaredevils', id: 'user_123' }),
    extractItemsFromPayload(payload) {
      return Array.isArray(payload?.items) ? payload.items : [];
    },
    getBackupItemId(_kind, item) {
      return typeof item?.id === 'string' ? item.id : '';
    },
    extractOwnerIdentity(item) {
      return item?.owner || { handle: 'someone', id: 'user_999' };
    },
    shouldFetchDiscoveryDetail() {
      return false;
    },
    fetchBackupDetail: async () => null,
    shouldExcludeAppearanceOwner() {
      return false;
    },
    buildBackupManifestItem(_run, bucketKey, kind, item, detail, order) {
      return {
        bucket: bucketKey,
        kind,
        id: (detail || item).id,
        item_key: `run:${kind}:${(detail || item).id}`,
        order,
        status: 'queued',
        skip_reason: '',
        last_error: '',
      };
    },
    maybeMarkBackupItemAlreadyBackedUp(run, item, baselineLookup) {
      if (!(baselineLookup instanceof Set) || !baselineLookup.has(`${item.kind}:${item.id}`)) return item;
      run.baseline_manifest = {
        ...(run.baseline_manifest || { filename: '', total_rows: 0, backed_up_rows: 0, matched_rows: 0 }),
        matched_rows: Number(run?.baseline_manifest?.matched_rows || 0) + 1,
      };
      return {
        ...item,
        status: 'skipped',
        skip_reason: 'already_backed_up',
      };
    },
    shouldStopBucketDiscoveryAfterItem(bucket, item, baselineLookup) {
      return !!(bucket?.stop_on_baseline_match && baselineLookup instanceof Set && baselineLookup.size > 0 &&
        item?.status === 'skipped' && item?.skip_reason === 'already_backed_up');
    },
    backupDbPut: async (_store, value) => {
      writes.push(JSON.parse(JSON.stringify(value)));
      return value;
    },
    applyBackupStatusTransition(counts, _fromStatus, toStatus) {
      const next = JSON.parse(JSON.stringify(counts || {}));
      const key = toStatus === 'downloading' ? 'downloading' : (toStatus || 'queued');
      next[key] = (Number(next[key]) || 0) + 1;
      return next;
    },
    extractCursorFromPayload(payload) {
      return payload?.next_cursor || null;
    },
    formatBackupDiscoveryProgressSummary(bucketKey, page, run) {
      const matched = Number(run?.baseline_manifest?.matched_rows) || 0;
      return matched > 0
        ? `Discovering ${bucketKey}: page ${page}, accepted ${run?.counts?.discovered || 0}, already backed up ${matched}`
        : `Discovering ${bucketKey}: page ${page}, accepted ${run?.counts?.discovered || 0}`;
    },
    formatBackupDiscoveryCompleteSummary(run) {
      return `Discovery complete. ${run?.counts?.queued || 0} files queued.`;
    },
    BACKUP_RUNS_STORE: 'runs',
    BACKUP_ITEMS_STORE: 'items',
  };

  vm.createContext(context);
  vm.runInContext(
    `
${snippet}
globalThis.__discoverBackupRun = discoverBackupRun;
`,
    context,
    { filename: 'background-backup-discover-harness.js' }
  );

  return {
    discoverBackupRun: context.__discoverBackupRun,
    writes,
    fetchCalls,
  };
}

function buildRunSummaryHarness() {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const snippet = extractSnippet(
    src,
    'function cloneBackupBucketCounts(raw) {',
    'async function sendBackupPageFetchToTab(tabId, payload) {',
    'background backup summary snippet'
  );

  const context = {
    isPlainObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value);
    },
    normalizeBackupScopes(value) {
      const source = value && typeof value === 'object' ? value : {};
      return {
        ownDrafts: source.ownDrafts !== false,
        ownPosts: source.ownPosts !== false,
        castInPosts: source.castInPosts !== false,
        castInDrafts: source.castInDrafts !== false,
      };
    },
    cloneBackupCounts(counts) {
      return JSON.parse(JSON.stringify(counts || {}));
    },
    normalizeRunStatus(value) {
      return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'idle';
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
    cloneBackupBaselineManifestSummary(value) {
      return value ? JSON.parse(JSON.stringify(value)) : null;
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `
${snippet}
globalThis.__summarizeBackupRunForClient = summarizeBackupRunForClient;
`,
    context,
    { filename: 'background-backup-summary-harness.js' }
  );

  return {
    summarizeBackupRunForClient: context.__summarizeBackupRunForClient,
  };
}

function buildManifestExportHarness() {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const snippet = extractSnippet(
    src,
    'function buildBackupManifestLine(item) {',
    '/* ─── Message handlers ─── */',
    'background backup export snippet'
  );

  let storedRun = null;
  let storedItems = [];
  const context = {
    BACKUP_RUNS_STORE: 'runs',
    sanitizeString(value, maxLen = 4096) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
    },
    normalizeItemStatus(value) {
      return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'queued';
    },
    summarizeBackupRunForClient(run) {
      return JSON.parse(JSON.stringify(run));
    },
    backupDbGet: async () => (storedRun ? JSON.parse(JSON.stringify(storedRun)) : null),
    backupDbGetLatestRun: async () => (storedRun ? JSON.parse(JSON.stringify(storedRun)) : null),
    backupDbGetRunItems: async () => storedItems.map((item) => JSON.parse(JSON.stringify(item))),
    __setRun(value) {
      storedRun = JSON.parse(JSON.stringify(value));
    },
    __setItems(value) {
      storedItems = Array.isArray(value) ? value.map((item) => JSON.parse(JSON.stringify(item))) : [];
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `
${snippet}
globalThis.__handleBackupManifestRequest = handleBackupManifestRequest;
`,
    context,
    { filename: 'background-backup-export-harness.js' }
  );

  return {
    handleBackupManifestRequest: context.__handleBackupManifestRequest,
    setRun(value) {
      context.__setRun(value);
    },
    setItems(value) {
      context.__setItems(value);
    },
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

test('maybeMarkBackupItemAlreadyBackedUp skips baseline matches and increments matched rows', () => {
  const harness = buildIncrementalMatchHarness();
  const lookup = harness.createBackupBaselineLookup({
    keys: ['published:post_123', 'published:post_123', 'draft:draft_456'],
  });
  const run = {
    baseline_manifest: {
      filename: 'sora_backup_manifest_2026-03-25_12-38-28.jsonl',
      total_rows: 42,
      backed_up_rows: 40,
      matched_rows: 0,
    },
  };

  const matched = harness.maybeMarkBackupItemAlreadyBackedUp(
    run,
    { kind: 'published', id: 'post_123', status: 'queued', skip_reason: '' },
    lookup
  );
  const untouched = harness.maybeMarkBackupItemAlreadyBackedUp(
    run,
    { kind: 'published', id: 'post_999', status: 'queued', skip_reason: '' },
    lookup
  );

  assert.equal(lookup.size, 2);
  assert.equal(matched.status, 'skipped');
  assert.equal(matched.skip_reason, 'already_backed_up');
  assert.equal(run.baseline_manifest.matched_rows, 1);
  assert.equal(untouched.status, 'queued');
  assert.equal(untouched.skip_reason, '');
});

test('shouldStopBucketDiscoveryAfterItem triggers only for baseline skip boundaries', () => {
  const harness = buildIncrementalMatchHarness();
  const lookup = harness.createBackupBaselineLookup({ keys: ['published:post_123'] });

  assert.equal(
    harness.shouldStopBucketDiscoveryAfterItem(
      { stop_on_baseline_match: true },
      { status: 'skipped', skip_reason: 'already_backed_up' },
      lookup
    ),
    true
  );
  assert.equal(
    harness.shouldStopBucketDiscoveryAfterItem(
      { stop_on_baseline_match: true },
      { status: 'skipped', skip_reason: 'network_error' },
      lookup
    ),
    false
  );
  assert.equal(
    harness.shouldStopBucketDiscoveryAfterItem(
      { stop_on_baseline_match: false },
      { status: 'skipped', skip_reason: 'already_backed_up' },
      lookup
    ),
    false
  );
});

test('discoverBackupRun stops paging a bucket after reaching the previous backup boundary', async () => {
  const harness = buildDiscoverHarness({
    '/backend/project_y/profile_feed/me::nf2': [
      {
        items: [
          { id: 'post_new', owner: { handle: 'aidaredevils', id: 'user_123' } },
          { id: 'post_old', owner: { handle: 'aidaredevils', id: 'user_123' } },
        ],
        next_cursor: 'cursor_page_2',
      },
      {
        items: [
          { id: 'post_older', owner: { handle: 'aidaredevils', id: 'user_123' } },
        ],
        next_cursor: null,
      },
    ],
  });

  const run = {
    id: 'backup_run_boundary',
    scopes: { ownDrafts: false, ownPosts: true, castInPosts: false, castInDrafts: false },
    counts: { discovered: 0, queued: 0, downloading: 0, done: 0, skipped: 0, failed: 0 },
    bucket_counts: { ownDrafts: 0, ownPosts: 0, castInPosts: 0, castInDrafts: 0 },
    current_user: { handle: '', id: '' },
    baseline_manifest: {
      filename: 'previous.jsonl',
      total_rows: 100,
      backed_up_rows: 100,
      matched_rows: 0,
    },
  };

  const out = await harness.discoverBackupRun(run, new Set(['published:post_old']));

  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.writes.length, 2);
  assert.equal(harness.writes[0].id, 'post_new');
  assert.equal(harness.writes[0].status, 'queued');
  assert.equal(harness.writes[1].id, 'post_old');
  assert.equal(harness.writes[1].status, 'skipped');
  assert.equal(harness.writes[1].skip_reason, 'already_backed_up');
  assert.equal(out.counts.queued, 1);
  assert.equal(out.counts.skipped, 1);
  assert.equal(out.bucket_counts.ownPosts, 2);
  assert.equal(out.baseline_manifest.matched_rows, 1);
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

test('summarizeBackupRunForClient keeps baseline manifest metadata for the UI and summary export', () => {
  const harness = buildRunSummaryHarness();
  const out = harness.summarizeBackupRunForClient({
    id: 'backup_run_6',
    status: 'completed',
    scopes: { ownDrafts: true, ownPosts: true, castInPosts: false, castInDrafts: false },
    counts: { discovered: 12, queued: 0, downloading: 0, done: 8, skipped: 4, failed: 0 },
    bucket_counts: { ownDrafts: 4, ownPosts: 8, castInPosts: 0, castInDrafts: 0 },
    current_user: { handle: 'aidaredevils', id: 'user_123' },
    run_stamp: '2026-04-08_21-56-23',
    baseline_manifest: {
      filename: 'sora_backup_manifest_2026-03-25_12-38-28.jsonl',
      total_rows: 42,
      backed_up_rows: 40,
      matched_rows: 4,
    },
    summary_text: 'Backup complete.',
  });

  assert.deepEqual(out.baseline_manifest, {
    filename: 'sora_backup_manifest_2026-03-25_12-38-28.jsonl',
    total_rows: 42,
    backed_up_rows: 40,
    matched_rows: 4,
  });
});

test('handleBackupManifestRequest excludes already_backed_up skips from failures exports', async () => {
  const harness = buildManifestExportHarness();
  harness.setRun({
    id: 'backup_run_7',
    run_stamp: '2026-04-08_21-56-23',
    baseline_manifest: {
      filename: 'sora_backup_manifest_2026-03-25_12-38-28.jsonl',
      total_rows: 42,
      backed_up_rows: 40,
      matched_rows: 3,
    },
  });
  harness.setItems([
    {
      item_key: 'backup_run_7:published:post_done',
      run_id: 'backup_run_7',
      bucket: 'ownPosts',
      kind: 'published',
      id: 'post_done',
      status: 'done',
      skip_reason: '',
    },
    {
      item_key: 'backup_run_7:published:post_already',
      run_id: 'backup_run_7',
      bucket: 'ownPosts',
      kind: 'published',
      id: 'post_already',
      status: 'skipped',
      skip_reason: 'already_backed_up',
    },
    {
      item_key: 'backup_run_7:published:post_skip_other',
      run_id: 'backup_run_7',
      bucket: 'ownPosts',
      kind: 'published',
      id: 'post_skip_other',
      status: 'skipped',
      skip_reason: 'network_error',
    },
    {
      item_key: 'backup_run_7:published:post_failed',
      run_id: 'backup_run_7',
      bucket: 'ownPosts',
      kind: 'published',
      id: 'post_failed',
      status: 'failed',
      skip_reason: '',
    },
  ]);

  const failures = await harness.handleBackupManifestRequest({ runId: 'backup_run_7', format: 'failures' });
  const summary = await harness.handleBackupManifestRequest({ runId: 'backup_run_7', format: 'summary' });

  assert.equal(failures.ok, true);
  assert.match(failures.text, /post_skip_other/);
  assert.match(failures.text, /post_failed/);
  assert.doesNotMatch(failures.text, /post_already/);

  const parsedSummary = JSON.parse(summary.text);
  assert.deepEqual(parsedSummary.run.baseline_manifest, {
    filename: 'sora_backup_manifest_2026-03-25_12-38-28.jsonl',
    total_rows: 42,
    backed_up_rows: 40,
    matched_rows: 3,
  });
});
