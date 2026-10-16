const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const bridge = fs.readFileSync('extension/bridge.js', 'utf8');
const content = fs.readFileSync('extension/content.js', 'utf8');
const translation = fs.readFileSync('extension/translation.js', 'utf8');
const channel = 'x-follower-count-v1';
const tick = () => new Promise(resolve => setTimeout(resolve, 45));

function cell(handle, name = handle) {
  return `<div data-testid="UserCell"><div data-testid="UserAvatar-Container-${handle}"></div><div><a href="/${handle}">${name}</a></div><a href="/${handle}">@${handle}</a><a href="/WrongUser">简介提到的账号</a></div>`;
}

function setup(html = cell('Alice'), before = false) {
  const dom = new JSDOM(`<main data-testid="primaryColumn">${html}</main><aside>${cell('Alice')}</aside>`, {
    url: 'https://x.com/demo_account/verified_followers', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const { window: w } = dom;
  const observers = [];
  const NativeObserver = w.MutationObserver;
  w.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const close = w.close.bind(w);
  w.close = () => { observers.forEach(observer => observer.disconnect()); close(); };
  // jsdom 的 postMessage 未设置来源，这里模拟浏览器同源消息。
  w.postMessage = data => w.dispatchEvent(new w.MessageEvent('message', { data, origin: w.location.origin, source: w }));
  w.eval(translation);
  if (!before) w.eval(content);
  return { dom, w, main: w.document.querySelector('main') };
}

function send(w, users, origin = w.location.origin) {
  w.dispatchEvent(new w.MessageEvent('message', { data: { channel, type: 'counts', users }, origin, source: w }));
}

test('粉丝数对应账号，支持零值、万和精确悬停提示，侧栏也可显示', async () => {
  const { dom, w, main } = setup(cell('Alice') + cell('Bob') + cell('Zero'));
  try {
    send(w, [{ handle: 'ALICE', count: 104912 }, { handle: 'Bob', count: 913 }, { handle: 'Zero', count: 0 }]);
    await tick();
    assert.deepEqual([...main.querySelectorAll('[data-xfc-badge]')].map(x => x.textContent), ['粉丝 10.5万', '粉丝 913', '粉丝 0']);
    main.querySelector('[data-xfc-badge]').focus();
    assert.match(w.document.querySelector('[data-xfc-preview]').textContent, /104,912/);
    assert.equal(w.document.querySelector('aside [data-xfc-badge]').textContent, '粉丝 10.5万');
  } finally { dom.window.close(); }
});

test('滚动新增、DOM 复用、重复消息不会错配或重复插入', async () => {
  const { dom, w, main } = setup();
  try {
    send(w, [{ handle: 'Alice', count: 9 }, { handle: 'Bob', count: 40 }]);
    await tick();
    main.insertAdjacentHTML('beforeend', cell('Bob'));
    await tick();
    assert.equal(main.querySelectorAll('[data-xfc-badge]').length, 2);
    const first = main.firstElementChild;
    first.querySelector('[data-testid]').setAttribute('data-testid', 'UserAvatar-Container-Carol');
    for (const link of first.querySelectorAll('a[href="/Alice"]')) { link.href = '/Carol'; link.textContent = 'Carol'; }
    await tick();
    assert.equal(first.querySelector('[data-xfc-badge]').textContent, '粉丝 —');
    send(w, [{ handle: 'Carol', count: 75 }]);
    send(w, [{ handle: 'Carol', count: 75 }]);
    await tick();
    assert.equal(first.querySelector('[data-xfc-badge]').textContent, '粉丝 75');
    assert.equal(main.querySelectorAll('[data-xfc-badge]').length, 2);
  } finally { dom.window.close(); }
});

test('非法来源、错误数字不展示；切换路由后继续处理有效账号卡片', async () => {
  const { dom, w, main } = setup();
  try {
    send(w, [{ handle: 'Alice', count: 999 }], 'https://other.example');
    send(w, [{ handle: 'Alice', count: -1 }, { handle: 'Alice', count: '42' }, null]);
    await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 —');
    w.history.pushState({}, '', '/home');
    w.dispatchEvent(new w.PopStateEvent('popstate'));
    await tick();
    assert.equal(main.querySelectorAll('[data-xfc-badge]').length, 1);
    main.firstElementChild.removeAttribute('data-testid');
    await tick();
    assert.equal(main.querySelectorAll('[data-xfc-badge]').length, 0);
  } finally { dom.window.close(); }
});

function author(handle, linked = true, testid = 'User-Name') {
  const name = linked ? `<a href="/${handle}">作者 ${handle}</a>` : `<div>作者 ${handle}</div>`;
  return `<div data-testid="${testid}"><div>${name}</div><div><span>@${handle}</span><time>1h</time></div></div>`;
}

test('首页原帖、无链接的引用帖分别映射作者，正文提及不添加标签', async () => {
  const { dom, w, main } = setup(`<article>${author('Alice')}<p><a href="/Carol">@Carol</a></p><div role="link">${author('Bob', false)}</div></article>`);
  try {
    w.history.pushState({}, '', '/home');
    send(w, [{ handle: 'Alice', count: 111 }, { handle: 'Bob', count: 222 }, { handle: 'Carol', count: 333 }]);
    await tick();
    assert.deepEqual([...main.querySelectorAll('[data-xfc-badge]')].map(x => [x.dataset.xfcHandle, x.textContent]), [['alice', '111粉丝'], ['bob', '222粉丝']]);
    assert.equal(main.querySelector('p [data-xfc-badge]'), null);
    const quote = main.querySelector('[role="link"] [data-testid="User-Name"]');
    quote.children[1].querySelector('span').textContent = '@Carol';
    await tick();
    assert.equal(quote.querySelector('[data-xfc-badge]').textContent, '333粉丝');
    assert.equal(main.querySelectorAll('[data-xfc-badge]').length, 2);
  } finally { dom.window.close(); }
});

test('搜索、回复及个人页标题复用同一账号匹配，未知作者不借用其他数字', async () => {
  const { dom, w, main } = setup(author('Alice', false, 'UserName') + author('Unknown') + author('Alice'));
  try {
    send(w, [{ handle: 'Alice', count: 99 }]);
    for (const path of ['/search?q=test', '/Alice/status/123', '/Alice']) {
      w.history.pushState({}, '', path);
      w.dispatchEvent(new w.PopStateEvent('popstate'));
      await tick();
      assert.deepEqual([...main.querySelectorAll('[data-xfc-badge]')].map(x => x.textContent), ['粉丝 99', '粉丝 —', '粉丝 99']);
    }
    main.querySelector('[data-testid="UserName"]').children[1].innerHTML = '<span>@Alice</span><span>@Bob</span>';
    await tick();
    assert.equal(main.querySelector('[data-testid="UserName"] [data-xfc-badge]'), null);
  } finally { dom.window.close(); }
});

test('fetch 提取新旧字段，原响应仍可读取，并支持晚启动重放', async () => {
  const { dom, w, main } = setup(cell('Alice') + cell('Bob'), true);
  let calls = 0;
  const body = { data: [{ core: { screen_name: 'Alice' }, relationship_counts: { followers: 12345 } }, { legacy: { screen_name: 'Bob', followers_count: 0 } }] };
  w.fetch = () => { calls++; return Promise.resolve({ ok: true, url: 'https://x.com/i/api/graphql/test/Followers', clone: () => ({ json: async () => body }), json: async () => body }); };
  try {
    w.eval(bridge);
    const response = await w.fetch('/i/api/graphql/test/Followers');
    assert.deepEqual(await response.json(), body);
    await tick();
    w.eval(content);
    await tick();
    assert.deepEqual([...main.querySelectorAll('[data-xfc-badge]')].map(x => x.textContent), ['粉丝 1.2万', '粉丝 0']);
    assert.equal(calls, 1);
  } finally { dom.window.close(); }
});

test('XHR 成功读取，接口失败和外域响应不会覆盖已知数字', async () => {
  const { dom, w, main } = setup();
  class XHR extends w.EventTarget {
    send() { this.dispatchEvent(new w.Event('loadend')); }
  }
  w.XMLHttpRequest = XHR;
  w.fetch = async () => { throw new Error('network'); };
  try {
    w.eval(bridge);
    const xhr = new XHR();
    xhr.status = 200; xhr.responseType = ''; xhr.responseURL = 'https://x.com/i/api/graphql/test/BlueVerifiedFollowers';
    xhr.responseText = JSON.stringify({ core: { screen_name: 'Alice' }, relationship_counts: { followers: 31 } });
    xhr.send(); await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 31');
    xhr.status = 429; xhr.responseText = 'not json'; xhr.send();
    xhr.status = 200; xhr.responseURL = 'https://other.example/i/api/graphql/test/Users'; xhr.send();
    await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 31');
    await assert.rejects(w.fetch('/anything'), /network/);
  } finally { dom.window.close(); }
});

test('安装清单仅向 X 注入脚本，翻译站点权限可选，运行文件均存在', () => {
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.ok(fs.existsSync(`extension/${manifest.background.service_worker}`));
  assert.ok(fs.existsSync(`extension/${manifest.options_page}`));
  for (const script of manifest.content_scripts) {
    assert.deepEqual(script.matches, ['https://x.com/*', 'https://twitter.com/*']);
    assert.equal(script.run_at, 'document_start');
    for (const file of [...script.js, ...(script.css || [])]) assert.ok(fs.existsSync(`extension/${file}`));
  }
});

test('异常链接不会阻断其他作者，显示名以 @ 开头也能匹配', async () => {
  const { dom, w, main } = setup(cell('Alice', '@Alice display name') + cell('Bob'));
  try {
    main.firstElementChild.insertAdjacentHTML('afterbegin', '<a href="http://[">bad URL</a>');
    send(w, [{ handle: 'Alice', count: 15 }, { handle: 'Bob', count: 26 }]);
    await tick();
    assert.deepEqual([...main.querySelectorAll('[data-xfc-badge]')].map(x => x.textContent), ['粉丝 15', '粉丝 26']);
  } finally { dom.window.close(); }
});

test('缓存超过 30 分钟不继续展示旧数；新响应恢复数字', async () => {
  const { dom, w, main } = setup();
  try {
    let now = 1000000;
    w.Date.now = () => now;
    send(w, [{ handle: 'Alice', count: 10 }]);
    await tick();
    now += 30 * 60 * 1000 + 1;
    w.dispatchEvent(new w.PopStateEvent('popstate'));
    await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 —');
    send(w, [{ handle: 'Alice', count: 11 }]);
    await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 11');
  } finally { dom.window.close(); }
});

test('忽略同源 iframe 的伪造消息和超大消息', async () => {
  const { dom, w, main } = setup();
  try {
    w.dispatchEvent(new w.MessageEvent('message', { origin: w.location.origin, source: null,
      data: { channel, type: 'counts', users: [{ handle: 'Alice', count: 500 }] } }));
    send(w, Array.from({ length: 251 }, () => ({ handle: 'Alice', count: 500 })));
    await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 —');
  } finally { dom.window.close(); }
});

test('批量响应分片发送，未提供的资料不猜测，不传递原始数据', async () => {
  const { dom, w } = setup('', true);
  const messages = [];
  w.postMessage = data => messages.push(data);
  const users = Array.from({ length: 600 }, (_, i) => ({ core: { screen_name: `demo${i}` }, relationship_counts: { followers: i }, private_fixture: 'SHOULD_NOT_LEAVE_BRIDGE' }));
  w.fetch = async () => ({ ok: true, url: 'https://x.com/i/api/graphql/test/Followers', clone: () => ({ json: async () => ({ users }) }) });
  try {
    w.eval(bridge);
    await w.fetch('fixture'); await tick();
    assert.deepEqual(messages.map(m => m.users.length), [250, 250, 100]);
    assert.ok(messages.every(m => m.users.every(u => Object.keys(u).sort().join(',') === 'count,handle')));
    assert.ok(!JSON.stringify(messages).includes('SHOULD_NOT_LEAVE_BRIDGE'));
  } finally { dom.window.close(); }
});

test('外域响应、非 JSON 以及 clone 异常不改变原请求结果', async () => {
  const { dom, w } = setup('', true);
  const messages = [];
  w.postMessage = data => messages.push(data);
  const response = { ok: true, url: 'https://other.example/i/api/graphql/test/Followers', clone() { throw new Error('must not read'); } };
  w.fetch = () => Promise.resolve(response);
  try {
    w.eval(bridge);
    assert.equal(await w.fetch('fixture'), response);
    await tick(); assert.equal(messages.length, 0);
    response.url = 'https://x.com/i/api/graphql/test/Followers';
    assert.equal(await w.fetch('fixture'), response);
    await tick(); assert.equal(messages.length, 0);
    response.clone = () => ({ json: async () => { throw new Error('invalid JSON'); } });
    assert.equal(await w.fetch('fixture'), response);
    await tick(); assert.equal(messages.length, 0);
  } finally { dom.window.close(); }
});

test('XHR 网络错误结束后不遗留监听器，复用请求只发送一次新结果', async () => {
  const { dom, w } = setup('', true);
  class XHR extends w.EventTarget { send() { this.dispatchEvent(new w.Event('loadend')); } }
  w.XMLHttpRequest = XHR;
  w.fetch = async () => {};
  const messages = [];
  w.postMessage = data => messages.push(data);
  try {
    w.eval(bridge);
    const xhr = new XHR();
    xhr.status = 0; xhr.send();
    xhr.status = 200; xhr.responseType = 'json'; xhr.responseURL = 'https://x.com/i/api/graphql/test/Users';
    xhr.response = { legacy: { screen_name: 'Alice', followers_count: 99 } };
    xhr.send();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].users[0].count, 99);
  } finally { dom.window.close(); }
});

