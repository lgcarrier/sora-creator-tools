#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const REQUIRED_AUTH_SCOPES = [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE];
const DEFAULT_PRIVACY = 'private';
const DEFAULT_CATEGORY_ID = '22';
const DEFAULT_NOTIFY_SUBSCRIBERS = false;
const DEFAULT_MADE_FOR_KIDS = false;
const DEFAULT_RETRY_LIMIT = 3;
const YOUTUBE_TITLE_LIMIT = 100;
const YOUTUBE_DESCRIPTION_LIMIT = 5000;
const YOUTUBE_TAGS_LIMIT = 500;
const STATE_VERSION = 1;

function defaultTokenPath() {
  return path.join(os.homedir(), '.config', 'sora-creator-tools', 'youtube-token.json');
}

function defaultStatePath() {
  return path.join(os.homedir(), '.config', 'sora-creator-tools', 'youtube-upload-state.jsonl');
}

function parseGrantedScopes(scopeValue) {
  return String(scopeValue || '')
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function tokenHasRequiredScopes(credentials, requiredScopes = REQUIRED_AUTH_SCOPES) {
  const granted = new Set(parseGrantedScopes(credentials?.scope));
  if (!granted.size) return false;
  return requiredScopes.every((scope) => granted.has(scope));
}

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/youtube-bulk-upload.js --manifest <path> --oauth-client <path> [options]',
    '',
    'Required:',
    '  --manifest <path>             Path to sora_backup_manifest_*.jsonl',
    '  --oauth-client <path>         Path to Google OAuth client JSON',
    '',
    'Options:',
    '  --download-root <path>        Parent directory above "Sora Backup"',
    '  --channel-handle <@handle>    Abort live uploads unless the token matches this YouTube handle',
    '  --privacy <private|unlisted|public>',
    '  --category <id>               Default: 22',
    '  --notify-subscribers <true|false>',
    '  --made-for-kids <true|false>',
    '  --state <path>                Default: ~/.config/sora-creator-tools/youtube-upload-state.jsonl',
    '  --token <path>                Default: ~/.config/sora-creator-tools/youtube-token.json',
    '  --limit <n>                   Process at most n upload candidates',
    '  --retry-failures              Retry items marked as failed in the state file',
    '  --dry-run                     Build payloads and verify files without uploading',
    '  --help                        Show this help message',
  ].join('\n'));
}

