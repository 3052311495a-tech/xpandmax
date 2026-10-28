const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const content = fs.readFileSync('extension/content.js', 'utf8');
const follow = fs.readFileSync('extension/follow.js', 'utf8');
const bridge = fs.readFileSync('extension/bridge.js', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const header = handle => `<div data-testid="User-Name"><div><a href="/${handle}">${handle}</a></div><div><span>@${handle}</span></div></div>`;
function setup() {
  const dom = new JSDOM(`<a data-testid="AppTabBar_Profile_Link" href="/Me">我</a><main><article>${header('Alice')}<button data-testid="caret" aria-expanded="false">更多</button><div role="link">${header('Bob')}</div></article><article>${header('Me')}<button data-testid="caret">更多</button></article></main>`, {
    url: 'https://x.com/home', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  const observers = [];
  const Observer = w.MutationObserver;
  w.MutationObserver = class extends Observer {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const close = w.close.bind(w);
  w.close = () => { observers.forEach(observer => observer.disconnect()); close(); };
  w.postMessage = data => w.dispatchEvent(new w.MessageEvent('message', { data, origin: w.location.origin, source: w }));
  w.eval(follow);
  w.eval(content);
  const send = users => w.postMessage({ channel: 'x-follower-count-v1', type: 'counts', users });
  const article = w.document.querySelector('article');
  const caret = article.querySelector('[data-testid="caret"]');
  const state = { following: false, followingRevision: 0 };
  let clicks = 0;
  function nativeMenu(label = '关注 @Alice', result) {
    caret.onclick = () => {
      if (caret.getAttribute('aria-expanded') === 'true') {
        caret.setAttribute('aria-expanded', 'false');
        w.document.querySelector('[role="menu"]')?.remove();
        return;
      }
      caret.setAttribute('aria-expanded', 'true');
      const menu = w.document.createElement('div'); menu.role = 'menu';
      const item = w.document.createElement('button'); item.role = 'menuitem'; item.textContent = label;
      item.onclick = () => { clicks++; result?.(); menu.remove(); caret.setAttribute('aria-expanded', 'false'); };
      menu.append(item); w.document.body.append(menu);
    };
  }
  async function ready(extra = {}) { send([{ handle: 'Alice', count: 12500, bio: '简介', following: false, ...extra }, { handle: 'Bob', count: 2, following: false }, { handle: 'Me', count: 3, following: false }]); await tick(); }
  function call(method) { const details = article.querySelector('[data-xfc-inline-profile]'); return w.xpandmaxFollow[method]({ button: details.querySelector('[data-xfc-follow]'), details, handle: 'alice', getProfile: () => state }); }
  const start = () => call('start');
  const unfollow = () => call('unfollow');
  return { dom, w, article, caret, send, state, nativeMenu, ready, start, unfollow, clicks: () => clicks };
}

test('关注按钮只给未关注的主帖作者显示，自己、引用作者、请求中和被屏蔽不显示', async () => {
  const f = setup();
  try {
    await f.ready();
    assert.equal(f.w.document.querySelectorAll('[data-xfc-follow]').length, 1);
    assert.equal(f.article.querySelector('[data-xfc-follow]').textContent, '关注');
    for (const extra of [{ followRequestSent: true }, { followBlocked: true }]) {
      await f.ready({ following: false, followRequestSent: false, followBlocked: false, ...extra });
      assert.equal(f.w.document.querySelector('[data-xfc-follow]'), null);
    }
  } finally { f.dom.window.close(); }
});

test('已经关注的主帖作者直接显示取消关注，引用作者和自己仍然不显示', async () => {
  const f = setup();
  try {
    f.state.following = true;
    await f.ready({ following: true });
    f.send([{ handle: 'Bob', count: 2, bio: '引用', following: true }]);
    await tick();
    const button = f.article.querySelector('[data-xfc-follow]');
    assert.equal(f.w.document.querySelectorAll('[data-xfc-follow]').length, 1);
    assert.equal(button.textContent, '取消关注');
    assert.equal(button.dataset.xfcFollowAction, 'unfollow');
    assert.equal(button.disabled, false);
    assert.equal(f.w.document.querySelector('[role="link"] [data-xfc-follow]'), null);
    f.nativeMenu('取消关注 @Alice', () => {
      f.state.following = false;
      f.state.followingRevision += 1;
      f.send([{ handle: 'Alice', following: false }]);
    });
    await f.unfollow();
    await tick();
    assert.equal(f.clicks(), 1);
    assert.equal(f.article.querySelector('[data-xfc-follow]').textContent, '关注');
    assert.equal(f.article.querySelector('[data-xfc-follow]').dataset.xfcFollowAction, 'follow');
  } finally { f.dom.window.close(); }
});

test('网页伪造的点击不能发起关注，关注按钮也不展开简介', async () => {
  const f = setup();
  let calls = 0;
  try {
    await f.ready();
    f.w.xpandmaxFollow.start = () => { calls++; };
    f.article.querySelector('[data-xfc-follow]').click(); await tick();
    assert.equal(calls, 0);
    assert.equal(f.article.querySelector('[data-xfc-expanded]').hidden, true);
  } finally { f.dom.window.close(); }
});

test('只点一次精确匹配的原生关注，确认成功后同一按钮提供取消关注', async () => {
  const f = setup();
  try {
    await f.ready(); f.nativeMenu();
    const task = f.start(); await tick();
    assert.equal(f.clicks(), 1);
    assert.equal(f.w.xpandmaxFollow.state('alice').status, 'pending');
    assert.equal(f.article.querySelector('[data-xfc-follow]').disabled, true);
    await f.start(); assert.equal(f.clicks(), 1);
    f.state.following = true; f.send([{ handle: 'Alice', following: true }]);
    await task; await tick();
    const button = f.article.querySelector('[data-xfc-follow]');
    assert.equal(button.textContent, '取消关注');
    assert.equal(button.disabled, false);
    assert.equal(button.dataset.xfcFollowAction, 'unfollow');
    assert.match(button.title, /已关注/);
    assert.equal(f.article.querySelector('[data-xfc-expanded]').hidden, true);
    assert.equal(f.w.document.querySelector('[role="menu"]'), null);
    assert.equal(f.w.document.documentElement.hasAttribute('data-xfc-follow-menu'), false);
  } finally { f.dom.window.close(); }
});

test('原生菜单已是取消关注时不点击，账号不同或菜单不匹配时停止', async () => {
  for (const label of ['取消关注 @Alice', '关注 @Bob', '不再关注 @Alice']) {
    const f = setup();
    try {
      await f.ready(); f.nativeMenu(label); await f.start();
      assert.equal(f.clicks(), 0);
      assert.equal(f.w.xpandmaxFollow.state('alice').status, label.startsWith('取消关注') ? 'success' : 'error');
      assert.equal(f.w.document.querySelector('[role="menu"]'), null);
    } finally { f.dom.window.close(); }
  }
});

test('关注请求待批准显示已请求，响应失败不误报成功', async () => {
  for (const requested of [true, false]) {
    const f = setup();
    try {
      await f.ready();
      const nativeTimeout = f.w.setTimeout.bind(f.w);
      f.w.setTimeout = (fn, delay, ...args) => nativeTimeout(fn, delay === 10000 ? 50 : delay, ...args);
      f.nativeMenu('Follow @Alice', requested ? () => { f.state.followRequestSent = true; f.send([{ handle: 'Alice', followRequestSent: true }]); } : undefined);
      await f.start(); await tick();
      assert.equal(f.clicks(), 1);
      assert.equal(f.w.xpandmaxFollow.state('alice').status, requested ? 'requested' : 'error');
      assert.equal(f.article.querySelector('[data-xfc-follow]').textContent, requested ? '已请求' : '重试关注');
    } finally { f.dom.window.close(); }
  }
});

test('作者 DOM 复用及已打开菜单时不执行关注', async () => {
  const f = setup();
  try {
    await f.ready(); f.nativeMenu();
    f.caret.onclick = () => {
      f.article.querySelector('a').href = '/Carol';
      f.article.querySelector('[data-testid="User-Name"] > div + div span').textContent = '@Carol';
      f.caret.setAttribute('aria-expanded', 'true');
      const menu = f.w.document.createElement('div'); menu.role = 'menu'; menu.textContent = '关注 @Alice'; f.w.document.body.append(menu);
    };
    await f.start(); assert.equal(f.clicks(), 0);
    assert.equal(f.w.xpandmaxFollow.state('alice').status, 'error');
  } finally { f.dom.window.close(); }
});

test('桥接兼容新旧关注状态并读取原生关注结果，不读取关注你字段或其他写入响应', async () => {
  const f = setup(); const messages = [];
  try {
    f.w.postMessage = data => messages.push(data);
    let url = 'https://x.com/i/api/graphql/example/Users';
    let body = [{ core: { screen_name: 'Alice' }, relationship_perspectives: { following: false, blocking: false, blocked_by: false, followed_by: true }, follow_request_sent: false }, { legacy: { screen_name: 'Bob', following: true, follow_request_sent: false } }];
    f.w.fetch = async () => ({ ok: true, url, clone: () => ({ json: async () => body }) });
    f.w.eval(bridge); await f.w.fetch('fixture'); await tick();
    const alice = messages[0].users.find(u => u.handle === 'alice');
    assert.equal(alice.following, false); assert.equal(alice.followBlocked, false); assert.equal(alice.followRequestSent, false);
    assert.equal(Object.hasOwn(alice, 'followedBy'), false);
    url = 'https://x.com/i/api/1.1/friendships/create.json'; body = { screen_name: 'Alice', following: false, follow_request_sent: false };
    await f.w.fetch('fixture'); await tick(); assert.equal(messages.at(-1).users[0].following, true);
    const count = messages.length;
    body = { screen_name: 'Alice', following: true, errors: [{ message: 'failed' }] };
    await f.w.fetch('fixture'); await tick(); assert.equal(messages.length, count);
    url = 'https://x.com/i/api/1.1/favorites/create.json'; await f.w.fetch('fixture'); await tick(); assert.equal(messages.length, count);
    url = 'https://x.com/i/api/graphql/example/TweetResult';
    body = { __typename: 'Tweet', rest_id: '999', core: { screen_name: 'Alice' }, relationship_counts: { followers: 3 } };
    await f.w.fetch('fixture'); await tick();
    assert.equal(Object.hasOwn(messages.at(-1).users.find(user => user.handle === 'alice'), 'userId'), false);
    url = 'https://x.com/i/api/graphql/example/UserByRestId';
    body = { __typename: 'User', rest_id: '42', core: { screen_name: 'Carol', name: ' 卡罗尔 ' }, relationship_counts: { followers: 8 } };
    await f.w.fetch('fixture'); await tick();
    assert.equal(messages.at(-1).users.find(user => user.handle === 'carol').userId, '42');
    assert.equal(messages.at(-1).users.find(user => user.handle === 'carol').name, '卡罗尔');
    url = 'https://x.com/i/api/1.1/friendships/destroy.json';
    body = { screen_name: 'Carol', id_str: '42', followers_count: 8, following: true };
    await f.w.fetch('fixture'); await tick();
    const carol = messages.at(-1).users.find(user => user.handle === 'carol');
    assert.equal(carol.following, false);
    assert.equal(carol.userId, '42');
  } finally { f.dom.window.close(); }
});

test('关注成功后只点一次原生取消关注，确认后恢复为关注', async () => {
  const f = setup();
  try {
    await f.ready(); f.nativeMenu();
    const followed = f.start();
    f.state.following = true; f.send([{ handle: 'Alice', following: true }]);
    await followed; await tick();
    f.nativeMenu('Unfollow @Alice', () => {
      f.state.following = false;
      f.state.followingRevision += 1;
      f.send([{ handle: 'Alice', following: false }]);
    });
    await f.unfollow(); await tick();
    assert.equal(f.clicks(), 2);
    assert.equal(f.w.xpandmaxFollow.state('alice'), undefined);
    assert.equal(f.article.querySelector('[data-xfc-follow]').textContent, '关注');
    assert.equal(f.article.querySelector('[data-xfc-expanded]').hidden, true);
    assert.equal(f.w.document.querySelector('[role="menu"]'), null);
  } finally { f.dom.window.close(); }
});

test('取消关注会点一次写明同一账号的原生确认按钮', async () => {
  const f = setup();
  let confirms = 0;
  try {
    await f.ready(); f.nativeMenu();
    const followed = f.start();
    f.state.following = true; f.send([{ handle: 'Alice', following: true }]);
    await followed;
    f.nativeMenu('取消关注 @Alice', () => {
      const dialog = f.w.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.append(f.w.document.createTextNode('取消关注 @Alice？'));
      const confirm = f.w.document.createElement('div');
      confirm.setAttribute('role', 'button');
      confirm.textContent = '取消关注';
      confirm.onclick = () => {
        confirms += 1;
        f.state.following = false;
        f.state.followingRevision += 1;
        f.send([{ handle: 'Alice', following: false }]);
        dialog.remove();
      };
      const cancel = f.w.document.createElement('button');
      cancel.textContent = '取消';
      dialog.append(confirm, cancel);
      f.w.document.body.append(dialog);
    });
    await f.unfollow(); await tick();
    assert.equal(confirms, 1);
    assert.equal(f.clicks(), 2);
    assert.equal(f.article.querySelector('[data-xfc-follow]').textContent, '关注');
    assert.equal(f.w.document.querySelector('[role="dialog"]'), null);
  } finally { f.dom.window.close(); }
});

test('取消关注不会点关注菜单、别人的确认框或已打开的弹窗', async () => {
  const f = setup();
  let confirms = 0;
  try {
    await f.ready(); f.nativeMenu();
    const followed = f.start();
    f.state.following = true; f.send([{ handle: 'Alice', following: true }]);
    await followed; await tick();
    f.nativeMenu('关注 @Alice');
    await f.unfollow();
    assert.equal(f.clicks(), 1);
    assert.equal(f.w.xpandmaxFollow.state('alice'), undefined);

    f.state.following = true;
    const open = f.w.document.createElement('div');
    open.setAttribute('role', 'dialog');
    open.textContent = '已打开 @Alice';
    f.w.document.body.append(open);
    await f.unfollow();
    assert.equal(f.clicks(), 1);
    assert.equal(f.w.xpandmaxFollow.state('alice').status, 'error');
    assert.match(f.w.xpandmaxFollow.state('alice').message, /菜单或弹窗/);
    open.remove();
    await tick();

    const nativeTimeout = f.w.setTimeout.bind(f.w);
    f.w.setTimeout = (fn, delay, ...args) => nativeTimeout(fn, delay === 10000 ? 20 : delay, ...args);
    f.nativeMenu('Unfollow @Alice', () => {
      const dialog = f.w.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.textContent = 'Unfollow @Bob?';
      const confirm = f.w.document.createElement('button');
      confirm.textContent = 'Unfollow';
      confirm.onclick = () => { confirms += 1; };
      dialog.append(confirm);
      f.w.document.body.append(dialog);
    });
    await f.unfollow(); await tick();
    assert.equal(confirms, 0);
    assert.equal(f.clicks(), 2);
    assert.equal(f.w.xpandmaxFollow.state('alice').status, 'error');
    assert.equal(f.article.querySelector('[data-xfc-follow]').textContent, '重试取消');
  } finally { f.dom.window.close(); }
});

test('网页伪造的点击不能取消关注', async () => {
  const f = setup();
  let calls = 0;
  try {
    await f.ready(); f.nativeMenu();
    const followed = f.start();
    f.state.following = true; f.send([{ handle: 'Alice', following: true }]);
    await followed; await tick();
    f.w.xpandmaxFollow.unfollow = () => { calls += 1; };
    f.article.querySelector('[data-xfc-follow]').click();
    await tick();
    assert.equal(calls, 0);
    assert.equal(f.article.querySelector('[data-xfc-expanded]').hidden, true);
  } finally { f.dom.window.close(); }
});
