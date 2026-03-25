const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAGE_PATH = path.join(__dirname, '..', 'uv-drafts-page.js');

function extractSnippet(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label} start not found`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${label} end not found`);
  return source.slice(start, end);
}

function buildPageBridgeHarness(fetchImpl) {
  const src = fs.readFileSync(PAGE_PATH, 'utf8');
  const snippet = extractSnippet(
    src,
    'function sanitizeRequestId(value) {',
    'function applyBackupRunUpdate(run, message = \'\') {',
    'uv drafts page backup bridge snippet'
  );

  const responses = [];
  const context = {
    URL,
    location: { origin: 'https://sora.chatgpt.com' },
    window: {
      postMessage(message) {
        responses.push(message);
      },
    },
    fetch: fetchImpl,
  };

  vm.createContext(context);
  vm.runInContext(
    `
${snippet}
globalThis.__handleBackupPageFetchBridgeRequest = handleBackupPageFetchBridgeRequest;
`,
    context,
    { filename: 'uv-drafts-page-backup-bridge-harness.js' }
  );

  return {
    handleBackupPageFetchBridgeRequest: context.__handleBackupPageFetchBridgeRequest,
    responses,
  };
}

test('handleBackupPageFetchBridgeRequest posts a bridged page fetch response', async () => {
  const { handleBackupPageFetchBridgeRequest, responses } = buildPageBridgeHarness(async (url, init) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        url,
        authorization: init?.headers?.Authorization || '',
      });
    },
  }));

  await handleBackupPageFetchBridgeRequest({
    req: 'backup_page_fetch_1',
    payload: {
      pathname: '/backend/project_y/profile_feed/me',
      params: { limit: 20, cut: 'nf2' },
      headers: { Authorization: 'Bearer token' },
    },
  });

  assert.equal(responses.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(responses[0])), {
    __sora_uv__: true,
    type: 'backup_page_fetch_response',
    req: 'backup_page_fetch_1',
    response: {
      ok: true,
      status: 200,
      json: {
        ok: true,
        url: 'https://sora.chatgpt.com/backend/project_y/profile_feed/me?limit=20&cut=nf2',
        authorization: 'Bearer token',
      },
      error: '',
    },
  });
});

test('handleBackupPageFetchBridgeRequest rejects invalid request ids before fetching', async () => {
  let called = false;
  const { handleBackupPageFetchBridgeRequest, responses } = buildPageBridgeHarness(async () => {
    called = true;
    throw new Error('fetch should not run');
  });

  await handleBackupPageFetchBridgeRequest({
    req: 'not allowed!',
    payload: {
      pathname: '/backend/project_y/profile_feed/me',
    },
  });

  assert.equal(called, false);
  assert.equal(responses.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(responses[0])), {
    __sora_uv__: true,
    type: 'backup_page_fetch_response',
    req: '',
    response: {
      ok: false,
      status: 0,
      error: 'invalid_backup_page_fetch',
    },
  });
});
