const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (text = '译文') => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] }));

const config = { provider: 'custom', endpoint: 'https://api.example/v1/chat/completions', model: 'example', apiKey: 'synthetic-key' };
const popup = { id: 'test', url: 'chrome-extension://test/translation-options.html' };
const page = { id: 'test', url: 'https://x.com/home', tab: { id: 1 }, frameId: 0 };
function setup({ saved = config, allowed = true, fetcher, schedule = setTimeout, deferTabChanges = false } = {}) {
  let listener;
  const storageListeners = [];
  const tabChanges = [];
  let state = saved;
  const requests = [];
  const chrome = {
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: {
      get: async () => ({ translationConfig: state }),
      set: async values => {
        const oldValue = state; state = values.translationConfig;
        storageListeners.forEach((fn, index) => {
          const emit = () => fn({ translationConfig: { oldValue, newValue: state } }, 'local');
          if (deferTabChanges && index > 0) tabChanges.push(emit); else emit();
        });
      }
    }, onChanged: { addListener: fn => { storageListeners.push(fn); } } },
    permissions: { contains: async () => allowed }
  };
  vm.runInNewContext(fs.readFileSync('extension/translation-background.js', 'utf8'), {
    chrome, URL, AbortController, TextDecoder, crypto: require('node:crypto').webcrypto, setTimeout: schedule, clearTimeout,
    fetch: async (...args) => {
      requests.push(args);
      return fetcher ? fetcher(...args) : new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '开发工具' } }] }));
    }
  });
  const dispatch = (message, sender = page) => new Promise(resolve => {
    if (listener(message, sender, resolve) !== true) resolve(undefined);
  });
  // Direct background tests act as a newly initialized client; real tab modules
  // below must provide their own revision, including intentionally stale ones.
  const send = async (message, sender = page) => {
    if (message.type === 'translate-bio' && !Object.hasOwn(message, 'revision')) {
      const status = await dispatch({ type: 'translation-status' }, sender);
      message = { ...message, revision: status?.revision };
    }
    return dispatch(message, sender);
  };
  const createTab = id => {
    const dom = new JSDOM('', { url: 'https://x.com/', runScripts: 'outside-only' });
    dom.window.chrome = {
      runtime: { sendMessage: message => dispatch(message, { ...page, tab: { id } }) },
      storage: { onChanged: chrome.storage.onChanged }
    };
    dom.window.eval(fs.readFileSync('extension/translation.js', 'utf8'));
    return { translations: dom.window.xpandmaxTranslations, close: () => dom.window.close() };
  };
  return { send, requests, createTab, flushTabChanges: () => tabChanges.splice(0).forEach(emit => emit()) };
}

test('API request uses saved endpoint and key only in background', async () => {
  const { send, requests } = setup();
  const result = await send({ type: 'translate-bio', text: 'Building tools' });
  assert.equal(result.text, '开发工具');
  assert.equal(requests[0][0], config.endpoint);
  assert.equal(requests[0][1].headers.Authorization, 'Bearer synthetic-key');
  assert.equal(requests[0][1].credentials, 'omit');
  assert.equal(requests[0][1].redirect, 'error');
  assert.equal(JSON.parse(requests[0][1].body).messages[1].content, 'Building tools');
  const status = await send({ type: 'translation-status' });
  assert.equal(status.provider, 'custom');
  assert.equal(typeof status.revision, 'string');
  assert.equal(await send({ type: 'translation-config' }), undefined);
});

test('denied permission, disabled provider and untrusted senders never call fetch', async () => {
  for (const options of [{ allowed: false }, { saved: { provider: 'local' } }]) {
    const { send, requests } = setup(options);
    assert.ok((await send({ type: 'translate-bio', text: 'Building tools' })).error);
    assert.equal(requests.length, 0);
  }
  const { send, requests } = setup();
  assert.equal(await send({ type: 'translate-bio', text: 'Building tools' }, { ...page, url: 'https://evil.example/' }), undefined);
  assert.equal(await send({ type: 'translation-save', config }, page), undefined);
  assert.equal(requests.length, 0);
});

