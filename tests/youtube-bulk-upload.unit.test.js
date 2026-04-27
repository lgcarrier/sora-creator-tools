const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDescription,
  buildTags,
  buildUploadKey,
  buildUploadPayload,
  describePriorUpload,
  ensureAuthorizedChannel,
  getAuthenticatedClient,
  inferDownloadRootFromManifest,
  isInvalidGrantError,
  main,
  normalizeChannelHandle,
  parseGrantedScopes,
  parseArgs,
  parseManifestText,
  readStateStore,
  readStateIndex,
  resolveDownloadRoot,
  resolveVideoPath,
  shouldSkipItem,
  tokenHasRequiredScopes,
} = require('../scripts/youtube-bulk-upload.js');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFixtureRun() {
  const tempRoot = createTempDir('sora-youtube-upload-');
  const backupRoot = path.join(tempRoot, 'Sora Backup');
  const runDir = path.join(backupRoot, '2026-03-25_12-38-28');
  const ownPostsDir = path.join(runDir, 'ownPosts');
  fs.mkdirSync(ownPostsDir, { recursive: true });

  const fixtureText = fs.readFileSync(path.join(__dirname, 'fixtures', 'youtube-upload-manifest.jsonl'), 'utf8');
  const manifestPath = path.join(runDir, 'sora_backup_manifest_2026-03-25_12-38-28.jsonl');
  fs.writeFileSync(manifestPath, fixtureText, 'utf8');
  fs.writeFileSync(path.join(ownPostsDir, 'post_123.mp4'), 'demo-1');
  fs.writeFileSync(path.join(ownPostsDir, 'post_456.mp4'), 'demo-2');

  return { tempRoot, manifestPath };
}

test('parseManifestText ignores blank lines and parses rows', () => {
  const rows = parseManifestText('{"id":"one"}\n\n{"id":"two"}\n', 'fixture.jsonl');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'one');
  assert.equal(rows[1].id, 'two');
});

test('inferDownloadRootFromManifest finds the parent above Sora Backup', () => {
  const manifestPath = path.join('/Users/example/Downloads', 'Sora Backup', '2026-03-25_12-38-28', 'manifest.jsonl');
  assert.equal(inferDownloadRootFromManifest(manifestPath), path.join('/Users/example/Downloads'));
  assert.equal(resolveDownloadRoot(manifestPath, ''), path.join('/Users/example/Downloads'));
});

test('normalizeChannelHandle strips leading at-signs and validates shape', () => {
  assert.equal(normalizeChannelHandle('@AIDaredevils'), 'AIDaredevils');
  assert.equal(normalizeChannelHandle('AIDaredevils'), 'AIDaredevils');
  assert.throws(() => normalizeChannelHandle('bad handle'), /--channel-handle/);
});

test('parseArgs stores normalized channel handles', () => {
  const out = parseArgs([
    '--manifest',
    '/tmp/manifest.jsonl',
    '--oauth-client',
    '/tmp/client_secret.json',
    '--channel-handle',
    '@AIDaredevils',
  ]);
  assert.equal(out.channelHandle, 'AIDaredevils');
});

test('parseGrantedScopes and tokenHasRequiredScopes recognize the upload plus readonly scope set', () => {
  const scopes = parseGrantedScopes(
    'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly'
  );
  assert.deepEqual(scopes, [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ]);
  assert.equal(
    tokenHasRequiredScopes({
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    }),
    true
  );
  assert.equal(
    tokenHasRequiredScopes({
      scope: 'https://www.googleapis.com/auth/youtube.upload',
    }),
    false
  );
});

test('isInvalidGrantError recognizes invalid_grant responses', () => {
  const err = new Error('Request failed');
  err.response = { data: { error: 'invalid_grant' } };
  assert.equal(isInvalidGrantError(err), true);
  assert.equal(isInvalidGrantError(new Error('invalid_grant')), true);
  assert.equal(isInvalidGrantError(new Error('network timeout')), false);
});

