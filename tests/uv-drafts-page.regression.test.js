const test = require('node:test');
const assert = require('node:assert/strict');

const createUVDraftsPageModule = require('../uv-drafts-page.js');

const {
  getComposerModelFamily,
  resolveComposerModelValue,
  buildPublicPostPayload,
  extractPublishedPost,
  applyPublishedPostToDraftData,
} = createUVDraftsPageModule.__test;

test('composer model helpers resolve legacy aliases onto canonical backend IDs', () => {
  const models = [
    { value: 'sy_8_20251208', label: 'Sora 2' },
    { value: 'sy_ore', label: 'Sora 2 Pro' },
  ];

  assert.equal(getComposerModelFamily('sora2'), 'sy_8');
  assert.equal(getComposerModelFamily('sora2pro'), 'sy_ore');
  assert.equal(resolveComposerModelValue(models, 'sora2'), 'sy_8_20251208');
  assert.equal(resolveComposerModelValue(models, 'sy_8'), 'sy_8_20251208');
  assert.equal(resolveComposerModelValue(models, 'sora2pro'), 'sy_ore');
  assert.equal(resolveComposerModelValue(models, 'sy_ore'), 'sy_ore');
});

test('buildPublicPostPayload uses the documented share payload shape', () => {
  assert.deepEqual(buildPublicPostPayload('gen_123', 'hello world'), {
    post_text: 'hello world',
    attachments_to_create: [
      {
        kind: 'sora',
        generation_id: 'gen_123',
      },
    ],
    destinations: [{ type: 'public' }],
  });
});

test('extractPublishedPost accepts nested post responses', () => {
  const payload = {
    item: {
      post: {
        id: 's_123',
        permalink: '/p/s_123',
      },
    },
  };

  assert.deepEqual(extractPublishedPost(payload), {
    id: 's_123',
    permalink: '/p/s_123',
  });
});

test('applyPublishedPostToDraftData marks drafts public and clears scheduled state', () => {
  const draft = {
    id: 'gen_123',
    scheduled_post_id: 'schedule_gen_123',
    scheduled_post_at: 123456789,
    scheduled_post_status: 'pending',
    scheduled_post_caption: 'queued caption',
    post_meta: {
      share_ref: 'old_ref',
    },
  };

  const updated = applyPublishedPostToDraftData(draft, {
    id: 's_123',
    permalink: '/p/s_123',
    share_ref: 'share_ref_1',
    permissions: { share_setting: 'public' },
  });

  assert.equal(updated.post_id, 's_123');
  assert.equal(updated.post_permalink, '/p/s_123');
  assert.equal(updated.post_visibility, 'public');
  assert.equal(updated.posted_to_public, true);
  assert.deepEqual(updated.post_meta, {
    id: 's_123',
    permalink: '/p/s_123',
    visibility: 'public',
    posted_to_public: true,
    share_ref: 'share_ref_1',
    share_setting: 'public',
  });
  assert.equal('scheduled_post_id' in updated, false);
  assert.equal('scheduled_post_at' in updated, false);
  assert.equal('scheduled_post_status' in updated, false);
  assert.equal('scheduled_post_caption' in updated, false);
});