function parseBoolean(value, flagName) {
  if (typeof value !== 'string') {
    throw new Error(`${flagName} requires "true" or "false"`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${flagName} requires "true" or "false"`);
}

function parsePositiveInteger(value, flagName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function normalizeChannelHandle(value) {
  const trimmed = normalizeInlineText(value).replace(/^@+/, '');
  if (!trimmed) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error('--channel-handle must look like a YouTube handle, for example @AIDaredevils');
  }
  return trimmed;
}

function parseArgs(argv) {
  const options = {
    manifestPath: '',
    oauthClientPath: '',
    downloadRoot: '',
    channelHandle: '',
    privacy: DEFAULT_PRIVACY,
    categoryId: DEFAULT_CATEGORY_ID,
    notifySubscribers: DEFAULT_NOTIFY_SUBSCRIBERS,
    madeForKids: DEFAULT_MADE_FOR_KIDS,
    dryRun: false,
    limit: 0,
    retryFailures: false,
    statePath: defaultStatePath(),
    tokenPath: defaultTokenPath(),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--retry-failures') {
      options.retryFailures = true;
      continue;
    }

    const next = argv[index + 1];
    if (typeof next !== 'string' || next.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }

    if (arg === '--manifest') {
      options.manifestPath = path.resolve(next);
    } else if (arg === '--oauth-client') {
      options.oauthClientPath = path.resolve(next);
    } else if (arg === '--download-root') {
      options.downloadRoot = path.resolve(next);
    } else if (arg === '--channel-handle') {
      options.channelHandle = normalizeChannelHandle(next);
    } else if (arg === '--privacy') {
      if (!['private', 'unlisted', 'public'].includes(next)) {
        throw new Error('--privacy must be one of private, unlisted, or public');
      }
      options.privacy = next;
    } else if (arg === '--category') {
      options.categoryId = String(next).trim();
    } else if (arg === '--notify-subscribers') {
      options.notifySubscribers = parseBoolean(next, '--notify-subscribers');
    } else if (arg === '--made-for-kids') {
      options.madeForKids = parseBoolean(next, '--made-for-kids');
    } else if (arg === '--limit') {
      options.limit = parsePositiveInteger(next, '--limit');
    } else if (arg === '--state') {
      options.statePath = path.resolve(next);
    } else if (arg === '--token') {
      options.tokenPath = path.resolve(next);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }

  if (!options.help) {
    if (!options.manifestPath) throw new Error('--manifest is required');
    if (!options.oauthClientPath) throw new Error('--oauth-client is required');
  }

  return options;
}

function normalizeFilenameParts(filename) {
  const normalized = String(filename || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!normalized.length) {
    throw new Error('Manifest item is missing filename');
  }
  if (normalized.includes('..')) {
    throw new Error(`Manifest filename escapes download root: ${filename}`);
  }
  return normalized;
}

function inferDownloadRootFromManifest(manifestPath) {
  const resolved = path.resolve(manifestPath);
  const marker = `${path.sep}Sora Backup${path.sep}`;
  const index = resolved.indexOf(marker);
  if (index >= 0) {
    return resolved.slice(0, index) || path.sep;
  }
  const tail = `${path.sep}Sora Backup`;
  if (resolved.endsWith(tail)) {
    return resolved.slice(0, resolved.length - tail.length) || path.sep;
  }
  return '';
}

function resolveDownloadRoot(manifestPath, explicitDownloadRoot) {
  if (explicitDownloadRoot) return path.resolve(explicitDownloadRoot);
  const inferred = inferDownloadRootFromManifest(manifestPath);
  if (inferred) return inferred;
  throw new Error(
    'Could not infer --download-root from the manifest path. Pass --download-root with the parent directory above "Sora Backup".'
  );
}

function resolveVideoPath(item, downloadRoot) {
  const rawFilename = String(item?.filename || '').trim();
  if (!rawFilename) {
    throw new Error('Manifest item is missing filename');
  }
  if (path.isAbsolute(rawFilename)) {
    return path.resolve(rawFilename);
  }
  const root = path.resolve(downloadRoot);
  const parts = normalizeFilenameParts(rawFilename);
  const absolute = path.resolve(root, ...parts);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Resolved path escapes download root: ${rawFilename}`);
  }
  return absolute;
}

function parseManifestText(text, manifestPath = 'manifest.jsonl') {
  return String(text || '')
    .split(/\r?\n/)
    .reduce((items, line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return items;
      try {
        items.push(JSON.parse(trimmed));
      } catch (error) {
        throw new Error(`Invalid JSON in ${manifestPath} at line ${index + 1}: ${error.message}`);
      }
      return items;
    }, []);
}

async function loadManifestItems(manifestPath) {
  const text = await fsp.readFile(manifestPath, 'utf8');
  return parseManifestText(text, manifestPath);
}

function normalizeInlineText(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMultilineText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, '')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function replaceForbiddenYouTubeCharacters(value) {
  return String(value || '').replace(/</g, '[').replace(/>/g, ']');
}

function sanitizeYouTubeInlineText(value) {
  return replaceForbiddenYouTubeCharacters(normalizeInlineText(value));
}

function sanitizeYouTubeMultilineText(value) {
  return replaceForbiddenYouTubeCharacters(normalizeMultilineText(value));
}

function truncateCodePoints(value, limit) {
  const chars = Array.from(String(value || ''));
  if (chars.length <= limit) return chars.join('');
  return chars.slice(0, limit).join('').trim();
}

function truncateUtf8(value, maxBytes) {
  let output = '';
  for (const char of Array.from(String(value || ''))) {
    const next = output + char;
    if (Buffer.byteLength(next, 'utf8') > maxBytes) break;
    output = next;
  }
  return output.trim();
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeInlineText(value))
    .filter(Boolean);
}

function buildTitle(item, filePath) {
  const fallback = path.basename(filePath, path.extname(filePath));
  const title = sanitizeYouTubeInlineText(item?.title) || sanitizeYouTubeInlineText(item?.prompt) || sanitizeYouTubeInlineText(fallback) || 'Sora upload';
  return truncateCodePoints(title, YOUTUBE_TITLE_LIMIT);
}

function formatTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const asDate = new Date(value > 1e12 ? value : value * 1000);
    if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
  }
  const normalized = normalizeInlineText(value);
  if (!normalized) return '';
  if (/^\d+(\.\d+)?$/.test(normalized)) {
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      const asDateFromNumber = new Date(numeric > 1e12 ? numeric : numeric * 1000);
      if (!Number.isNaN(asDateFromNumber.getTime())) return asDateFromNumber.toISOString();
    }
  }
  const asDate = new Date(normalized);
  if (Number.isNaN(asDate.getTime())) return normalized;
  return asDate.toISOString();
}

function buildDescription(item) {
  const blocks = [];
  const prompt = sanitizeYouTubeMultilineText(item?.prompt);
  if (prompt) blocks.push(prompt);

  const detailLines = [];
  const ownerHandle = normalizeInlineText(item?.owner_handle).replace(/^@+/, '');
  const ownerId = normalizeInlineText(item?.owner_id);
  const castNames = normalizeStringList(item?.cast_names);
  const createdAt = formatTimestamp(item?.created_at);
  const postedAt = formatTimestamp(item?.posted_at);
  const updatedAt = formatTimestamp(item?.updated_at);
  const postPermalink = normalizeInlineText(item?.post_permalink);
  const detailUrl = normalizeInlineText(item?.detail_url);

  if (ownerHandle) detailLines.push(`Owner: @${ownerHandle}`);
  if (ownerId) detailLines.push(`Owner ID: ${ownerId}`);
  if (castNames.length) detailLines.push(`Cast: ${castNames.join(', ')}`);
  if (createdAt) detailLines.push(`Created: ${createdAt}`);
  if (postedAt) detailLines.push(`Posted: ${postedAt}`);
  if (updatedAt) detailLines.push(`Updated: ${updatedAt}`);
  if (postPermalink) detailLines.push(`Sora post: ${postPermalink}`);
  if (detailUrl) detailLines.push(`Sora detail: ${detailUrl}`);

  if (detailLines.length) blocks.push(detailLines.join('\n'));

  const description = sanitizeYouTubeMultilineText(blocks.join('\n\n').trim());
  return truncateUtf8(description, YOUTUBE_DESCRIPTION_LIMIT);
}

function buildTags(item) {
  const seen = new Set();
  const tags = [];
  const candidates = [...normalizeStringList(item?.cast_names)];
  const ownerHandle = normalizeInlineText(item?.owner_handle).replace(/^@+/, '');
  if (ownerHandle) candidates.push(ownerHandle);
  candidates.push('sora');

  let totalChars = 0;
  for (const rawValue of candidates) {
    const tag = truncateUtf8(normalizeInlineText(rawValue), 60);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    const projected = totalChars + tag.length + (tags.length ? 1 : 0);
    if (projected > YOUTUBE_TAGS_LIMIT) break;
    seen.add(key);
    tags.push(tag);
    totalChars = projected;
  }

  return tags;
}

function buildItemKey(item, index) {
  const existing = normalizeInlineText(item?.item_key);
  if (existing) return existing;
  const runId = normalizeInlineText(item?.run_id) || 'run';
  const kind = normalizeInlineText(item?.kind) || 'item';
  const id = normalizeInlineText(item?.id) || String(index);
  return `${runId}:${kind}:${id}`;
}

function buildUploadPayload(item, filePath, options) {
  const snippet = {
    title: buildTitle(item, filePath),
    description: buildDescription(item),
    categoryId: options.categoryId,
  };
  const tags = buildTags(item);
  if (tags.length) snippet.tags = tags;

  return {
    notifySubscribers: options.notifySubscribers,
    part: 'snippet,status',
    requestBody: {
      snippet,
      status: {
        privacyStatus: options.privacy,
        selfDeclaredMadeForKids: options.madeForKids,
      },
    },
  };
}

