/*
 * Shared bulk-backup logic for Creator Tools runtime + tests.
 */
(function initUVBackupLogic(globalScope) {
  'use strict';

  const BACKUP_SCOPE_KEYS = ['ownDrafts', 'ownPosts', 'castInPosts', 'castInDrafts'];
  const DEFAULT_BACKUP_SCOPES = Object.freeze({
    ownDrafts: true,
    ownPosts: true,
    castInPosts: true,
    castInDrafts: true,
  });
  const TERMINAL_RUN_STATUSES = new Set(['completed', 'cancelled', 'failed']);
  const RUN_STATUS_VALUES = new Set([
    'idle',
    'discovering',
    'queued',
    'running',
    'paused',
    'completed',
    'cancelled',
    'failed',
  ]);
  const ITEM_STATUS_VALUES = new Set(['queued', 'downloading', 'done', 'skipped', 'failed']);
  const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'm4v']);
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);
  const SIGNED_URL_MIN_REMAINING_MS = 15 * 60 * 1000;

  function normalizeString(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
  }

  function normalizeLower(value) {
    return normalizeString(value).toLowerCase();
  }

  function normalizeId(value) {
    const text = normalizeString(value);
    if (!text) return '';
    return /^[A-Za-z0-9:_./-]+$/.test(text) ? text : text;
  }

  function normalizeUrl(value) {
    const text = normalizeString(value);
    if (!/^https?:\/\//i.test(text)) return '';
    return text;
  }

  function cloneScopes(scopes) {
    return {
      ownDrafts: scopes.ownDrafts === true,
      ownPosts: scopes.ownPosts === true,
      castInPosts: scopes.castInPosts === true,
      castInDrafts: scopes.castInDrafts === true,
    };
  }

  function normalizeBackupScopes(raw) {
    const base = cloneScopes(DEFAULT_BACKUP_SCOPES);
    if (!raw || typeof raw !== 'object') return base;
    for (const key of BACKUP_SCOPE_KEYS) {
      if (raw[key] === true || raw[key] === false) base[key] = raw[key];
    }
    return base;
  }

  function normalizeBackupHeaders(raw) {
    const headers = {};
    if (!raw || typeof raw !== 'object') return headers;
    const auth = normalizeString(raw.Authorization || raw.authorization);
    const device = normalizeString(raw['OAI-Device-Id'] || raw['oai-device-id']);
    const language = normalizeString(raw['OAI-Language'] || raw['oai-language']);
    if (auth) headers.Authorization = auth;
    if (device) headers['OAI-Device-Id'] = device;
    if (language) headers['OAI-Language'] = language;
    return headers;
  }

  function normalizeRunStatus(value) {
    const status = normalizeLower(value);
    return RUN_STATUS_VALUES.has(status) ? status : 'idle';
  }

  function normalizeItemStatus(value) {
    const status = normalizeLower(value);
    return ITEM_STATUS_VALUES.has(status) ? status : 'queued';
  }

  function isTerminalRunStatus(value) {
    return TERMINAL_RUN_STATUSES.has(normalizeRunStatus(value));
  }

  function buildBackupRunId(now = Date.now()) {
    const stamp = Math.max(0, Number(now) || Date.now()).toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `backup_${stamp}_${rand}`;
  }

  function buildBackupRunStamp(value) {
    const ts = Number(value);
    const date = Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date();
    return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  }

  function makeBackupItemKey(runId, kind, id) {
    return `${normalizeString(runId)}:${normalizeString(kind)}:${normalizeString(id)}`;
  }

  function normalizeOwnerIdentity(raw) {
    if (!raw || typeof raw !== 'object') return { handle: '', id: '' };
    const handle = normalizeString(
      raw.handle ||
      raw.username ||
      raw.name ||
      raw.user_handle
    );
    const id = normalizeString(raw.id || raw.user_id || raw._id || raw.userId);
    return { handle, id };
  }

  function sameOwnerIdentity(left, right) {
    const a = normalizeOwnerIdentity(left);
    const b = normalizeOwnerIdentity(right);
    if (a.id && b.id) return a.id === b.id;
    if (a.handle && b.handle) return a.handle.toLowerCase() === b.handle.toLowerCase();
    return false;
  }

  function extractOwnerIdentity(payload) {
    if (!payload || typeof payload !== 'object') return { handle: '', id: '' };
    const root = payload.post && typeof payload.post === 'object' ? payload.post : payload;
    const profile =
      payload.profile ||
      payload.owner_profile ||
      payload.user ||
      payload.author ||
      root.author ||
      root.owner ||
      root.profile ||
      null;
    const owner = normalizeOwnerIdentity({
      handle: profile?.username || profile?.handle || profile?.name || payload?.user_handle,
      id: root?.shared_by || profile?.user_id || profile?.id || profile?._id || payload?.user_id,
    });
    return owner;
  }

  function normalizeCurrentUser(raw) {
    if (!raw || typeof raw !== 'object') return { handle: '', id: '' };
    return normalizeOwnerIdentity({
      handle:
        raw.username ||
        raw.handle ||
        raw.name ||
        raw.profile?.username ||
        raw.profile?.handle ||
        raw.user_handle,
      id:
        raw.user_id ||
        raw.id ||
        raw.profile?.user_id ||
        raw.profile?.id ||
        raw.user_id,
    });
  }

  function shouldExcludeAppearanceOwner(owner, currentUser) {
    return sameOwnerIdentity(owner, currentUser);
  }

  function parseTimestampMs(value) {
    if (value == null || value === '') return 0;
    if (Number.isFinite(Number(value))) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return n > 1e12 ? Math.floor(n) : Math.floor(n * 1000);
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function inferFileExtension(url, mimeType) {
    const normalizedMime = normalizeLower(mimeType);
    if (normalizedMime.includes('video/mp4')) return 'mp4';
    if (normalizedMime.includes('video/quicktime')) return 'mov';
    if (normalizedMime.includes('video/webm')) return 'webm';
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) return 'mp4';
    try {
      const path = new URL(normalizedUrl).pathname;
      const match = path.match(/\.([a-z0-9]+)$/i);
      if (match && VIDEO_EXTENSIONS.has(match[1].toLowerCase())) return match[1].toLowerCase();
    } catch {}
    return 'mp4';
  }

  function extractSignedUrlExpiry(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return 0;
    try {
      const parsed = new URL(normalized);
      const candidates = [
        parsed.searchParams.get('se'),
        parsed.searchParams.get('expires'),
        parsed.searchParams.get('Expires'),
        parsed.searchParams.get('exp'),
      ].filter(Boolean);
      for (const value of candidates) {
        const decoded = decodeURIComponent(String(value));
        const dateMs = parseTimestampMs(decoded);
        if (dateMs > 0) return dateMs;
      }
    } catch {}
    return 0;
  }

  function isSignedUrlFresh(url, refreshedAt = 0, now = Date.now(), minRemainingMs = SIGNED_URL_MIN_REMAINING_MS) {
    const expiryMs = extractSignedUrlExpiry(url);
    if (!expiryMs) return !!normalizeUrl(url);
    const refreshedMs = parseTimestampMs(refreshedAt);
    if (!refreshedMs) return (expiryMs - Number(now || Date.now())) > minRemainingMs;
    return (expiryMs - Number(now || Date.now())) > minRemainingMs;
  }

  function isImageLikeUrl(url, keyPath) {
    const loweredKey = normalizeLower(keyPath);
    if (/(thumb|thumbnail|image|poster|avatar|sprite|firstframe|first_frame|preview_image)/.test(loweredKey)) {
      return true;
    }
    const normalized = normalizeUrl(url);
    if (!normalized) return false;
    try {
      const path = new URL(normalized).pathname;
      const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';
      return IMAGE_EXTENSIONS.has(ext);
    } catch {
      return false;
    }
  }

  function isNavigationLikeUrl(url, keyPath) {
    const loweredKey = normalizeLower(keyPath);
    if (/(permalink|href|link|page_url|post_url|detail_url)/.test(loweredKey)) return true;
    const normalized = normalizeUrl(url);
    if (!normalized) return false;
    try {
      const parsed = new URL(normalized);
      return /sora\.chatgpt\.com$/i.test(parsed.hostname) && !/videos\.openai\.com$/i.test(parsed.hostname);
    } catch {
      return false;
    }
  }

  function isVideoLikeUrl(url, keyPath) {
    const normalized = normalizeUrl(url);
    if (!normalized || isImageLikeUrl(normalized, keyPath) || isNavigationLikeUrl(normalized, keyPath)) return false;
    const loweredKey = normalizeLower(keyPath);
    if (/(raw|video|download|source|attachment|media|preview|stream|src|url|path)/.test(loweredKey)) return true;
    try {
      const parsed = new URL(normalized);
      const ext = parsed.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';
      if (VIDEO_EXTENSIONS.has(ext)) return true;
      if (/videos\.openai\.com$/i.test(parsed.hostname)) return true;
      if (/\/raw(?:$|[/?])/.test(parsed.pathname)) return true;
    } catch {}
    return false;
  }

  function scoreCandidate(url, keyPath, variant, bias = 0) {
    let score = 40 + Number(bias || 0);
    const loweredKey = normalizeLower(keyPath);
    const normalized = normalizeUrl(url);
    if (variant === 'no_watermark') score += 50;
    else if (variant === 'watermark') score += 30;
    else score += 10;
    if (/(encodings\.source|download_urls\.no_watermark|no[_-]?watermark|raw)/.test(loweredKey)) score += 25;
    if (/(downloadable_url|download|source|attachment)/.test(loweredKey)) score += 15;
    if (/(preview|stream|drvs)/.test(loweredKey)) score -= 10;
    try {
      const parsed = new URL(normalized);
      if (/videos\.openai\.com$/i.test(parsed.hostname)) score += 10;
      if (/\/raw(?:$|[/?])/.test(parsed.pathname)) score += 8;
      if (/\/drvs\//.test(parsed.pathname)) score -= 8;
      const ext = parsed.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';
      if (VIDEO_EXTENSIONS.has(ext)) score += 8;
    } catch {}
    return score;
  }

  function addCandidate(list, seen, url, variant, keyPath, mimeType, bias) {
    const normalized = normalizeUrl(url);
    if (!normalized || !isVideoLikeUrl(normalized, keyPath) || seen.has(normalized)) return;
    seen.add(normalized);
    list.push({
      url: normalized,
      variant,
      keyPath,
      mimeType: normalizeString(mimeType),
      score: scoreCandidate(normalized, keyPath, variant, bias),
    });
  }

  function walkVideoCandidates(list, seen, value, keyPath = '', depth = 0) {
    if (depth > 3 || value == null) return;
    if (typeof value === 'string') {
      const loweredKey = normalizeLower(keyPath);
      let variant = 'unknown_fallback';
      if (/(no[_-]?watermark|encodings\.source(?:\.|$)|source_path)/.test(loweredKey)) variant = 'no_watermark';
      else if (/(watermark|source_wm|_wm(?:\.|$)|\.wm(?:\.|$))/.test(loweredKey)) variant = 'watermark';
      addCandidate(list, seen, value, variant, keyPath, '', 0);
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        walkVideoCandidates(list, seen, value[i], `${keyPath}[${i}]`, depth + 1);
      }
      return;
    }
    if (typeof value !== 'object') return;

    const directMime = normalizeString(value.mime_type || value.content_type || value.type);
    const directUrl = value.url || value.src || value.path || value.raw_url || value.video_url || value.download_url || value.downloadable_url || '';
    const loweredKey = normalizeLower(keyPath);
    if (directUrl) {
      let variant = 'unknown_fallback';
      if (/(no[_-]?watermark|encodings\.source(?:\.|$)|source_path)/.test(loweredKey)) variant = 'no_watermark';
      else if (/(watermark|source_wm|_wm(?:\.|$)|\.wm(?:\.|$))/.test(loweredKey)) variant = 'watermark';
      addCandidate(list, seen, directUrl, variant, keyPath ? `${keyPath}.url` : 'url', directMime, 0);
    }

    for (const [key, entry] of Object.entries(value)) {
      const nextKey = keyPath ? `${keyPath}.${key}` : key;
      walkVideoCandidates(list, seen, entry, nextKey, depth + 1);
    }
  }

  function pickBestCandidate(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    return candidates
      .slice()
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return String(left.keyPath || '').localeCompare(String(right.keyPath || ''));
      })[0] || null;
  }

  function collectExplicitDraftCandidates(payload) {
    const candidates = [];
    const seen = new Set();
    const root = payload?.draft && typeof payload.draft === 'object' ? payload.draft : payload;
    addCandidate(candidates, seen, root?.encodings?.source?.path, 'no_watermark', 'encodings.source.path', '', 30);
    addCandidate(candidates, seen, root?.download_urls?.no_watermark, 'no_watermark', 'download_urls.no_watermark', '', 28);
    addCandidate(candidates, seen, root?.downloadable_url, 'unknown_fallback', 'downloadable_url', '', 18);
    addCandidate(candidates, seen, root?.encodings?.source_wm?.path, 'watermark', 'encodings.source_wm.path', '', 24);
    addCandidate(candidates, seen, root?.download_urls?.watermark, 'watermark', 'download_urls.watermark', '', 22);
    walkVideoCandidates(candidates, seen, root?.attachments || [], 'attachments', 0);
    walkVideoCandidates(candidates, seen, root, 'draft', 0);
    return candidates;
  }

  function pickDraftMediaSource(payload) {
    const candidate = pickBestCandidate(collectExplicitDraftCandidates(payload));
    if (!candidate) return null;
    return {
      url: candidate.url,
      variant: candidate.variant,
      ext: inferFileExtension(candidate.url, candidate.mimeType),
      mimeType: candidate.mimeType,
      keyPath: candidate.keyPath,
    };
  }

  function pickPublishedMediaSource(payload) {
    const candidates = [];
    const seen = new Set();
    const root = payload?.post && typeof payload.post === 'object' ? payload.post : payload;
    addCandidate(candidates, seen, root?.encodings?.source?.path, 'no_watermark', 'post.encodings.source.path', '', 30);
    addCandidate(candidates, seen, root?.download_urls?.no_watermark, 'no_watermark', 'post.download_urls.no_watermark', '', 28);
    addCandidate(candidates, seen, root?.downloadable_url, 'unknown_fallback', 'post.downloadable_url', '', 16);
    addCandidate(candidates, seen, root?.encodings?.source_wm?.path, 'watermark', 'post.encodings.source_wm.path', '', 24);
    addCandidate(candidates, seen, root?.download_urls?.watermark, 'watermark', 'post.download_urls.watermark', '', 22);
    walkVideoCandidates(candidates, seen, root?.attachments || [], 'post.attachments', 0);
    walkVideoCandidates(candidates, seen, root, 'post', 0);
    const candidate = pickBestCandidate(candidates);
    if (!candidate) return null;
    return {
      url: candidate.url,
      variant: candidate.variant,
      ext: inferFileExtension(candidate.url, candidate.mimeType),
      mimeType: candidate.mimeType,
      keyPath: candidate.keyPath,
    };
  }

  function pickBackupMediaSource(kind, payload) {
    const normalizedKind = normalizeLower(kind);
    if (normalizedKind === 'draft') return pickDraftMediaSource(payload);
    if (normalizedKind === 'published') return pickPublishedMediaSource(payload);
    return null;
  }

  function getRunCountBucketForItemStatus(status) {
    const normalized = normalizeItemStatus(status);
    if (normalized === 'downloading') return 'downloading';
    if (normalized === 'done') return 'done';
    if (normalized === 'failed') return 'failed';
    if (normalized === 'skipped') return 'skipped';
    return 'queued';
  }

  function cloneBackupCounts(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      discovered: Number.isFinite(Number(source.discovered)) ? Number(source.discovered) : 0,
      queued: Number.isFinite(Number(source.queued)) ? Number(source.queued) : 0,
      downloading: Number.isFinite(Number(source.downloading)) ? Number(source.downloading) : 0,
      done: Number.isFinite(Number(source.done)) ? Number(source.done) : 0,
      skipped: Number.isFinite(Number(source.skipped)) ? Number(source.skipped) : 0,
      failed: Number.isFinite(Number(source.failed)) ? Number(source.failed) : 0,
    };
  }

  function applyBackupStatusTransition(counts, fromStatus, toStatus) {
    const next = cloneBackupCounts(counts);
    const fromBucket = fromStatus ? getRunCountBucketForItemStatus(fromStatus) : '';
    const toBucket = toStatus ? getRunCountBucketForItemStatus(toStatus) : '';
    if (fromBucket && Number.isFinite(Number(next[fromBucket])) && next[fromBucket] > 0) next[fromBucket] -= 1;
    if (toBucket) next[toBucket] = (Number(next[toBucket]) || 0) + 1;
    return next;
  }

  function createEmptyBackupCounts() {
    return cloneBackupCounts({});
  }

  function buildBackupPanelState(run, options = {}) {
    const status = normalizeRunStatus(run?.status || 'idle');
    const active = !!(run?.id && !isTerminalRunStatus(status));
    const busy = options.busy === true;
    const exporting = options.exporting === true;
    const hasAuth = options.hasAuth === true;
    return {
      active,
      terminal: !!(run?.id && isTerminalRunStatus(status)),
      showPause: status === 'running',
      showResume: status === 'paused',
      showCancel: active || status === 'paused',
      canStart: !active && !busy && hasAuth,
      canRefresh: !busy,
      canExport: !!run?.id && !exporting,
    };
  }

  const api = {
    BACKUP_SCOPE_KEYS,
    DEFAULT_BACKUP_SCOPES,
    SIGNED_URL_MIN_REMAINING_MS,
    normalizeBackupScopes,
    normalizeBackupHeaders,
    normalizeRunStatus,
    normalizeItemStatus,
    isTerminalRunStatus,
    buildBackupRunId,
    buildBackupRunStamp,
    makeBackupItemKey,
    normalizeOwnerIdentity,
    extractOwnerIdentity,
    normalizeCurrentUser,
    sameOwnerIdentity,
    shouldExcludeAppearanceOwner,
    parseTimestampMs,
    inferFileExtension,
    extractSignedUrlExpiry,
    isSignedUrlFresh,
    pickDraftMediaSource,
    pickPublishedMediaSource,
    pickBackupMediaSource,
    getRunCountBucketForItemStatus,
    applyBackupStatusTransition,
    createEmptyBackupCounts,
    cloneBackupCounts,
    buildBackupPanelState,
  };

  globalScope.SoraUVBackupLogic = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