test('不展示任何关注关系，包括列表、原帖、引用和悬浮资料', async () => {
  const { dom, w, main } = setup(cell('Alice') + `<article>${author('Bob')}</article>`);
  try {
    send(w, [{ handle: 'Alice', count: 10, following: true, followedBy: true }, { handle: 'Bob', count: 20, followedBy: true, bio: '中文简介' }]);
    await tick();
    assert.equal(w.document.querySelector('[data-xfc-relationship]'), null);
    main.querySelector('[data-xfc-badge]').focus();
    assert.doesNotMatch(w.document.body.textContent, /互关|关注你|已关注|未关注/);
  } finally { dom.window.close(); }
});

test('资料预览仅作为文本渲染，鼠标与键盘可查看，退出和滚动可关闭', async () => {
  const { dom, w, main } = setup();
  try {
    const bio = '<img src=x onerror="alert(1)">\nBuild small things.';
    send(w, [{ handle: 'Alice', count: 15, bio, location: '上海 / Remote', following: true }]);
    await tick();
    const badge = main.querySelector('[data-xfc-badge]');
    badge.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
    const preview = w.document.querySelector('[data-xfc-preview]');
    assert.equal(preview.hidden, false);
    assert.match(preview.textContent, /上海 \/ Remote/);
    assert.equal(preview.querySelector('[data-xfc-preview-line="bio"]').textContent, bio);
    assert.equal(preview.querySelector('img'), null);
    assert.equal(badge.getAttribute('aria-describedby'), preview.id);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(preview.hidden, true);
    assert.equal(badge.hasAttribute('aria-describedby'), false);
    badge.focus();
    assert.equal(preview.hidden, false);
    w.dispatchEvent(new w.Event('scroll'));
    assert.equal(preview.hidden, true);
    // 自己更新预览不会造成 MutationObserver 渲染循环。
    badge.blur(); badge.focus();
    let renders = 0;
    const observer = new w.MutationObserver(() => renders++);
    observer.observe(preview, { childList: true, subtree: true });
    await tick(); await tick();
    observer.disconnect();
    assert.ok(renders < 3);
  } finally { dom.window.close(); }
});

