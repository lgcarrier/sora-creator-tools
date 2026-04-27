const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultOutputPath,
  extractPostPermalinks,
  isDownloadedManifestRow,
  main,
  parseArgs,
} = require('../scripts/manifest-to-sora-movies.js');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('parseArgs defaults output next to the manifest', () => {
  const manifestPath = path.join('/tmp', 'Sora Backup', '2026-03-25_12-38-28', 'sora_backup_manifest.jsonl');
  const out = parseArgs(['--manifest', manifestPath]);
  assert.equal(out.manifestPath, path.resolve(manifestPath));
  assert.equal(out.outputPath, defaultOutputPath(manifestPath));
});

test('isDownloadedManifestRow accepts done and legacy rows only', () => {
  assert.equal(isDownloadedManifestRow({ status: 'done' }), true);
  assert.equal(isDownloadedManifestRow({ status: ' DONE ' }), true);
  assert.equal(isDownloadedManifestRow({ status: 'skipped', skip_reason: 'already_backed_up' }), false);
  assert.equal(isDownloadedManifestRow({ status: 'failed' }), false);
  assert.equal(isDownloadedManifestRow({ status: 'queued' }), false);
  assert.equal(isDownloadedManifestRow({}), true);
});

test('extractPostPermalinks keeps downloaded and legacy post permalinks in order', () => {
  assert.deepEqual(
    extractPostPermalinks([
      { status: 'done', post_permalink: 'https://sora.example/post/one' },
      { status: 'skipped', skip_reason: 'already_backed_up', post_permalink: 'https://sora.example/post/skipped' },
      { status: 'failed', post_permalink: 'https://sora.example/post/failed' },
      { status: 'queued', post_permalink: 'https://sora.example/post/queued' },
      { status: ' DONE ', post_permalink: 'https://sora.example/post/two' },
      { status: 'done', post_permalink: '  ' },
      { post_permalink: 'https://sora.example/post/legacy' },
      {},
    ]),
    [
      'https://sora.example/post/one',
      'https://sora.example/post/two',
      'https://sora.example/post/legacy',
    ]
  );
});

test('main writes sora_movies.txt from downloaded manifest post_permalink values', async () => {
  const tempRoot = createTempDir('sora-movies-export-');
  const manifestDir = path.join(tempRoot, 'Sora Backup', '2026-04-26_02-46-30');
  fs.mkdirSync(manifestDir, { recursive: true });

  const rows = [
    { item_key: 'run:published:one', status: 'done', post_permalink: 'https://sora.example/post/one' },
    {
      item_key: 'run:published:skipped',
      status: 'skipped',
      skip_reason: 'already_backed_up',
      post_permalink: 'https://sora.example/post/skipped',
    },
    { item_key: 'run:published:failed', status: 'failed', post_permalink: 'https://sora.example/post/failed' },
    { item_key: 'run:published:queued', status: 'queued', post_permalink: 'https://sora.example/post/queued' },
    { item_key: 'run:published:two', status: 'done', post_permalink: 'https://sora.example/post/two' },
  ];
  const manifestPath = path.join(manifestDir, 'sora_backup_manifest_2026-04-26_02-46-30.jsonl');
  fs.writeFileSync(manifestPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const logs = [];
  const result = await main(['--manifest', manifestPath], {
    log: (line) => logs.push(String(line)),
  });

  const outputPath = path.join(manifestDir, 'sora_movies.txt');
  assert.equal(result.ok, true);
  assert.equal(result.outputPath, outputPath);
  assert.equal(result.itemCount, 5);
  assert.equal(result.urlCount, 2);
  assert.equal(
    fs.readFileSync(outputPath, 'utf8'),
    [
      'https://sora.example/post/one',
      'https://sora.example/post/two',
      '',
    ].join('\n')
  );
  assert.match(logs[0], /Wrote 2 downloaded URLs/);
  assert.match(logs[0], /from 5 manifest rows/);
});

test('main treats legacy rows without status as downloaded', async () => {
  const tempRoot = createTempDir('sora-movies-export-');
  const manifestDir = path.join(tempRoot, 'Sora Backup', '2026-03-25_12-38-28');
  fs.mkdirSync(manifestDir, { recursive: true });

  const fixtureText = fs.readFileSync(path.join(__dirname, 'fixtures', 'youtube-upload-manifest.jsonl'), 'utf8');
  const manifestPath = path.join(manifestDir, 'sora_backup_manifest_2026-03-25_12-38-28.jsonl');
  fs.writeFileSync(manifestPath, fixtureText, 'utf8');

  const logs = [];
  const result = await main(['--manifest', manifestPath], {
    log: (line) => logs.push(String(line)),
  });

  const outputPath = path.join(manifestDir, 'sora_movies.txt');
  assert.equal(result.ok, true);
  assert.equal(result.outputPath, outputPath);
  assert.equal(
    fs.readFileSync(outputPath, 'utf8'),
    [
      'https://sora.example/post/post_123',
      'https://sora.example/post/post_456',
      '',
    ].join('\n')
  );
  assert.match(logs[0], /Wrote 2 downloaded URLs/);
});
