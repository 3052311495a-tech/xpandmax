const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('release evidence rejects changed code, stale or incomplete page validation', async () => {
  const { extensionDigest, validateChromeEvidence } = await import('../scripts/extension-evidence.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xpand-evidence-test-'));
  try {
    const extension = path.join(root, 'extension'); await fs.mkdir(extension);
    await fs.writeFile(path.join(extension, 'manifest.json'), '{"version":"test"}');
    const file = path.join(root, 'report.json');
    const now = Date.now();
    const report = { schema: 1, mode: 'existing-authenticated-chrome-page', candidateDelivery: 'temporary-page-code',
      status: 'passed', verifiedAt: new Date(now).toISOString(), extensionDigest: await extensionDigest(extension),
      checks: ['timeline', 'quotedTweets', 'detailMainTweet', 'returnNavigation'].map(name => ({ name, passed: true })),
      samples: { timeline: 2, quotes: 1, detail: 1 } };
    await fs.writeFile(file, JSON.stringify(report));
    assert.equal((await validateChromeEvidence(file, extension, now)).status, 'passed');
    await assert.rejects(validateChromeEvidence(file, extension, now + 3600001), /expired/);
    await fs.writeFile(file, JSON.stringify({ ...report, samples: { timeline: 2, quotes: 0, detail: 1 } }));
    await assert.rejects(validateChromeEvidence(file, extension, now), /positive/);
    await fs.writeFile(file, JSON.stringify({ ...report, checks: report.checks.slice(1) }));
    await assert.rejects(validateChromeEvidence(file, extension, now), /incomplete/);
    await fs.writeFile(file, JSON.stringify(report));
    await fs.writeFile(path.join(extension, 'manifest.json'), '{"version":"changed"}');
    await assert.rejects(validateChromeEvidence(file, extension, now), /changed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