test('resolveVideoPath joins manifest filenames under the download root', () => {
  const out = resolveVideoPath(
    { filename: 'Sora Backup/2026-03-25_12-38-28/ownPosts/post_123.mp4' },
    path.join('/Users/example/Downloads')
  );
  assert.equal(
    out,
    path.join('/Users/example/Downloads', 'Sora Backup', '2026-03-25_12-38-28', 'ownPosts', 'post_123.mp4')
  );
});

test('resolveVideoPath keeps absolute manifest filenames unchanged', () => {
  const absolutePath = path.join('/Users/example/Downloads', 'Sora Backup', '2026-03-25_12-38-28', 'ownPosts', 'post_123.mp4');
  assert.equal(
    resolveVideoPath({ filename: absolutePath }, path.join('/Users/example/Downloads')),
    absolutePath
  );
});

test('buildUploadPayload maps manifest metadata into YouTube fields', () => {
  const payload = buildUploadPayload(
    {
      title: 'Morning Orbit',
      prompt: 'Unused prompt fallback',
      owner_handle: 'aidaredevils',
      owner_id: 'user_123',
      cast_names: ['Alex', 'Jordan', 'Alex'],
      created_at: '2026-03-25T12:38:28Z',
      posted_at: '2026-03-25T13:00:00Z',
      detail_url: 'https://sora.example/detail/post_123',
      post_permalink: 'https://sora.example/post/post_123',
    },
    '/tmp/post_123.mp4',
    {
      categoryId: '22',
      privacy: 'private',
      notifySubscribers: false,
      madeForKids: false,
    }
  );

  assert.equal(payload.requestBody.snippet.title, 'Morning Orbit');
  assert.equal(payload.requestBody.snippet.categoryId, '22');
  assert.equal(payload.requestBody.status.privacyStatus, 'private');
  assert.equal(payload.requestBody.status.selfDeclaredMadeForKids, false);
  assert.deepEqual(payload.requestBody.snippet.tags, ['Alex', 'Jordan', 'aidaredevils', 'sora']);
  assert.match(payload.requestBody.snippet.description, /Owner: @aidaredevils/);
  assert.match(payload.requestBody.snippet.description, /Sora post: https:\/\/sora\.example\/post\/post_123/);
});

test('buildDescription composes prompt and metadata blocks', () => {
  const description = buildDescription({
    prompt: 'Camera drifts through a neon observatory above the clouds.',
    owner_handle: 'aidaredevils',
    cast_names: ['Alex', 'Jordan'],
    created_at: '2026-03-25T12:38:28Z',
  });

  assert.match(description, /^Camera drifts through a neon observatory above the clouds\./);
  assert.match(description, /Owner: @aidaredevils/);
  assert.match(description, /Cast: Alex, Jordan/);
});

test('buildDescription replaces forbidden angle brackets and normalizes numeric timestamps', () => {
  const description = buildDescription({
    prompt: 'Line one\n\n> quoted <warning>',
    owner_handle: 'aidaredevils',
    posted_at: 1759775553.728873,
  });

  assert.equal(description.includes('<'), false);
  assert.equal(description.includes('>'), false);
  assert.match(description, /\] quoted \[warning\]/);
  assert.match(description, /Posted: 2025-10-06T/);
});

test('buildTags deduplicates derived tags and preserves order', () => {
  assert.deepEqual(
    buildTags({
      cast_names: ['Alex', 'Jordan', 'Alex'],
      owner_handle: '@aidaredevils',
    }),
    ['Alex', 'Jordan', 'aidaredevils', 'sora']
  );
});

