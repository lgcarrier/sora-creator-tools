try {
  importScripts('uv-backup-logic.js');
} catch {}

/* Open full dashboard page when the action icon is clicked */
chrome.action.onClicked.addListener(() => {
  openOrFocusDashboard(() => {});
});

/* ─── Metrics module (single owner of cache + storage writes) ─── */

const PENDING = [];
let flushTimer = null;
const HARVEST_PENDING = [];
let harvestFlushTimer = null;
let isHarvestFlushing = false;
let needsHarvestFlush = false;
let harvestDbPromise = null;
const METRICS_STORAGE_KEY = 'metrics';
const METRICS_UPDATED_AT_KEY = 'metricsUpdatedAt';
const METRICS_USERS_INDEX_KEY = 'metricsUsersIndex';
const TRUSTED_TAB_URL_RE = /^https:\/\/sora\.chatgpt\.com\//i;
const MAX_MESSAGE_BATCH_ITEMS = 250;
const MAX_SNAPSHOT_HISTORY_PER_POST = 720;
const MAX_PROFILE_SERIES_POINTS = 720;
const MAX_HARVEST_BATCH_ITEMS = 250;
const MAX_HARVEST_RECORDS = 25000;
const MAX_HARVEST_CAST_NAMES = 32;
const HARVEST_FLUSH_DEBOUNCE_MS = 900;
const HARVEST_UPDATED_AT_KEY = 'harvestUpdatedAt';
const HARVEST_STORAGE_VERSION_KEY = 'harvestStorageVersion';
const HARVEST_STORAGE_KEY = 'harvestRecordsV1';
const HARVEST_STORAGE_VERSION = 1;
const HARVEST_DB_NAME = 'SCT_HARVEST_DB_V1';
const HARVEST_DB_VERSION = 1;
const HARVEST_STORE = 'records';
const HARVEST_META_STORE = 'meta';
const BACKUP_DB_NAME = 'SCT_BACKUP_DB_V1';
const BACKUP_DB_VERSION = 1;
const BACKUP_RUNS_STORE = 'runs';
const BACKUP_ITEMS_STORE = 'items';
const BACKUP_ORIGIN = 'https://sora.chatgpt.com';
const BACKUP_DEFAULT_FEED_LIMIT = 20;
const BACKUP_DEFAULT_DRAFT_LIMIT = 50;
const BACKUP_URL_REFRESH_MAX_AGE_MS = 30 * 60 * 1000;
const BACKUP_DOWNLOAD_FOLDER = 'Sora Backup';
const BACKUP_FETCH_MAX_ATTEMPTS = 4;
const BACKUP_FETCH_RETRY_BASE_MS = 1500;
const BACKUP_FETCH_RETRY_MAX_MS = 15000;
const MAX_BACKUP_BASELINE_KEYS = 100000;

const backupLogic = globalThis.SoraUVBackupLogic || {};
const {
  DEFAULT_BACKUP_SCOPES = { ownDrafts: true, ownPosts: true, castInPosts: true, castInDrafts: true },
  normalizeBackupScopes = (value) => value || DEFAULT_BACKUP_SCOPES,
  normalizeBackupHeaders = (value) => value || {},
  buildBackupRunId = () => `backup_${Date.now()}`,
  buildBackupRunStamp = () => new Date().toISOString().replace(/[:.]/g, '-'),
  makeBackupItemKey = (runId, kind, id) => `${runId}:${kind}:${id}`,
  buildBackupComparisonKey = (kind, id) => {
    const normalizedKind = String(kind || '').trim().toLowerCase();
    const normalizedId = String(id || '').trim();
    return normalizedKind && normalizedId ? `${normalizedKind}:${normalizedId}` : '';
  },
  normalizeCurrentUser = (value) => value || { handle: '', id: '' },
  extractOwnerIdentity = (value) => value || { handle: '', id: '' },
  sameOwnerIdentity = () => false,
  shouldExcludeAppearanceOwner = () => false,
  parseTimestampMs = (value) => Number(value) || 0,
  inferFileExtension = () => 'mp4',
  isSignedUrlFresh = () => true,
  pickBackupMediaSource = () => null,
  normalizeRunStatus = (value) => value || 'idle',
  normalizeItemStatus = (value) => value || 'queued',
  isTerminalRunStatus = () => false,
  applyBackupStatusTransition = (counts) => counts,
  createEmptyBackupCounts = () => ({ discovered: 0, queued: 0, downloading: 0, done: 0, skipped: 0, failed: 0 }),
  cloneBackupCounts = (counts) => ({ ...(counts || {}) }),
} = backupLogic;

// Debug toggles
const DEBUG = { storage: false, thumbs: false };
const dlog = (topic, ...args) => { try { if (DEBUG[topic]) console.log('[SoraUV]', topic, ...args); } catch {} };

const DEFAULT_METRICS = { users: {} };
const postIdToUserKey = new Map();
let metricsCache = null;
let metricsCacheUpdatedAt = 0;
let metricsCacheLoading = null;
let lastSelfWriteTs = 0;
let knownUserCount = 0;
let lastUsersIndexWrite = 0;

// Hot/cold storage split constants and state
const COLD_PREFIX = 'snapshots_';
const COLD_DEBOUNCE_MS = 8000;
const STORAGE_VERSION_KEY = 'metricsStorageVersion';
const CURRENT_STORAGE_VERSION = 2;
const coldSnapshotBuffer = new Map(); // Map<userKey, Map<postId, snapshot[]>>
const coldDirtyUsers = new Set();
let coldWriteTimer = null;

let isFlushing = false;
let needsFlush = false;
let backupDbPromise = null;
let backupRunLoopPromise = null;
const backupRunInterrupts = new Map();
const backupRunSaveQueues = new Map();

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeString(value, maxLen = 4096) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function sanitizeIdToken(value, maxLen = 128) {
  const s = sanitizeString(value, maxLen);
  if (!s) return null;
  if (!/^[A-Za-z0-9:_.-]+$/.test(s)) return null;
  return s;
}

function sanitizeNumber(value, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function sanitizeUserId(value) {
  const numeric = sanitizeNumber(value);
  if (numeric != null) return numeric;
  return sanitizeIdToken(value);
}

function sanitizeCameoUsernames(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const raw of value) {
    if (out.length >= 32) break;
    const username = sanitizeString(raw, 80);
    if (!username) continue;
    out.push(username);
  }
  return out;
}

function sanitizeMetricsSnapshot(raw) {
  if (!isPlainObject(raw)) return null;
  const snap = {};

  const ts = sanitizeNumber(raw.ts, 0);
  if (ts != null) snap.ts = ts;
  const userKey = sanitizeIdToken(raw.userKey);
  if (userKey) snap.userKey = userKey;
  const pageUserKey = sanitizeIdToken(raw.pageUserKey);
  if (pageUserKey) snap.pageUserKey = pageUserKey;

  const userHandle = sanitizeString(raw.userHandle, 80);
  if (userHandle) snap.userHandle = userHandle;
  const pageUserHandle = sanitizeString(raw.pageUserHandle, 80);
  if (pageUserHandle) snap.pageUserHandle = pageUserHandle;

  const userId = sanitizeUserId(raw.userId);
  if (userId != null) snap.userId = userId;
  if (!snap.userKey && userId != null) snap.userKey = `id:${String(userId)}`;

  const postId = sanitizeIdToken(raw.postId);
  if (postId) snap.postId = postId;
  const parentPostId = sanitizeIdToken(raw.parent_post_id);
  if (parentPostId) snap.parent_post_id = parentPostId;
  const rootPostId = sanitizeIdToken(raw.root_post_id);
  if (rootPostId) snap.root_post_id = rootPostId;

  if (typeof raw.created_at === 'string') {
    const createdAt = sanitizeString(raw.created_at, 64);
    if (createdAt) snap.created_at = createdAt;
  } else {
    const createdAtNum = sanitizeNumber(raw.created_at, 0);
    if (createdAtNum != null) snap.created_at = createdAtNum;
  }

  const url = sanitizeString(raw.url, 2048);
  if (url) snap.url = url;
  const thumb = sanitizeString(raw.thumb, 2048);
  if (thumb) snap.thumb = thumb;
  const caption = sanitizeString(raw.caption, 4096);
  if (caption) snap.caption = caption;

  const cameoUsernames = sanitizeCameoUsernames(raw.cameo_usernames);
  if (cameoUsernames) snap.cameo_usernames = cameoUsernames;

  const uv = sanitizeNumber(raw.uv, 0);
  if (uv != null) snap.uv = uv;
  const likes = sanitizeNumber(raw.likes, 0);
  if (likes != null) snap.likes = likes;
  const views = sanitizeNumber(raw.views, 0);
  if (views != null) snap.views = views;
  const comments = sanitizeNumber(raw.comments, 0);
  if (comments != null) snap.comments = comments;
  const remixes = sanitizeNumber(raw.remixes, 0);
  if (remixes != null) snap.remixes = remixes;
  const remixCount = sanitizeNumber(raw.remix_count, 0);
  if (remixCount != null) snap.remix_count = remixCount;
  const followers = sanitizeNumber(raw.followers, 0);
  if (followers != null) snap.followers = followers;
  const cameoCount = sanitizeNumber(raw.cameo_count, 0);
  if (cameoCount != null) snap.cameo_count = cameoCount;
  const duration = sanitizeNumber(raw.duration, 0, 60 * 60 * 10);
  if (duration != null) snap.duration = duration;
  const width = sanitizeNumber(raw.width, 1, 20000);
  if (width != null) snap.width = width;
  const height = sanitizeNumber(raw.height, 1, 20000);
  if (height != null) snap.height = height;

  const hasSignal = !!snap.postId || snap.followers != null || snap.cameo_count != null;
  return hasSignal ? snap : null;
}

function sanitizeMetricsBatch(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const limit = Math.min(items.length, MAX_MESSAGE_BATCH_ITEMS);
  for (let i = 0; i < limit; i++) {
    const snap = sanitizeMetricsSnapshot(items[i]);
    if (snap) out.push(snap);
  }
  return out;
}

function normalizeHarvestKind(value) {
  const kind = sanitizeString(value, 16);
  if (!kind) return null;
  const n = kind.toLowerCase();
  if (n === 'published' || n === 'draft' || n === 'unknown') return n;
  return null;
}

function normalizeHarvestContext(value) {
  const context = sanitizeString(value, 16);
  if (!context) return null;
  const n = context.toLowerCase();
  if (n === 'top' || n === 'profile' || n === 'drafts') return n;
  return null;
}

function normalizeHarvestSource(value) {
  const source = sanitizeString(value, 16);
  if (!source) return null;
  const n = source.toLowerCase();
  if (n === 'api' || n === 'dom') return n;
  return null;
}

function sanitizeStringArray(value, maxItems = MAX_HARVEST_CAST_NAMES, maxLen = 80) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const raw of value) {
    if (out.length >= maxItems) break;
    const next = sanitizeString(raw, maxLen);
    if (!next) continue;
    out.push(next);
  }
  return out.length ? out : null;
}

function sanitizeHarvestRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const rec = {};

  const id = sanitizeIdToken(raw.id);
  if (!id) return null;
  rec.id = id;

  const kind = normalizeHarvestKind(raw.kind);
  if (!kind) return null;
  rec.kind = kind;

  const context = normalizeHarvestContext(raw.context);
  if (context) rec.context = context;
  const source = normalizeHarvestSource(raw.source);
  if (source) rec.source = source;

  const userHandle = sanitizeString(raw.user_handle, 80);
  if (userHandle) rec.user_handle = userHandle;
  const userId = sanitizeUserId(raw.user_id);
  if (userId != null) rec.user_id = userId;

  const detailUrl = sanitizeString(raw.detail_url, 2048);
  if (detailUrl) rec.detail_url = detailUrl;

  const prompt = sanitizeString(raw.prompt, 4096);
  if (prompt) rec.prompt = prompt;
  const promptSource = sanitizeString(raw.prompt_source, 32);
  if (promptSource) rec.prompt_source = promptSource;
  const title = sanitizeString(raw.title, 512);
  if (title) rec.title = title;
  const generationType = sanitizeString(raw.generation_type, 64);
  if (generationType) rec.generation_type = generationType;
  const generationId = sanitizeIdToken(raw.generation_id);
  if (generationId) rec.generation_id = generationId;

  const width = sanitizeNumber(raw.width, 1, 20000);
  if (width != null) rec.width = width;
  const height = sanitizeNumber(raw.height, 1, 20000);
  if (height != null) rec.height = height;
  const duration = sanitizeNumber(raw.duration_s, 0, 60 * 60 * 10);
  if (duration != null) rec.duration_s = duration;

  if (typeof raw.created_at === 'string') {
    const createdAt = sanitizeString(raw.created_at, 64);
    if (createdAt) rec.created_at = createdAt;
  } else {
    const createdAt = sanitizeNumber(raw.created_at, 0);
    if (createdAt != null) rec.created_at = createdAt;
  }
  if (typeof raw.posted_at === 'string') {
    const postedAt = sanitizeString(raw.posted_at, 64);
    if (postedAt) rec.posted_at = postedAt;
  } else {
    const postedAt = sanitizeNumber(raw.posted_at, 0);
    if (postedAt != null) rec.posted_at = postedAt;
  }
  if (typeof raw.updated_at === 'string') {
    const updatedAt = sanitizeString(raw.updated_at, 64);
    if (updatedAt) rec.updated_at = updatedAt;
  } else {
    const updatedAt = sanitizeNumber(raw.updated_at, 0);
    if (updatedAt != null) rec.updated_at = updatedAt;
  }

  const viewCount = sanitizeNumber(raw.view_count, 0);
  if (viewCount != null) rec.view_count = viewCount;
  const uniqueViewCount = sanitizeNumber(raw.unique_view_count, 0);
  if (uniqueViewCount != null) rec.unique_view_count = uniqueViewCount;
  const likeCount = sanitizeNumber(raw.like_count, 0);
  if (likeCount != null) rec.like_count = likeCount;
  const dislikeCount = sanitizeNumber(raw.dislike_count, 0);
  if (dislikeCount != null) rec.dislike_count = dislikeCount;
  const replyCount = sanitizeNumber(raw.reply_count, 0);
  if (replyCount != null) rec.reply_count = replyCount;
  const recursiveReplyCount = sanitizeNumber(raw.recursive_reply_count, 0);
  if (recursiveReplyCount != null) rec.recursive_reply_count = recursiveReplyCount;
  const remixCount = sanitizeNumber(raw.remix_count, 0);
  if (remixCount != null) rec.remix_count = remixCount;

  const postPermalink = sanitizeString(raw.post_permalink, 2048);
  if (postPermalink) rec.post_permalink = postPermalink;
  const postVisibility = sanitizeString(raw.post_visibility, 32);
  if (postVisibility) rec.post_visibility = postVisibility;

  const castCount = sanitizeNumber(raw.cast_count, 0, MAX_HARVEST_CAST_NAMES);
  if (castCount != null) rec.cast_count = castCount;
  const castNames = sanitizeStringArray(raw.cast_names, MAX_HARVEST_CAST_NAMES, 80);
  if (castNames) rec.cast_names = castNames;
  const cameos = sanitizeStringArray(raw.cameos, MAX_HARVEST_CAST_NAMES, 80);
  if (cameos) rec.cameos = cameos;

  const firstSeenTs = sanitizeNumber(raw.first_seen_ts, 0);
  if (firstSeenTs != null) rec.first_seen_ts = firstSeenTs;
  const lastSeenTs = sanitizeNumber(raw.last_seen_ts, 0);
  if (lastSeenTs != null) rec.last_seen_ts = lastSeenTs;
  const runId = sanitizeIdToken(raw.last_harvest_run_id);
  if (runId) rec.last_harvest_run_id = runId;

  rec.recordKey = `${rec.kind}:${rec.id}`;
  return rec;
}

function sanitizeHarvestBatch(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const limit = Math.min(items.length, MAX_HARVEST_BATCH_ITEMS);
  for (let i = 0; i < limit; i++) {
    const rec = sanitizeHarvestRecord(items[i]);
    if (rec) out.push(rec);
  }
  return out;
}

function mergeHarvestRecord(existing, incoming) {
  const prev = isPlainObject(existing) ? existing : null;
  const next = isPlainObject(incoming) ? incoming : null;
  if (!next) return prev;
  if (!prev) return { ...next };

  const out = { ...prev, ...next };
  out.recordKey = next.recordKey || prev.recordKey;
  out.id = prev.id || next.id;
  out.kind = prev.kind || next.kind || 'unknown';

  const firstSeenPrev = sanitizeNumber(prev.first_seen_ts, 0);
  const firstSeenNext = sanitizeNumber(next.first_seen_ts, 0);
  if (firstSeenPrev != null && firstSeenNext != null) out.first_seen_ts = Math.min(firstSeenPrev, firstSeenNext);
  else out.first_seen_ts = firstSeenPrev != null ? firstSeenPrev : firstSeenNext;

  const lastSeenPrev = sanitizeNumber(prev.last_seen_ts, 0);
  const lastSeenNext = sanitizeNumber(next.last_seen_ts, 0);
  if (lastSeenPrev != null && lastSeenNext != null) out.last_seen_ts = Math.max(lastSeenPrev, lastSeenNext);
  else out.last_seen_ts = lastSeenPrev != null ? lastSeenPrev : lastSeenNext;

  const maxField = (name) => {
    const a = sanitizeNumber(prev[name], 0);
    const b = sanitizeNumber(next[name], 0);
    if (a != null && b != null) out[name] = Math.max(a, b);
    else if (a != null || b != null) out[name] = a != null ? a : b;
  };
  maxField('view_count');
  maxField('unique_view_count');
  maxField('like_count');
  maxField('dislike_count');
  maxField('reply_count');
  maxField('recursive_reply_count');
  maxField('remix_count');
  maxField('cast_count');

  const preferIncomingIfExistingEmpty = (name) => {
    const prevVal = prev[name];
    const nextVal = next[name];
    const prevEmpty = prevVal == null || prevVal === '' || (Array.isArray(prevVal) && prevVal.length === 0);
    const nextNonEmpty = !(nextVal == null || nextVal === '' || (Array.isArray(nextVal) && nextVal.length === 0));
    if (prevEmpty && nextNonEmpty) out[name] = nextVal;
    else out[name] = prevVal != null ? prevVal : nextVal;
  };
  preferIncomingIfExistingEmpty('prompt');
  preferIncomingIfExistingEmpty('prompt_source');
  preferIncomingIfExistingEmpty('title');
  preferIncomingIfExistingEmpty('generation_type');
  preferIncomingIfExistingEmpty('generation_id');
  preferIncomingIfExistingEmpty('detail_url');
  preferIncomingIfExistingEmpty('created_at');
  preferIncomingIfExistingEmpty('posted_at');
  preferIncomingIfExistingEmpty('updated_at');
  preferIncomingIfExistingEmpty('post_permalink');
  preferIncomingIfExistingEmpty('post_visibility');
  preferIncomingIfExistingEmpty('cast_names');
  preferIncomingIfExistingEmpty('cameos');
  preferIncomingIfExistingEmpty('user_handle');
  preferIncomingIfExistingEmpty('user_id');

  out.context = next.context || prev.context;
  out.source = next.source || prev.source;
  out.last_harvest_run_id = next.last_harvest_run_id || prev.last_harvest_run_id;
  return out;
}

function normalizeRequestScope(scope) {
  const s = sanitizeString(scope, 16);
  if (!s) return null;
  const normalized = s.toLowerCase();
  if (normalized === 'analyze' || normalized === 'post') return normalized;
  return null;
}

function normalizeSnapshotMode(mode) {
  const s = sanitizeString(mode, 16);
  return s && s.toLowerCase() === 'all' ? 'all' : 'latest';
}

function sanitizeMetricsRequest(message) {
  const scope = normalizeRequestScope(message?.scope);
  if (!scope) return null;
  if (scope === 'analyze') {
    return {
      scope,
      windowHours: sanitizeNumber(message?.windowHours, 1, 24) ?? 24,
      snapshotMode: 'latest',
      postId: null,
    };
  }
  const postId = sanitizeIdToken(message?.postId);
  if (!postId) return null;
  return {
    scope,
    postId,
    windowHours: null,
    snapshotMode: normalizeSnapshotMode(message?.snapshotMode),
  };
}

function sanitizeBackupHeadersForRequest(value) {
  const headers = normalizeBackupHeaders(value);
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  const auth = sanitizeString(headers.Authorization, 4096);
  const device = sanitizeString(headers['OAI-Device-Id'], 256);
  const language = sanitizeString(headers['OAI-Language'], 64);
  if (auth) out.Authorization = auth;
  if (device) out['OAI-Device-Id'] = device;
  if (language) out['OAI-Language'] = language;
  return out;
}

function sanitizeBackupComparisonKey(value) {
  const key = sanitizeString(value, 256);
  if (!key) return null;
  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9:_./-]+$/.test(key)) return null;
  return key;
}

function sanitizeBackupBaselineManifestForRequest(value) {
  const raw = isPlainObject(value) ? value : null;
  if (!raw) return null;
  const keys = [];
  const seen = new Set();
  const sourceKeys = Array.isArray(raw.keys) ? raw.keys : [];
  for (const entry of sourceKeys) {
    if (keys.length >= MAX_BACKUP_BASELINE_KEYS) break;
    const key = sanitizeBackupComparisonKey(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  const filename = sanitizeString(raw.filename, 512) || '';
  const totalRows = sanitizeNumber(raw.total_rows, 0, 100000000) ?? 0;
  const backedUpRows = sanitizeNumber(raw.backed_up_rows, 0, 100000000) ?? 0;
  if (!filename && !keys.length && totalRows <= 0 && backedUpRows <= 0) return null;
  return {
    filename,
    total_rows: totalRows,
    backed_up_rows: backedUpRows,
    keys,
  };
}

function cloneBackupBaselineManifestSummary(value) {
  const raw = isPlainObject(value) ? value : null;
  if (!raw) return null;
  const filename = sanitizeString(raw.filename, 512) || '';
  const totalRows = sanitizeNumber(raw.total_rows, 0, 100000000) ?? 0;
  const backedUpRows = sanitizeNumber(raw.backed_up_rows, 0, 100000000) ?? 0;
  const matchedRows = sanitizeNumber(raw.matched_rows, 0, 100000000) ?? 0;
  if (!filename && totalRows <= 0 && backedUpRows <= 0 && matchedRows <= 0) return null;
  return {
    filename,
    total_rows: totalRows,
    backed_up_rows: backedUpRows,
    matched_rows: matchedRows,
  };
}

function sanitizeBackupPayload(action, payload) {
  const raw = isPlainObject(payload) ? payload : {};
  const runId = sanitizeIdToken(raw.runId);
  if (action === 'backup_start') {
    return {
      scopes: normalizeBackupScopes(raw.scopes),
      headers: sanitizeBackupHeadersForRequest(raw.headers),
      baseline_manifest: sanitizeBackupBaselineManifestForRequest(raw.baseline_manifest),
    };
  }
  if (action === 'backup_manifest_request') {
    const format = sanitizeString(raw.format, 24);
    return {
      runId: runId || null,
      format: format || 'manifest',
    };
  }
  return {
    runId: runId || null,
    headers: sanitizeBackupHeadersForRequest(raw.headers),
  };
}

function isTrustedSender(sender) {
  if (!sender) return false;
  const tabUrl = String(sender.tab?.url || '');
  if (tabUrl) return TRUSTED_TAB_URL_RE.test(tabUrl);
  if (sender.id && sender.id === chrome.runtime.id) return true;
  const senderUrl = String(sender.url || '');
  return senderUrl.startsWith(chrome.runtime.getURL(''));
}

function trimSeriesInPlace(arr, maxPoints = MAX_PROFILE_SERIES_POINTS) {
  if (!Array.isArray(arr) || arr.length <= maxPoints) return;
  arr.splice(0, arr.length - maxPoints);
}

function normalizeMetrics(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_METRICS };
  const users = raw.users;
  if (!users || typeof users !== 'object' || Array.isArray(users)) return { ...DEFAULT_METRICS };
  return { ...raw, users };
}

function rebuildPostIndex(metrics) {
  postIdToUserKey.clear();
  const users = metrics?.users || {};
  for (const [userKey, user] of Object.entries(users)) {
    const posts = user?.posts;
    if (!posts || typeof posts !== 'object') continue;
    for (const postId of Object.keys(posts)) {
      postIdToUserKey.set(postId, userKey);
    }
  }
}

function cacheMetrics(rawMetrics, updatedAt, opts) {
  const normalized = normalizeMetrics(rawMetrics);
  metricsCache = normalized;
  metricsCacheUpdatedAt = Number(updatedAt) || 0;
  if (opts?.rebuildIndex !== false) {
    rebuildPostIndex(normalized);
  }
}

async function loadMetricsFromStorage() {
  if (metricsCacheLoading) return metricsCacheLoading;
  metricsCacheLoading = (async () => {
    try {
      const stored = await chrome.storage.local.get([METRICS_STORAGE_KEY, METRICS_UPDATED_AT_KEY]);
      cacheMetrics(stored[METRICS_STORAGE_KEY], stored[METRICS_UPDATED_AT_KEY]);
    } catch {
      metricsCache = normalizeMetrics(null);
      metricsCacheUpdatedAt = metricsCacheUpdatedAt || 0;
    } finally {
      metricsCacheLoading = null;
    }
    return { metrics: metricsCache || { users: {} }, metricsUpdatedAt: metricsCacheUpdatedAt || 0 };
  })();
  return metricsCacheLoading;
}

async function migrateStorageIfNeeded() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_VERSION_KEY, METRICS_STORAGE_KEY]);
    if (stored[STORAGE_VERSION_KEY] === CURRENT_STORAGE_VERSION) return;
    const raw = stored[METRICS_STORAGE_KEY];
    if (!raw || !raw.users) {
      // No metrics to migrate, just stamp the version
      await chrome.storage.local.set({ [STORAGE_VERSION_KEY]: CURRENT_STORAGE_VERSION });
      return;
    }
    const coldShards = {};
    for (const [userKey, user] of Object.entries(raw.users)) {
      if (!user?.posts) continue;
      const shardData = {};
      let hasColdData = false;
      for (const [postId, post] of Object.entries(user.posts)) {
        if (!Array.isArray(post.snapshots) || post.snapshots.length <= 1) continue;
        // Copy full snapshot history to cold shard
        shardData[postId] = post.snapshots.slice(-MAX_SNAPSHOT_HISTORY_PER_POST);
        // Trim hot post to latest snapshot only
        post.snapshots = [post.snapshots[post.snapshots.length - 1]];
        hasColdData = true;
      }
      if (hasColdData) {
        coldShards[COLD_PREFIX + userKey] = shardData;
      }
    }
    const writePayload = {
      [METRICS_STORAGE_KEY]: raw,
      [STORAGE_VERSION_KEY]: CURRENT_STORAGE_VERSION,
      ...coldShards
    };
    await chrome.storage.local.set(writePayload);
    dlog('storage', 'migration v2 complete', { coldShards: Object.keys(coldShards).length });
  } catch (err) {
    try { console.warn('[SoraMetrics] migration failed', err); } catch {}
  }
}

