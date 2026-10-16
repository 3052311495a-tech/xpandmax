const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

for (const provider of ['custom', 'google', 'gemini', 'anthropic']) test(`${provider} translates without browser models and preserves handles`, async () => {
  const dom = new JSDOM('', { url: 'https://x.com/', runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  w.chrome = {
    runtime: { sendMessage: async message => {
      if (message.type === 'translation-status') return { provider };
      calls.push(message);
      return { text: '为创作者开发工具 ⟦XP0⟧' };
    } },
    storage: { onChanged: { addListener() {} } }
  };
  try {
    w.eval(fs.readFileSync('extension/translation.js', 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 0));
    w.xpandmaxTranslations.request('Building tools for creators @Example');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(w.xpandmaxTranslations.inspect('Building tools for creators @Example')?.text, '为创作者开发工具 @Example');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'translate-bio');
    assert.equal(calls[0].text, 'Building tools for creators ⟦XP0⟧');
  } finally { w.close(); }
});

test('switching to API escapes hung local model jobs and ignores their late results', async () => {
  const dom = new JSDOM('', { url: 'https://x.com/', runScripts: 'outside-only' });
  const w = dom.window;
  let provider = 'local', changed;
  let finishLocal;
  const calls = [];
  w.LanguageDetector = { create: async () => ({ detect: async () => [{ detectedLanguage: 'en' }] }) };
  w.Translator = { create: () => new Promise(resolve => { finishLocal = resolve; }) };
  w.chrome = {
    runtime: { sendMessage: async message => {
      if (message.type === 'translation-status') return { provider };
      calls.push(message);
      return { text: '新接口译文' };
    } },
    storage: { onChanged: { addListener: listener => { changed = listener; } } }
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    w.eval(fs.readFileSync('extension/translation.js', 'utf8'));
    await tick();
    w.xpandmaxTranslations.request('First bio');
    w.xpandmaxTranslations.request('Second bio');
    await tick();
    provider = 'custom';
    changed({ translationConfig: {} }, 'local');
    await tick();
    w.xpandmaxTranslations.request('First bio');
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(w.xpandmaxTranslations.inspect('First bio').text, '新接口译文');
    finishLocal({ translate: async () => '旧译文' });
    await tick();
    assert.equal(w.xpandmaxTranslations.inspect('First bio').text, '新接口译文');
  } finally { w.close(); }
});

test('pending provider refresh immediately invalidates old work and ignores out-of-order status replies', async () => {
  const dom = new JSDOM('', { url: 'https://x.com/', runScripts: 'outside-only' });
  const w = dom.window;
  const statuses = [], pending = [];
  let changed;
  w.chrome = {
    runtime: { sendMessage: message => new Promise(resolve => {
      (message.type === 'translation-status' ? statuses : pending).push(resolve);
    }) },
    storage: { onChanged: { addListener: listener => { changed = listener; } } }
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    w.eval(fs.readFileSync('extension/translation.js', 'utf8'));
    statuses[0]({ provider: 'custom' });
    await tick();
    const api = w.xpandmaxTranslations;
    ['First bio', 'Second bio', 'Queued bio'].forEach(text => api.request(text));
    await tick();
    changed({ translationConfig: {} }, 'local');
    pending[0]({ text: '旧译文' }); pending[1]({ text: '旧译文' });
    await tick();
    assert.equal(pending.length, 2, 'old completion must not start an old queued bio');
    assert.equal(api.inspect('First bio'), null);
    assert.equal(api.request('During refresh'), null);
    changed({ translationConfig: {} }, 'local');
    statuses[2]({ provider: 'google' });
    await tick();
    statuses[1]({ provider: 'local' });
    await tick();
    assert.ok(api.request('First bio'), 'late local status must not replace the latest online provider');
    await tick();
    assert.equal(pending.length, 3);
    pending[2]({ text: '新译文' });
    await tick();
    assert.equal(api.inspect('First bio').text, '新译文');
  } finally { w.close(); }
});

test('a stale background revision refreshes status and visible bios resume without caching cancellation', async () => {
  const dom = new JSDOM('', { url: 'https://x.com/', runScripts: 'outside-only' });
  const w = dom.window;
  let statuses = 0, visible = false;
  const calls = [];
  w.chrome = {
    runtime: { sendMessage: async message => {
      if (message.type === 'translation-status') return { provider: 'custom', revision: ++statuses === 1 ? 'old' : 'new' };
      calls.push(message);
      return message.revision === 'old' ? { error: '设置已更改', code: 'cancelled' } : { text: '新译文' };
    } },
    storage: { onChanged: { addListener() {} } }
  };
  try {
    w.eval(fs.readFileSync('extension/translation.js', 'utf8'));
    const api = w.xpandmaxTranslations;
    // Match the content UI: a translation update re-renders visible bios.
    w.addEventListener('xpandmax:translation', () => { if (visible) api.request('Visible bio'); });
    await new Promise(resolve => setTimeout(resolve, 0));
    visible = true;
    api.request('Visible bio');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(statuses, 2);
    assert.deepEqual(calls.map(call => call.revision), ['old', 'new']);
    assert.equal(api.inspect('Visible bio').state, 'ready');
    assert.equal(api.inspect('Visible bio').text, '新译文');
  } finally { w.close(); }
});