test('HTTP errors and malformed responses are sanitized', async () => {
  for (const response of [new Response('synthetic-key', { status: 401 }), new Response('secret', { status: 429 }), new Response('{}'), new Response('<html>secret</html>'), new Response('x'.repeat(65537))]) {
    const { send } = setup({ fetcher: () => response });
    const result = await send({ type: 'translate-bio', text: 'Building tools' });
    assert.equal(typeof result.error, 'string');
    assert.doesNotMatch(result.error, /synthetic-key|secret|<html>/);
  }
});

test('a stalled provider times out, and retries remain a user action', async () => {
  const { send, requests } = setup({
    schedule: callback => setTimeout(callback, 1),
    fetcher: (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('synthetic network error')));
    })
  });
  const result = await send({ type: 'translate-bio', text: 'Building tools' });
  assert.match(result.error, /超时/);
  assert.equal(requests.length, 1);
});

test('background queues requests in arrival order with only two active timers and rejects oversized bios', async () => {
  const pending = [];
  let timers = 0;
  const { send, requests } = setup({
    fetcher: () => new Promise(resolve => pending.push(resolve)),
    schedule: (callback, delay) => { timers++; return setTimeout(callback, delay); }
  });
  const jobs = ['First', 'Second', 'Third', 'Fourth'].map(text => send({ type: 'translate-bio', text }));
  await tick();
  assert.ok((await send({ type: 'translate-bio', text: 'x'.repeat(6001) })).error);
  assert.equal(requests.length, 2);
  assert.equal(timers, 2);
  // Even a provider error must release its slot to the next queued request.
  pending[1](new Response('', { status: 429 }));
  assert.match((await jobs[1]).error, /限流/);
  await tick();
  assert.equal(requests.length, 3);
  assert.equal(timers, 3);
  pending[0](response());
  await tick();
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(([, options]) => JSON.parse(options.body).messages[1].content), ['First', 'Second', 'Third', 'Fourth']);
  pending[2](response()); pending[3](response());
  for (const job of [jobs[0], jobs[2], jobs[3]]) assert.equal((await job).text, '译文');
});

test('two X tabs share the queue and waiting bios finish without a cached failure or manual retry', async t => {
  const pending = [];
  let active = 0, peak = 0;
  const { createTab, requests } = setup({ fetcher: () => new Promise(resolve => {
    peak = Math.max(peak, ++active);
    pending.push(() => { active--; resolve(response()); });
  }) });
  const a = createTab(1), b = createTab(2);
  t.after(() => { a.close(); b.close(); });
  await tick();
  ['A first', 'A second'].forEach(text => a.translations.request(text));
  await tick();
  const bios = ['B first', 'B second', 'B third'];
  bios.forEach(text => b.translations.request(text));
  await tick();
  assert.equal(requests.length, 2);
  for (const text of bios) assert.ok(['queued', 'translating'].includes(b.translations.inspect(text).state));
  pending[0](); pending[1]();
  await tick();
  assert.equal(requests.length, 4);
  pending[2](); pending[3]();
  await tick();
  assert.equal(requests.length, 5);
  pending[4]();
  await tick();
  for (const text of bios) {
    assert.equal(b.translations.inspect(text).state, 'ready');
    assert.equal(b.translations.request(text).text, '译文');
  }
  assert.equal(requests.length, 5);
  assert.equal(peak, 2);
});

test('a timed-out request releases its slot and the waiting request gets its own timeout', async () => {
  const pending = [], timers = [];
  const { send, requests } = setup({
    schedule: (callback, delay) => { timers.push(callback); return setTimeout(callback, delay); },
    fetcher: (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      pending.push(resolve);
    })
  });
  const jobs = ['First', 'Second', 'Waiting'].map(text => send({ type: 'translate-bio', text }));
  await tick();
  assert.equal(timers.length, 2);
  timers[0]();
  assert.match((await jobs[0]).error, /超时/);
  await tick();
  assert.equal(requests.length, 3);
  assert.equal(timers.length, 3);
  pending[1](response()); pending[2](response());
  assert.equal((await jobs[1]).text, '译文');
  assert.equal((await jobs[2]).text, '译文');
});

