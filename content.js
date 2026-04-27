/*
 * Copyright (c) 2025-2026 sora-creator-tools contributors
 * Licensed under the MIT License. See the LICENSE file for details.
 */

(() => {
  const p = String(location.pathname || '');
  const isDraftDetail = p === '/d' || p.startsWith('/d/');
  const PAGE_ORIGIN = location.origin;
  const ULTRA_MODE_KEY = 'SCT_ULTRA_MODE_V1';
  const MAX_METRICS_BATCH_ITEMS = 250;
  const MAX_STR_LEN = 4096;
  const MAX_URL_LEN = 2048;
  const MAX_ID_LEN = 128;
  const MAX_HANDLE_LEN = 80;
  const MAX_REQUEST_ID_LEN = 80;
  const MAX_CAMEO_USERNAMES = 32;
  const MAX_HARVEST_BATCH_ITEMS = 250;
  const MAX_HARVEST_CAST_NAMES = 32;
  const MAX_BACKUP_FETCH_PARAMS = 20;
  const MAX_BACKUP_BASELINE_KEYS = 100000;
  const BACKUP_PAGE_FETCH_TIMEOUT_MS = 30000;
  const BACKUP_ACTIONS = new Set([
    'backup_start',
    'backup_pause',
    'backup_resume',
    'backup_cancel',
    'backup_status_request',
    'backup_manifest_request',
  ]);

  function sanitizeString(value, maxLen = MAX_STR_LEN) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
  }

  function sanitizeNumber(value, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, n));
  }

  function sanitizeIdToken(value, maxLen = MAX_ID_LEN) {
    const s = sanitizeString(value, maxLen);
    if (!s) return null;
    if (!/^[A-Za-z0-9:_.-]+$/.test(s)) return null;
    return s;
  }

  function sanitizeUserId(value) {
    const numeric = sanitizeNumber(value);
    if (numeric != null) return numeric;
    return sanitizeIdToken(value, MAX_ID_LEN);
  }

  function sanitizeCameoUsernames(value) {
    if (!Array.isArray(value)) return null;
    const out = [];
    for (const raw of value) {
      if (out.length >= MAX_CAMEO_USERNAMES) break;
      const username = sanitizeString(raw, MAX_HANDLE_LEN);
      if (!username) continue;
      out.push(username);
    }
    return out;
  }

  function sanitizeMetricsItem(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = {};

    const ts = sanitizeNumber(raw.ts, 0);
    if (ts != null) item.ts = ts;

    const userKey = sanitizeIdToken(raw.userKey);
    if (userKey) item.userKey = userKey;
    const pageUserKey = sanitizeIdToken(raw.pageUserKey);
    if (pageUserKey) item.pageUserKey = pageUserKey;

    const userHandle = sanitizeString(raw.userHandle, MAX_HANDLE_LEN);
    if (userHandle) item.userHandle = userHandle;
    const pageUserHandle = sanitizeString(raw.pageUserHandle, MAX_HANDLE_LEN);
    if (pageUserHandle) item.pageUserHandle = pageUserHandle;

    const userId = sanitizeUserId(raw.userId);
    if (userId != null) item.userId = userId;
    if (!item.userKey && userId != null) item.userKey = `id:${String(userId)}`;

    const postId = sanitizeIdToken(raw.postId);
    if (postId) item.postId = postId;
    const parentPostId = sanitizeIdToken(raw.parent_post_id);
    if (parentPostId) item.parent_post_id = parentPostId;
    const rootPostId = sanitizeIdToken(raw.root_post_id);
    if (rootPostId) item.root_post_id = rootPostId;

    const createdAt = raw.created_at;
    if (typeof createdAt === 'string' || Number.isFinite(Number(createdAt))) {
      item.created_at = typeof createdAt === 'string'
        ? sanitizeString(createdAt, 64)
        : Number(createdAt);
    }

    const url = sanitizeString(raw.url, MAX_URL_LEN);
    if (url) item.url = url;
    const thumb = sanitizeString(raw.thumb, MAX_URL_LEN);
    if (thumb) item.thumb = thumb;
    const caption = sanitizeString(raw.caption, MAX_STR_LEN);
    if (caption) item.caption = caption;

    const cameoUsernames = sanitizeCameoUsernames(raw.cameo_usernames);
    if (cameoUsernames) item.cameo_usernames = cameoUsernames;

    const uv = sanitizeNumber(raw.uv, 0);
    if (uv != null) item.uv = uv;
    const likes = sanitizeNumber(raw.likes, 0);
    if (likes != null) item.likes = likes;
    const views = sanitizeNumber(raw.views, 0);
    if (views != null) item.views = views;
    const comments = sanitizeNumber(raw.comments, 0);
    if (comments != null) item.comments = comments;
    const remixes = sanitizeNumber(raw.remixes, 0);
    if (remixes != null) item.remixes = remixes;
    const remixCount = sanitizeNumber(raw.remix_count, 0);
    if (remixCount != null) item.remix_count = remixCount;
    const followers = sanitizeNumber(raw.followers, 0);
    if (followers != null) item.followers = followers;
    const cameoCount = sanitizeNumber(raw.cameo_count, 0);
    if (cameoCount != null) item.cameo_count = cameoCount;
    const duration = sanitizeNumber(raw.duration, 0, 60 * 60 * 10);
    if (duration != null) item.duration = duration;
    const width = sanitizeNumber(raw.width, 1, 20000);
    if (width != null) item.width = width;
    const height = sanitizeNumber(raw.height, 1, 20000);
    if (height != null) item.height = height;

    const hasSignal = !!item.postId || item.followers != null || item.cameo_count != null;
    return hasSignal ? item : null;
  }

  function sanitizeMetricsBatch(items) {
    if (!Array.isArray(items)) return [];
    const out = [];
    const limit = Math.min(items.length, MAX_METRICS_BATCH_ITEMS);
    for (let i = 0; i < limit; i++) {
      const item = sanitizeMetricsItem(items[i]);
      if (item) out.push(item);
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

  function sanitizeStringArray(value, maxItems = MAX_HARVEST_CAST_NAMES, maxLen = MAX_HANDLE_LEN) {
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

  function sanitizeHarvestItem(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = {};

    const id = sanitizeIdToken(raw.id);
    if (!id) return null;
    item.id = id;

    const kind = normalizeHarvestKind(raw.kind);
    if (!kind) return null;
    item.kind = kind;

    const context = normalizeHarvestContext(raw.context);
    if (context) item.context = context;

    const source = normalizeHarvestSource(raw.source);
    if (source) item.source = source;

    const userHandle = sanitizeString(raw.user_handle, MAX_HANDLE_LEN);
    if (userHandle) item.user_handle = userHandle;
    const userId = sanitizeUserId(raw.user_id);
    if (userId != null) item.user_id = userId;

    const detailUrl = sanitizeString(raw.detail_url, MAX_URL_LEN);
    if (detailUrl) item.detail_url = detailUrl;

    const prompt = sanitizeString(raw.prompt, MAX_STR_LEN);
    if (prompt) item.prompt = prompt;
    const promptSource = sanitizeString(raw.prompt_source, 32);
    if (promptSource) item.prompt_source = promptSource;
    const title = sanitizeString(raw.title, 512);
    if (title) item.title = title;
    const generationType = sanitizeString(raw.generation_type, 64);
    if (generationType) item.generation_type = generationType;
    const generationId = sanitizeIdToken(raw.generation_id, MAX_ID_LEN);
    if (generationId) item.generation_id = generationId;

    const width = sanitizeNumber(raw.width, 1, 20000);
    if (width != null) item.width = width;
    const height = sanitizeNumber(raw.height, 1, 20000);
    if (height != null) item.height = height;
    const duration = sanitizeNumber(raw.duration_s, 0, 60 * 60 * 10);
    if (duration != null) item.duration_s = duration;

    const createdAt = raw.created_at;
    if (typeof createdAt === 'string' || Number.isFinite(Number(createdAt))) {
      item.created_at = typeof createdAt === 'string'
        ? sanitizeString(createdAt, 64)
        : Number(createdAt);
    }
    const postedAt = raw.posted_at;
    if (typeof postedAt === 'string' || Number.isFinite(Number(postedAt))) {
      item.posted_at = typeof postedAt === 'string'
        ? sanitizeString(postedAt, 64)
        : Number(postedAt);
    }
    const updatedAt = raw.updated_at;
    if (typeof updatedAt === 'string' || Number.isFinite(Number(updatedAt))) {
      item.updated_at = typeof updatedAt === 'string'
        ? sanitizeString(updatedAt, 64)
        : Number(updatedAt);
    }

    const viewCount = sanitizeNumber(raw.view_count, 0);
    if (viewCount != null) item.view_count = viewCount;
    const uniqueViewCount = sanitizeNumber(raw.unique_view_count, 0);
    if (uniqueViewCount != null) item.unique_view_count = uniqueViewCount;
    const likeCount = sanitizeNumber(raw.like_count, 0);
    if (likeCount != null) item.like_count = likeCount;
    const dislikeCount = sanitizeNumber(raw.dislike_count, 0);
    if (dislikeCount != null) item.dislike_count = dislikeCount;
    const replyCount = sanitizeNumber(raw.reply_count, 0);
    if (replyCount != null) item.reply_count = replyCount;
    const recursiveReplyCount = sanitizeNumber(raw.recursive_reply_count, 0);
    if (recursiveReplyCount != null) item.recursive_reply_count = recursiveReplyCount;
    const remixCount = sanitizeNumber(raw.remix_count, 0);
    if (remixCount != null) item.remix_count = remixCount;

    const postPermalink = sanitizeString(raw.post_permalink, MAX_URL_LEN);
    if (postPermalink) item.post_permalink = postPermalink;
    const postVisibility = sanitizeString(raw.post_visibility, 32);
    if (postVisibility) item.post_visibility = postVisibility;

    const castCount = sanitizeNumber(raw.cast_count, 0, MAX_HARVEST_CAST_NAMES);
    if (castCount != null) item.cast_count = castCount;
    const castNames = sanitizeStringArray(raw.cast_names, MAX_HARVEST_CAST_NAMES, MAX_HANDLE_LEN);
    if (castNames) item.cast_names = castNames;
    const cameos = sanitizeStringArray(raw.cameos, MAX_HARVEST_CAST_NAMES, MAX_HANDLE_LEN);
    if (cameos) item.cameos = cameos;

    const firstSeenTs = sanitizeNumber(raw.first_seen_ts, 0);
    if (firstSeenTs != null) item.first_seen_ts = firstSeenTs;
    const lastSeenTs = sanitizeNumber(raw.last_seen_ts, 0);
    if (lastSeenTs != null) item.last_seen_ts = lastSeenTs;
    const runId = sanitizeIdToken(raw.last_harvest_run_id, MAX_ID_LEN);
    if (runId) item.last_harvest_run_id = runId;

    return item;
  }

  function sanitizeHarvestBatch(items) {
    if (!Array.isArray(items)) return [];
    const out = [];
    const limit = Math.min(items.length, MAX_HARVEST_BATCH_ITEMS);
    for (let i = 0; i < limit; i++) {
      const item = sanitizeHarvestItem(items[i]);
      if (item) out.push(item);
    }
    return out;
  }

  function sanitizeBackupHeaders(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const headers = {};
    const auth = sanitizeString(raw.Authorization || raw.authorization, MAX_STR_LEN);
    const deviceId = sanitizeString(raw['OAI-Device-Id'] || raw['oai-device-id'], 256);
    const language = sanitizeString(raw['OAI-Language'] || raw['oai-language'], 64);
    if (auth) headers.Authorization = auth;
    if (deviceId) headers['OAI-Device-Id'] = deviceId;
    if (language) headers['OAI-Language'] = language;
    return Object.keys(headers).length ? headers : null;
  }

  function sanitizeBackupScopes(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      ownDrafts: source.ownDrafts !== false,
      ownPosts: source.ownPosts !== false,
      castInPosts: source.castInPosts !== false,
      castInDrafts: source.castInDrafts !== false,
    };
  }

  function sanitizeBackupComparisonKey(value) {
    const key = sanitizeString(value, 256);
    if (!key) return null;
    if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9:_./-]+$/.test(key)) return null;
    return key;
  }

  function sanitizeBackupBaselineManifest(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!source) return null;
    const keys = [];
    const seen = new Set();
    const inputKeys = Array.isArray(source.keys) ? source.keys : [];
    for (const entry of inputKeys) {
      if (keys.length >= MAX_BACKUP_BASELINE_KEYS) break;
      const key = sanitizeBackupComparisonKey(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    const filename = sanitizeString(source.filename, 512) || '';
    const totalRows = sanitizeNumber(source.total_rows, 0, 100000000) ?? 0;
    const backedUpRows = sanitizeNumber(source.backed_up_rows, 0, 100000000) ?? 0;
    if (!filename && !keys.length && totalRows <= 0 && backedUpRows <= 0) return null;
    return {
      filename,
      total_rows: totalRows,
      backed_up_rows: backedUpRows,
      keys,
    };
  }

  function sanitizeBackupPayload(action, raw) {
    const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const runId = sanitizeIdToken(payload.runId, MAX_ID_LEN);
    if (action === 'backup_start') {
      return {
        scopes: sanitizeBackupScopes(payload.scopes),
        headers: sanitizeBackupHeaders(payload.headers) || {},
        baseline_manifest: sanitizeBackupBaselineManifest(payload.baseline_manifest),
      };
    }
    if (action === 'backup_manifest_request') {
      const format = sanitizeString(payload.format, 24);
      return {
        runId: runId || null,
        format: format || 'manifest',
      };
    }
    return {
      runId: runId || null,
      headers: sanitizeBackupHeaders(payload.headers) || {},
    };
  }

  function sanitizeBackupPathname(value) {
    const pathname = sanitizeString(value, MAX_URL_LEN);
    if (!pathname || !pathname.startsWith('/backend/')) return null;
    if (/[\s\\]/.test(pathname)) return null;
    return pathname;
  }

  function sanitizeBackupQueryParams(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    let count = 0;
    for (const [key, value] of Object.entries(raw)) {
      if (count >= MAX_BACKUP_FETCH_PARAMS) break;
      if (value == null || value === '') continue;
      const paramKey = sanitizeString(key, 64);
      if (!paramKey) continue;
      const paramValue = sanitizeString(String(value), MAX_URL_LEN);
      if (paramValue == null) continue;
      out[paramKey] = paramValue;
      count += 1;
    }
    return out;
  }

  function sanitizeBackupPageFetchPayload(raw) {
    const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const pathname = sanitizeBackupPathname(payload.pathname);
    if (!pathname) return null;
    return {
      pathname,
      params: sanitizeBackupQueryParams(payload.params),
      headers: sanitizeBackupHeaders(payload.headers) || {},
    };
  }

  function sanitizeRequestId(value) {
    const s = sanitizeString(value, MAX_REQUEST_ID_LEN);
    if (!s) return null;
    if (!/^[A-Za-z0-9._:-]+$/.test(s)) return null;
    return s;
  }

  function normalizeMetricsScope(scope) {
    const s = sanitizeString(scope, 16);
    if (!s) return null;
    const n = s.toLowerCase();
    if (n === 'analyze' || n === 'post') return n;
    return null;
  }

  function normalizeSnapshotMode(mode) {
    const s = sanitizeString(mode, 16);
    return s && s.toLowerCase() === 'all' ? 'all' : 'latest';
  }

  function postMetricsResponse(req, metrics = { users: {} }, metricsUpdatedAt = 0) {
    try {
      window.postMessage(
        { __sora_uv__: true, type: 'metrics_response', req, metrics, metricsUpdatedAt },
        PAGE_ORIGIN
      );
    } catch {}
  }

  const pendingBackupPageFetches = new Map();
  let backupPageFetchSeq = 0;

  function nextBackupPageFetchId() {
    backupPageFetchSeq += 1;
    return `backup_page_fetch_${Date.now()}_${backupPageFetchSeq}`;
  }

  function requestPageBackupFetch(payload) {
    return new Promise((resolve, reject) => {
      const req = nextBackupPageFetchId();
      const timerId = setTimeout(() => {
        pendingBackupPageFetches.delete(req);
        reject(new Error('backup_page_fetch_timeout'));
      }, BACKUP_PAGE_FETCH_TIMEOUT_MS);
      pendingBackupPageFetches.set(req, { resolve, reject, timerId });
      try {
        window.postMessage(
          { __sora_uv__: true, type: 'backup_page_fetch_request', req, payload },
          PAGE_ORIGIN
        );
      } catch (err) {
        clearTimeout(timerId);
        pendingBackupPageFetches.delete(req);
        reject(err);
      }
    });
  }
  function writeUltraModeToLocalStorage(enabled) {
    try {
      localStorage.setItem(ULTRA_MODE_KEY, JSON.stringify({ enabled: !!enabled, setAt: Date.now() }));
    } catch {}
  }

  async function syncUltraModePreference() {
    try {
      const stored = await chrome.storage.local.get(ULTRA_MODE_KEY);
      const enabled = !!stored[ULTRA_MODE_KEY];
      writeUltraModeToLocalStorage(enabled);
      try {
        window.dispatchEvent(new CustomEvent('sct_ultra_mode', { detail: { enabled } }));
      } catch {}
    } catch {}
  }

  syncUltraModePreference();

  function injectPageScript(filename, next) {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL(filename);
      s.async = false;
      s.onload = () => {
        try {
          s.remove();
        } catch {}
        try {
          if (typeof next === 'function') next();
        } catch {}
      };
      s.onerror = () => {
        try {
          if (typeof next === 'function') next();
        } catch {}
      };
      (document.head || document.documentElement).appendChild(s);
    } catch {
      try {
        if (typeof next === 'function') next();
      } catch {}
    }
  }

  let uvDraftsScriptsInjected = false;
  let uvDraftsScriptsInjecting = false;
  let uvDraftsScriptReadyCallbacks = [];
  const UV_DRAFTS_ROUTE_RE = /^\/creatortools(?:\/|$)/i;

  function isUVDraftsRoute(pathname = location.pathname) {
    return UV_DRAFTS_ROUTE_RE.test(String(pathname || ''));
  }

  function flushUVDraftsReadyCallbacks() {
    const cbs = uvDraftsScriptReadyCallbacks;
    uvDraftsScriptReadyCallbacks = [];
    for (const cb of cbs) {
      try { cb(); } catch {}
    }
  }

  function announceUVDraftsScriptsReady() {
    try {
      window.postMessage({ __sora_uv__: true, type: 'uv_drafts_scripts_ready' }, PAGE_ORIGIN);
    } catch {}
  }

  function ensureUVDraftsScriptsInjected(next) {
    if (typeof next === 'function') uvDraftsScriptReadyCallbacks.push(next);
    if (uvDraftsScriptsInjected) {
      flushUVDraftsReadyCallbacks();
      return;
    }
    if (uvDraftsScriptsInjecting) return;
    uvDraftsScriptsInjecting = true;
    injectPageScript('uv-drafts-logic.js', () => {
      injectPageScript('uv-backup-logic.js', () => {
        injectPageScript('uv-drafts-page.js', () => {
          uvDraftsScriptsInjected = true;
          uvDraftsScriptsInjecting = false;
          announceUVDraftsScriptsReady();
          flushUVDraftsReadyCallbacks();
        });
      });
    });
  }

  // Inject core page scripts first. Creator Tools modules are lazy-loaded on demand.
  injectPageScript('api.js', () => {
    injectPageScript('inject.js', () => {
      if (isUVDraftsRoute()) ensureUVDraftsScriptsInjected();
    });
  });

  // Listen for dashboard open requests from inject.js and relay to background.
  let dashboardOpenLock = false;
  let dashboardOpenLockTimer = null;
  function openDashboardTab(opts){
    try {
      if (dashboardOpenLock) return;
      dashboardOpenLock = true;
      if (dashboardOpenLockTimer) clearTimeout(dashboardOpenLockTimer);
      dashboardOpenLockTimer = setTimeout(()=>{ dashboardOpenLock = false; }, 1000);
      const payload = {};
      if (opts?.userKey) payload.lastUserKey = opts.userKey;
      if (opts?.userHandle) payload.lastUserHandle = opts.userHandle;
      if (Object.keys(payload).length) chrome.storage.local.set(payload);
      try {
        chrome.runtime.sendMessage({ action: 'open_dashboard' }, (resp)=>{
          if (chrome.runtime.lastError || !resp || resp.success !== true) {
            dashboardOpenLock = false;
          }
        });
      } catch {
        dashboardOpenLock = false;
      }
    } catch {
      dashboardOpenLock = false;
    }
  }

  window.addEventListener('message', function(ev) {
    if (ev?.source !== window) return;
    const d = ev?.data;
    if (!d || d.__sora_uv__ !== true || d.type !== 'open_dashboard') return;
    const userHandle = sanitizeString(d.userHandle, MAX_HANDLE_LEN);
    const providedUserKey = sanitizeIdToken(d.userKey);
    const userKey = providedUserKey || (userHandle ? `h:${userHandle.toLowerCase()}` : null);
    openDashboardTab({ userKey, userHandle });
  });

  window.addEventListener('message', function(ev) {
    if (ev?.source !== window) return;
    const d = ev?.data;
    if (!d || d.__sora_uv__ !== true || d.type !== 'load_uv_drafts_scripts') return;
    ensureUVDraftsScriptsInjected();
  });

  // Fallback: also listen directly for clicks on the injected dashboard button in the page DOM.
  const dashboardClickHandler = (ev)=>{
    const btn = ev.target && ev.target.closest && ev.target.closest('.sora-uv-dashboard-btn');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    openDashboardTab({});
  };
  document.addEventListener('click', dashboardClickHandler, true);
  document.addEventListener('pointerup', dashboardClickHandler, true);
  document.addEventListener('touchend', dashboardClickHandler, true);

  if (isDraftDetail) return;

  // Relay metrics batches from inject.js to background service worker (fire-and-forget).
  window.addEventListener('message', function(ev) {
    if (ev?.source !== window) return;
    const d = ev?.data;
    if (!d || d.__sora_uv__ !== true || d.type !== 'metrics_batch' || !Array.isArray(d.items)) return;
    const items = sanitizeMetricsBatch(d.items);
    if (!items.length) return;
    try {
      chrome.runtime.sendMessage({ action: 'metrics_batch', items });
    } catch {}
  });

  // Relay metrics requests from inject.js to background and return the response.
  window.addEventListener('message', function(ev) {
    if (ev?.source !== window) return;
    const d = ev?.data;
    if (!d || d.__sora_uv__ !== true || d.type !== 'metrics_request') return;
    const req = sanitizeRequestId(d.req);
    const scope = normalizeMetricsScope(d.scope);
    if (!req || !scope) return;
    const postId = scope === 'post' ? sanitizeIdToken(d.postId) : null;
    if (scope === 'post' && !postId) {
      postMetricsResponse(req);
      return;
    }
    const windowHours = scope === 'analyze'
      ? (sanitizeNumber(d.windowHours, 1, 24) ?? 24)
      : undefined;
    const snapshotMode = normalizeSnapshotMode(d.snapshotMode);
    try {
      chrome.runtime.sendMessage({
        action: 'metrics_request',
        scope,
        postId,
        windowHours,
        snapshotMode,
      }, (response) => {
        if (chrome.runtime.lastError || !response) {
          postMetricsResponse(req);
          return;
        }
        postMetricsResponse(req, response.metrics, response.metricsUpdatedAt);
      });
    } catch {
      postMetricsResponse(req);
    }
  });

  // Relay harvest batches from inject.js to background service worker (fire-and-forget).
  window.addEventListener('message', function(ev) {
    if (ev?.source !== window) return;
    const d = ev?.data;
    if (!d || d.__sora_uv__ !== true || d.type !== 'harvest_batch' || !Array.isArray(d.items)) return;
    const items = sanitizeHarvestBatch(d.items);
    if (!items.length) return;
    try {
      chrome.runtime.sendMessage({ action: 'harvest_batch', items });
    } catch {}
  });

  // Relay Creator Tools backup requests to the background service worker.
  window.addEventListener('message', function(ev) {
    if (ev?.source !== window) return;
    const d = ev?.data;
    if (!d || d.__sora_uv__ !== true || d.type !== 'backup_request') return;
    const req = sanitizeRequestId(d.req);
    const action = sanitizeString(d.action, 64);
    if (!req || !action || !BACKUP_ACTIONS.has(action)) return;
    const payload = sanitizeBackupPayload(action, d.payload);
    try {
      chrome.runtime.sendMessage({ action, payload }, (response) => {
        try {
          window.postMessage(
            {
              __sora_uv__: true,
              type: 'backup_response',
              req,
              action,
              response: response || null,
              hadRuntimeError: !!chrome.runtime.lastError,
            },
            PAGE_ORIGIN
          );
        } catch {}
      });
    } catch {
      try {
        window.postMessage(
          {
            __sora_uv__: true,
            type: 'backup_response',
            req,
            action,
            response: null,
            hadRuntimeError: true,
          },
          PAGE_ORIGIN
        );
      } catch {}
    }
  });

  // Relay background backup status pushes back into the page context.
  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.action === 'ultra_mode_changed') {
        syncUltraModePreference();
        return false;
      }
      if (message?.action === 'backup_page_fetch') {
        const payload = sanitizeBackupPageFetchPayload(message.payload);
        if (!payload) {
          try {
            sendResponse({ ok: false, error: 'invalid_backup_page_fetch' });
          } catch {}
          return false;
        }
        requestPageBackupFetch(payload)
          .then((response) => {
            try {
              sendResponse(response || { ok: false, error: 'backup_page_fetch_empty' });
            } catch {}
          })
          .catch((err) => {
            try {
              sendResponse({ ok: false, error: sanitizeString(err?.message || String(err), MAX_STR_LEN) || 'backup_page_fetch_failed' });
            } catch {}
          });
        return true;
      }
      if (message?.action !== 'backup_run_event') return false;
      try {
        window.postMessage(
          { __sora_uv__: true, type: 'backup_run_event', event: message.event || null },
          PAGE_ORIGIN
        );
      } catch {}
      return false;
    });
  } catch {}

  window.addEventListener('message', function(ev) {
    if (ev?.source !== window) return;
    const d = ev?.data;
    if (!d || d.__sora_uv__ !== true || d.type !== 'backup_page_fetch_response') return;
    const req = sanitizeRequestId(d.req);
    if (!req) return;
    const pending = pendingBackupPageFetches.get(req);
    if (!pending) return;
    pendingBackupPageFetches.delete(req);
    clearTimeout(pending.timerId);
    pending.resolve(d.response || { ok: false, error: 'backup_page_fetch_empty' });
  });
})();
