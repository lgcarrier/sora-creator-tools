const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBackupComparisonKey,
  getBackupManifestComparisonKey,
  doesBackupManifestRowCountAsBackedUp,
  parseBackupManifestJsonl,
  pickDraftMediaSource,
  pickPublishedMediaSource,
  shouldExcludeAppearanceOwner,
  isSignedUrlFresh,
  buildBackupPanelState,
} = require('../uv-backup-logic.js');

test('pickDraftMediaSource prefers explicit source over watermark and legacy URLs', () => {
  const out = pickDraftMediaSource({
    encodings: {
      source: { path: 'https://videos.openai.com/path/source.mp4?sig=1' },
      source_wm: { path: 'https://videos.openai.com/path/source-wm.mp4?sig=1' },
    },
    downloadable_url: 'https://videos.openai.com/path/legacy.mp4?sig=1',
    download_urls: {
      no_watermark: 'https://videos.openai.com/path/legacy-no-wm.mp4?sig=1',
      watermark: 'https://videos.openai.com/path/legacy-wm.mp4?sig=1',
    },
  });

  assert.ok(out);
  assert.equal(out.url, 'https://videos.openai.com/path/source.mp4?sig=1');
  assert.equal(out.variant, 'no_watermark');
  assert.equal(out.ext, 'mp4');
});

test('pickPublishedMediaSource prefers raw video-like attachment URLs over preview variants', () => {
  const out = pickPublishedMediaSource({
    post: {
      attachments: [
        {
          preview_url: 'https://videos.openai.com/demo/drvs/md/raw?sig=1',
          raw_url: 'https://videos.openai.com/demo/raw?sig=1',
          thumbnail_url: 'https://videos.openai.com/demo/thumb.jpg?sig=1',
        },
      ],
    },
  });

  assert.ok(out);
  assert.equal(out.url, 'https://videos.openai.com/demo/raw?sig=1');
  assert.equal(out.variant, 'unknown_fallback');
});

test('buildBackupComparisonKey normalizes kind and id into a stable comparison key', () => {
  assert.equal(buildBackupComparisonKey('Published', 'post_123'), 'published:post_123');
  assert.equal(buildBackupComparisonKey('', 'post_123'), '');
});

test('getBackupManifestComparisonKey falls back to item_key when kind and id are missing', () => {
  assert.equal(
    getBackupManifestComparisonKey({
      run_id: 'backup_run_1',
      item_key: 'backup_run_1:published:post_123',
    }),
    'published:post_123'
  );
});

test('doesBackupManifestRowCountAsBackedUp accepts done, missing status, and chained already_backed_up rows', () => {
  assert.equal(doesBackupManifestRowCountAsBackedUp({ status: 'done' }), true);
  assert.equal(doesBackupManifestRowCountAsBackedUp({}), true);
  assert.equal(doesBackupManifestRowCountAsBackedUp({ status: 'skipped', skip_reason: 'already_backed_up' }), true);
  assert.equal(doesBackupManifestRowCountAsBackedUp({ status: 'failed' }), false);
  assert.equal(doesBackupManifestRowCountAsBackedUp({ status: 'skipped', skip_reason: 'network_error' }), false);
});

test('parseBackupManifestJsonl keeps only rows that count as already backed up', () => {
  const parsed = parseBackupManifestJsonl(
    [
      JSON.stringify({ kind: 'published', id: 'post_done', status: 'done' }),
      JSON.stringify({ kind: 'draft', id: 'draft_legacy' }),
      JSON.stringify({
        run_id: 'backup_run_2',
        item_key: 'backup_run_2:published:post_chained',
        status: 'skipped',
        skip_reason: 'already_backed_up',
      }),
      JSON.stringify({ kind: 'published', id: 'post_failed', status: 'failed' }),
      JSON.stringify({ kind: 'published', id: 'post_skipped_other', status: 'skipped', skip_reason: 'network_error' }),
      '{"kind":"published"',
    ].join('\n'),
    { filename: 'sora_backup_manifest_2026-03-25_12-38-28.jsonl' }
  );

  assert.equal(parsed.filename, 'sora_backup_manifest_2026-03-25_12-38-28.jsonl');
  assert.equal(parsed.total_rows, 6);
  assert.equal(parsed.backed_up_rows, 3);
  assert.equal(parsed.invalid_rows, 1);
  assert.deepEqual(parsed.keys, [
    'published:post_done',
    'draft:draft_legacy',
    'published:post_chained',
  ]);
});

test('shouldExcludeAppearanceOwner matches either user id or handle', () => {
  assert.equal(
    shouldExcludeAppearanceOwner({ id: 'user_123', handle: 'alice' }, { id: 'user_123', handle: 'bob' }),
    true
  );
  assert.equal(
    shouldExcludeAppearanceOwner({ id: '', handle: 'Alice' }, { id: '', handle: 'alice' }),
    true
  );
  assert.equal(
    shouldExcludeAppearanceOwner({ id: 'user_123', handle: 'alice' }, { id: 'user_999', handle: 'alice-elsewhere' }),
    false
  );
});

test('isSignedUrlFresh rejects URLs that are too close to expiry', () => {
  const now = Date.parse('2026-03-30T23:50:00Z');
  assert.equal(
    isSignedUrlFresh('https://videos.openai.com/demo/raw?se=2026-03-31T03%3A00%3A00Z', now, now),
    true
  );
  assert.equal(
    isSignedUrlFresh('https://videos.openai.com/demo/raw?se=2026-03-31T00%3A00%3A00Z', now, now),
    false
  );
});

test('buildBackupPanelState exposes the expected control states', () => {
  const running = buildBackupPanelState({ id: 'run_1', status: 'running' }, { busy: false, exporting: false, hasAuth: true });
  assert.equal(running.active, true);
  assert.equal(running.showPause, true);
  assert.equal(running.showResume, false);
  assert.equal(running.canStart, false);

  const paused = buildBackupPanelState({ id: 'run_1', status: 'paused' }, { busy: false, exporting: false, hasAuth: true });
  assert.equal(paused.showPause, false);
  assert.equal(paused.showResume, true);
  assert.equal(paused.showCancel, true);

  const completed = buildBackupPanelState({ id: 'run_1', status: 'completed' }, { busy: false, exporting: false, hasAuth: true });
  assert.equal(completed.active, false);
  assert.equal(completed.canStart, true);
  assert.equal(completed.canExport, true);
});
