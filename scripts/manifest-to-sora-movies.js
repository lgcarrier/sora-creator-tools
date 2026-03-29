#!/usr/bin/env node

const fsp = require('node:fs/promises');
const path = require('node:path');

const { parseManifestText } = require('./youtube-bulk-upload.js');

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/manifest-to-sora-movies.js --manifest <path> [--output <path>]',
    '',
    'Required:',
    '  --manifest <path>             Path to sora_backup_manifest_*.jsonl',
    '',
    'Options:',
    '  --output <path>               Output file path. Default: <manifest dir>/sora_movies.txt',
    '  --help                        Show this help message',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {
    manifestPath: '',
    outputPath: '',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    const next = argv[index + 1];
    if (typeof next !== 'string' || next.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }

    if (arg === '--manifest') {
      options.manifestPath = path.resolve(next);
    } else if (arg === '--output') {
      options.outputPath = path.resolve(next);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }

  if (!options.help && !options.manifestPath) {
    throw new Error('--manifest is required');
  }

  if (!options.outputPath && options.manifestPath) {
    options.outputPath = defaultOutputPath(options.manifestPath);
  }

  return options;
}

function defaultOutputPath(manifestPath) {
  return path.join(path.dirname(path.resolve(manifestPath)), 'sora_movies.txt');
}

function normalizePermalink(value) {
  return String(value || '').trim();
}

function extractPostPermalinks(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => normalizePermalink(item?.post_permalink))
    .filter(Boolean);
}

async function main(argv = process.argv.slice(2), io = { log: console.log }) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return { ok: true, help: true };
  }

  const manifestText = await fsp.readFile(options.manifestPath, 'utf8');
  const items = parseManifestText(manifestText, options.manifestPath);
  const urls = extractPostPermalinks(items);
  if (!urls.length) {
    throw new Error(`No post_permalink values found in ${options.manifestPath}`);
  }

  await fsp.writeFile(options.outputPath, `${urls.join('\n')}\n`, 'utf8');
  io.log(`Wrote ${urls.length} URLs to ${options.outputPath}`);

  return {
    ok: true,
    manifestPath: options.manifestPath,
    outputPath: options.outputPath,
    itemCount: items.length,
    urlCount: urls.length,
  };
}

module.exports = {
  defaultOutputPath,
  extractPostPermalinks,
  main,
  normalizePermalink,
  parseArgs,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