test('部分资料更新不清空其他新鲜字段，也不会延长旧简介的有效期', async () => {
  const { dom, w, main } = setup();
  try {
    let now = 1000000;
    w.Date.now = () => now;
    send(w, [{ handle: 'Alice', count: 10, following: true, followedBy: true, bio: 'Alice bio', location: '上海' }]);
    await tick();
    now += 20 * 60 * 1000;
    send(w, [{ handle: 'Alice', count: 20 }]);
    await tick();
    assert.equal(main.querySelector('[data-xfc-relationship]'), null);
    const badge = main.querySelector('[data-xfc-badge]');
    badge.focus();
    assert.match(w.document.querySelector('[data-xfc-preview]').textContent, /Alice bio/);
    now += 11 * 60 * 1000;
    w.dispatchEvent(new w.PopStateEvent('popstate'));
    await tick();
    assert.equal(badge.textContent, '粉丝 20');
    assert.equal(main.querySelector('[data-xfc-relationship]'), null);
    assert.doesNotMatch(w.document.querySelector('[data-xfc-preview]').textContent, /Alice bio/);
    send(w, [{ handle: 'Alice', bio: '', location: '' }]);
    await tick();
    assert.match(w.document.querySelector('[data-xfc-preview]').textContent, /尚未填写/);
  } finally { dom.window.close(); }
});