async function getMetricsState() {
  if (metricsCache) {
    return { metrics: metricsCache, metricsUpdatedAt: metricsCacheUpdatedAt || 0 };
  }
  return loadMetricsFromStorage();
}

function toTs(v) {
  if (typeof v === 'number' && isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n < 1e11 ? n * 1000 : n;
    }
    const d = Date.parse(s);
    if (!isNaN(d)) return d;
  }
  return 0;
}

function getPostTimeMs(p) {
  const cands = [p?.post_time, p?.postTime, p?.post?.post_time, p?.post?.postTime, p?.meta?.post_time];
  for (const c of cands) {
    const t = toTs(c);
    if (t) return t;
  }
  return 0;
}

function latestSnapshot(snaps) {
  if (!Array.isArray(snaps) || snaps.length === 0) return null;
  const last = snaps[snaps.length - 1];
  if (last?.t != null) return last;
  let best = null;
  let bt = -Infinity;
  for (const s of snaps) {
    const t = Number(s?.t);
    if (isFinite(t) && t > bt) {
      bt = t;
      best = s;
    }
  }
  return best || last || null;
}

function pickSnapshotFields(snap) {
  if (!snap || typeof snap !== 'object') return null;
  return {
    t: snap.t ?? null,
    uv: snap.uv ?? null,
    likes: snap.likes ?? null,
    views: snap.views ?? null,
    comments: snap.comments ?? null,
    remixes: snap.remixes ?? null,
    remix_count: snap.remix_count ?? snap.remixes ?? null,
    duration: snap.duration ?? null,
    width: snap.width ?? null,
    height: snap.height ?? null,
  };
}

function trimPostForResponse(post, snapshotMode) {
  if (!post || typeof post !== 'object') return null;
  const postTime = getPostTimeMs(post);
  let snapshots = [];
  if (snapshotMode === 'all' && Array.isArray(post.snapshots)) {
    snapshots = post.snapshots.map(pickSnapshotFields).filter(Boolean);
  } else {
    const latest = latestSnapshot(post.snapshots);
    if (latest) {
      const picked = pickSnapshotFields(latest);
      if (picked) snapshots = [picked];
    }
  }
  return {
    url: post.url ?? null,
    thumb: post.thumb ?? null,
    caption: typeof post.caption === 'string' ? post.caption : null,
    text: typeof post.text === 'string' ? post.text : null,
    ownerKey: post.ownerKey ?? null,
    ownerHandle: post.ownerHandle ?? null,
    ownerId: post.ownerId ?? null,
    userHandle: post.userHandle ?? null,
    userKey: post.userKey ?? null,
    post_time: postTime || null,
    parent_post_id: post.parent_post_id ?? null,
    root_post_id: post.root_post_id ?? null,
    duration: post.duration ?? null,
    width: post.width ?? null,
    height: post.height ?? null,
    cameo_usernames: post.cameo_usernames ?? null,
    snapshots,
  };
}

function findPost(metrics, postId) {
  if (!postId || typeof postId !== 'string') return null;
  const userKey = postIdToUserKey.get(postId);
  if (userKey && metrics?.users?.[userKey]?.posts?.[postId]) {
    return { userKey, post: metrics.users[userKey].posts[postId] };
  }
  const users = metrics?.users || {};
  for (const [uKey, user] of Object.entries(users)) {
    const posts = user?.posts;
    if (!posts || typeof posts !== 'object') continue;
    if (posts[postId]) {
      postIdToUserKey.set(postId, uKey);
      return { userKey: uKey, post: posts[postId] };
    }
    for (const parentPost of Object.values(posts)) {
      const remixPostsData = parentPost?.remix_posts;
      const remixPosts = Array.isArray(remixPostsData)
        ? remixPostsData
        : (Array.isArray(remixPostsData?.items) ? remixPostsData.items : []);
      for (const remixItem of remixPosts) {
        const remixPost = remixItem?.post || remixItem;
        const remixId = remixPost?.id || remixPost?.post_id;
        if (remixId === postId) {
          postIdToUserKey.set(postId, uKey);
          return { userKey: uKey, post: remixPost };
        }
      }
    }
  }
  return null;
}

function buildAnalyzeMetrics(metrics, windowHours) {
  const trimmed = { users: {} };
  const NOW = Date.now();
  const hours = Math.min(24, Math.max(1, Number(windowHours) || 24));
  const windowMs = hours * 60 * 60 * 1000;
  const users = metrics?.users || {};
  for (const [userKey, user] of Object.entries(users)) {
    const posts = user?.posts;
    if (!posts || typeof posts !== 'object') continue;
    const nextPosts = {};
    for (const [pid, p] of Object.entries(posts)) {
      const tPost = getPostTimeMs(p);
      if (!tPost || NOW - tPost > windowMs) continue;
      const latest = latestSnapshot(p?.snapshots);
      if (!latest) continue;
      const trimmedPost = trimPostForResponse(p, 'latest');
      if (!trimmedPost) continue;
      nextPosts[pid] = trimmedPost;
    }
    if (Object.keys(nextPosts).length) {
      trimmed.users[userKey] = {
        handle: user?.handle ?? user?.userHandle ?? null,
        userHandle: user?.userHandle ?? user?.handle ?? null,
        id: user?.id ?? user?.userId ?? null,
        posts: nextPosts,
      };
    }
  }
  return trimmed;
}

function buildPostMetrics(metrics, postId, snapshotMode) {
  const result = { users: {} };
  const found = findPost(metrics, postId);
  if (!found) return result;
  const { userKey, post } = found;
  const user = metrics?.users?.[userKey] || {};
  const trimmedPost = trimPostForResponse(post, snapshotMode);
  if (!trimmedPost) return result;
  result.users[userKey] = {
    handle: user?.handle ?? user?.userHandle ?? null,
    userHandle: user?.userHandle ?? user?.handle ?? null,
    id: user?.id ?? user?.userId ?? null,
    posts: { [postId]: trimmedPost },
  };
  return result;
}

function buildMetricsForRequest(metrics, req) {
  const scope = normalizeRequestScope(req?.scope);
  if (scope === 'analyze') {
    return buildAnalyzeMetrics(metrics, req?.windowHours);
  }
  if (scope === 'post') {
    const snapshotMode = req?.snapshotMode === 'all' ? 'all' : 'latest';
    return buildPostMetrics(metrics, req?.postId, snapshotMode);
  }
  return { users: {} };
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 750);
}

function scheduleHarvestFlush() {
  if (harvestFlushTimer) return;
  harvestFlushTimer = setTimeout(flushHarvest, HARVEST_FLUSH_DEBOUNCE_MS);
}

function scheduleColdWrite() {
  if (coldWriteTimer) return;
  coldWriteTimer = setTimeout(flushCold, COLD_DEBOUNCE_MS);
}

async function flush() {
  flushTimer = null;

  // If already flushing, mark that we need another pass and return
  if (isFlushing) {
    needsFlush = true;
    return;
  }

  if (!PENDING.length) return;

  isFlushing = true;

  try {
    // Check purge lock to prevent overwriting dashboard purge
    try {
      const { purgeLock } = await chrome.storage.local.get('purgeLock');
      if (purgeLock && Date.now() - purgeLock < 30000) { // 30s timeout
         dlog('storage', 'purge locked, retrying', {});
         isFlushing = false;
         scheduleFlush();
         return;
      }
    } catch {}

    // Take current items
    const items = PENDING.splice(0, PENDING.length);
    try {
      const { metrics } = await getMetricsState();
      dlog('storage', 'flush begin', { count: items.length });
      let dirty = false;
      const touchedPosts = new Set();
      for (const snap of items) {
        const userKey = snap.userKey || snap.pageUserKey || 'unknown';
        if (!metrics.users[userKey]) {
          dirty = true;
        }
        const userEntry = metrics.users[userKey] || (metrics.users[userKey] = { handle: snap.userHandle || snap.pageUserHandle || null, id: snap.userId || null, posts: {}, followers: [], cameos: [] });
        if (!userEntry.posts || typeof userEntry.posts !== 'object' || Array.isArray(userEntry.posts)) userEntry.posts = {};
        if (!Array.isArray(userEntry.followers)) userEntry.followers = [];
        if (snap.postId) {
          postIdToUserKey.set(snap.postId, userKey);
          if (!userEntry.posts[snap.postId]) {
            dirty = true;
          }
          const post = userEntry.posts[snap.postId] || (userEntry.posts[snap.postId] = { url: snap.url || null, thumb: snap.thumb || null, snapshots: [] });
          touchedPosts.add(post);
          // Persist owner attribution on the post to allow dashboard integrity checks
          if (!post.ownerKey && (snap.userKey || snap.pageUserKey)) { post.ownerKey = snap.userKey || snap.pageUserKey; dirty = true; }
          if (!post.ownerHandle && (snap.userHandle || snap.pageUserHandle)) { post.ownerHandle = snap.userHandle || snap.pageUserHandle; dirty = true; }
          if (!post.ownerId && snap.userId != null) { post.ownerId = snap.userId; dirty = true; }
          if (!post.url && snap.url) { post.url = snap.url; dirty = true; }
          // Capture/refresh caption
          if (typeof snap.caption === 'string' && snap.caption) {
            if (!post.caption) { post.caption = snap.caption; dirty = true; }
            else if (post.caption !== snap.caption) { post.caption = snap.caption; dirty = true; }
          }
          // Capture/refresh cameo_usernames
          if (snap.cameo_usernames != null) {
            if (Array.isArray(snap.cameo_usernames) && snap.cameo_usernames.length > 0) {
              post.cameo_usernames = snap.cameo_usernames; dirty = true;
            } else if (!post.cameo_usernames) {
              // Only set to null/empty if it wasn't already set (preserve existing data)
              post.cameo_usernames = null;
            }
          }
          // Update thumbnail when a better/different one becomes available
          if (snap.thumb) {
            if (!post.thumb) {
              post.thumb = snap.thumb; dirty = true;
              dlog('thumbs', 'thumb set', { postId: snap.postId, thumb: post.thumb });
            } else if (post.thumb !== snap.thumb) {
              dlog('thumbs', 'thumb update', { postId: snap.postId, old: post.thumb, new: snap.thumb });
              post.thumb = snap.thumb; dirty = true;
            } else {
              dlog('thumbs', 'thumb unchanged', { postId: snap.postId, thumb: post.thumb });
            }
          } else {
            dlog('thumbs', 'thumb missing in snap', { postId: snap.postId });
          }
          if (!post.post_time && snap.created_at) { post.post_time = snap.created_at; dirty = true; } // Map creation time so dashboard can sort posts
          // Relationship fields for deriving direct remix counts across metrics
          if (snap.parent_post_id != null && post.parent_post_id !== snap.parent_post_id) { post.parent_post_id = snap.parent_post_id; dirty = true; }
          if (snap.root_post_id != null && post.root_post_id !== snap.root_post_id) { post.root_post_id = snap.root_post_id; dirty = true; }

          // IMPORTANT: Always update duration and dimensions at post level when available
          if (snap.duration != null) {
            const d = Number(snap.duration);
            if (Number.isFinite(d) && post.duration !== d) {
              const wasSet = post.duration != null;
              post.duration = d; dirty = true;
              if (DEBUG.storage) {
                dlog('storage', wasSet ? 'duration updated' : 'duration set', { postId: snap.postId, duration: d });
              }
            }
          }
          if (snap.width != null) {
            const w = Number(snap.width);
            if (Number.isFinite(w) && post.width !== w) { post.width = w; dirty = true; }
          }
          if (snap.height != null) {
            const h = Number(snap.height);
            if (Number.isFinite(h) && post.height !== h) { post.height = h; dirty = true; }
          }

          const s = {
            t: snap.ts || Date.now(),
            uv: snap.uv ?? null,
            likes: snap.likes ?? null,
            views: snap.views ?? null,
            comments: snap.comments ?? null,
            // Store direct remixes; map both names for backward/forward compat
            remixes: snap.remix_count ?? snap.remixes ?? null,
            remix_count: snap.remix_count ?? snap.remixes ?? null,
            // Store duration and dimensions (frame count data)
            duration: snap.duration ?? null,
            width: snap.width ?? null,
            height: snap.height ?? null,
          };

          // Only add a new snapshot if engagement metrics changed
          const last = post.snapshots[post.snapshots.length - 1];
          const same = last && last.uv === s.uv && last.likes === s.likes && last.views === s.views &&
            last.comments === s.comments && last.remix_count === s.remix_count;

          if (!same) {
            post.snapshots.push(s);
            dirty = true;
            // Buffer for cold write
            if (!coldSnapshotBuffer.has(userKey)) coldSnapshotBuffer.set(userKey, new Map());
            const userBuf = coldSnapshotBuffer.get(userKey);
            if (!userBuf.has(snap.postId)) userBuf.set(snap.postId, []);
            userBuf.get(snap.postId).push(s);
            coldDirtyUsers.add(userKey);
          } else if (last && (last.duration !== s.duration || last.width !== s.width || last.height !== s.height)) {
            // If metrics are the same but duration/dimensions changed, update the last snapshot
            last.duration = s.duration;
            last.width = s.width;
            last.height = s.height;
            dirty = true;
          }

          post.lastSeen = Date.now();
        }

        // Capture follower history at the user level when available
        if (snap.followers != null) {
          const fCount = Number(snap.followers);
          if (Number.isFinite(fCount)) {
            const arr = userEntry.followers;
            const t = snap.ts || Date.now();
            const lastF = arr[arr.length - 1];
            if (!lastF || lastF.count !== fCount) {
              arr.push({ t, count: fCount });
              trimSeriesInPlace(arr);
              dirty = true;
              if (DEBUG.storage) dlog('storage', 'followers persisted', { userKey, count: fCount, t });
            }
          }
        }
        // Capture cameo count (profile-level) if available
        if (snap.cameo_count != null) {
          const cCount = Number(snap.cameo_count);
          if (Number.isFinite(cCount)) {
            if (!Array.isArray(userEntry.cameos)) userEntry.cameos = [];
            const arr = userEntry.cameos;
            const t = snap.ts || Date.now();
            const lastC = arr[arr.length - 1];
            if (!lastC || lastC.count !== cCount) {
              arr.push({ t, count: cCount });
              trimSeriesInPlace(arr);
              dirty = true;
              if (DEBUG.storage) dlog('storage', 'cameos persisted', { userKey, count: cCount, t });
            }
          }
        }
      }
      if (!dirty) {
        dlog('storage', 'flush skip (no changes)', {});
        return;
      }
      try {
        // Trim only the touched hot posts to latest-snapshot-only before writing.
        for (const post of touchedPosts) {
          if (Array.isArray(post?.snapshots) && post.snapshots.length > 1) {
            post.snapshots = [post.snapshots[post.snapshots.length - 1]];
          }
        }

        const metricsUpdatedAt = Date.now();
        const currentUserCount = Object.keys(metrics.users || {}).length;
        const shouldWriteIndex = currentUserCount !== knownUserCount || (metricsUpdatedAt - lastUsersIndexWrite >= 30000);
        const payload = {
          [METRICS_STORAGE_KEY]: metrics,
          [METRICS_UPDATED_AT_KEY]: metricsUpdatedAt,
        };
        if (shouldWriteIndex) {
          payload[METRICS_USERS_INDEX_KEY] = Object.entries(metrics.users || {}).map(([key, user])=>({
            key,
            handle: user?.handle || null,
            id: user?.id || null,
            postCount: Object.keys(user?.posts || {}).length
          }));
          knownUserCount = currentUserCount;
          lastUsersIndexWrite = metricsUpdatedAt;
        }
        lastSelfWriteTs = metricsUpdatedAt;
        await chrome.storage.local.set(payload);
        metricsCache = metrics;
        metricsCacheUpdatedAt = metricsUpdatedAt;
        // Schedule cold shard writes if there are buffered snapshots
        if (coldDirtyUsers.size > 0) {
          scheduleColdWrite();
        }
        // Debug: Verify duration is in the metrics we just saved
        if (DEBUG.storage) {
          const sampleUser = Object.values(metrics.users || {})[0];
          if (sampleUser && sampleUser.posts) {
            const postsWithDuration = Object.values(sampleUser.posts).filter(p => p.duration != null);
            dlog('storage', 'flush end', {
              totalPosts: Object.values(metrics.users || {}).reduce((sum, u) => sum + Object.keys(u.posts || {}).length, 0),
              postsWithDuration: postsWithDuration.length
            });
          } else {
            dlog('storage', 'flush end', {});
          }
        }
      } catch (err) {
        try { console.warn('[SoraMetrics] storage.set failed; enable unlimitedStorage or lower snapshot cap', err); } catch {}
      }
    } catch (e) {
      try { console.warn('[SoraMetrics] flush failed', e); } catch {}
    }
  } finally {
    isFlushing = false;
    if (needsFlush) {
      needsFlush = false;
      scheduleFlush();
    }
  }
}