test('readStateIndex and shouldSkipItem honor uploaded and failed records', () => {
  const stateStore = readStateStore([
    JSON.stringify({
      item_key: 'item-1',
      upload_key: 'channel:UC123::published:post_123',
      status: 'uploaded',
      updated_at: '2026-03-26T00:00:00.000Z',
      youtube_url: 'https://www.youtube.com/watch?v=video123',
      title: 'Morning Orbit',
    }),
    JSON.stringify({
      item_key: 'item-2',
      upload_key: 'channel:UC123::published:post_456',
      status: 'failed',
      error: 'network timeout',
    }),
  ].join('\n'));

  const uploadedSkip = shouldSkipItem('item-1', 'channel:UC123::published:post_123', stateStore, false);
  assert.equal(uploadedSkip.skip, true);
  assert.match(uploadedSkip.reason, /already uploaded/);
  assert.match(uploadedSkip.reason, /Morning Orbit/);
  assert.match(uploadedSkip.reason, /youtube\.com\/watch\?v=video123/);

  assert.deepEqual(
    shouldSkipItem('item-2', 'channel:UC123::published:post_456', stateStore, false),
    { skip: true, reason: 'previous failure recorded (network timeout)', previous: stateStore.byUploadKey.get('channel:UC123::published:post_456') }
  );
  assert.deepEqual(shouldSkipItem('item-2', 'channel:UC123::published:post_456', stateStore, true), { skip: false, reason: '' });
  assert.deepEqual(shouldSkipItem('item-3', 'channel:UC123::published:post_789', stateStore, false), { skip: false, reason: '' });
});

test('buildUploadKey is stable across manifest runs for the same channel and Sora item id', () => {
  const itemA = {
    item_key: 'backup_run_a:published:post_123',
    kind: 'published',
    id: 'post_123',
    filename: '/tmp/run-a/post_123.mp4',
  };
  const itemB = {
    item_key: 'backup_run_b:published:post_123',
    kind: 'published',
    id: 'post_123',
    filename: '/tmp/run-b/post_123.mp4',
  };
  assert.equal(
    buildUploadKey(itemA, '/tmp/run-a/post_123.mp4', 'channel:UC123'),
    buildUploadKey(itemB, '/tmp/run-b/post_123.mp4', 'channel:UC123')
  );
});

test('describePriorUpload formats a useful upload log summary', () => {
  assert.match(
    describePriorUpload({
      title: 'Morning Orbit',
      updated_at: '2026-03-26T00:00:00.000Z',
      youtube_url: 'https://www.youtube.com/watch?v=video123',
    }),
    /Morning Orbit.*2026-03-26T00:00:00.000Z.*video123/
  );
});

test('ensureAuthorizedChannel succeeds when the requested handle matches an owned channel', async () => {
  const calls = [];
  const youtube = {
    channels: {
      list: async (params) => {
        calls.push(params);
        if (params.forHandle) {
          return {
            data: {
              items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }],
            },
          };
        }
        return {
          data: {
            items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }],
          },
        };
      },
    },
  };
  const logs = [];

  const out = await ensureAuthorizedChannel(youtube, '@AIDaredevils', {
    log: (line) => logs.push(String(line)),
  });

  assert.equal(out.requestedHandle, '@AIDaredevils');
  assert.equal(out.expectedChannelId, 'UC123');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { part: 'id,snippet', forHandle: '@AIDaredevils', maxResults: 1 });
  assert.deepEqual(calls[1], { part: 'id,snippet', mine: true, maxResults: 50 });
  assert.match(logs[0], /Verified YouTube channel @AIDaredevils/);
});