test('账号行复用时旧关系和打开的资料立即清理，引用帖作者不串号', async () => {
  const { dom, w, main } = setup(cell('Alice') + `<article>${author('Bob')}<div role="link">${author('Carol', false)}</div></article>`);
  try {
    send(w, [
      { handle: 'Alice', count: 1, following: true, bio: 'Alice only' },
      { handle: 'Bob', count: 2, followedBy: true, bio: 'Bob only' },
      { handle: 'Carol', count: 3, following: true, followedBy: true, bio: 'Carol only' }
    ]);
    await tick();
    assert.equal(main.querySelector('[data-xfc-relationship]'), null);
    main.querySelector('[data-xfc-badge]').focus();
    const row = main.firstElementChild;
    row.querySelector('[data-testid]').setAttribute('data-testid', 'UserAvatar-Container-Unknown');
    for (const link of row.querySelectorAll('a[href="/Alice"]')) { link.href = '/Unknown'; link.textContent = 'Unknown'; }
    await tick();
    assert.equal(row.querySelector('[data-xfc-relationship]'), null);
    assert.equal(w.document.querySelector('[data-xfc-preview]').hidden, true);
    main.querySelector('[role="link"] [data-xfc-toggle]').click(); await tick();
    const expanded = main.querySelector('[role="link"] [data-xfc-expanded]');
    assert.equal(expanded.hidden, false);
    assert.match(expanded.textContent, /Carol only/);
    assert.doesNotMatch(expanded.textContent, /Alice only|Bob only/);
  } finally { dom.window.close(); }
});

