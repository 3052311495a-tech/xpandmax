(() => {
  'use strict';
  // 与 translation-background.js 的 validateMonitorWebhook 保持同一规则。
  function validateWebhookAuth(value) {
    if (value == null) return '';
    // 常见误贴：把整行「Authorization: Bearer …」粘进来，只保留冒号后的值。
    const text = String(value).trim().replace(/^authorization\s*:\s*/i, '');
    if (!text) return '';
    if (text.length > 4096 || /[\u0000-\u001F\u007F]/.test(text)) return null;
    return text;
  }

  function validateWebhook(value) {
    if (value == null) return '';
    const text = String(value).trim();
    if (!text) return '';
    if (text.length > 2048) return null;
    let url;
    try { url = new URL(text); } catch { return null; }
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) return null;
    return url.href;
  }

  const HANDLE = /^[a-z0-9_]{1,15}$/;
  const MAX = 500;
  const cache = new Map();
  const pending = new Set();
  const notices = new Map();
  let webhookUrl = '';
  let webhookAuth = '';
  let accountEpoch = 0;
  let webhookEpoch = 0;

  function keyOf(value) {
    return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : '';
  }

  function normalizeAccount(input) {
    const username = keyOf(input?.username);
    if (!HANDLE.test(username)) return null;
    const account = { username, profileUrl: `https://x.com/${username}` };
    if (typeof input.userId === 'string' && /^\d{1,25}$/.test(input.userId)) account.userId = input.userId;
    const name = nameOf(input.name);
    if (name) account.name = name;
    return account;
  }

  function nameOf(value) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 100) : '';
  }

  function normalizeList(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const list = [];
    for (const item of value) {
      const account = normalizeAccount(item);
      if (!account || seen.has(account.username)) continue;
      seen.add(account.username);
      list.push({ ...account, addedAt: Number.isFinite(item?.addedAt) ? item.addedAt : 0 });
      if (list.length >= MAX) break;
    }
    return list;
  }

  function applyList(value) {
    cache.clear();
    for (const account of normalizeList(value)) cache.set(account.username, account);
    publish();
  }

  function publish() {
    window.dispatchEvent(new Event('xpandmax:monitor'));
  }

  function remoteFields(remote) {
    if (remote?.notified) return { notified: true };
    if (remote?.error) return { notified: false, notifyError: remote.error };
    return { notified: false };
  }

  function remember(username, result) {
    if (result?.notifyError) notices.set(username, result.notifyError);
    else notices.delete(username);
    return result;
  }

  function notifyRemote(action, account) {
    return new Promise(resolve => {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.sendMessage) { resolve({ notified: false }); return; }
      const body = { username: account.username, profileUrl: account.profileUrl };
      if (account.userId) body.userId = account.userId;
      const message = { type: 'monitor-notify', action, account: body };
      try {
        runtime.sendMessage(message, result => {
          if (runtime.lastError || !result) resolve({ notified: false, error: runtime.lastError ? 'Webhook 通知失败' : undefined });
          else resolve({ notified: !!result.notified, error: result.notified ? undefined : result.error });
        });
      } catch {
        resolve({ notified: false, error: 'Webhook 通知失败' });
      }
    });
  }

  function persist(list) {
    const storage = globalThis.chrome?.storage?.local;
    const epoch = ++accountEpoch;
    if (!storage) {
      applyList(list);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      storage.set({ monitorAccounts: list }, () => {
        if (globalThis.chrome.runtime?.lastError) {
          storage.get({ monitorAccounts: [] }, saved => {
            if (epoch === accountEpoch && !globalThis.chrome.runtime?.lastError) applyList(saved.monitorAccounts);
            reject(new Error('名单未保存，请重试'));
          });
          return;
        }
        if (epoch === accountEpoch) applyList(list);
        resolve();
      });
    });
  }

  async function add(input) {
    const account = normalizeAccount(input);
    if (!account) return { ok: false, error: '账号无效' };
    if (cache.has(account.username)) return remember(account.username, { ok: true, monitored: true, notified: false });
    if (cache.size >= MAX) return { ok: false, error: '最多监控 500 个账号' };
    const stored = { ...account, addedAt: Date.now() };
    await persist([...cache.values(), stored]);
    return remember(account.username, { ok: true, monitored: true, ...remoteFields(await notifyRemote('monitor', stored)) });
  }

  // 只改显示名，不通知 Webhook。
  function rememberName(handle, value) {
    const key = keyOf(handle);
    const name = nameOf(value);
    const existing = cache.get(key);
    if (!existing || !name || existing.name === name || pending.has(key)) return Promise.resolve();
    return persist([...cache.values()].map(account => account.username === key ? { ...account, name } : account)).catch(() => {});
  }

  async function remove(username) {
    const key = keyOf(typeof username === 'string' ? username : username?.username);
    const existing = key ? cache.get(key) : null;
    if (!existing) return { ok: true, monitored: false, notified: false };
    await persist([...cache.values()].filter(account => account.username !== key));
    return remember(key, { ok: true, monitored: false, ...remoteFields(await notifyRemote('unmonitor', existing)) });
  }

  async function toggle(input) {
    const account = normalizeAccount(input);
    if (!account) return { ok: false, error: '账号无效' };
    if (pending.has(account.username)) return { ok: false, error: '正在保存' };
    pending.add(account.username);
    publish();
    try {
      const result = cache.has(account.username) ? await remove(account.username) : await add(account);
      if (!result?.ok && result?.error) notices.set(account.username, result.error);
      return result;
    } catch (error) {
      notices.set(account.username, error.message || '名单未保存，请重试');
      return { ok: false, error: error.message || '名单未保存，请重试' };
    } finally {
      pending.delete(account.username);
      publish();
    }
  }

  function saveWebhook(value, auth) {
    const validated = validateWebhook(value);
    if (validated === null) return Promise.resolve({ ok: false, error: 'Webhook 须为 HTTPS 地址，不能包含账号密码或片段，也不能指向 X' });
    const nextAuth = auth === undefined ? webhookAuth : validateWebhookAuth(auth);
    if (nextAuth === null) return Promise.resolve({ ok: false, error: 'Authorization 不能包含换行或控制字符' });
    const storage = globalThis.chrome?.storage?.local;
    const epoch = ++webhookEpoch;
    if (!storage) {
      webhookUrl = validated;
      webhookAuth = nextAuth;
      publish();
      return Promise.resolve({ ok: true, url: validated, hasAuth: !!nextAuth });
    }
    return new Promise(resolve => {
      storage.set({ monitorWebhookUrl: validated, monitorWebhookAuth: nextAuth }, () => {
        if (globalThis.chrome.runtime?.lastError) resolve({ ok: false, error: 'Webhook 未保存，请重试' });
        else if (epoch === webhookEpoch) {
          webhookUrl = validated;
          webhookAuth = nextAuth;
          publish();
          resolve({ ok: true, url: validated, hasAuth: !!nextAuth });
        } else resolve({ ok: true, url: webhookUrl, hasAuth: !!webhookAuth });
      });
    });
  }

  const storage = globalThis.chrome?.storage;
  let accountsFromChange = false;
  let webhookFromChange = false;
  if (storage?.local && storage.onChanged) {
    storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (Object.hasOwn(changes, 'monitorAccounts')) {
        accountsFromChange = true;
        applyList(changes.monitorAccounts.newValue);
      }
      if (Object.hasOwn(changes, 'monitorWebhookUrl') || Object.hasOwn(changes, 'monitorWebhookAuth')) {
        webhookFromChange = true;
        if (Object.hasOwn(changes, 'monitorWebhookUrl')) webhookUrl = typeof changes.monitorWebhookUrl.newValue === 'string' ? changes.monitorWebhookUrl.newValue : '';
        if (Object.hasOwn(changes, 'monitorWebhookAuth')) webhookAuth = validateWebhookAuth(changes.monitorWebhookAuth.newValue) || '';
        publish();
      }
    });
    storage.local.get({ monitorAccounts: [], monitorWebhookUrl: '', monitorWebhookAuth: '' }, saved => {
      if (globalThis.chrome.runtime?.lastError) return;
      if (accountEpoch === 0 && !accountsFromChange) applyList(saved.monitorAccounts);
      if (webhookEpoch === 0 && !webhookFromChange) {
        webhookUrl = typeof saved.monitorWebhookUrl === 'string' ? saved.monitorWebhookUrl : '';
        webhookAuth = validateWebhookAuth(saved.monitorWebhookAuth) || '';
      }
      publish();
    });
  }

  window.xpandmaxMonitor = {
    has: handle => cache.has(keyOf(handle)),
    pending: handle => pending.has(keyOf(handle)),
    notice: handle => notices.get(keyOf(handle)) || '',
    list: () => [...cache.values()].map(account => ({ ...account })),
    webhook: () => webhookUrl,
    hasWebhookAuth: () => !!webhookAuth,
    validateWebhook,
    validateWebhookAuth,
    toggle,
    add,
    remove,
    rememberName,
    saveWebhook
  };
})();
