const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultOutputPath,
  extractPostPermalinks,
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

test('extractPostPermalinks keeps non-empty post permalinks in order', () => {
  assert.deepEqual(
    extractPostPermalinks([
      { post_permalink: 'https://sora.example/post/one' },
      { post_permalink: '  ' },
      { post_permalink: 'https://sora.example/post/two' },
      {},
    ]),
    [
      'https://sora.example/post/one',
      'https://sora.example/post/two',
    ]
  );
});

test('main writes sora_movies.txt from manifest post_permalink values', async () => {
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
  assert.match(logs[0], /Wrote 2 URLs/);
});