test('新旧接口提取资料和布尔值，没有粉丝数的资料仍然可用，晚启动不重置时效', async () => {
  const { dom, w, main } = setup(cell('Alice') + cell('Bob'), true);
  let now = 1000000;
  w.Date.now = () => now;
  const body = { users: [
    { core: { screen_name: 'Alice' }, relationship_perspectives: { following: true, followed_by: false }, profile_bio: { description: '新资料' }, location: { location: '杭州' }, secret: 'DO_NOT_FORWARD' },
    { legacy: { screen_name: 'Bob', followers_count: 0, following: false, followed_by: true, description: '旧资料', location: '深圳' } }
  ] };
  w.fetch = async () => ({ ok: true, url: 'https://x.com/i/api/graphql/test/Users', clone: () => ({ json: async () => body }) });
  try {
    w.eval(bridge);
    await w.fetch('fixture'); await tick();
    now += 29 * 60 * 1000;
    w.eval(content); await tick();
    assert.equal(main.querySelector('[data-xfc-relationship]'), null);
    const badge = main.querySelector('[data-xfc-badge]');
    badge.focus();
    assert.match(w.document.querySelector('[data-xfc-preview]').textContent, /新资料.*杭州/s);
    assert.doesNotMatch(w.document.body.textContent, /DO_NOT_FORWARD/);
    now += 2 * 60 * 1000;
    w.dispatchEvent(new w.PopStateEvent('popstate')); await tick();
    assert.equal(main.querySelectorAll('[data-xfc-relationship]').length, 0);
    assert.equal(main.children[1].querySelector('[data-xfc-badge]').textContent, '粉丝 —');
  } finally { dom.window.close(); }
});

