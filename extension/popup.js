(() => {
  'use strict';
  const controls = [
    { key: 'showTweetVelocity', id: 'show-tweet-velocity', label: '帖子流速', defaultValue: true },
    { key: 'hideNotificationCount', id: 'hide-notification-count', label: '通知数字', defaultValue: true },
    { key: 'hideLeftSidebar', id: 'hide-left-sidebar', label: '左侧导航', defaultValue: false },
    { key: 'hideSidebarRecommendations', id: 'hide-sidebar-recommendations', label: '右侧栏', defaultValue: true }
  ];
  const status = document.getElementById('status');
  const rising = document.getElementById('velocity-rising');
  const viral = document.getElementById('velocity-viral');
  chrome.storage.local.get({ velocityRisingThreshold: 1000, velocityViralThreshold: 10000 }, saved => {
    if (chrome.runtime.lastError) return;
    rising.value = saved.velocityRisingThreshold ?? 1000;
    viral.value = saved.velocityViralThreshold ?? 10000;
  });
  document.getElementById('velocity-thresholds').addEventListener('submit', event => {
    event.preventDefault();
    const low = Number(rising.value), high = Number(viral.value);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= low) {
      status.textContent = '请输入正数，爆款阈值必须大于上升阈值'; return;
    }
    chrome.storage.local.set({ velocityRisingThreshold: low, velocityViralThreshold: high }, () => {
      status.textContent = chrome.runtime.lastError ? '阈值未保存，请重试' : '流速阈值已保存';
    });
  });
  const defaults = Object.fromEntries(controls.map(({ key, defaultValue }) => [key, defaultValue]));
  chrome.storage.local.get(defaults, settings => {
    if (chrome.runtime.lastError) { status.textContent = '读取设置失败，请重新打开插件'; return; }
    for (const { key, id, label } of controls) {
      const toggle = document.getElementById(id);
      let saved = typeof settings[key] === 'boolean' ? settings[key] : defaults[key];
      toggle.checked = saved;
      toggle.disabled = false;
      toggle.addEventListener('change', () => {
        const next = toggle.checked;
        toggle.disabled = true;
        chrome.storage.local.set({ [key]: next }, () => {
          if (chrome.runtime.lastError) {
            toggle.checked = saved;
            status.textContent = '设置未保存，请重试';
          } else {
            saved = next;
            status.textContent = key === 'showTweetVelocity' ? `${saved ? '已显示' : '已关闭'}帖子流速` : `${saved ? '已隐藏' : '已恢复显示'}${label}`;
          }
          toggle.disabled = false;
        });
      });
    }
    status.textContent = '设置自动保存，切换后立即生效';
  });

  if (window.xpandmaxMonitor && document.getElementById('monitor-accounts')) {
    const monitor = window.xpandmaxMonitor;
    const webhookInput = document.getElementById('monitor-webhook-url');
    const authInput = document.getElementById('monitor-webhook-auth');
    const clearAuth = document.getElementById('monitor-webhook-auth-clear');
    const accountList = document.getElementById('monitor-accounts');
    const empty = document.getElementById('monitor-empty');
    let webhookDirty = false;
    let authDirty = false;
    const renderMonitor = () => {
      const accounts = monitor.list().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      accountList.replaceChildren();
      for (const account of accounts) {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = `@${account.username}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '移出';
        remove.setAttribute('aria-label', `移出 @${account.username}`);
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          const result = await monitor.remove(account.username);
          if (!result?.ok) status.textContent = result?.error || '移出失败，请重试';
          else if (result.notifyError) status.textContent = `已移出 @${account.username}。${result.notifyError}`;
          else if (result.notified) status.textContent = `已移出 @${account.username}，并已通知 Webhook`;
          else status.textContent = `已移出 @${account.username}`;
        });
        item.append(name, remove);
        accountList.append(item);
      }
      empty.hidden = accounts.length > 0;
      if (webhookInput && !webhookDirty) webhookInput.value = monitor.webhook();
      if (authInput && !authDirty) {
        authInput.value = '';
        authInput.placeholder = monitor.hasWebhookAuth() ? '已保存，留空则不修改' : '粘贴 Authorization，如 Bearer …';
      }
      if (clearAuth) clearAuth.hidden = !monitor.hasWebhookAuth();
    };
    webhookInput.addEventListener('input', () => { webhookDirty = true; });
    authInput?.addEventListener('input', () => { authDirty = true; });
    clearAuth?.addEventListener('click', async () => {
      clearAuth.disabled = true;
      try {
        const result = await monitor.saveWebhook(monitor.webhook(), '');
        if (!result.ok) status.textContent = result.error || '密钥未清除，请重试';
        else {
          authDirty = false;
          authInput.value = '';
          authInput.placeholder = '粘贴 Authorization，如 Bearer …';
          clearAuth.hidden = true;
          status.textContent = '已清除 Authorization，名单和 Webhook 地址仍保留';
        }
      } catch {
        status.textContent = '密钥未清除，请重试';
      } finally { clearAuth.disabled = false; }
    });
    document.getElementById('monitor-webhook').addEventListener('submit', async event => {
      event.preventDefault();
      const validated = monitor.validateWebhook(webhookInput.value);
      if (validated === null) {
        status.textContent = 'Webhook 须为 HTTPS 地址，不能包含账号密码或片段，也不能指向 X';
        return;
      }
      const authValue = authDirty ? monitor.validateWebhookAuth(authInput.value) : undefined;
      if (authValue === null) {
        status.textContent = 'Authorization 不能包含换行或控制字符';
        return;
      }
      const button = event.target.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        if (validated) {
          const granted = await chrome.permissions.request({ origins: [`${new URL(validated).origin}/*`] });
          if (!granted) { status.textContent = '未允许访问该站点，Webhook 未保存'; return; }
        }
        const result = await monitor.saveWebhook(validated, authValue);
        if (!result.ok) status.textContent = result.error || 'Webhook 未保存，请重试';
        else {
          webhookDirty = false;
          authDirty = false;
          webhookInput.value = result.url || '';
          authInput.value = '';
          authInput.placeholder = result.hasAuth ? '已保存，留空则不修改' : '粘贴 Authorization，如 Bearer …';
          if (clearAuth) clearAuth.hidden = !result.hasAuth;
          status.textContent = !validated ? '已清除 Webhook，名单仍只保存在本机'
            : result.hasAuth ? '已保存 Webhook 和 Authorization。之后加入或移出监控名单时会通知该地址'
            : '已保存 Webhook。之后加入或移出监控名单时会通知该地址';
        }
      } catch {
        status.textContent = 'Webhook 未保存，请重试';
      } finally { button.disabled = false; }
    });
    window.addEventListener('xpandmax:monitor', renderMonitor);
    renderMonitor();
  }
})();