function buildDryRunRecord(item, filePath, options) {
  const payload = buildUploadPayload(item, filePath, options);
  return {
    item_key: buildItemKey(item, 0),
    upload_key: buildUploadKey(item, filePath, options.channelNamespace || 'dry-run'),
    file_path: filePath,
    notifySubscribers: payload.notifySubscribers,
    part: payload.part,
    requestBody: payload.requestBody,
  };
}

function buildSourceIdentity(item, filePath) {
  const kind = normalizeInlineText(item?.kind);
  const id = normalizeInlineText(item?.id);
  if (id) return `${kind || 'item'}:${id}`;
  const permalink = normalizeInlineText(item?.post_permalink);
  if (permalink) return `permalink:${permalink}`;
  const detailUrl = normalizeInlineText(item?.detail_url);
  if (detailUrl) return `detail:${detailUrl}`;
  const filename = normalizeInlineText(item?.filename);
  if (filename) return `filename:${path.basename(filename)}`;
  return `path:${path.resolve(filePath || '')}`;
}

function buildUploadKey(item, filePath, channelNamespace) {
  const namespace = normalizeInlineText(channelNamespace) || 'channel:unknown';
  return `${namespace}::${buildSourceIdentity(item, filePath)}`;
}

function readStateStore(text) {
  const byItemKey = new Map();
  const byUploadKey = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed);
    const itemKey = normalizeInlineText(record?.item_key);
    const uploadKey = normalizeInlineText(record?.upload_key);
    if (itemKey) byItemKey.set(itemKey, record);
    if (uploadKey) byUploadKey.set(uploadKey, record);
  }
  return { byItemKey, byUploadKey };
}

function readStateIndex(text) {
  return readStateStore(text).byItemKey;
}