test('简介和自填所在地直接出现在帖子及引用作者下方，文本安全且不会重复插入', async () => {
  const { dom, w, main } = setup(`<article>${author('Alice')}<p>正文</p><div role="link">${author('Bob', false)}</div></article>`);
  try {
    send(w, [
      { handle: 'Alice', count: 1, bio: '<img src=x>\n写代码', location: '杭州' },
      { handle: 'Bob', count: 2, bio: 'Bob 的简介', location: '' }
    ]);
    await tick();
    const profiles = main.querySelectorAll('[data-xfc-inline-profile]');
    assert.equal(profiles.length, 2);
    assert.equal(profiles[0].dataset.xfcHandle, 'alice');
    assert.equal(profiles[0].querySelector('[data-xfc-inline-bio]').textContent, '<img src=x>\n写代码');
    assert.equal(profiles[0].querySelector('[data-xfc-inline-location]').textContent, '杭州');
    assert.equal(profiles[0].querySelector('img'), null);
    assert.equal(profiles[1].querySelector('[data-xfc-inline-bio]').textContent, 'Bob 的简介');
    assert.equal(w.document.querySelector('aside [data-xfc-inline-profile]'), null);
    send(w, [{ handle: 'Alice', count: 3 }]); await tick();
    assert.equal(main.querySelectorAll('[data-xfc-inline-profile]').length, 2);
    // 引用区域复用成没有资料的新作者时，不保留旧账号简介。
    main.querySelector('[role="link"] [data-testid="User-Name"]').children[1].querySelector('span').textContent = '@Unknown';
    await tick();
    assert.equal(main.querySelector('[role="link"] [data-xfc-inline-profile]'), null);
    send(w, [{ handle: 'Alice', bio: '', location: '' }]); await tick();
    assert.equal(main.querySelectorAll('[data-xfc-inline-profile]').length, 1);
    assert.equal(main.querySelector('[data-xfc-inline-bio]'), null);
    assert.equal(main.querySelector('[data-xfc-inline-location]'), null);
    assert.equal(main.querySelector('[data-xfc-inline-profile] [data-xfc-count]').textContent, '3');
  } finally { dom.window.close(); }
});

test('简介到期自动移除，主题变化同步到直接显示的资料', async () => {
  const { dom, w, main } = setup(`<article>${author('Alice')}</article>`);
  try {
    let now = 1000000;
    w.Date.now = () => now;
    send(w, [{ handle: 'Alice', bio: '简介', location: '上海' }]); await tick();
    w.document.body.style.backgroundColor = '#000'; await tick();
    assert.equal(main.querySelector('[data-xfc-inline-profile]').dataset.xfcTheme, 'dark');
    now += 30 * 60 * 1000 + 1;
    w.dispatchEvent(new w.PopStateEvent('popstate')); await tick();
    assert.equal(main.querySelector('[data-xfc-inline-profile]'), null);
  } finally { dom.window.close(); }
});

test('简介保留完整换行，并从新旧接口的已返回链接字段生成可读域名', async () => {
  const { dom, w, main } = setup(`<article>${author('Alice')}${author('Bob')}</article>`, true);
  let calls = 0;
  const urls = [
    { url: 'https://t.co/demo', expanded_url: 'https://www.example.com/about?tracking=1' },
    { url: 'https://t.co/unsafe', expanded_url: 'javascript:alert(1)' },
    { url: 'https://t.co/invalid', expanded_url: 'not a url' }
  ];
  const bio = 'Designer\nBuilds useful things: https://t.co/demo\nhttps://t.co/unsafe https://t.co/invalid';
  const body = { users: [
    { core: { screen_name: 'Alice' }, profile_bio: { description: bio, entities: { description: { urls } } } },
    { legacy: { screen_name: 'Bob', description: bio, entities: { description: { urls } } } }
  ] };
  w.fetch = async () => {
    calls++;
    return { ok: true, url: 'https://x.com/i/api/graphql/test/HomeTimeline', clone: () => ({ json: async () => body }) };
  };
  try {
    w.eval(bridge); w.eval(content);
    await w.fetch('fixture'); await tick();
    for (const line of main.querySelectorAll('[data-xfc-inline-bio]')) {
      assert.equal(line.textContent, 'Designer\nBuilds useful things: example.com/about\nhttps://t.co/unsafe https://t.co/invalid');
      assert.equal(line.querySelector('a'), null);
    }
    assert.equal(main.querySelectorAll('[data-xfc-layout="compact"]').length, 2);
    assert.equal(calls, 1);
  } finally { dom.window.close(); }
});