test('getAuthenticatedClient reauthorizes when the stored token refresh fails with invalid_grant', async () => {
  const tempRoot = createTempDir('sora-youtube-auth-');
  const oauthClientPath = path.join(tempRoot, 'client_secret.json');
  const tokenPath = path.join(tempRoot, 'token.json');
  const logs = [];
  const authenticateCalls = [];

  class FakeOAuth2Client {
    constructor(clientId, clientSecret, redirectUri) {
      this.clientId = clientId;
      this.clientSecret = clientSecret;
      this.redirectUri = redirectUri;
      this.credentials = null;
    }

    setCredentials(credentials) {
      this.credentials = credentials;
    }

    async getAccessToken() {
      if (this.credentials?.refresh_token === 'stale-refresh-token') {
        const err = new Error('invalid_grant');
        err.response = { data: { error: 'invalid_grant' } };
        throw err;
      }
      return { token: this.credentials?.access_token || 'fresh-access-token' };
    }
  }

  try {
    fs.writeFileSync(
      oauthClientPath,
      JSON.stringify({
        installed: {
          client_id: 'client-id',
          client_secret: 'client-secret',
          redirect_uris: ['http://127.0.0.1'],
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      tokenPath,
      JSON.stringify({
        access_token: 'stale-access-token',
        refresh_token: 'stale-refresh-token',
        scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload',
      }),
      'utf8'
    );

    const client = await getAuthenticatedClient(oauthClientPath, tokenPath, {
      OAuth2Client: FakeOAuth2Client,
      authenticate: async (options) => {
        authenticateCalls.push(options);
        return {
          credentials: {
            access_token: 'fresh-access-token',
            refresh_token: 'fresh-refresh-token',
            scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload',
          },
        };
      },
      io: {
        log: (line) => logs.push(String(line)),
      },
    });

    assert.equal(client.credentials.refresh_token, 'fresh-refresh-token');
    assert.equal(authenticateCalls.length, 1);
    assert.match(logs.join('\n'), /invalid_grant/);
    assert.match(logs.join('\n'), /Opening Google OAuth consent/);

    const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    assert.equal(saved.refresh_token, 'fresh-refresh-token');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('ensureAuthorizedChannel throws when the token does not match the requested handle', async () => {
  const youtube = {
    channels: {
      list: async (params) => {
        if (params.forHandle) {
          return {
            data: {
              items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }],
            },
          };
        }
        return {
          data: {
            items: [{ id: 'UC999', snippet: { title: 'Other Channel', customUrl: '@OtherChannel' } }],
          },
        };
      },
    },
  };

  await assert.rejects(
    () => ensureAuthorizedChannel(youtube, '@AIDaredevils', { log: () => {} }),
    /Authenticated YouTube channel mismatch/
  );
});

test('main dry run emits upload previews for fixture manifest rows', async () => {
  const { tempRoot, manifestPath } = createFixtureRun();
  const logs = [];
  const errors = [];

  try {
    const out = await main(
      [
        '--manifest',
        manifestPath,
        '--oauth-client',
        path.join(tempRoot, 'client_secret.json'),
        '--dry-run',
      ],
      {
        log: (line) => logs.push(String(line)),
        error: (line) => errors.push(String(line)),
      }
    );

    assert.equal(out.ok, true);
    assert.equal(out.summary.dry_run, 2);
    assert.deepEqual(errors, []);

    const previews = logs.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    assert.equal(previews.length, 2);
    assert.equal(previews[0].item_key, 'backup_run_1:published:post_123');
    assert.equal(previews[0].requestBody.snippet.title, 'Morning Orbit');
    assert.equal(previews[1].requestBody.snippet.title, 'A handheld walk through a rainy cyberpunk market at dusk.');
    assert.equal(
      previews[0].file_path,
      path.join(tempRoot, 'Sora Backup', '2026-03-25_12-38-28', 'ownPosts', 'post_123.mp4')
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('main dry run also works when manifest filenames are already absolute', async () => {
  const tempRoot = createTempDir('sora-youtube-upload-abs-');
  const runDir = path.join(tempRoot, 'Sora Backup', '2026-03-25_12-38-28');
  const ownPostsDir = path.join(runDir, 'ownPosts');
  const manifestPath = path.join(runDir, 'sora_backup_manifest_2026-03-25_12-38-28.jsonl');
  const absoluteFile = path.join(ownPostsDir, 'post_abs.mp4');
  const logs = [];

  try {
    fs.mkdirSync(ownPostsDir, { recursive: true });
    fs.writeFileSync(absoluteFile, 'demo-abs');
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        item_key: 'backup_run_abs:published:post_abs',
        run_id: 'backup_run_abs',
        kind: 'published',
        id: 'post_abs',
        filename: absoluteFile,
        prompt: 'Absolute path fixture',
        owner_handle: 'aidaredevils',
      })}\n`,
      'utf8'
    );

    const out = await main(
      [
        '--manifest',
        manifestPath,
        '--oauth-client',
        path.join(tempRoot, 'client_secret.json'),
        '--dry-run',
      ],
      {
        log: (line) => logs.push(String(line)),
        error: () => {},
      }
    );

    assert.equal(out.ok, true);
    assert.equal(out.summary.dry_run, 1);
    const preview = logs.find((line) => line.startsWith('{'));
    assert.ok(preview);
    assert.equal(JSON.parse(preview).file_path, absoluteFile);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('main verifies the requested channel handle before live uploads', async () => {
  const { tempRoot, manifestPath } = createFixtureRun();
  const statePath = path.join(tempRoot, 'state.jsonl');
  const logs = [];
  const callOrder = [];

  try {
    const youtube = {
      channels: {
        list: async (params) => {
          callOrder.push(params.forHandle ? 'forHandle' : 'mine');
          if (params.forHandle) {
            return {
              data: {
                items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }],
              },
            };
          }
          return {
            data: {
              items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }],
            },
          };
        },
      },
      videos: {
        insert: async () => {
          callOrder.push('upload');
          return { data: { id: 'video123' } };
        },
      },
    };

    const out = await main(
      [
        '--manifest',
        manifestPath,
        '--oauth-client',
        path.join(tempRoot, 'client_secret.json'),
        '--token',
        path.join(tempRoot, 'token.json'),
        '--state',
        statePath,
        '--channel-handle',
        '@AIDaredevils',
        '--limit',
        '1',
      ],
      {
        log: (line) => logs.push(String(line)),
        error: () => {},
      },
      {
        getAuthenticatedClient: async () => ({ access_token: 'fake' }),
        createYouTubeService: () => youtube,
      }
    );

    assert.equal(out.ok, true);
    assert.equal(out.summary.uploaded, 1);
    assert.deepEqual(callOrder, ['forHandle', 'mine', 'upload']);
    assert.match(logs.join('\n'), /Requested YouTube channel handle @AIDaredevils/);
    assert.match(logs.join('\n'), /Verified YouTube channel @AIDaredevils/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('main skips a previously uploaded item on later runs using the stable upload log key', async () => {
  const tempRoot = createTempDir('sora-youtube-upload-rerun-');
  const runDir = path.join(tempRoot, 'Sora Backup', '2026-03-26_12-00-00');
  const ownPostsDir = path.join(runDir, 'ownPosts');
  const manifestPath = path.join(runDir, 'sora_backup_manifest_2026-03-26_12-00-00.jsonl');
  const statePath = path.join(tempRoot, 'state.jsonl');
  const tokenPath = path.join(tempRoot, 'token.json');
  const videoPath = path.join(ownPostsDir, 'post_123.mp4');
  const logs = [];
  let uploadCalls = 0;

  try {
    fs.mkdirSync(ownPostsDir, { recursive: true });
    fs.writeFileSync(videoPath, 'demo-rerun');
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        item_key: 'backup_run_new:published:post_123',
        run_id: 'backup_run_new',
        kind: 'published',
        id: 'post_123',
        filename: videoPath,
        title: 'Morning Orbit',
      })}\n`,
      'utf8'
    );
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        item_key: 'backup_run_old:published:post_123',
        upload_key: 'channel:UC123::published:post_123',
        id: 'post_123',
        kind: 'published',
        file_path: '/tmp/old/post_123.mp4',
        title: 'Morning Orbit',
        channel_namespace: 'channel:UC123',
        channel_id: 'UC123',
        channel_handle: '@AIDaredevils',
        status: 'uploaded',
        updated_at: '2026-03-26T10:00:00.000Z',
        youtube_video_id: 'video123',
        youtube_url: 'https://www.youtube.com/watch?v=video123',
      })}\n`,
      'utf8'
    );

    const youtube = {
      channels: {
        list: async (params) => {
          if (params.forHandle) {
            return { data: { items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }] } };
          }
          return { data: { items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }] } };
        },
      },
      videos: {
        insert: async () => {
          uploadCalls += 1;
          return { data: { id: 'newVideoShouldNotHappen' } };
        },
      },
    };

    const out = await main(
      [
        '--manifest',
        manifestPath,
        '--oauth-client',
        path.join(tempRoot, 'client_secret.json'),
        '--token',
        tokenPath,
        '--state',
        statePath,
        '--channel-handle',
        '@AIDaredevils',
      ],
      {
        log: (line) => logs.push(String(line)),
        error: () => {},
      },
      {
        getAuthenticatedClient: async () => ({ access_token: 'fake' }),
        createYouTubeService: () => youtube,
      }
    );

    assert.equal(out.ok, true);
    assert.equal(out.summary.skipped, 1);
    assert.equal(uploadCalls, 0);
    assert.match(logs.join('\n'), /already uploaded/);
    assert.match(logs.join('\n'), /video123/);
    assert.match(logs.join('\n'), /Upload log written to/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('main retries previously failed items automatically when no fresh candidates remain', async () => {
  const tempRoot = createTempDir('sora-youtube-upload-fallback-');
  const runDir = path.join(tempRoot, 'Sora Backup', '2026-03-26_12-00-00');
  const ownPostsDir = path.join(runDir, 'ownPosts');
  const manifestPath = path.join(runDir, 'sora_backup_manifest_2026-03-26_12-00-00.jsonl');
  const statePath = path.join(tempRoot, 'state.jsonl');
  const tokenPath = path.join(tempRoot, 'token.json');
  const uploadedVideoPath = path.join(ownPostsDir, 'post_uploaded.mp4');
  const failedVideoPath = path.join(ownPostsDir, 'post_failed.mp4');
  const logs = [];
  let uploadCalls = 0;

  try {
    fs.mkdirSync(ownPostsDir, { recursive: true });
    fs.writeFileSync(uploadedVideoPath, 'demo-uploaded');
    fs.writeFileSync(failedVideoPath, 'demo-failed');
    fs.writeFileSync(
      manifestPath,
      [
        {
          item_key: 'backup_run_new:published:post_uploaded',
          run_id: 'backup_run_new',
          kind: 'published',
          id: 'post_uploaded',
          filename: uploadedVideoPath,
          title: 'Already There',
        },
        {
          item_key: 'backup_run_new:published:post_failed',
          run_id: 'backup_run_new',
          kind: 'published',
          id: 'post_failed',
          filename: failedVideoPath,
          title: 'Retry Me',
        },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      statePath,
      [
        {
          version: 1,
          item_key: 'backup_run_old:published:post_uploaded',
          upload_key: 'channel:UC123::published:post_uploaded',
          id: 'post_uploaded',
          kind: 'published',
          file_path: '/tmp/old/post_uploaded.mp4',
          title: 'Already There',
          channel_namespace: 'channel:UC123',
          channel_id: 'UC123',
          channel_handle: '@AIDaredevils',
          status: 'uploaded',
          updated_at: '2026-03-26T10:00:00.000Z',
          youtube_video_id: 'videoUploaded',
          youtube_url: 'https://www.youtube.com/watch?v=videoUploaded',
        },
        {
          version: 1,
          item_key: 'backup_run_old:published:post_failed',
          upload_key: 'channel:UC123::published:post_failed',
          id: 'post_failed',
          kind: 'published',
          file_path: '/tmp/old/post_failed.mp4',
          title: 'Retry Me',
          channel_namespace: 'channel:UC123',
          channel_id: 'UC123',
          channel_handle: '@AIDaredevils',
          status: 'failed',
          updated_at: '2026-03-26T10:05:00.000Z',
          error: 'network timeout',
        },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8'
    );

    const youtube = {
      channels: {
        list: async (params) => {
          if (params.forHandle) {
            return { data: { items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }] } };
          }
          return { data: { items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }] } };
        },
      },
      videos: {
        insert: async () => {
          uploadCalls += 1;
          return { data: { id: 'retriedVideo123' } };
        },
      },
    };

    const out = await main(
      [
        '--manifest',
        manifestPath,
        '--oauth-client',
        path.join(tempRoot, 'client_secret.json'),
        '--token',
        tokenPath,
        '--state',
        statePath,
        '--channel-handle',
        '@AIDaredevils',
      ],
      {
        log: (line) => logs.push(String(line)),
        error: () => {},
      },
      {
        getAuthenticatedClient: async () => ({ access_token: 'fake' }),
        createYouTubeService: () => youtube,
      }
    );

    assert.equal(out.ok, true);
    assert.equal(out.summary.skipped, 1);
    assert.equal(out.summary.uploaded, 1);
    assert.equal(uploadCalls, 1);
    assert.match(logs.join('\n'), /No new upload candidates found; retrying 1 previously failed item/);
    assert.match(logs.join('\n'), /already uploaded/);
    assert.match(logs.join('\n'), /retriedVideo123/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('main keeps previously failed items skipped while fresh candidates still exist', async () => {
  const tempRoot = createTempDir('sora-youtube-upload-fresh-first-');
  const runDir = path.join(tempRoot, 'Sora Backup', '2026-03-26_12-00-00');
  const ownPostsDir = path.join(runDir, 'ownPosts');
  const manifestPath = path.join(runDir, 'sora_backup_manifest_2026-03-26_12-00-00.jsonl');
  const statePath = path.join(tempRoot, 'state.jsonl');
  const tokenPath = path.join(tempRoot, 'token.json');
  const freshVideoPath = path.join(ownPostsDir, 'post_fresh.mp4');
  const failedVideoPath = path.join(ownPostsDir, 'post_failed.mp4');
  const logs = [];
  let uploadCalls = 0;

  try {
    fs.mkdirSync(ownPostsDir, { recursive: true });
    fs.writeFileSync(freshVideoPath, 'demo-fresh');
    fs.writeFileSync(failedVideoPath, 'demo-failed');
    fs.writeFileSync(
      manifestPath,
      [
        {
          item_key: 'backup_run_new:published:post_failed',
          run_id: 'backup_run_new',
          kind: 'published',
          id: 'post_failed',
          filename: failedVideoPath,
          title: 'Retry Me Later',
        },
        {
          item_key: 'backup_run_new:published:post_fresh',
          run_id: 'backup_run_new',
          kind: 'published',
          id: 'post_fresh',
          filename: freshVideoPath,
          title: 'Brand New',
        },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        item_key: 'backup_run_old:published:post_failed',
        upload_key: 'channel:UC123::published:post_failed',
        id: 'post_failed',
        kind: 'published',
        file_path: '/tmp/old/post_failed.mp4',
        title: 'Retry Me Later',
        channel_namespace: 'channel:UC123',
        channel_id: 'UC123',
        channel_handle: '@AIDaredevils',
        status: 'failed',
        updated_at: '2026-03-26T10:05:00.000Z',
        error: 'network timeout',
      })}\n`,
      'utf8'
    );

    const youtube = {
      channels: {
        list: async (params) => {
          if (params.forHandle) {
            return { data: { items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }] } };
          }
          return { data: { items: [{ id: 'UC123', snippet: { title: 'AI Daredevils', customUrl: '@AIDaredevils' } }] } };
        },
      },
      videos: {
        insert: async () => {
          uploadCalls += 1;
          return { data: { id: 'freshVideo123' } };
        },
      },
    };

    const out = await main(
      [
        '--manifest',
        manifestPath,
        '--oauth-client',
        path.join(tempRoot, 'client_secret.json'),
        '--token',
        tokenPath,
        '--state',
        statePath,
        '--channel-handle',
        '@AIDaredevils',
      ],
      {
        log: (line) => logs.push(String(line)),
        error: () => {},
      },
      {
        getAuthenticatedClient: async () => ({ access_token: 'fake' }),
        createYouTubeService: () => youtube,
      }
    );

    assert.equal(out.ok, true);
    assert.equal(out.summary.skipped, 1);
    assert.equal(out.summary.uploaded, 1);
    assert.equal(uploadCalls, 1);
    assert.doesNotMatch(logs.join('\n'), /No new upload candidates found/);
    assert.match(logs.join('\n'), /previous failure recorded/);
    assert.match(logs.join('\n'), /freshVideo123/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