async function flushCold() {
  coldWriteTimer = null;
  if (coldDirtyUsers.size === 0) return;
  // Check purge lock to prevent overwriting dashboard purge
  try {
    const { purgeLock } = await chrome.storage.local.get('purgeLock');
    if (purgeLock && Date.now() - purgeLock < 30000) {
      // Retry after a delay
      coldWriteTimer = setTimeout(flushCold, 2000);
      return;
    }
  } catch {}

  const dirtyKeys = Array.from(coldDirtyUsers);
  coldDirtyUsers.clear();

  try {
    // Read existing cold shards for dirty users
    const storageKeys = dirtyKeys.map(k => COLD_PREFIX + k);
    const existing = await chrome.storage.local.get(storageKeys);
    const writePayload = {};

    for (const userKey of dirtyKeys) {
      const shardKey = COLD_PREFIX + userKey;
      const existingShard = existing[shardKey] || {};
      const buffered = coldSnapshotBuffer.get(userKey);
      if (!buffered) continue;

      for (const [postId, newSnaps] of buffered.entries()) {
        if (!existingShard[postId]) {
          existingShard[postId] = [];
        }
        // Append buffered snapshots (dedup by timestamp)
        const existingTs = new Set(existingShard[postId].map(s => s.t));
        for (const s of newSnaps) {
          if (!existingTs.has(s.t)) {
            existingShard[postId].push(s);
          }
        }
        if (existingShard[postId].length > MAX_SNAPSHOT_HISTORY_PER_POST) {
          existingShard[postId] = existingShard[postId].slice(-MAX_SNAPSHOT_HISTORY_PER_POST);
        }
      }
      writePayload[shardKey] = existingShard;
      coldSnapshotBuffer.delete(userKey);
    }

    if (Object.keys(writePayload).length > 0) {
      await chrome.storage.local.set(writePayload);
      dlog('storage', 'cold flush complete', { shards: Object.keys(writePayload).length });
    }
  } catch (err) {
    // Re-mark as dirty so we retry
    for (const k of dirtyKeys) {
      if (coldSnapshotBuffer.has(k)) coldDirtyUsers.add(k);
    }
    try { console.warn('[SoraMetrics] cold flush failed', err); } catch {}
  }
}

function openHarvestDB() {
  if (harvestDbPromise) return harvestDbPromise;
  harvestDbPromise = new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(HARVEST_DB_NAME, HARVEST_DB_VERSION);
      request.onerror = () => reject(request.error || new Error('Failed to open harvest DB'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(HARVEST_STORE)) {
          const store = db.createObjectStore(HARVEST_STORE, { keyPath: 'recordKey' });
          store.createIndex('last_seen_ts', 'last_seen_ts', { unique: false });
        }
        if (!db.objectStoreNames.contains(HARVEST_META_STORE)) {
          db.createObjectStore(HARVEST_META_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
    } catch (err) {
      reject(err);
    }
  });
  return harvestDbPromise;
}

async function harvestGetMany(recordKeys) {
  if (!Array.isArray(recordKeys) || !recordKeys.length) return [];
  const db = await openHarvestDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HARVEST_STORE, 'readonly');
    const store = tx.objectStore(HARVEST_STORE);
    const out = new Array(recordKeys.length);
    let pending = recordKeys.length;
    for (let i = 0; i < recordKeys.length; i++) {
      const req = store.get(recordKeys[i]);
      req.onsuccess = () => {
        out[i] = req.result || null;
        pending -= 1;
        if (pending === 0) resolve(out);
      };
      req.onerror = () => {
        pending -= 1;
        out[i] = null;
        if (pending === 0) resolve(out);
      };
    }
    tx.onerror = () => reject(tx.error || new Error('harvestGetMany transaction failed'));
  });
}

async function harvestPutMany(records) {
  if (!Array.isArray(records) || !records.length) return;
  const db = await openHarvestDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HARVEST_STORE, 'readwrite');
    const store = tx.objectStore(HARVEST_STORE);
    for (const rec of records) {
      if (!rec || !rec.recordKey) continue;
      store.put(rec);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('harvestPutMany transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('harvestPutMany transaction aborted'));
  });
}

async function harvestCount() {
  const db = await openHarvestDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HARVEST_STORE, 'readonly');
    const req = tx.objectStore(HARVEST_STORE).count();
    req.onsuccess = () => resolve(Number(req.result) || 0);
    req.onerror = () => reject(req.error || new Error('harvest count failed'));
  });
}

async function harvestTrimOldest(maxRecords) {
  const max = Math.max(1, Number(maxRecords) || MAX_HARVEST_RECORDS);
  const currentCount = await harvestCount();
  let toDelete = currentCount - max;
  if (toDelete <= 0) return currentCount;

  const db = await openHarvestDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(HARVEST_STORE, 'readwrite');
    const store = tx.objectStore(HARVEST_STORE);
    const idx = store.index('last_seen_ts');
    const cursorReq = idx.openCursor();
    cursorReq.onsuccess = (ev) => {
      const cursor = ev?.target?.result;
      if (!cursor || toDelete <= 0) return;
      store.delete(cursor.primaryKey);
      toDelete -= 1;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error || new Error('harvest trim cursor failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('harvest trim transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('harvest trim transaction aborted'));
  });
  return harvestCount();
}

async function flushHarvest() {
  harvestFlushTimer = null;
  if (isHarvestFlushing) {
    needsHarvestFlush = true;
    return;
  }
  if (!HARVEST_PENDING.length) return;

  isHarvestFlushing = true;
  try {
    const items = HARVEST_PENDING.splice(0, HARVEST_PENDING.length);
    const mergedIncoming = new Map();
    for (const rec of items) {
      const key = rec.recordKey || `${rec.kind || 'unknown'}:${rec.id || ''}`;
      if (!key) continue;
      const current = mergedIncoming.get(key);
      mergedIncoming.set(key, mergeHarvestRecord(current, rec));
    }
    const keys = Array.from(mergedIncoming.keys());
    if (!keys.length) return;

    const existing = await harvestGetMany(keys);
    const writes = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const merged = mergeHarvestRecord(existing[i], mergedIncoming.get(key));
      if (!merged) continue;
      merged.recordKey = key;
      writes.push(merged);
    }
    if (!writes.length) return;

    await harvestPutMany(writes);
    const count = await harvestTrimOldest(MAX_HARVEST_RECORDS);
    const now = Date.now();
    await chrome.storage.local.set({
      [HARVEST_UPDATED_AT_KEY]: now,
      [HARVEST_STORAGE_VERSION_KEY]: HARVEST_STORAGE_VERSION,
      [HARVEST_STORAGE_KEY]: {
        backend: 'indexeddb',
        db: HARVEST_DB_NAME,
        store: HARVEST_STORE,
        count,
      },
    });
  } catch (err) {
    try { console.warn('[SoraHarvest] flush failed', err); } catch {}
  } finally {
    isHarvestFlushing = false;
    if (needsHarvestFlush) {
      needsHarvestFlush = false;
      scheduleHarvestFlush();
    }
  }
}

function openBackupDB() {
  if (backupDbPromise) return backupDbPromise;
  backupDbPromise = new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION);
      request.onerror = () => reject(request.error || new Error('Failed to open backup DB'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BACKUP_RUNS_STORE)) {
          const runsStore = db.createObjectStore(BACKUP_RUNS_STORE, { keyPath: 'id' });
          runsStore.createIndex('updated_at', 'updated_at', { unique: false });
          runsStore.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains(BACKUP_ITEMS_STORE)) {
          const itemsStore = db.createObjectStore(BACKUP_ITEMS_STORE, { keyPath: 'item_key' });
          itemsStore.createIndex('run_id', 'run_id', { unique: false });
          itemsStore.createIndex('run_id_order', ['run_id', 'order'], { unique: false });
          itemsStore.createIndex('download_id', 'download_id', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
    } catch (err) {
      reject(err);
    }
  });
  return backupDbPromise;
}

async function backupDbGet(storeName, key) {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error(`backup get failed for ${storeName}`));
  });
}

async function backupDbPut(storeName, value) {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error(`backup put failed for ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`backup put aborted for ${storeName}`));
  });
}

async function backupDbPutMany(storeName, values) {
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!items.length) return;
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const value of items) store.put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`backup putMany failed for ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`backup putMany aborted for ${storeName}`));
  });
}

async function backupDbGetAllRuns() {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_RUNS_STORE, 'readonly');
    const req = tx.objectStore(BACKUP_RUNS_STORE).getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error || new Error('backup getAll runs failed'));
  });
}

async function backupDbGetLatestRun() {
  const runs = await backupDbGetAllRuns();
  if (!runs.length) return null;
  return runs
    .slice()
    .sort((left, right) => (Number(right.updated_at) || 0) - (Number(left.updated_at) || 0))[0] || null;
}

async function backupDbGetRunItems(runId) {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_ITEMS_STORE, 'readonly');
    const idx = tx.objectStore(BACKUP_ITEMS_STORE).index('run_id');
    const req = idx.getAll(IDBKeyRange.only(String(runId || '')));
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error || new Error('backup get run items failed'));
  });
}

