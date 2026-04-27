const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_PATH = path.join(__dirname, '..', 'content.js');

function extractSnippet(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label} start not found`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${label} end not found`);
  return source.slice(start, end);
}

function buildBackupHarness() {
  const src = fs.readFileSync(CONTENT_PATH, 'utf8');
  const snippet = extractSnippet(
    src,
    'function sanitizeBackupHeaders(raw) {',
    'function sanitizeRequestId(value) {',
    'content backup sanitizer snippet'
  );
  const context = {
    MAX_STR_LEN: 4096,
    MAX_ID_LEN: 128,
    MAX_URL_LEN: 2048,
    MAX_BACKUP_FETCH_PARAMS: 20,
    MAX_BACKUP_BASELINE_KEYS: 100000,
  };
  vm.createContext(context);
  vm.runInContext(
    `
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
${snippet}
globalThis.__sanitizeBackupHeaders = sanitizeBackupHeaders;
globalThis.__sanitizeBackupScopes = sanitizeBackupScopes;
globalThis.__sanitizeBackupPayload = sanitizeBackupPayload;
globalThis.__sanitizeBackupPageFetchPayload = sanitizeBackupPageFetchPayload;
`,
    context,
    { filename: 'content-backup-harness.js' }
  );
  return {
    sanitizeBackupHeaders: context.__sanitizeBackupHeaders,
    sanitizeBackupScopes: context.__sanitizeBackupScopes,
    sanitizeBackupPayload: context.__sanitizeBackupPayload,
    sanitizeBackupPageFetchPayload: context.__sanitizeBackupPageFetchPayload,
  };
}

test('sanitizeBackupPayload keeps only supported headers and scope booleans', () => {
  const { sanitizeBackupPayload } = buildBackupHarness();
  const out = sanitizeBackupPayload('backup_start', {
    scopes: { ownDrafts: true, ownPosts: false, castInPosts: true, castInDrafts: false },
    headers: {
      Authorization: 'Bearer token',
      'OAI-Device-Id': 'device_123',
      'OAI-Language': 'en-US',
      Cookie: 'do-not-forward',
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(out.scopes)), {
    ownDrafts: true,
    ownPosts: false,
    castInPosts: true,
    castInDrafts: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(out.headers)), {
    Authorization: 'Bearer token',
    'OAI-Device-Id': 'device_123',
    'OAI-Language': 'en-US',
  });
});

test('sanitizeBackupPayload preserves a deduped baseline manifest for incremental backups', () => {
  const { sanitizeBackupPayload } = buildBackupHarness();
  const out = sanitizeBackupPayload('backup_start', {
    scopes: { ownDrafts: true },
    headers: { Authorization: 'Bearer token' },
    baseline_manifest: {
      filename: 'sora_backup_manifest_2026-03-25_12-38-28.jsonl',
      total_rows: 42,
      backed_up_rows: 40,
      keys: [
        'published:post_123',
        'published:post_123',
        'draft:draft_456',
        'not valid!',
      ],
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(out.baseline_manifest)), {
    filename: 'sora_backup_manifest_2026-03-25_12-38-28.jsonl',
    total_rows: 42,
    backed_up_rows: 40,
    keys: [
      'published:post_123',
      'draft:draft_456',
    ],
  });
});

test('sanitizeBackupPayload normalizes manifest requests', () => {
  const { sanitizeBackupPayload } = buildBackupHarness();
  const out = sanitizeBackupPayload('backup_manifest_request', {
    runId: 'backup_abc123',
    format: 'summary',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(out)), {
    runId: 'backup_abc123',
    format: 'summary',
  });
});

test('sanitizeBackupPageFetchPayload only keeps backend paths, capped params, and supported headers', () => {
  const { sanitizeBackupPageFetchPayload } = buildBackupHarness();
  const longCursor = 'c'.repeat(400);
  const out = sanitizeBackupPageFetchPayload({
    pathname: '/backend/project_y/profile_feed/me',
    params: {
      limit: 20,
      cut: 'nf2',
      empty: '',
      cursor: null,
      next_cursor: longCursor,
    },
    headers: {
      Authorization: 'Bearer token',
      'OAI-Device-Id': 'device_123',
      Cookie: 'blocked',
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(out)), {
    pathname: '/backend/project_y/profile_feed/me',
    params: {
      limit: '20',
      cut: 'nf2',
      next_cursor: longCursor,
    },
    headers: {
      Authorization: 'Bearer token',
      'OAI-Device-Id': 'device_123',
    },
  });

  assert.equal(
    sanitizeBackupPageFetchPayload({ pathname: 'https://evil.example/not-allowed' }),
    null
  );
});

test('Creator Tools injection loads backup logic before the page module', () => {
  const src = fs.readFileSync(CONTENT_PATH, 'utf8');
  const logicIndex = src.indexOf("injectPageScript('uv-drafts-logic.js'");
  const backupIndex = src.indexOf("injectPageScript('uv-backup-logic.js'");
  const pageIndex = src.indexOf("injectPageScript('uv-drafts-page.js'");

  assert.ok(logicIndex > -1, 'uv-drafts-logic.js should be injected');
  assert.ok(backupIndex > logicIndex, 'uv-backup-logic.js should load after uv-drafts-logic.js');
  assert.ok(pageIndex > backupIndex, 'uv-drafts-page.js should load after uv-backup-logic.js');
});
