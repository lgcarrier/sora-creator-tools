const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