test('简介自动显示中文，同一原文只翻译一次，并可切换查看原文', async () => {
  const { dom, w, main } = setup(`<article>${author('Alice')}${author('Bob')}</article>`);
  let calls = 0;
  w.LanguageDetector = { create: async () => ({ detect: async () => [{ detectedLanguage: 'en' }] }) };
  w.Translator = { create: async () => ({ translate: async () => { calls++; return '独立开发者\n制作实用工具'; } }) };
  try {
    send(w, [{ handle: 'Alice', bio: 'Indie developer\nBuilding useful tools' }, { handle: 'Bob', bio: 'Indie developer\nBuilding useful tools' }]);
    await tick(); await tick();
    assert.equal(calls, 1);
    assert.deepEqual([...main.querySelectorAll('[data-xfc-inline-bio]')].map(x => x.textContent), ['独立开发者\n制作实用工具', '独立开发者\n制作实用工具']);
    main.querySelector('[data-xfc-toggle]').click(); await tick();
    main.querySelector('[data-xfc-translation]').click(); await tick();
    assert.equal(main.querySelector('[data-xfc-inline-bio]').textContent, 'Indie developer\nBuilding useful tools');
    assert.equal(main.querySelector('[data-xfc-translation]').textContent, '查看中文');
    assert.equal(main.querySelectorAll('[data-xfc-inline-bio]')[1].textContent, '独立开发者\n制作实用工具');
  } finally { dom.window.close(); }
});

test('浏览器需要用户手势时提供启用入口，启用后继续自动翻译', async () => {
  const { dom, w, main } = setup(`<article>${author('Alice')}</article>`);
  let ready = false;
  w.LanguageDetector = { create: async () => {
    if (!ready) { const error = new Error('User activation required'); error.name = 'NotAllowedError'; throw error; }
    return { detect: async () => [{ detectedLanguage: 'en' }] };
  } };
  w.Translator = { create: async () => ({ translate: async () => '设计师' }) };
  try {
    send(w, [{ handle: 'Alice', bio: 'Designer' }]); await tick(); await tick();
    assert.equal(main.querySelector('[data-xfc-inline-bio]').textContent, 'Designer');
    assert.equal(main.querySelector('[data-xfc-translation]').textContent, '启用中文翻译');
    ready = true;
    main.querySelector('[data-xfc-toggle]').click(); await tick();
    main.querySelector('[data-xfc-translation]').click(); await tick(); await tick();
    assert.equal(main.querySelector('[data-xfc-inline-bio]').textContent, '设计师');
  } finally { dom.window.close(); }
});

test('中文简介无需翻译，异步结果不会覆盖复用后另一个账号的简介', async () => {
  const { dom, w, main } = setup(`<article>${author('Alice')}${author('Chinese')}</article>`);
  let finish;
  let calls = 0;
  w.LanguageDetector = { create: async () => ({ detect: async () => [{ detectedLanguage: 'en' }] }) };
  w.Translator = { create: async () => ({ translate: () => { calls++; return new Promise(resolve => { finish = resolve; }); } }) };
  try {
    send(w, [{ handle: 'Alice', bio: 'Designer' }, { handle: 'Chinese', bio: '独立开发者 / AI' }]); await tick();
    assert.equal(calls, 1);
    const header = main.querySelector('[data-testid="User-Name"]');
    header.children[0].querySelector('a').href = '/Carol';
    header.children[0].querySelector('a').textContent = 'Carol';
    header.children[1].querySelector('span').textContent = '@Carol';
    send(w, [{ handle: 'Carol', bio: '新的中文简介' }]); await tick();
    finish('设计师'); await tick(); await tick();
    assert.equal(header.querySelector('[data-xfc-inline-bio]').textContent, '新的中文简介');
    assert.equal(main.querySelectorAll('[data-xfc-inline-bio]')[1].textContent, '独立开发者 / AI');
  } finally { dom.window.close(); }
});

