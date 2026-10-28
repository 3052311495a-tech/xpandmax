const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const header = handle => `<div data-testid="User-Name"><div><a href="/${handle}">${handle}</a></div><div><span>@${handle}</span></div></div>`;
const cell = handle => `<div data-testid="UserCell"><div data-testid="UserAvatar-Container-${handle}"></div><div><a href="/${handle}">${handle}</a></div></div>`;

function storageBackend(initial = {}) {
  const data = { ...initial };
  const listeners = [];
  const writes = [];
  const chrome = { runtime: { lastError: undefined, sendMessage(message, callback) { chrome.sent.push(message); callback?.({ ok: true, notified: false }); } }, sent: [] };
  chrome.storage = {
    local: {
      get(defaults, callback) {
        const base = defaults && typeof defaults === 'object' ? { ...defaults } : {};
        callback({ ...base, ...data });
      },
      set(values, callback) {
        Object.assign(data, values);
        writes.push(values);
        const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }]));
        listeners.forEach(listener => listener(changes, 'local'));
        callback?.();
      }
    },
    onChanged: { addListener(listener) { listeners.push(listener); } }
  };
  return { chrome, data, writes };
}

function setup(initial) {
  const backend = storageBackend(initial);
  const dom = new JSDOM(`<a data-testid="AppTabBar_Profile_Link" href="/Me"></a><main>${cell('Dave')}<article>${header('Alice')}<button data-testid="caret"></button><div role="link">${header('Bob')}</div></article><article>${header('Me')}<button data-testid="caret"></button></article></main>`, {
    url: 'https://x.com/home', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  const observers = [];
  const NativeObserver = w.MutationObserver;
  w.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const close = w.close.bind(w);
  w.close = () => { observers.forEach(observer => observer.disconnect()); close(); };
  w.chrome = backend.chrome;
  w.postMessage = data => w.dispatchEvent(new w.MessageEvent('message', { data, origin: w.location.origin, source: w }));
  w.eval(fs.readFileSync('extension/monitor.js', 'utf8'));
  w.eval(fs.readFileSync('extension/content.js', 'utf8'));
  const send = users => w.postMessage({ channel: 'x-follower-count-v1', type: 'counts', users });
  return { ...backend, dom, w, send };
}

test('监控按钮出现在原帖、引用、自己和账号卡片上，伪造点击不会改名单', async () => {
  const page = setup();
  let toggles = 0;
  try {
    page.send([
      { handle: 'Alice', count: 10, bio: '简介', userId: '42', following: false },
      { handle: 'Bob', count: 2, bio: '引用', userId: 'nope' },
      { handle: 'Me', count: 3, bio: '自己' },
      { handle: 'Dave', count: 4 }
    ]);
    await tick();
    const buttons = [...page.w.document.querySelectorAll('[data-xfc-monitor]')];
    assert.deepEqual(buttons.map(button => button.dataset.xfcHandle).sort(), ['alice', 'bob', 'dave', 'me']);
    assert.equal(page.w.document.querySelectorAll('[data-xfc-follow]').length, 1);
    const alice = page.w.document.querySelector('article [data-xfc-monitor]');
    assert.equal(alice.dataset.xfcUserId, '42');
    assert.equal(alice.textContent, '监控');
    assert.equal(page.w.document.querySelector('[data-testid="UserCell"] [data-xfc-badge]').textContent, '粉丝 4');
    const original = page.w.xpandmaxMonitor.toggle;
    page.w.xpandmaxMonitor.toggle = (...args) => { toggles += 1; return original(...args); };
    alice.click();
    await tick();
    assert.equal(toggles, 0);
    assert.equal(page.data.monitorAccounts, undefined);
  } finally { page.dom.window.close(); }
});

test('加入和移出只写入用户名等标识，并通知 monitor 与 unmonitor', async () => {
  const page = setup();
  try {
    page.send([{ handle: 'Alice', count: 10, bio: '不要保存', userId: '42', following: false }]);
    await tick();
    const added = await page.w.xpandmaxMonitor.toggle({ username: '@Alice', userId: '42', bio: '不要保存' });
    await tick();
    assert.equal(added.ok, true);
    assert.equal(added.monitored, true);
    assert.equal(added.notified, false);
    const stored = page.data.monitorAccounts;
    assert.equal(stored.length, 1);
    assert.deepEqual(Object.keys(stored[0]).sort(), ['addedAt', 'profileUrl', 'userId', 'username']);
    assert.equal(stored[0].username, 'alice');
    assert.equal(stored[0].userId, '42');
    assert.equal(stored[0].profileUrl, 'https://x.com/alice');
    assert.equal(page.w.document.querySelector('article [data-xfc-monitor]').textContent, '已监控');
    assert.equal(JSON.stringify(page.chrome.sent[0]), JSON.stringify({
      type: 'monitor-notify', action: 'monitor',
      account: { username: 'alice', profileUrl: 'https://x.com/alice', userId: '42' }
    }));
    const removed = await page.w.xpandmaxMonitor.remove('Alice');
    await tick();
    assert.equal(removed.monitored, false);
    assert.equal(JSON.stringify(page.data.monitorAccounts), '[]');
    assert.equal(page.chrome.sent[1].action, 'unmonitor');
    assert.equal(page.chrome.sent[1].account.userId, '42');
    assert.equal(page.w.document.querySelector('article [data-xfc-monitor]').textContent, '监控');
    assert.equal((await page.w.xpandmaxMonitor.toggle({ username: 'bad name' })).ok, false);
    assert.equal(page.data.monitorAccounts.length, 0);
  } finally { page.dom.window.close(); }
});

test('每个页面使用自己的 chrome.storage，名单互不影响，满额后拒绝新增', async () => {
  const first = setup();
  const second = setup();
  try {
    await first.w.xpandmaxMonitor.add({ username: 'alpha' });
    assert.equal(second.w.xpandmaxMonitor.list().length, 0);
    assert.equal(first.w.xpandmaxMonitor.list()[0].username, 'alpha');
    const full = Array.from({ length: 500 }, (_, index) => ({ username: `u${String(index).padStart(3, '0')}`, addedAt: index }));
    const packed = setup({ monitorAccounts: full });
    try {
      const result = await packed.w.xpandmaxMonitor.add({ username: 'new_user' });
      assert.equal(result.ok, false);
      assert.equal(packed.data.monitorAccounts.length, 500);
      assert.equal(packed.chrome.sent.length, 0);
    } finally { packed.dom.window.close(); }
  } finally { first.dom.window.close(); second.dom.window.close(); }
});

test('Webhook 保存前校验地址；未授权不写入', async () => {
  const dom = new JSDOM(fs.readFileSync('extension/popup.html', 'utf8'), { url: 'chrome-extension://test/popup.html', runScripts: 'outside-only' });
  const w = dom.window;
  const backend = storageBackend();
  const requests = [];
  w.chrome = backend.chrome;
  w.chrome.permissions = { request: async origins => { requests.push(origins); return requests.allow; } };
  w.chrome.permissions.request = async spec => { requests.push(spec); return requests.allow; };
  try {
    w.eval(fs.readFileSync('extension/monitor.js', 'utf8'));
    w.eval(fs.readFileSync('extension/popup.js', 'utf8'));
    const input = w.document.querySelector('#monitor-webhook-url');
    const form = w.document.querySelector('#monitor-webhook');
    const submit = () => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    for (const value of ['http://hooks.example/x', 'https://user:pass@hooks.example/x', 'https://hooks.example/x#frag', 'https://x.com/hook', 'https://api.twitter.com/hook']) {
      input.value = value;
      submit();
      assert.equal(backend.data.monitorWebhookUrl, undefined);
      assert.equal(requests.length, 0);
    }
    input.value = 'https://hooks.example/xpand?token=synthetic';
    requests.allow = false;
    submit();
    await tick();
    assert.equal(backend.data.monitorWebhookUrl, undefined);
    assert.equal(requests[0].origins[0], 'https://hooks.example/*');
    requests.allow = true;
    submit();
    await tick();
    assert.equal(backend.data.monitorWebhookUrl, 'https://hooks.example/xpand?token=synthetic');
    input.value = '  ';
    submit();
    await tick();
    assert.equal(backend.data.monitorWebhookUrl, '');
    assert.equal(requests.length, 2);
  } finally { dom.window.close(); }
});

test('弹窗列出本机名单，移出后通知 unmonitor', async () => {
  const dom = new JSDOM(fs.readFileSync('extension/popup.html', 'utf8'), { url: 'chrome-extension://test/popup.html', runScripts: 'outside-only' });
  const w = dom.window;
  const backend = storageBackend({ monitorAccounts: [{ username: 'alice', userId: '7', profileUrl: 'https://x.com/alice', addedAt: 5 }, { username: 'carol', profileUrl: 'https://x.com/carol', addedAt: 9 }] });
  w.chrome = backend.chrome;
  try {
    w.eval(fs.readFileSync('extension/monitor.js', 'utf8'));
    w.eval(fs.readFileSync('extension/popup.js', 'utf8'));
    assert.deepEqual([...w.document.querySelectorAll('#monitor-accounts span')].map(node => node.textContent), ['@carol', '@alice']);
    w.document.querySelector('[aria-label="移出 @carol"]').click();
    await tick();
    assert.deepEqual(Array.from(backend.data.monitorAccounts, account => account.username), ['alice']);
    assert.equal(w.chrome.sent.at(-1).action, 'unmonitor');
    assert.equal(w.chrome.sent.at(-1).account.username, 'carol');
    assert.equal(w.document.querySelector('#monitor-accounts span').textContent, '@alice');
    assert.equal(w.document.querySelector('#monitor-empty').hidden, true);
  } finally { dom.window.close(); }
});

function setupBackground({ webhook = '', allowed = true, status = 200, fail = false } = {}) {
  const requests = [];
  let listener;
  const chrome = {
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: { get: async () => ({ monitorWebhookUrl: webhook }), set: async () => {} }, onChanged: { addListener() {} } },
    permissions: { contains: async () => allowed }
  };
  vm.runInNewContext(fs.readFileSync('extension/translation-background.js', 'utf8'), {
    chrome, URL, AbortController, TextDecoder, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout,
    fetch: async (...args) => {
      requests.push(args);
      if (fail) throw new Error('offline');
      return new Response('', { status });
    }
  });
  const page = { id: 'test', url: 'https://x.com/home', tab: { id: 1 }, frameId: 0 };
  const send = (message, sender = page) => new Promise(resolve => {
    if (listener(message, sender, resolve) !== true) resolve(undefined);
  });
  return { send, requests, page };
}

test('配置了 Webhook 才 POST 固定字段，不附带简介、Cookie 或调用方传入的链接', async () => {
  const silent = setupBackground();
  const quiet = await silent.send({ type: 'monitor-notify', action: 'monitor', account: { username: 'alice', bio: 'secret' } });
  assert.equal(quiet.notified, false);
  assert.equal(quiet.error, undefined);
  assert.equal(silent.requests.length, 0);

  const denied = setupBackground({ webhook: 'https://hooks.example/xpand', allowed: false });
  const blocked = await denied.send({ type: 'monitor-notify', action: 'monitor', account: { username: 'alice' } });
  assert.equal(blocked.notified, false);
  assert.match(blocked.error, /允许/);
  assert.equal(denied.requests.length, 0);

  const live = setupBackground({ webhook: 'https://hooks.example/xpand?token=synthetic' });
  const result = await live.send({
    type: 'monitor-notify', action: 'monitor',
    account: { username: '@Alice', userId: '42', profileUrl: 'https://evil.test/alice', bio: 'secret', cookie: 'no' }
  });
  assert.equal(result.notified, true);
  assert.equal(live.requests[0][0], 'https://hooks.example/xpand?token=synthetic');
  assert.equal(live.requests[0][1].method, 'POST');
  assert.equal(live.requests[0][1].credentials, 'omit');
  assert.equal(live.requests[0][1].redirect, 'error');
  assert.equal(live.requests[0][1].referrerPolicy, 'no-referrer');
  assert.equal(JSON.stringify(live.requests[0][1].headers), JSON.stringify({ 'Content-Type': 'application/json' }));
  assert.equal(live.requests[0][1].body, JSON.stringify({
    action: 'monitor', platform: 'x', username: 'alice', userId: '42', profileUrl: 'https://x.com/alice', source: 'xpandmax'
  }));
  const removed = await live.send({ type: 'monitor-notify', action: 'unmonitor', account: { username: 'alice' } }, { id: 'test', url: 'chrome-extension://test/popup.html' });
  assert.equal(removed.notified, true);
  assert.equal(JSON.parse(live.requests[1][1].body).action, 'unmonitor');
  assert.equal(Object.hasOwn(JSON.parse(live.requests[1][1].body), 'userId'), false);

  const failed = setupBackground({ webhook: 'https://hooks.example/xpand', status: 500 });
  assert.equal((await failed.send({ type: 'monitor-notify', action: 'monitor', account: { username: 'alice' } })).notified, false);
  const offline = setupBackground({ webhook: 'https://hooks.example/xpand', fail: true });
  assert.match((await offline.send({ type: 'monitor-notify', action: 'unmonitor', account: { username: 'alice' } })).error, /失败/);

  for (const sender of [
    { id: 'other', url: 'https://x.com/home', tab: { id: 1 }, frameId: 0 },
    { id: 'test', url: 'https://evil.test/', tab: { id: 1 }, frameId: 0 },
    { id: 'test', url: 'https://x.com/home', tab: { id: 1 }, frameId: 1 },
    { id: 'test', url: 'chrome-extension://test/translation-options.html' }
  ]) {
    const gate = setupBackground({ webhook: 'https://hooks.example/xpand' });
    assert.equal(await gate.send({ type: 'monitor-notify', action: 'monitor', account: { username: 'alice' } }, sender), undefined);
    assert.equal(gate.requests.length, 0);
  }
  const invalid = setupBackground({ webhook: 'https://x.com/hook' });
  assert.equal((await invalid.send({ type: 'monitor-notify', action: 'monitor', account: { username: 'alice' } })).notified, false);
  assert.equal(invalid.requests.length, 0);
  assert.equal((await live.send({ type: 'monitor-notify', action: 'delete', account: { username: 'alice' } })).ok, false);
});