test('settings reject unsafe URLs and test only uses a fixed synthetic sentence', async () => {
  const { send, requests } = setup();
  for (const endpoint of ['http://api.example/v1', 'https://user:pass@api.example/v1', 'https://api.example/v1?key=secret']) {
    assert.ok((await send({ type: 'translation-save', config: { ...config, endpoint } }, popup)).error);
  }
  assert.equal((await send({ type: 'translation-test', text: 'private data' }, popup)).text, '开发工具');
  assert.equal(JSON.parse(requests[0][1].body).messages[1].content, 'I build useful tools.');
});

test('Google uses a fixed no-key endpoint, joins segments, and requires permission', async () => {
  const google = { provider: 'google', endpoint: 'https://evil.example', apiKey: 'must-not-send' };
  const { send, requests } = setup({ saved: google, fetcher: () => new Response(JSON.stringify({ sentences: [{ trans: '开发' }, { trans: '工具' }] })) });
  assert.equal((await send({ type: 'translate-bio', text: 'Build & share ⟦XP0⟧' })).text, '开发工具');
  const url = new URL(requests[0][0]);
  assert.equal(url.origin, 'https://translate.googleapis.com');
  assert.equal(url.searchParams.get('q'), 'Build & share ⟦XP0⟧');
  assert.equal(url.searchParams.get('tl'), 'zh-CN');
  assert.equal(requests[0][1].method, 'GET');
  assert.equal(requests[0][1].headers, undefined);
  assert.equal((await send({ type: 'translation-status' })).provider, 'google');
  assert.equal((await send({ type: 'translation-save', config: google }, popup)).saved, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await send({ type: 'translation-config' }, popup))), { provider: 'google' });
  const denied = setup({ saved: google, allowed: false });
  assert.ok((await denied.send({ type: 'translate-bio', text: 'Build' })).error);
  assert.equal(denied.requests.length, 0);
});

test('Google rejects missing or malformed translation segments', async () => {
  for (const data of [{}, { sentences: [] }, { sentences: [{ trans: 3 }] }]) {
    const { send } = setup({ saved: { provider: 'google' }, fetcher: () => new Response(JSON.stringify(data)) });
    assert.ok((await send({ type: 'translate-bio', text: 'Build' })).error);
  }
});

test('Gemini sends native contents and header key, preserving model path and hiding thoughts', async () => {
  const saved = { provider: 'gemini', endpoint: 'https://api.example/v1beta', model: 'gemini-test', apiKey: 'synthetic-key' };
  const { send, requests } = setup({ saved, fetcher: () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hidden reasoning', thought: true }, { text: '开发' }, { text: '工具' }] } }] })) });
  assert.equal((await send({ type: 'translate-bio', text: 'Building tools' })).text, '开发工具');
  assert.equal(requests[0][0], 'https://api.example/v1beta/models/gemini-test:generateContent');
  assert.equal(requests[0][1].headers['x-goog-api-key'], 'synthetic-key');
  assert.equal(requests[0][1].headers.Authorization, undefined);
  assert.equal(JSON.parse(requests[0][1].body).contents[0].parts[0].text, 'Building tools');
  assert.equal((await send({ type: 'translation-status' })).provider, 'gemini');
  assert.equal((await send({ type: 'translation-save', config: saved }, popup)).saved, true);
});

test('Gemini rejects blocked, truncated, empty or malformed results and denied permission', async () => {
  const saved = { provider: 'gemini', endpoint: 'https://api.example/v1beta', model: 'gemini-test', apiKey: '' };
  for (const data of [{}, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] }, { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'reasoning' }] } }] }]) {
    const { send, requests } = setup({ saved, fetcher: () => new Response(JSON.stringify(data)) });
    assert.ok((await send({ type: 'translate-bio', text: 'Build' })).error);
    assert.equal(requests.length, 1);
  }
  const denied = setup({ saved, allowed: false });
  assert.ok((await denied.send({ type: 'translate-bio', text: 'Build' })).error);
  assert.equal(denied.requests.length, 0);
});