async function loadStateStore(statePath) {
  try {
    const text = await fsp.readFile(statePath, 'utf8');
    return readStateStore(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return { byItemKey: new Map(), byUploadKey: new Map() };
    throw error;
  }
}

async function ensureParentDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

function buildStateRecord(item, filePath, options, status, details = {}) {
  const channelHandle = normalizeInlineText(options?.channelHandle || options?.resolvedChannelHandle).replace(/^@+/, '');
  return {
    version: STATE_VERSION,
    item_key: buildItemKey(item, 0),
    upload_key: buildUploadKey(item, filePath, options?.channelNamespace || ''),
    id: normalizeInlineText(item?.id),
    kind: normalizeInlineText(item?.kind),
    filename: normalizeInlineText(item?.filename),
    file_path: filePath,
    title: buildTitle(item, filePath),
    channel_namespace: normalizeInlineText(options?.channelNamespace || ''),
    channel_id: normalizeInlineText(options?.resolvedChannelId || ''),
    channel_handle: channelHandle ? `@${channelHandle}` : '',
    status,
    updated_at: new Date().toISOString(),
    ...details,
  };
}

function buildYouTubeWatchUrl(videoId) {
  const normalized = normalizeInlineText(videoId);
  return normalized ? `https://www.youtube.com/watch?v=${normalized}` : '';
}

function summarizeChannel(channel) {
  const id = normalizeInlineText(channel?.id);
  const title = normalizeInlineText(channel?.snippet?.title);
  const customUrl = normalizeChannelHandle(channel?.snippet?.customUrl || '');
  const parts = [];
  if (title) parts.push(title);
  if (customUrl) parts.push(`@${customUrl}`);
  if (id) parts.push(id);
  return parts.join(' / ') || '(unknown channel)';
}

async function appendStateRecord(statePath, record) {
  await ensureParentDir(statePath);
  await fsp.appendFile(statePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function describePriorUpload(record) {
  const parts = [];
  const uploadedAt = normalizeInlineText(record?.updated_at);
  const youtubeUrl = normalizeInlineText(record?.youtube_url);
  const youtubeVideoId = normalizeInlineText(record?.youtube_video_id);
  const title = normalizeInlineText(record?.title);
  if (title) parts.push(`title="${title}"`);
  if (uploadedAt) parts.push(`at ${uploadedAt}`);
  if (youtubeUrl) parts.push(youtubeUrl);
  else if (youtubeVideoId) parts.push(`video ${youtubeVideoId}`);
  return parts.join(' ');
}

function shouldSkipItem(itemKey, uploadKey, stateStore, retryFailures) {
  const byItemKey = stateStore?.byItemKey instanceof Map ? stateStore.byItemKey : (stateStore instanceof Map ? stateStore : new Map());
  const byUploadKey = stateStore?.byUploadKey instanceof Map ? stateStore.byUploadKey : new Map();
  const previous = byUploadKey.get(uploadKey) || byItemKey.get(itemKey);
  if (!previous) return { skip: false, reason: '' };
  const status = normalizeInlineText(previous.status).toLowerCase();
  if (status === 'uploaded') {
    return {
      skip: true,
      reason: `already uploaded${describePriorUpload(previous) ? ` (${describePriorUpload(previous)})` : ''}`,
      previous,
    };
  }
  if (status === 'failed' && !retryFailures) {
    return {
      skip: true,
      reason: `previous failure recorded${normalizeInlineText(previous.error) ? ` (${normalizeInlineText(previous.error)})` : ''}`,
      previous,
    };
  }
  return { skip: false, reason: '' };
}

function isRetryableUploadError(error) {
  const status = Number(error?.code || error?.status || error?.response?.status || 0);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const message = String(error?.message || '').toLowerCase();
  return ['econnreset', 'etimedout', 'socket hang up', 'quota exceeded', 'rate limit'].some((term) => message.includes(term));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadOAuthClientConfig(oauthClientPath) {
  const text = await fsp.readFile(oauthClientPath, 'utf8');
  const parsed = JSON.parse(text);
  const client = parsed.installed || parsed.web;
  if (!client?.client_id || !client?.client_secret) {
    throw new Error('OAuth client JSON must include installed or web client credentials');
  }
  return client;
}

async function getAuthenticatedClient(oauthClientPath, tokenPath) {
  const { OAuth2Client } = require('google-auth-library');
  const clientConfig = await loadOAuthClientConfig(oauthClientPath);
  const redirectUri = Array.isArray(clientConfig.redirect_uris) && clientConfig.redirect_uris.length
    ? clientConfig.redirect_uris[0]
    : 'http://127.0.0.1';
  const client = new OAuth2Client(clientConfig.client_id, clientConfig.client_secret, redirectUri);

  try {
    const tokenText = await fsp.readFile(tokenPath, 'utf8');
    const storedCredentials = JSON.parse(tokenText);
    if (tokenHasRequiredScopes(storedCredentials)) {
      client.setCredentials(storedCredentials);
      return client;
    }
    console.log(
      `Stored token at ${tokenPath} is missing required scopes (${REQUIRED_AUTH_SCOPES.join(', ')}). Reauthorizing.`
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const { authenticate } = require('@google-cloud/local-auth');
  const authenticated = await authenticate({
    keyfilePath: oauthClientPath,
    scopes: REQUIRED_AUTH_SCOPES,
  });

  if (!authenticated?.credentials) {
    throw new Error('OAuth flow completed without credentials');
  }

  client.setCredentials(authenticated.credentials);
  await ensureParentDir(tokenPath);
  await fsp.writeFile(tokenPath, JSON.stringify(authenticated.credentials, null, 2), 'utf8');
  return client;
}

function createYouTubeService(authClient) {
  return require('googleapis').google.youtube({
    version: 'v3',
    auth: authClient,
  });
}

async function ensureAuthorizedChannel(youtube, channelHandle, io = { log: console.log }) {
  const normalizedHandle = normalizeChannelHandle(channelHandle);
  if (!normalizedHandle) return null;

  const expectedResponse = await youtube.channels.list({
    part: 'id,snippet',
    forHandle: `@${normalizedHandle}`,
    maxResults: 1,
  });
  const expectedChannels = Array.isArray(expectedResponse?.data?.items) ? expectedResponse.data.items : [];
  const expected = expectedChannels[0] || null;
  if (!expected?.id) {
    throw new Error(`Could not resolve YouTube channel handle @${normalizedHandle}.`);
  }

  const ownedResponse = await youtube.channels.list({
    part: 'id,snippet',
    mine: true,
    maxResults: 50,
  });
  const ownedChannels = Array.isArray(ownedResponse?.data?.items) ? ownedResponse.data.items : [];
  if (!ownedChannels.length) {
    throw new Error('The authenticated token did not return any YouTube channels for mine=true.');
  }

  const matched = ownedChannels.find((channel) => normalizeInlineText(channel?.id) === normalizeInlineText(expected.id)) || null;
  if (!matched) {
    const ownedSummary = ownedChannels.map((channel) => summarizeChannel(channel)).join('; ');
    throw new Error(
      `Authenticated YouTube channel mismatch. Requested @${normalizedHandle} (${normalizeInlineText(expected.id)}), ` +
      `but this token resolved to ${ownedSummary || 'no accessible channels'}. ` +
      `Use a dedicated --token path and re-authorize it for @${normalizedHandle}.`
    );
  }

  io.log(`Verified YouTube channel @${normalizedHandle}: ${summarizeChannel(matched)}`);
  return {
    requestedHandle: `@${normalizedHandle}`,
    expectedChannelId: normalizeInlineText(expected.id),
    matchedChannelId: normalizeInlineText(matched.id),
    matchedChannel: matched,
  };
}

async function uploadOneVideo(youtube, item, filePath, options) {
  const payload = buildUploadPayload(item, filePath, options);
  return youtube.videos.insert({
    part: payload.part,
    notifySubscribers: payload.notifySubscribers,
    requestBody: payload.requestBody,
    media: {
      body: fs.createReadStream(filePath),
    },
  });
}

async function processManifestItems(items, options, io, youtube = null) {
  const stateStore = options.dryRun ? { byItemKey: new Map(), byUploadKey: new Map() } : await loadStateStore(options.statePath);
  const results = [];
  let attempted = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const itemKey = buildItemKey(item, index);
    item.item_key = itemKey;
    let filePath = '';

    try {
      filePath = resolveVideoPath(item, options.downloadRoot);
      await fsp.access(filePath, fs.constants.R_OK);
    } catch (error) {
      const message = `Missing video file for ${itemKey}: ${error.message}`;
      io.error(message);
      results.push({ item_key: itemKey, status: 'failed', error: message });
      if (!options.dryRun) {
        const record = buildStateRecord(item, filePath, options, 'failed', { error: message });
        await appendStateRecord(options.statePath, record);
        stateStore.byItemKey.set(itemKey, record);
        if (record.upload_key) stateStore.byUploadKey.set(record.upload_key, record);
      }
      continue;
    }

    const uploadKey = buildUploadKey(item, filePath, options.channelNamespace || '');

    const skip = shouldSkipItem(itemKey, uploadKey, stateStore, options.retryFailures);
    if (skip.skip) {
      io.log(`Skipping ${uploadKey}: ${skip.reason}`);
      results.push({ item_key: itemKey, upload_key: uploadKey, status: 'skipped', reason: skip.reason });
      continue;
    }
    if (options.limit && attempted >= options.limit) break;

    attempted += 1;

    if (options.dryRun) {
      const preview = buildDryRunRecord(item, filePath, options);
      io.log(JSON.stringify(preview));
      results.push({ item_key: itemKey, status: 'dry_run', preview });
      continue;
    }

    let uploaded = false;
    for (let attempt = 1; attempt <= DEFAULT_RETRY_LIMIT; attempt += 1) {
      try {
        io.log(`Uploading ${uploadKey} (${attempt}/${DEFAULT_RETRY_LIMIT}) from ${filePath}`);
        const response = await uploadOneVideo(youtube, item, filePath, options);
        const videoId = normalizeInlineText(response?.data?.id);
        const record = buildStateRecord(item, filePath, options, 'uploaded', {
          uploaded_at: new Date().toISOString(),
          youtube_video_id: videoId,
          youtube_url: buildYouTubeWatchUrl(videoId),
          response: response?.data || null,
        });
        await appendStateRecord(options.statePath, record);
        stateStore.byItemKey.set(itemKey, record);
        if (record.upload_key) stateStore.byUploadKey.set(record.upload_key, record);
        results.push({
          item_key: itemKey,
          upload_key: uploadKey,
          status: 'uploaded',
          youtube_video_id: record.youtube_video_id,
          youtube_url: record.youtube_url,
        });
        io.log(
          `Uploaded ${uploadKey}: "${record.title}" from ${filePath}` +
          `${record.youtube_url ? ` -> ${record.youtube_url}` : (record.youtube_video_id ? ` -> ${record.youtube_video_id}` : '')}`
        );
        uploaded = true;
        break;
      } catch (error) {
        const retryable = isRetryableUploadError(error);
        const message = String(error?.message || error);
        if (retryable && attempt < DEFAULT_RETRY_LIMIT) {
          io.error(`Retrying ${uploadKey} after upload error: ${message}`);
          await sleep(1000 * attempt);
          continue;
        }
        const record = buildStateRecord(item, filePath, options, 'failed', { error: message });
        await appendStateRecord(options.statePath, record);
        stateStore.byItemKey.set(itemKey, record);
        if (record.upload_key) stateStore.byUploadKey.set(record.upload_key, record);
        results.push({ item_key: itemKey, upload_key: uploadKey, status: 'failed', error: message });
        io.error(`Failed ${uploadKey}: ${message}`);
        break;
      }
    }

    if (!uploaded) continue;
  }

  return results;
}

function summarizeResults(results) {
  return results.reduce((summary, result) => {
    const key = result.status || 'unknown';
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, {});
}

async function main(
  argv = process.argv.slice(2),
  io = { log: console.log, error: console.error },
  deps = {}
) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return { ok: true, help: true };
  }

  const getAuthClient = deps.getAuthenticatedClient || getAuthenticatedClient;
  const buildYouTubeService = deps.createYouTubeService || createYouTubeService;
  const verifyAuthorizedChannel = deps.ensureAuthorizedChannel || ensureAuthorizedChannel;

  options.downloadRoot = resolveDownloadRoot(options.manifestPath, options.downloadRoot);
  const manifestItems = await loadManifestItems(options.manifestPath);
  io.log(`Loaded ${manifestItems.length} manifest rows from ${options.manifestPath}`);
  io.log(`Using download root ${options.downloadRoot}`);
  if (options.channelHandle) {
    io.log(`Requested YouTube channel handle @${options.channelHandle}`);
  }
  if (!options.dryRun) {
    io.log(`Using state file ${options.statePath}`);
    io.log(`Using token file ${options.tokenPath}`);
  } else if (options.channelHandle) {
    io.log('Skipping channel verification in dry-run mode; it runs before live uploads.');
  }

  let youtube = null;
  if (!options.dryRun) {
    const authClient = await getAuthClient(options.oauthClientPath, options.tokenPath);
    youtube = buildYouTubeService(authClient);
    if (options.channelHandle) {
      const verifiedChannel = await verifyAuthorizedChannel(youtube, options.channelHandle, io);
      options.resolvedChannelId = verifiedChannel?.matchedChannelId || '';
      options.resolvedChannelHandle = verifiedChannel?.requestedHandle || '';
      options.channelNamespace = options.resolvedChannelId ? `channel:${options.resolvedChannelId}` : `handle:${options.channelHandle}`;
    } else {
      options.channelNamespace = `token:${path.resolve(options.tokenPath)}`;
    }
  } else {
    options.channelNamespace = options.channelHandle ? `handle:${options.channelHandle}` : 'dry-run';
  }

  const results = await processManifestItems(manifestItems, options, io, youtube);
  const summary = summarizeResults(results);
  io.log(`Summary: ${JSON.stringify(summary)}`);
  if (!options.dryRun) {
    io.log(`Upload log written to ${options.statePath}`);
  }
  return { ok: true, options, summary, results };
}

module.exports = {
  buildDescription,
  buildDryRunRecord,
  buildTags,
  buildTitle,
  buildUploadPayload,
  buildItemKey,
  buildSourceIdentity,
  buildUploadKey,
  createYouTubeService,
  defaultStatePath,
  defaultTokenPath,
  describePriorUpload,
  ensureAuthorizedChannel,
  inferDownloadRootFromManifest,
  loadManifestItems,
  main,
  normalizeChannelHandle,
  parseGrantedScopes,
  parseArgs,
  parseManifestText,
  readStateStore,
  readStateIndex,
  resolveDownloadRoot,
  resolveVideoPath,
  summarizeChannel,
  shouldSkipItem,
  buildYouTubeWatchUrl,
  tokenHasRequiredScopes,
  truncateCodePoints,
  truncateUtf8,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