test('中文翻译保留品牌合作列表、网址和账号名，避免专有名词被误译', async () => {
  const { dom, w, main } = setup(`<article>${author('Alice')}</article>`);
  let received;
  w.LanguageDetector = { create: async () => ({ detect: async () => [{ detectedLanguage: 'en' }] }) };
  w.Translator = { create: async () => ({ translate: async text => {
    received = text;
    return text.replace('Ambassador', '大使').replace('Partner', '合作伙伴').replace('Visit', '访问');
  } }) };
  try {
    send(w, [{ handle: 'Alice', bio: 'Ambassador Higgsfield • Openart • LTX • Elevenlabs | Partner : Hailuo • Topazlabs\nVisit example.com @Alice' }]);
    await tick(); await tick();
    assert.doesNotMatch(received, /Elevenlabs|Higgsfield|example\.com|@Alice/);
    assert.equal(main.querySelector('[data-xfc-inline-bio]').textContent, '大使 Higgsfield • Openart • LTX • Elevenlabs | 合作伙伴 : Hailuo • Topazlabs\n访问 example.com @Alice');
  } finally { dom.window.close(); }
});

test('默认显示粉丝数和简介片段，只展开当前作者，切换、复用与 Esc 都正确收起', async () => {
  const { dom, w, main } = setup(`<article>${author('Alice')}<p>帖子正文</p></article><article>${author('Bob')}</article>`);
  const bio = '这是一段完整简介。\n'.repeat(15).trim();
  try {
    send(w, [{ handle: 'Alice', count: 64000, bio, location: 'Guangdong' }, { handle: 'Bob', count: 32, bio: '另一位作者的完整简介' }]);
    await tick();
    const header = main.querySelector('[data-testid="User-Name"]');
    const profiles = main.querySelectorAll('[data-xfc-inline-profile]');
    assert.equal(header.firstElementChild.querySelector('[data-xfc-badge]'), null);
    assert.equal(profiles[0].querySelector('[data-xfc-count]').textContent, '6.4万');
    assert.equal(profiles[0].querySelector('[data-xfc-summary]').textContent, bio.replace(/\s+/g, ' '));
    assert.equal(profiles[0].querySelector('[data-xfc-summary]').hidden, false);
    assert.equal(profiles[0].querySelector('[data-xfc-expanded]').hidden, true);
    profiles[0].querySelector('[data-xfc-toggle]').click(); await tick();
    assert.equal(profiles[0].querySelector('[data-xfc-expanded]').hidden, false);
    assert.equal(profiles[0].querySelector('[data-xfc-summary]').hidden, true);
    assert.equal(profiles[0].querySelector('[data-xfc-inline-bio]').textContent, bio);
    profiles[1].querySelector('[data-xfc-toggle]').click(); await tick();
    assert.equal(profiles[0].querySelector('[data-xfc-expanded]').hidden, true);
    assert.equal(profiles[1].querySelector('[data-xfc-expanded]').hidden, false);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick();
    assert.equal(profiles[1].querySelector('[data-xfc-expanded]').hidden, true);
    profiles[0].querySelector('[data-xfc-toggle]').click(); await tick();
    header.firstElementChild.querySelector('a').href = '/Unknown';
    header.children[1].querySelector('span').textContent = '@Unknown';
    await tick();
    assert.equal(header.querySelector('[data-xfc-inline-profile]'), null);
    assert.equal(main.querySelector('[data-xfc-relationship]'), null);
  } finally { dom.window.close(); }
});

test('桥接脚本仅提取关注按钮需要的状态，不提取关注你状态', async () => {
  const { dom, w } = setup('', true);
  const messages = [];
  w.postMessage = data => messages.push(data);
  w.fetch = async () => ({ ok: true, url: 'https://x.com/i/api/graphql/test/Users', clone: () => ({ json: async () => ({
    core: { screen_name: 'Alice' }, relationship_counts: { followers: 32 }, relationship_perspectives: { following: true, followed_by: true }, profile_bio: { description: '简介' }
  }) }) });
  try {
    w.eval(bridge); await w.fetch('fixture'); await tick();
    const user = messages[0].users[0];
    assert.equal(user.count, 32);
    assert.equal(user.bio, '简介');
    assert.equal(user.following, true);
    assert.equal(Object.hasOwn(user, 'followedBy'), false);
  } finally { dom.window.close(); }
});