async function backupDbGetItemByDownloadId(downloadId) {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_ITEMS_STORE, 'readonly');
    const idx = tx.objectStore(BACKUP_ITEMS_STORE).index('download_id');
    const req = idx.getAll(IDBKeyRange.only(Number(downloadId) || 0));
    req.onsuccess = () => {
      const out = Array.isArray(req.result) ? req.result : [];
      resolve(out[0] || null);
    };
    req.onerror = () => reject(req.error || new Error('backup get by download id failed'));
  });
}

function cloneBackupBucketCounts(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    ownDrafts: Number(source.ownDrafts) || 0,
    ownPosts: Number(source.ownPosts) || 0,
    castInPosts: Number(source.castInPosts) || 0,
    castInDrafts: Number(source.castInDrafts) || 0,
  };
}

function summarizeBackupRunForClient(run) {
  if (!isPlainObject(run)) return null;
  return {
    id: run.id || '',
    status: normalizeRunStatus(run.status),
    scopes: normalizeBackupScopes(run.scopes),
    counts: cloneBackupCounts(run.counts),
    bucket_counts: cloneBackupBucketCounts(run.bucket_counts),
    current_user: normalizeCurrentUser(run.current_user),
    run_stamp: sanitizeString(run.run_stamp, 64) || '',
    created_at: Number(run.created_at) || 0,
    updated_at: Number(run.updated_at) || 0,
    started_at: Number(run.started_at) || 0,
    completed_at: Number(run.completed_at) || 0,
    paused_at: Number(run.paused_at) || 0,
    cancelled_at: Number(run.cancelled_at) || 0,
    active_item_key: sanitizeString(run.active_item_key, 256) || '',
    last_error: sanitizeString(run.last_error, 1024) || '',
    summary_text: sanitizeString(run.summary_text, 1024) || '',
    baseline_manifest: cloneBackupBaselineManifestSummary(run.baseline_manifest),
  };
}

async function sendBackupPageFetchToTab(tabId, payload) {
  const numericTabId = Number(tabId) || 0;
  if (!numericTabId) return { ok: false, status: 0, error: 'backup_page_fetch_missing_tab' };
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(
        numericTabId,
        { action: 'backup_page_fetch', payload },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              status: 0,
              error: sanitizeString(chrome.runtime.lastError.message, 512) || 'backup_page_fetch_runtime_error',
            });
            return;
          }
          resolve(response || { ok: false, status: 0, error: 'backup_page_fetch_empty' });
        }
      );
    } catch (err) {
      resolve({
        ok: false,
        status: 0,
        error: sanitizeString(err?.message || String(err), 512) || 'backup_page_fetch_send_failed',
      });
    }
  });
}

async function getBackupFetchTabIds(preferredTabId) {
  const preferred = Number(preferredTabId) || 0;
  const ordered = [];
  if (preferred > 0) ordered.push(preferred);
  try {
    const tabs = await chrome.tabs.query({ url: `${BACKUP_ORIGIN}/*` });
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      const tabId = Number(tab?.id) || 0;
      if (!tabId || ordered.includes(tabId)) continue;
      ordered.push(tabId);
    }
  } catch {}
  return ordered;
}

async function performBackupPageFetch(run, pathname, params = {}, overrideHeaders = {}) {
  const payload = {
    pathname,
    params,
    headers: buildBackupHeaders(run, overrideHeaders),
  };
  const tabIds = await getBackupFetchTabIds(run?.page_tab_id);
  let lastResponse = { ok: false, status: 0, error: 'backup_page_fetch_unavailable' };
  for (const tabId of tabIds) {
    const response = await sendBackupPageFetchToTab(tabId, payload);
    lastResponse = response || lastResponse;
    if ((response?.ok === true) || Number(response?.status) > 0) {
      if (Number(tabId) > 0 && Number(run?.page_tab_id) !== Number(tabId)) {
        run = await syncBackupRunPageTabId(run, tabId);
      }
      return response;
    }
  }
  return lastResponse;
}

async function broadcastBackupRunEvent(event) {
  try {
    const tabs = await chrome.tabs.query({ url: `${BACKUP_ORIGIN}/*` });
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      if (tab?.id == null) continue;
      try {
        chrome.tabs.sendMessage(tab.id, { action: 'backup_run_event', event });
      } catch {}
    }
  } catch {}
}

async function saveBackupRun(run, eventType = 'status') {
  return enqueueBackupRunSave(run?.id, async () => {
    const existing = run?.id ? await backupDbGet(BACKUP_RUNS_STORE, run.id).catch(() => null) : null;
    const rawIncomingInterrupt = (
      run &&
      typeof run === 'object' &&
      Object.prototype.hasOwnProperty.call(run, 'interrupt_status') &&
      typeof run.interrupt_status === 'string'
    ) ? run.interrupt_status.trim().toLowerCase() : null;
    const incomingInterrupt = normalizeRunStatus(rawIncomingInterrupt);
    const wantsInterruptClear = rawIncomingInterrupt === '' && normalizeRunStatus(run?.status) === 'running';
    const hasIncomingInterrupt = !!(
      run &&
      typeof run === 'object' &&
      Object.prototype.hasOwnProperty.call(run, 'interrupt_status') &&
      (
        incomingInterrupt === 'paused' ||
        incomingInterrupt === 'cancelled' ||
        wantsInterruptClear
      )
    );
    const existingInterrupt = normalizeRunStatus(existing?.interrupt_status);
    const liveInterrupt = normalizeRunStatus(backupRunInterrupts.get(String(run?.id || '')) || '');
    const effectiveInterrupt = hasIncomingInterrupt
      ? ((incomingInterrupt === 'paused' || incomingInterrupt === 'cancelled') ? incomingInterrupt : '')
      : (
        (liveInterrupt === 'paused' || liveInterrupt === 'cancelled')
          ? liveInterrupt
          : ((existingInterrupt === 'paused' || existingInterrupt === 'cancelled') ? existingInterrupt : '')
      );

    const next = {
      ...(existing || {}),
      ...run,
      status: normalizeRunStatus(run.status),
      interrupt_status: effectiveInterrupt,
      counts: cloneBackupCounts(run.counts),
      bucket_counts: cloneBackupBucketCounts(run.bucket_counts),
      updated_at: Date.now(),
    };
    const baselineManifest = cloneBackupBaselineManifestSummary(next.baseline_manifest);
    if (baselineManifest) next.baseline_manifest = baselineManifest;
    else delete next.baseline_manifest;

    if (!hasIncomingInterrupt && (effectiveInterrupt === 'paused' || effectiveInterrupt === 'cancelled')) {
      next.status = effectiveInterrupt;
      if (effectiveInterrupt === 'paused') {
        next.paused_at = Number(existing?.paused_at) || Number(run?.paused_at) || Date.now();
        next.summary_text = (existingInterrupt === 'paused' ? sanitizeString(existing?.summary_text, 1024) : null) || 'Paused.';
      } else {
        next.cancelled_at = Number(existing?.cancelled_at) || Number(run?.cancelled_at) || Date.now();
        next.active_download_id = 0;
        next.active_item_key = '';
        next.summary_text = (existingInterrupt === 'cancelled' ? sanitizeString(existing?.summary_text, 1024) : null) || 'Backup cancelled.';
      }
    }

    await backupDbPut(BACKUP_RUNS_STORE, next);
    await broadcastBackupRunEvent({ type: eventType, run: summarizeBackupRunForClient(next) });
    return next;
  });
}

function enqueueBackupRunSave(runId, task) {
  const key = String(runId || '');
  const previous = backupRunSaveQueues.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => task());
  backupRunSaveQueues.set(key, current);
  current.finally(() => {
    if (backupRunSaveQueues.get(key) === current) {
      backupRunSaveQueues.delete(key);
    }
  });
  return current;
}

async function syncBackupRunPageTabId(run, tabId) {
  const nextTabId = Number(tabId) || 0;
  if (!run?.id || !nextTabId) return run;
  const latest = await backupDbGet(BACKUP_RUNS_STORE, run.id).catch(() => null);
  if (!latest) return run;
  const next = await saveBackupRun({
    ...latest,
    page_tab_id: nextTabId,
  }, 'status');
  if (next) {
    run.page_tab_id = Number(next.page_tab_id) || nextTabId;
    run.status = next.status;
    run.interrupt_status = next.interrupt_status;
    run.cancelled_at = Number(next.cancelled_at) || 0;
    run.paused_at = Number(next.paused_at) || 0;
    run.summary_text = next.summary_text || run.summary_text || '';
  }
  return next || run;
}

function buildBackupHeaders(run, overrideHeaders = {}) {
  const headers = {
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
    ...normalizeBackupHeaders(run?.headers),
    ...normalizeBackupHeaders(overrideHeaders),
  };
  if (!headers.Authorization) throw new Error('backup_missing_auth_header');
  return headers;
}

function buildBackupUrl(pathname, params = {}) {
  const url = new URL(pathname, BACKUP_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseRetryAfterMs(value) {
  const raw = sanitizeString(value, 128);
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0, Math.floor(seconds * 1000));
  const dateMs = parseTimestampMs(raw);
  if (!dateMs) return 0;
  return Math.max(0, dateMs - Date.now());
}

function shouldRetryBackupStatus(status) {
  const numeric = Number(status) || 0;
  return numeric === 408 || numeric === 425 || numeric === 429 || numeric === 500 || numeric === 502 || numeric === 503 || numeric === 504;
}

function getBackupRetryDelayMs(response, attempt) {
  const retryAfterMs = parseRetryAfterMs(response?.headers?.get?.('Retry-After'));
  if (retryAfterMs > 0) return Math.min(BACKUP_FETCH_RETRY_MAX_MS, retryAfterMs);
  const backoffMs = BACKUP_FETCH_RETRY_BASE_MS * Math.pow(2, Math.max(0, Number(attempt) - 1));
  const jitterMs = Math.floor(Math.random() * 350);
  return Math.min(BACKUP_FETCH_RETRY_MAX_MS, backoffMs + jitterMs);
}

async function backupFetchJson(run, pathname, params = {}, overrideHeaders = {}, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || BACKUP_FETCH_MAX_ATTEMPTS);
  let lastStatus = 0;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await performBackupPageFetch(run, pathname, params, overrideHeaders);
    if (response?.ok) return response.json || {};
    lastStatus = Number(response?.status) || 0;
    lastError = sanitizeString(response?.error, 512) || '';
    if (attempt >= maxAttempts || !shouldRetryBackupStatus(lastStatus)) break;
    await waitMs(getBackupRetryDelayMs({ headers: { get: () => null } }, attempt));
  }
  if (lastStatus > 0) throw new Error(`backup_http_${lastStatus}`);
  throw new Error(lastError || 'backup_page_fetch_failed');
}

function extractItemsFromPayload(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.drafts)) return payload.drafts;
  if (Array.isArray(payload?.data?.drafts)) return payload.data.drafts;
  return [];
}

function extractCursorFromPayload(payload) {
  const cursor = payload?.next_cursor ?? payload?.cursor ?? payload?.data?.next_cursor ?? payload?.data?.cursor ?? null;
  return cursor == null || cursor === '' ? null : String(cursor);
}

function getBackupItemId(kind, item) {
  if (!isPlainObject(item)) return '';
  if (String(kind) === 'draft') {
    return sanitizeIdToken(item.id || item.generation_id || item.draft_id) || '';
  }
  const post = item.post && typeof item.post === 'object' ? item.post : item;
  return sanitizeIdToken(post.id || item.id || post.post_id) || '';
}

function pickPrompt(detail, item) {
  const detailPost = detail?.post && typeof detail.post === 'object' ? detail.post : detail;
  const listPost = item?.post && typeof item.post === 'object' ? item.post : item;
  const values = [
    detailPost?.creation_config?.prompt,
    detailPost?.prompt,
    detailPost?.caption,
    detailPost?.text,
    detail?.creation_config?.prompt,
    item?.creation_config?.prompt,
    listPost?.prompt,
    listPost?.caption,
    listPost?.text,
    item?.prompt,
  ];
  for (const value of values) {
    const next = sanitizeString(value, 4096);
    if (next) return next;
  }
  return '';
}

function pickPromptSource(detail, item) {
  const detailPost = detail?.post && typeof detail.post === 'object' ? detail.post : detail;
  if (sanitizeString(detailPost?.creation_config?.prompt, 4096)) return 'creation_config';
  if (sanitizeString(detailPost?.prompt, 4096)) return 'detail';
  if (sanitizeString(detailPost?.caption, 4096) || sanitizeString(detailPost?.text, 4096)) return 'inline';
  const listPost = item?.post && typeof item.post === 'object' ? item.post : item;
  if (sanitizeString(item?.creation_config?.prompt, 4096)) return 'creation_config';
  if (sanitizeString(listPost?.caption, 4096) || sanitizeString(listPost?.text, 4096) || sanitizeString(item?.prompt, 4096)) return 'inline';
  return '';
}

function pickTitle(detail, item) {
  const detailPost = detail?.post && typeof detail.post === 'object' ? detail.post : detail;
  const listPost = item?.post && typeof item.post === 'object' ? item.post : item;
  return (
    sanitizeString(detailPost?.title, 512) ||
    sanitizeString(detail?.title, 512) ||
    sanitizeString(listPost?.title, 512) ||
    sanitizeString(item?.title, 512) ||
    ''
  );
}