test('Anthropic uses Messages headers and text blocks, not thinking blocks', async () => {
  const saved = { provider: 'anthropic', endpoint: 'https://api.example', model: 'claude-test', apiKey: 'synthetic-key' };
  const { send, requests } = setup({ saved, fetcher: () => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '译文' }] })) });
  assert.equal((await send({ type: 'translate-bio', text: 'Build' })).text, '译文');
  assert.equal(requests[0][0], 'https://api.example/v1/messages');
  assert.equal(requests[0][1].headers['x-api-key'], 'synthetic-key');
  assert.equal(requests[0][1].headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(requests[0][1].body).messages[0].content, 'Build');
});

test('base addresses and full endpoints normalize without duplicate paths', async () => {
  for (const [provider, endpoint, expected] of [
    ['custom','https://api.example','https://api.example/v1/chat/completions'],
    ['custom','https://api.example/v1/','https://api.example/v1/chat/completions'],
    ['custom','https://api.example/proxy/v2/chat/completions','https://api.example/proxy/v2/chat/completions'],
    ['anthropic','https://api.example/v1/messages','https://api.example/v1/messages'],
    ['gemini','https://api.example','https://api.example/v1beta/models/test:generateContent'],
    ['gemini','https://api.example/v1beta/models/old:generateContent','https://api.example/v1beta/models/test:generateContent']
  ]) {
    const { send, requests } = setup({ saved: { provider, endpoint, model: 'test', apiKey: '' } });
    await send({ type: 'translate-bio', text: 'Build' });
    assert.equal(requests[0][0], expected);
  }
});


test('Google ignores metadata-only sentences but still requires translated text', async () => {
  const { send } = setup({ saved: { provider: 'google' }, fetcher: () => new Response(JSON.stringify({ sentences: [{ trans: '译文' }, { src_translit: 'metadata' }, null] })) });
  assert.equal((await send({ type: 'translate-bio', text: 'Build' })).text, '译文');
});

test('Chat Completions accepts text parts and rejects truncated or non-final output', async () => {
  for (const content of ['译文', [{ type: 'text', text: '译' }, { type: 'text', text: '文' }]]) {
    const { send } = setup({ fetcher: () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content, reasoning_content: 'hidden' } }] })) });
    assert.equal((await send({ type: 'translate-bio', text: 'Build' })).text, '译文');
  }
  for (const finish_reason of ['length', 'content_filter', 'tool_calls', null, undefined]) {
    const { send } = setup({ fetcher: () => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: 'partial' } }] })) });
    assert.ok((await send({ type: 'translate-bio', text: 'Build' })).error);
  }
});