function collectBackupCastNames(detail, item) {
  const candidates = [];
  const pushAll = (values) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (candidates.length >= MAX_HARVEST_CAST_NAMES) break;
      const next = sanitizeString(typeof value === 'string' ? value : (value?.username || value?.handle || value?.name), 80);
      if (!next || candidates.includes(next)) continue;
      candidates.push(next);
    }
  };
  const detailPost = detail?.post && typeof detail.post === 'object' ? detail.post : detail;
  const listPost = item?.post && typeof item.post === 'object' ? item.post : item;
  pushAll(detailPost?.cameo_usernames);
  pushAll(detail?.cameos);
  pushAll(detail?.cameo_profiles);
  pushAll(listPost?.cameo_usernames);
  pushAll(item?.cameos);
  pushAll(item?.cameo_profiles);
  return candidates;
}

function resolveBackupDimensionsAndDuration(kind, detail, item) {
  const root = detail?.post && typeof detail.post === 'object'
    ? detail.post
    : (detail?.draft && typeof detail.draft === 'object' ? detail.draft : detail);
  const fallback = item?.post && typeof item.post === 'object' ? item.post : item;
  const cfg = root?.creation_config && typeof root.creation_config === 'object'
    ? root.creation_config
    : (fallback?.creation_config && typeof fallback.creation_config === 'object' ? fallback.creation_config : {});
  const attachment = Array.isArray(root?.attachments) && root.attachments.length
    ? root.attachments[0]
    : (Array.isArray(fallback?.attachments) && fallback.attachments.length ? fallback.attachments[0] : null);
  const width = sanitizeNumber(cfg.width ?? root?.width ?? attachment?.width ?? fallback?.width, 1, 20000);
  const height = sanitizeNumber(cfg.height ?? root?.height ?? attachment?.height ?? fallback?.height, 1, 20000);
  let duration = sanitizeNumber(root?.duration_s ?? detail?.duration_s ?? fallback?.duration_s, 0, 60 * 60 * 10);
  if (duration == null) {
    const fps = sanitizeNumber(cfg.fps ?? root?.fps ?? fallback?.fps, 1, 120) || 30;
    const nFrames = sanitizeNumber(
      cfg.n_frames ??
      root?.n_frames ??
      root?.video_metadata?.n_frames ??
      attachment?.n_frames ??
      fallback?.n_frames,
      1,
      1000000
    );
    if (nFrames != null && fps > 0) duration = nFrames / fps;
  }
  return {
    width: width != null ? width : null,
    height: height != null ? height : null,
    duration_s: duration != null ? duration : null,
  };
}

function buildBackupFilename(run, bucket, id, ext) {
  const safeExt = sanitizeString(ext, 16) || 'mp4';
  return `${BACKUP_DOWNLOAD_FOLDER}/${run.run_stamp}/${bucket}/${id}.${safeExt}`;
}

function buildBackupDetailPath(kind, id) {
  if (kind === 'draft') return `/backend/project_y/profile/drafts/v2/${encodeURIComponent(id)}`;
  return `/backend/project_y/post/${encodeURIComponent(id)}`;
}

function buildBackupPermalink(kind, id) {
  return kind === 'draft'
    ? `${BACKUP_ORIGIN}/d/${encodeURIComponent(id)}`
    : `${BACKUP_ORIGIN}/p/${encodeURIComponent(id)}`;
}

function createBackupBaselineLookup(baselineManifest) {
  const out = new Set();
  const source = Array.isArray(baselineManifest?.keys) ? baselineManifest.keys : [];
  for (const entry of source) {
    const key = sanitizeBackupComparisonKey(entry);
    if (key) out.add(key);
  }
  return out;
}

function maybeMarkBackupItemAlreadyBackedUp(run, item, baselineLookup) {
  if (!item || !(baselineLookup instanceof Set) || !baselineLookup.size) return item;
  const comparisonKey = buildBackupComparisonKey(item.kind, item.id);
  if (!comparisonKey || !baselineLookup.has(comparisonKey)) return item;
  const summary = cloneBackupBaselineManifestSummary(run?.baseline_manifest) || {
    filename: '',
    total_rows: 0,
    backed_up_rows: 0,
    matched_rows: 0,
  };
  summary.matched_rows = (Number(summary.matched_rows) || 0) + 1;
  run.baseline_manifest = summary;
  return {
    ...item,
    status: 'skipped',
    skip_reason: 'already_backed_up',
  };
}

function shouldStopBucketDiscoveryAfterItem(bucket, item, baselineLookup) {
  if (!bucket?.stop_on_baseline_match) return false;
  if (!(baselineLookup instanceof Set) || !baselineLookup.size) return false;
  return normalizeItemStatus(item?.status) === 'skipped' &&
    String(item?.skip_reason || '').trim().toLowerCase() === 'already_backed_up';
}

function formatBackupDiscoveryProgressSummary(bucketKey, page, run) {
  const matched = Number(run?.baseline_manifest?.matched_rows) || 0;
  return matched > 0
    ? `Discovering ${bucketKey}: page ${page}, accepted ${run?.counts?.discovered || 0}, already backed up ${matched}`
    : `Discovering ${bucketKey}: page ${page}, accepted ${run?.counts?.discovered || 0}`;
}

function formatBackupDiscoveryCompleteSummary(run) {
  const queued = Number(run?.counts?.queued) || 0;
  const matched = Number(run?.baseline_manifest?.matched_rows) || 0;
  if (queued > 0) {
    return matched > 0
      ? `Discovery complete. ${queued} files queued. ${matched} already backed up.`
      : `Discovery complete. ${queued} files queued.`;
  }
  if (matched > 0) return `Discovery complete. ${matched} already backed up. Nothing new to download.`;
  return 'Discovery complete. No downloadable media found.';
}

function formatBackupCompletionSummary(run) {
  const base = `Backup complete. ${run?.counts?.done || 0} downloaded, ${run?.counts?.failed || 0} failed, ${run?.counts?.skipped || 0} skipped.`;
  const matched = Number(run?.baseline_manifest?.matched_rows) || 0;
  return matched > 0 ? `${base} ${matched} already backed up.` : base;
}

function buildBackupManifestItem(run, bucket, kind, listItem, detail, order) {
  const id = getBackupItemId(kind, detail) || getBackupItemId(kind, listItem);
  if (!id) return null;
  const owner = extractOwnerIdentity(detail || listItem);
  const prompt = pickPrompt(detail, listItem);
  const promptSource = pickPromptSource(detail, listItem);
  const title = pickTitle(detail, listItem);
  const createdAt = detail?.created_at ?? detail?.post?.created_at ?? listItem?.created_at ?? listItem?.post?.created_at ?? null;
  const postedAt = detail?.posted_at ?? detail?.post?.posted_at ?? listItem?.posted_at ?? listItem?.post?.posted_at ?? null;
  const updatedAt = detail?.updated_at ?? detail?.post?.updated_at ?? listItem?.updated_at ?? listItem?.post?.updated_at ?? null;
  const dims = resolveBackupDimensionsAndDuration(kind, detail, listItem);
  const castNames = collectBackupCastNames(detail, listItem);
  const media = pickBackupMediaSource(kind, detail || listItem);
  const itemKey = makeBackupItemKey(run.id, kind, id);
  const nextStatus = 'queued';
  const mediaExt = media?.ext || 'mp4';
  return {
    item_key: itemKey,
    run_id: run.id,
    order: Number.isFinite(Number(order)) ? Math.floor(Number(order)) : 0,
    bucket,
    kind,
    id,
    status: nextStatus,
    attempts: 0,
    download_id: 0,
    owner_handle: owner.handle || '',
    owner_id: owner.id || '',
    prompt,
    prompt_source: promptSource,
    title,
    created_at: typeof createdAt === 'string' ? createdAt : (createdAt ?? null),
    posted_at: typeof postedAt === 'string' ? postedAt : (postedAt ?? null),
    updated_at: typeof updatedAt === 'string' ? updatedAt : (updatedAt ?? null),
    width: dims.width,
    height: dims.height,
    duration_s: dims.duration_s,
    cast_names: castNames,
    cameos: castNames,
    detail_url: `${BACKUP_ORIGIN}${buildBackupDetailPath(kind, id)}`,
    post_permalink: buildBackupPermalink(kind, id),
    media_url: media?.url || '',
    media_variant: media?.variant || '',
    media_ext: mediaExt,
    media_key_path: media?.keyPath || '',
    filename: buildBackupFilename(run, bucket, id, mediaExt),
    url_refreshed_at: media?.url ? Date.now() : 0,
    last_error: '',
    skip_reason: '',
  };
}

function hasResolvedBackupOwner(raw) {
  const owner = normalizeCurrentUser(raw);
  return !!(owner.handle || owner.id);
}

function shouldFetchDiscoveryDetail(bucket, owner) {
  if (!bucket || !bucket.key) return false;
  if (bucket.key === 'castInDrafts') return !hasResolvedBackupOwner(owner);
  if (bucket.key === 'castInPosts') return !hasResolvedBackupOwner(owner);
  return false;
}

function createBackupRunRecord(scopes, headers, pageTabId = 0, baselineManifest = null) {
  const createdAt = Date.now();
  const run = {
    id: buildBackupRunId(createdAt),
    status: 'discovering',
    interrupt_status: '',
    scopes: normalizeBackupScopes(scopes),
    headers: normalizeBackupHeaders(headers),
    counts: createEmptyBackupCounts(),
    bucket_counts: cloneBackupBucketCounts(),
    created_at: createdAt,
    updated_at: createdAt,
    started_at: createdAt,
    completed_at: 0,
    paused_at: 0,
    cancelled_at: 0,
    current_user: { handle: '', id: '' },
    run_stamp: buildBackupRunStamp(createdAt),
    page_tab_id: Number(pageTabId) || 0,
    active_download_id: 0,
    active_item_key: '',
    last_error: '',
    summary_text: 'Starting discovery…',
  };
  const baselineSummary = cloneBackupBaselineManifestSummary(baselineManifest);
  if (baselineSummary) run.baseline_manifest = baselineSummary;
  return run;
}

async function resolveCurrentBackupUser(run, cachedOwnPostsPage = null) {
  try {
    const json = await backupFetchJson(run, '/backend/project_y/v2/me');
    const user = normalizeCurrentUser(json);
    if (user.handle || user.id) return user;
  } catch {}
  const items = extractItemsFromPayload(cachedOwnPostsPage);
  if (items.length) {
    const owner = extractOwnerIdentity(items[0]);
    if (owner.handle || owner.id) return owner;
  }
  return { handle: '', id: '' };
}

async function fetchBackupDetail(run, kind, id) {
  const pathname = buildBackupDetailPath(kind, id);
  return backupFetchJson(run, pathname);
}

async function updateBackupRunStatus(runId, updater, eventType = 'status') {
  const run = await backupDbGet(BACKUP_RUNS_STORE, runId);
  if (!run) return null;
  const next = typeof updater === 'function' ? updater({ ...run }) : { ...run, ...(updater || {}) };
  return saveBackupRun(next, eventType);
}

async function transitionBackupItem(run, item, nextStatus, overrides = {}, eventType = 'status') {
  const prevStatus = normalizeItemStatus(item.status);
  const targetStatus = normalizeItemStatus(nextStatus);
  const nextItem = {
    ...item,
    ...overrides,
    status: targetStatus,
  };
  await backupDbPut(BACKUP_ITEMS_STORE, nextItem);
  const nextRun = await updateBackupRunStatus(run.id, (draft) => {
    draft.counts = applyBackupStatusTransition(draft.counts, prevStatus, targetStatus);
    if (targetStatus === 'downloading') draft.active_item_key = nextItem.item_key;
    if (targetStatus === 'done' || targetStatus === 'failed' || targetStatus === 'skipped') {
      draft.active_item_key = draft.active_item_key === nextItem.item_key ? '' : draft.active_item_key;
    }
    if (targetStatus === 'failed' && nextItem.last_error) draft.last_error = nextItem.last_error;
    return draft;
  }, eventType);
  return { run: nextRun, item: nextItem };
}

function shouldInterruptBackupDiscovery(run) {
  const status = normalizeRunStatus(run?.status);
  return status === 'paused' || status === 'cancelled' || isTerminalRunStatus(status);
}

function getBackupRunInterruptStatus(runId) {
  return normalizeRunStatus(backupRunInterrupts.get(String(runId || '')) || '');
}

function markBackupRunInterrupted(runId, status) {
  const normalized = normalizeRunStatus(status);
  if (normalized === 'paused' || normalized === 'cancelled') {
    backupRunInterrupts.set(String(runId || ''), normalized);
  } else {
    backupRunInterrupts.delete(String(runId || ''));
  }
}

function isBackupRunInterrupted(runId) {
  const status = getBackupRunInterruptStatus(runId);
  return status === 'paused' || status === 'cancelled';
}