test('saving config aborts old requests and immediately frees both slots without stale results', async () => {
  const pending = [];
  const { send, requests } = setup({ fetcher: (_url, options) => new Promise(resolve => pending.push({ resolve, signal: options.signal })) });
  const old1 = send({ type: 'translate-bio', text: 'Old first' });
  const old2 = send({ type: 'translate-bio', text: 'Old second' });
  const queued = send({ type: 'translate-bio', text: 'Old queued' });
  await new Promise(resolve => setImmediate(resolve));
  await send({ type: 'translation-save', config: { ...config, model: 'new' } }, popup);
  assert.ok(pending[0].signal.aborted && pending[1].signal.aborted);
  assert.match((await queued).error, /设置已更改/);
  const fresh1 = send({ type: 'translate-bio', text: 'New first' });
  const fresh2 = send({ type: 'translate-bio', text: 'New second' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 4);
  const fresh3 = send({ type: 'translate-bio', text: 'Third new' });
  pending[0].resolve(response()); pending[1].resolve(response());
  assert.ok((await old1).error); assert.ok((await old2).error);
  await tick();
  assert.equal(requests.length, 4, 'late old completions must not free new-generation slots');
  pending[2].resolve(response()); pending[3].resolve(response());
  assert.equal((await fresh1).text, '译文'); assert.equal((await fresh2).text, '译文');
  await tick();
  assert.equal(requests.length, 5);
  assert.equal(JSON.parse(requests[4][1].body).model, 'new');
  pending[4].resolve(response());
  assert.equal((await fresh3).text, '译文');
});

test('config changes discard both tabs old queues and late responses cannot replace new translations', async t => {
  const pending = [];
  const { createTab, send, requests } = setup({ fetcher: (_url, options) => new Promise(resolve => pending.push({ resolve, signal: options.signal })) });
  const a = createTab(1), b = createTab(2);
  t.after(() => { a.close(); b.close(); });
  await tick();
  ['A first', 'A second'].forEach(text => a.translations.request(text));
  await tick();
  ['B first', 'B second', 'B third'].forEach(text => b.translations.request(text));
  await tick();
  await send({ type: 'translation-save', config: { ...config, model: 'new' } }, popup);
  await tick();
  assert.ok(pending.every(job => job.signal.aborted));
  assert.equal(b.translations.inspect('B third'), null);
  a.translations.request('A first'); b.translations.request('B first');
  await tick();
  assert.equal(requests.length, 4);
  pending[2].resolve(response('新译文')); pending[3].resolve(response('新译文'));
  await tick();
  pending[0].resolve(response('旧译文')); pending[1].resolve(response('旧译文'));
  await tick();
  assert.equal(a.translations.inspect('A first').text, '新译文');
  assert.equal(b.translations.inspect('B first').text, '新译文');
  assert.equal(requests.length, 4, 'cancelled queued bios must never reach the provider');
});

test('delayed tab notifications cannot send old queued bios through the new configuration', async t => {
  const pending = [];
  const { createTab, send, requests, flushTabChanges } = setup({
    deferTabChanges: true,
    fetcher: () => new Promise(resolve => pending.push(resolve))
  });
  const a = createTab(1), b = createTab(2);
  t.after(() => { a.close(); b.close(); });
  await tick();
  ['A first', 'A second'].forEach(text => a.translations.request(text));
  await tick();
  ['B first', 'B second', 'B third'].forEach(text => b.translations.request(text));
  await tick();
  await send({ type: 'translation-save', config: { ...config, model: 'new' } }, popup);
  await tick();
  assert.equal(requests.length, 2, 'stale tabs must not submit old work using new settings');
  assert.equal(b.translations.inspect('B third'), null);
  flushTabChanges();
  await tick();
  b.translations.request('New bio');
  await tick();
  assert.equal(requests.length, 3);
  assert.equal(JSON.parse(requests[2][1].body).model, 'new');
  pending[2](response('新译文'));
  pending[0](response('旧译文')); pending[1](response('旧译文'));
  await tick();
  assert.equal(b.translations.inspect('New bio').text, '新译文');
  assert.equal(requests.length, 3);
});

test('a new background instance rejects a previous workers revision before calling the provider', async () => {
  const first = setup(), second = setup();
  const before = await first.send({ type: 'translation-status' });
  const after = await second.send({ type: 'translation-status' });
  assert.notEqual(before.revision, after.revision);
  for (const revision of [before.revision, undefined]) {
    const result = await second.send({ type: 'translate-bio', text: 'Bio', revision });
    assert.equal(result.code, 'cancelled');
  }
  assert.equal(second.requests.length, 0);
  assert.equal((await second.send({ type: 'translate-bio', text: 'Bio', revision: after.revision })).text, '开发工具');
});