async function saveBackupDiscoveryProgress(run, eventType = 'status') {
  if (isBackupRunInterrupted(run.id)) {
    return (await backupDbGet(BACKUP_RUNS_STORE, run.id)) || run;
  }
  const next = await updateBackupRunStatus(run.id, (draft) => {
    if (isBackupRunInterrupted(run.id)) return draft;
    if (shouldInterruptBackupDiscovery(draft)) return draft;
    return {
      ...draft,
      status: normalizeRunStatus(run.status),
      counts: cloneBackupCounts(run.counts),
      bucket_counts: cloneBackupBucketCounts(run.bucket_counts),
      current_user: normalizeCurrentUser(run.current_user),
      completed_at: Number(run.completed_at) || 0,
      baseline_manifest: cloneBackupBaselineManifestSummary(run.baseline_manifest),
      last_error: sanitizeString(run.last_error, 1024) || '',
      summary_text: sanitizeString(run.summary_text, 1024) || '',
    };
  }, eventType);
  return next || run;
}

function getSelectedBackupBuckets(scopes) {
  const normalized = normalizeBackupScopes(scopes);
  const buckets = [];
  if (normalized.ownDrafts) buckets.push({ key: 'ownDrafts', kind: 'draft', pathname: '/backend/project_y/profile/drafts/v2', limit: BACKUP_DEFAULT_DRAFT_LIMIT, stop_on_baseline_match: true });
  if (normalized.ownPosts) buckets.push({ key: 'ownPosts', kind: 'published', pathname: '/backend/project_y/profile_feed/me', limit: BACKUP_DEFAULT_FEED_LIMIT, extraParams: { cut: 'nf2' }, stop_on_baseline_match: true });
  if (normalized.castInPosts) buckets.push({ key: 'castInPosts', kind: 'published', pathname: '/backend/project_y/profile_feed/me', limit: BACKUP_DEFAULT_FEED_LIMIT, extraParams: { cut: 'appearances' }, stop_on_baseline_match: true });
  if (normalized.castInDrafts) buckets.push({ key: 'castInDrafts', kind: 'draft', pathname: '/backend/project_y/profile/drafts/cameos', limit: BACKUP_DEFAULT_DRAFT_LIMIT, stop_on_baseline_match: true });
  return buckets;
}

async function discoverBackupRun(run, baselineLookup = null) {
  const buckets = getSelectedBackupBuckets(run.scopes);
  const seenKeys = new Set();
  let order = 0;
  let ownPostsFirstPage = null;

  for (const bucket of buckets) {
    if (isBackupRunInterrupted(run.id)) return (await backupDbGet(BACKUP_RUNS_STORE, run.id)) || run;
    run.summary_text = `Discovering ${bucket.key}…`;
    run = await saveBackupDiscoveryProgress(run, 'status');
    if (shouldInterruptBackupDiscovery(run)) return run;
    let cursor = null;
    let page = 0;
    let stopBucketDiscovery = false;
    do {
      if (isBackupRunInterrupted(run.id)) return (await backupDbGet(BACKUP_RUNS_STORE, run.id)) || run;
      const latest = await backupDbGet(BACKUP_RUNS_STORE, run.id);
      if (shouldInterruptBackupDiscovery(latest)) return latest;
      const params = { limit: bucket.limit, cursor, ...(bucket.extraParams || {}) };
      const json = await backupFetchJson(run, bucket.pathname, params);
      if (!ownPostsFirstPage && bucket.key === 'ownPosts') ownPostsFirstPage = json;
      if (!(run.current_user?.handle || run.current_user?.id)) {
        run.current_user = await resolveCurrentBackupUser(run, ownPostsFirstPage);
        run = await saveBackupDiscoveryProgress(run, 'status');
        if (shouldInterruptBackupDiscovery(run)) return run;
      }
      const items = extractItemsFromPayload(json);
      for (const item of items) {
        if (isBackupRunInterrupted(run.id)) return (await backupDbGet(BACKUP_RUNS_STORE, run.id)) || run;
        const latestRun = await backupDbGet(BACKUP_RUNS_STORE, run.id);
        if (shouldInterruptBackupDiscovery(latestRun)) return latestRun;
        const id = getBackupItemId(bucket.kind, item);
        if (!id) continue;
        const dedupeKey = `${bucket.kind}:${id}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        let detail = null;
        let owner = extractOwnerIdentity(item);
        if (shouldFetchDiscoveryDetail(bucket, owner)) {
          detail = await fetchBackupDetail(run, bucket.kind, id);
          owner = extractOwnerIdentity(detail || item);
        }
        if ((bucket.key === 'castInPosts' || bucket.key === 'castInDrafts') && shouldExcludeAppearanceOwner(owner, run.current_user)) {
          continue;
        }
        let backupItem = buildBackupManifestItem(run, bucket.key, bucket.kind, item, detail, order);
        if (!backupItem) continue;
        backupItem = maybeMarkBackupItemAlreadyBackedUp(run, backupItem, baselineLookup);
        await backupDbPut(BACKUP_ITEMS_STORE, backupItem);
        run.counts.discovered += 1;
        run.bucket_counts[bucket.key] = (Number(run.bucket_counts[bucket.key]) || 0) + 1;
        run.counts = applyBackupStatusTransition(run.counts, null, backupItem.status);
        order += 1;
        if (backupItem.status === 'skipped' && backupItem.last_error) run.last_error = backupItem.last_error;
        if (shouldStopBucketDiscoveryAfterItem(bucket, backupItem, baselineLookup)) {
          stopBucketDiscovery = true;
          break;
        }
      }
      page += 1;
      run.summary_text = formatBackupDiscoveryProgressSummary(bucket.key, page, run);
      run = await saveBackupDiscoveryProgress(run, 'status');
      if (shouldInterruptBackupDiscovery(run)) return run;
      const nextCursor = extractCursorFromPayload(json);
      cursor = !stopBucketDiscovery && nextCursor && items.length ? nextCursor : null;
    } while (cursor);
  }

  run.status = run.counts.queued > 0 ? 'running' : 'completed';
  run.summary_text = formatBackupDiscoveryCompleteSummary(run);
  if (run.status === 'completed') run.completed_at = Date.now();
  return saveBackupDiscoveryProgress(run, 'status');
}

async function refreshBackupItemMedia(run, item) {
  if (!item?.detail_url) return item;
  const freshEnough = item.media_url &&
    isSignedUrlFresh(item.media_url, item.url_refreshed_at || 0, Date.now()) &&
    ((Date.now() - Number(item.url_refreshed_at || 0)) < BACKUP_URL_REFRESH_MAX_AGE_MS);
  if (freshEnough) return item;

  const detailPath = item.detail_url.startsWith(BACKUP_ORIGIN)
    ? item.detail_url.slice(BACKUP_ORIGIN.length)
    : item.detail_url;
  const detail = await backupFetchJson(run, detailPath);
  const media = pickBackupMediaSource(item.kind, detail);
  if (!media?.url) {
    const failed = {
      ...item,
      media_url: '',
      media_variant: '',
      media_ext: 'mp4',
      url_refreshed_at: 0,
      last_error: 'refresh_missing_media_url',
    };
    await backupDbPut(BACKUP_ITEMS_STORE, failed);
    return failed;
  }
  const next = {
    ...item,
    owner_handle: item.owner_handle || extractOwnerIdentity(detail).handle || '',
    owner_id: item.owner_id || extractOwnerIdentity(detail).id || '',
    prompt: item.prompt || pickPrompt(detail, null),
    prompt_source: item.prompt_source || pickPromptSource(detail, null),
    title: item.title || pickTitle(detail, null),
    media_url: media.url,
    media_variant: media.variant,
    media_ext: media.ext || inferFileExtension(media.url, media.mimeType),
    media_key_path: media.keyPath || '',
    filename: buildBackupFilename(run, item.bucket, item.id, media.ext || 'mp4'),
    url_refreshed_at: Date.now(),
    last_error: '',
  };
  await backupDbPut(BACKUP_ITEMS_STORE, next);
  return next;
}

async function finalizeBackupRunIfIdle(runId) {
  const run = await backupDbGet(BACKUP_RUNS_STORE, runId);
  if (!run) return null;
  if (normalizeRunStatus(run.status) === 'paused' || normalizeRunStatus(run.status) === 'cancelled') return run;
  const items = await backupDbGetRunItems(runId);
  const hasQueued = items.some((item) => normalizeItemStatus(item.status) === 'queued');
  const hasDownloading = items.some((item) => normalizeItemStatus(item.status) === 'downloading');
  if (hasQueued || hasDownloading) return run;
  run.status = 'completed';
  run.completed_at = Date.now();
  run.active_download_id = 0;
  run.active_item_key = '';
  run.summary_text = formatBackupCompletionSummary(run);
  return saveBackupRun(run, 'status');
}

async function processNextBackupQueue(runId) {
  const run = await backupDbGet(BACKUP_RUNS_STORE, runId);
  if (!run) return null;
  const status = normalizeRunStatus(run.status);
  if (status === 'paused' || status === 'cancelled' || isTerminalRunStatus(status)) return run;
  if (Number(run.active_download_id) > 0) return run;
  const items = await backupDbGetRunItems(runId);
  const nextItem = items
    .filter((item) => normalizeItemStatus(item.status) === 'queued')
    .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0))[0] || null;
  if (!nextItem) return finalizeBackupRunIfIdle(runId);

  let item = await refreshBackupItemMedia(run, nextItem);
  if (!item.media_url) {
    await transitionBackupItem(run, item, 'failed', { last_error: item.last_error || 'missing_media_url' }, 'item');
    return processNextBackupQueue(runId);
  }

  const target = await transitionBackupItem(run, item, 'downloading', {
    attempts: (Number(item.attempts) || 0) + 1,
    last_error: '',
  }, 'item');
  item = target.item;
  const updatedRun = target.run;

  try {
    const downloadId = await chrome.downloads.download({
      url: item.media_url,
      filename: item.filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    item = {
      ...item,
      download_id: Number(downloadId) || 0,
    };
    await backupDbPut(BACKUP_ITEMS_STORE, item);
    updatedRun.active_download_id = Number(downloadId) || 0;
    updatedRun.active_item_key = item.item_key;
    updatedRun.summary_text = `Downloading ${item.id}…`;
    await saveBackupRun(updatedRun, 'status');
    return updatedRun;
  } catch (err) {
    const message = sanitizeString(err?.message || String(err), 1024) || 'download_start_failed';
    await transitionBackupItem(updatedRun, item, 'failed', { download_id: 0, last_error: message }, 'item');
    return processNextBackupQueue(runId);
  }
}

function queueBackupRunProcessing(runId) {
  if (backupRunLoopPromise) return backupRunLoopPromise;
  backupRunLoopPromise = (async () => {
    try {
      return await processNextBackupQueue(runId);
    } finally {
      backupRunLoopPromise = null;
    }
  })();
  return backupRunLoopPromise;
}

async function handleBackupStart(payload, pageTabId = 0) {
  const latest = await backupDbGetLatestRun();
  if (latest && !isTerminalRunStatus(latest.status)) {
    return { ok: false, error: 'backup_run_in_progress', run: summarizeBackupRunForClient(latest) };
  }
  const baselineManifest = sanitizeBackupBaselineManifestForRequest(payload?.baseline_manifest);
  const baselineLookup = createBackupBaselineLookup(baselineManifest);
  const run = createBackupRunRecord(payload?.scopes || DEFAULT_BACKUP_SCOPES, payload?.headers || {}, pageTabId, baselineManifest);
  markBackupRunInterrupted(run.id, '');
  await backupDbPut(BACKUP_RUNS_STORE, run);
  await broadcastBackupRunEvent({ type: 'status', run: summarizeBackupRunForClient(run) });
  (async () => {
    try {
      const discoveredRun = await discoverBackupRun(run, baselineLookup);
      if (normalizeRunStatus(discoveredRun?.status) === 'running') {
        queueBackupRunProcessing(discoveredRun.id);
      }
    } catch (err) {
      const failed = await updateBackupRunStatus(run.id, (draft) => ({
        ...draft,
        status: 'failed',
        completed_at: Date.now(),
        last_error: sanitizeString(err?.message || String(err), 1024) || 'backup_discovery_failed',
        summary_text: 'Backup discovery failed.',
        active_download_id: 0,
        active_item_key: '',
      }), 'status');
      return failed;
    }
  })().catch(() => {});
  return { ok: true, run: summarizeBackupRunForClient(run) };
}

async function handleBackupPause(payload) {
  const run = payload?.runId ? await backupDbGet(BACKUP_RUNS_STORE, payload.runId) : await backupDbGetLatestRun();
  if (!run) return { ok: false, error: 'backup_run_not_found' };
  markBackupRunInterrupted(run.id, 'paused');
  run.status = 'paused';
  run.interrupt_status = 'paused';
  run.paused_at = Date.now();
  run.summary_text = run.active_download_id ? 'Pause requested. The current download will finish first.' : 'Paused.';
  const next = await saveBackupRun(run, 'status');
  return { ok: true, run: summarizeBackupRunForClient(next) };
}

async function handleBackupResume(payload) {
  const run = payload?.runId ? await backupDbGet(BACKUP_RUNS_STORE, payload.runId) : await backupDbGetLatestRun();
  if (!run) return { ok: false, error: 'backup_run_not_found' };
  markBackupRunInterrupted(run.id, '');
  run.status = 'running';
  run.interrupt_status = '';
  run.paused_at = 0;
  if (payload?.headers && Object.keys(payload.headers).length) {
    run.headers = { ...normalizeBackupHeaders(run.headers), ...normalizeBackupHeaders(payload.headers) };
  }
  run.summary_text = 'Resuming backup…';
  const next = await saveBackupRun(run, 'status');
  queueBackupRunProcessing(next.id);
  return { ok: true, run: summarizeBackupRunForClient(next) };
}

async function handleBackupCancel(payload) {
  const run = payload?.runId ? await backupDbGet(BACKUP_RUNS_STORE, payload.runId) : await backupDbGetLatestRun();
  if (!run) return { ok: false, error: 'backup_run_not_found' };
  markBackupRunInterrupted(run.id, 'cancelled');
  run.status = 'cancelled';
  run.interrupt_status = 'cancelled';
  run.cancelled_at = Date.now();
  run.summary_text = 'Backup cancelled.';
  const downloadId = Number(run.active_download_id) || 0;
  if (downloadId > 0) {
    try { await chrome.downloads.cancel(downloadId); } catch {}
  }
  run.active_download_id = 0;
  run.active_item_key = '';
  const next = await saveBackupRun(run, 'status');
  return { ok: true, run: summarizeBackupRunForClient(next) };
}

async function handleBackupStatusRequest(payload) {
  const run = payload?.runId ? await backupDbGet(BACKUP_RUNS_STORE, payload.runId) : await backupDbGetLatestRun();
  return { ok: true, run: summarizeBackupRunForClient(run) };
}

function buildBackupManifestLine(item) {
  return {
    item_key: item.item_key,
    run_id: item.run_id,
    bucket: item.bucket,
    kind: item.kind,
    id: item.id,
    owner_handle: item.owner_handle || '',
    owner_id: item.owner_id || '',
    title: item.title || '',
    prompt: item.prompt || '',
    prompt_source: item.prompt_source || '',
    created_at: item.created_at || '',
    posted_at: item.posted_at || '',
    updated_at: item.updated_at || '',
    width: item.width ?? '',
    height: item.height ?? '',
    duration_s: item.duration_s ?? '',
    post_permalink: item.post_permalink || '',
    detail_url: item.detail_url || '',
    cast_names: Array.isArray(item.cast_names) ? item.cast_names : [],
    cameos: Array.isArray(item.cameos) ? item.cameos : [],
    media_url: item.media_url || '',
    media_variant: item.media_variant || '',
    media_ext: item.media_ext || '',
    filename: item.filename || '',
    status: item.status || '',
    skip_reason: item.skip_reason || '',
    attempts: Number(item.attempts) || 0,
    url_refreshed_at: Number(item.url_refreshed_at) || 0,
    last_error: item.last_error || '',
  };
}

async function handleBackupManifestRequest(payload) {
  const run = payload?.runId ? await backupDbGet(BACKUP_RUNS_STORE, payload.runId) : await backupDbGetLatestRun();
  if (!run) return { ok: false, error: 'backup_run_not_found' };
  const items = await backupDbGetRunItems(run.id);
  const format = sanitizeString(payload?.format, 24) || 'manifest';
  if (format === 'summary') {
    return {
      ok: true,
      filename: `sora_backup_summary_${run.run_stamp}.json`,
      mimeType: 'application/json;charset=utf-8;',
      text: JSON.stringify({
        run: summarizeBackupRunForClient(run),
        items_total: items.length,
      }, null, 2),
    };
  }
  if (format === 'failures') {
    const failures = items.filter((item) => {
      const status = normalizeItemStatus(item.status);
      if (status === 'failed') return true;
      if (status !== 'skipped') return false;
      return String(item?.skip_reason || '').trim().toLowerCase() !== 'already_backed_up';
    });
    return {
      ok: true,
      filename: `sora_backup_failures_${run.run_stamp}.jsonl`,
      mimeType: 'application/x-ndjson;charset=utf-8;',
      text: failures.map((item) => JSON.stringify(buildBackupManifestLine(item))).join('\n'),
    };
  }
  return {
    ok: true,
    filename: `sora_backup_manifest_${run.run_stamp}.jsonl`,
    mimeType: 'application/x-ndjson;charset=utf-8;',
    text: items.map((item) => JSON.stringify(buildBackupManifestLine(item))).join('\n'),
  };
}

/* ─── Message handlers ─── */

function openOrFocusDashboard(sendResponse) {
  const url = chrome.runtime.getURL('dashboard.html');
  chrome.tabs.query({ url: `${url}*` }, (tabs) => {
    const existing = Array.isArray(tabs) ? tabs[0] : null;
    if (existing?.id != null) {
      chrome.tabs.update(existing.id, { active: true }, () => {
        sendResponse({ success: true, tabId: existing.id, reused: true });
      });
      return;
    }
    chrome.tabs.create({ url }, (tab) => {
      sendResponse({ success: true, tabId: tab?.id ?? null, reused: false });
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isPlainObject(message) || typeof message.action !== 'string') return false;
  if (!isTrustedSender(sender)) {
    if (message.action === 'metrics_request') {
      sendResponse({ metrics: { users: {} }, metricsUpdatedAt: 0 });
    } else if (message.action.startsWith('backup_')) {
      sendResponse({ ok: false, error: 'untrusted_sender' });
    }
    return false;
  }

  if (message.action === 'open_dashboard') {
    openOrFocusDashboard(sendResponse);
    return true; // Keep message channel open for async response
  }

  if (message.action === 'metrics_batch') {
    const items = sanitizeMetricsBatch(message.items);
    if (items.length) {
      for (const it of items) PENDING.push(it);
      scheduleFlush();
    }
    return false; // fire-and-forget
  }

  if (message.action === 'harvest_batch') {
    const items = sanitizeHarvestBatch(message.items);
    if (items.length) {
      for (const it of items) HARVEST_PENDING.push(it);
      scheduleHarvestFlush();
    }
    return false; // fire-and-forget
  }

  if (message.action === 'metrics_request') {
    const request = sanitizeMetricsRequest(message);
    if (!request) {
      sendResponse({ metrics: { users: {} }, metricsUpdatedAt: 0 });
      return false;
    }
    (async () => {
      try {
        const { metrics } = await getMetricsState();
        const responseMetrics = buildMetricsForRequest(metrics, request);
        sendResponse({ metrics: responseMetrics, metricsUpdatedAt: metricsCacheUpdatedAt });
      } catch {
        sendResponse({ metrics: { users: {} }, metricsUpdatedAt: 0 });
      }
    })();
    return true; // async response
  }

  if (message.action === 'backup_start') {
    const payload = sanitizeBackupPayload(message.action, message.payload);
    (async () => {
      try {
        sendResponse(await handleBackupStart(payload, sender?.tab?.id || 0));
      } catch (err) {
        sendResponse({ ok: false, error: sanitizeString(err?.message || String(err), 1024) || 'backup_start_failed' });
      }
    })();
    return true;
  }

  if (message.action === 'backup_pause') {
    const payload = sanitizeBackupPayload(message.action, message.payload);
    (async () => {
      try {
        sendResponse(await handleBackupPause(payload));
      } catch (err) {
        sendResponse({ ok: false, error: sanitizeString(err?.message || String(err), 1024) || 'backup_pause_failed' });
      }
    })();
    return true;
  }

  if (message.action === 'backup_resume') {
    const payload = sanitizeBackupPayload(message.action, message.payload);
    (async () => {
      try {
        sendResponse(await handleBackupResume(payload));
      } catch (err) {
        sendResponse({ ok: false, error: sanitizeString(err?.message || String(err), 1024) || 'backup_resume_failed' });
      }
    })();
    return true;
  }

  if (message.action === 'backup_cancel') {
    const payload = sanitizeBackupPayload(message.action, message.payload);
    (async () => {
      try {
        sendResponse(await handleBackupCancel(payload));
      } catch (err) {
        sendResponse({ ok: false, error: sanitizeString(err?.message || String(err), 1024) || 'backup_cancel_failed' });
      }
    })();
    return true;
  }

  if (message.action === 'backup_status_request') {
    const payload = sanitizeBackupPayload(message.action, message.payload);
    (async () => {
      try {
        sendResponse(await handleBackupStatusRequest(payload));
      } catch (err) {
        sendResponse({ ok: false, error: sanitizeString(err?.message || String(err), 1024) || 'backup_status_failed' });
      }
    })();
    return true;
  }

  if (message.action === 'backup_manifest_request') {
    const payload = sanitizeBackupPayload(message.action, message.payload);
    (async () => {
      try {
        sendResponse(await handleBackupManifestRequest(payload));
      } catch (err) {
        sendResponse({ ok: false, error: sanitizeString(err?.message || String(err), 1024) || 'backup_manifest_failed' });
      }
    })();
    return true;
  }
  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  const downloadId = Number(delta?.id) || 0;
  if (!downloadId) return;
  (async () => {
    const item = await backupDbGetItemByDownloadId(downloadId);
    if (!item) return;
    const run = await backupDbGet(BACKUP_RUNS_STORE, item.run_id);
    if (!run) return;

    if (delta.state?.current === 'complete') {
      let finalFilename = item.filename || '';
      try {
        const matches = await chrome.downloads.search({ id: downloadId });
        if (Array.isArray(matches) && matches[0]?.filename) finalFilename = matches[0].filename;
      } catch {}
      const result = await transitionBackupItem(run, item, 'done', {
        download_id: downloadId,
        filename: finalFilename,
        last_error: '',
      }, 'item');
      const nextRun = {
        ...result.run,
        active_download_id: result.run.active_download_id === downloadId ? 0 : result.run.active_download_id,
        active_item_key: result.run.active_item_key === item.item_key ? '' : result.run.active_item_key,
        summary_text: `Downloaded ${result.item.id}.`,
      };
      await saveBackupRun(nextRun, 'status');
      if (normalizeRunStatus(nextRun.status) !== 'paused' && normalizeRunStatus(nextRun.status) !== 'cancelled') {
        queueBackupRunProcessing(nextRun.id);
      }
      return;
    }

    if (delta.state?.current === 'interrupted') {
      const errorText = sanitizeString(delta.error?.current || 'download_interrupted', 1024) || 'download_interrupted';
      const result = await transitionBackupItem(run, item, 'failed', {
        download_id: downloadId,
        last_error: errorText,
      }, 'item');
      const nextRun = {
        ...result.run,
        active_download_id: result.run.active_download_id === downloadId ? 0 : result.run.active_download_id,
        active_item_key: result.run.active_item_key === item.item_key ? '' : result.run.active_item_key,
        last_error: errorText,
        summary_text: `Download failed for ${result.item.id}.`,
      };
      await saveBackupRun(nextRun, 'status');
      if (normalizeRunStatus(nextRun.status) !== 'paused' && normalizeRunStatus(nextRun.status) !== 'cancelled') {
        queueBackupRunProcessing(nextRun.id);
      }
    }
  })().catch(() => {});
});

/* ─── Storage change listener (catches external writes like dashboard purge) ─── */

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes) return;
  // Broadcast ultra mode changes to all Sora content scripts so they never need
  // their own chrome.storage.onChanged listener (which would deserialize the full
  // metrics blob into every tab on every flush).
  if (Object.prototype.hasOwnProperty.call(changes, 'SCT_ULTRA_MODE_V1')) {
    chrome.tabs.query({ url: 'https://sora.chatgpt.com/*' }, (tabs) => {
      if (!tabs) return;
      for (const tab of tabs) {
        try { chrome.tabs.sendMessage(tab.id, { action: 'ultra_mode_changed' }); } catch {}
      }
    });
  }
  const hasMetrics = Object.prototype.hasOwnProperty.call(changes, METRICS_STORAGE_KEY);
  const hasUpdatedAt = Object.prototype.hasOwnProperty.call(changes, METRICS_UPDATED_AT_KEY);
  // Skip self-triggered writes — we already updated the cache in flush()
  if (hasUpdatedAt) {
    const incomingTs = Number(changes[METRICS_UPDATED_AT_KEY]?.newValue) || 0;
    if (lastSelfWriteTs && Math.abs(incomingTs - lastSelfWriteTs) < 100) {
      return;
    }
  }
  if (hasMetrics) {
    const nextMetrics = changes[METRICS_STORAGE_KEY]?.newValue;
    const nextUpdatedAt = hasUpdatedAt ? changes[METRICS_UPDATED_AT_KEY]?.newValue : metricsCacheUpdatedAt;
    cacheMetrics(nextMetrics, nextUpdatedAt);
  } else if (hasUpdatedAt) {
    const nextUpdatedAt = Number(changes[METRICS_UPDATED_AT_KEY]?.newValue) || 0;
    metricsCacheUpdatedAt = nextUpdatedAt || metricsCacheUpdatedAt;
  }
});

/* ─── Startup ─── */

// Run one-time migration from v1 (monolithic) to v2 (hot/cold split)
migrateStorageIfNeeded();

// Ensure harvest metadata is initialized.
(async () => {
  try {
    const current = await chrome.storage.local.get([HARVEST_STORAGE_VERSION_KEY, HARVEST_STORAGE_KEY]);
    if (Number(current[HARVEST_STORAGE_VERSION_KEY]) === HARVEST_STORAGE_VERSION && current[HARVEST_STORAGE_KEY]) return;
    await chrome.storage.local.set({
      [HARVEST_STORAGE_VERSION_KEY]: HARVEST_STORAGE_VERSION,
      [HARVEST_STORAGE_KEY]: {
        backend: 'indexeddb',
        db: HARVEST_DB_NAME,
        store: HARVEST_STORE,
        count: 0,
      },
    });
  } catch {}
})();
