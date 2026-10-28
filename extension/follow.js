(() => {
  'use strict';
  const states = new Map();
  let active = false;

  function update(handle, status, message = '', action = 'follow') {
    states.delete(handle);
    states.set(handle, { status, message, action });
    while (states.size > 100) states.delete(states.keys().next().value);
    window.dispatchEvent(new Event('xpandmax:followstate'));
  }

  function clearState(handle) {
    states.delete(handle);
    window.dispatchEvent(new Event('xpandmax:followstate'));
  }

  function belongsTo(header, handle) {
    if (!header?.isConnected) return false;
    return [...header.querySelectorAll('a[href], span')].some(node => {
      if (node.closest('[data-xfc-inline-profile]')) return false;
      if (node.tagName === 'A') {
        try {
          const url = new URL(node.getAttribute('href'), location.href);
          return url.origin === location.origin && url.pathname.replace(/^\//, '').replace(/\/$/, '').toLowerCase() === handle;
        } catch { return false; }
      }
      return node.textContent.trim().toLowerCase() === `@${handle}`;
    });
  }

  function waitFor(check, timeout, signal, eventName, timeoutMessage) {
    return new Promise((resolve, reject) => {
      let observer;
      let timer;
      const cleanup = () => {
        observer?.disconnect();
        clearTimeout(timer);
        window.removeEventListener(eventName, inspect);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => { cleanup(); reject(new Error('操作已取消')); };
      const inspect = () => {
        try {
          const result = check();
          if (result) { cleanup(); resolve(result); }
        } catch (error) { cleanup(); reject(error); }
      };
      observer = new MutationObserver(inspect);
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid', 'href'] });
      window.addEventListener(eventName, inspect);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { cleanup(); reject(new Error(timeoutMessage)); }, timeout);
      inspect();
    });
  }

  function textOf(node) {
    return node.textContent.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function menuLabels(handle, action) {
    const suffix = `@${handle}`;
    const verbs = action === 'unfollow'
      ? ['取消关注', '取消關注', '取消跟隨', '取消追蹤', 'unfollow']
      : ['关注', '關注', '跟隨', '追蹤', 'follow'];
    return verbs.map(verb => `${verb} ${suffix}`.toLowerCase());
  }

  // 确认框必须写明同一个 @账号，并且按钮文案就是取消关注，避免点到别的操作。
  function confirmUnfollow(handle) {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog || !dialog.textContent.toLowerCase().includes(`@${handle}`)) return null;
    const verbs = ['取消关注', '取消關注', '取消跟隨', '取消追蹤', 'unfollow'];
    return [...dialog.querySelectorAll('button, [role="button"]')].find(node => {
      const label = textOf(node);
      return verbs.includes(label) || menuLabels(handle, 'unfollow').includes(label);
    }) || null;
  }

  function canStart(action, original, prior) {
    if (original?.followBlocked) return false;
    if (action === 'follow') return original?.following === false && !original.followRequestSent;
    if (original?.followRequestSent && original.following !== true) return false;
    return original?.following === true || prior?.status === 'success' || (prior?.action === 'unfollow' && prior?.status === 'error');
  }

  async function begin({ button, details, handle, getProfile, action }) {
    if (active || !/^[a-zA-Z0-9_]{1,15}$/.test(handle) || button?.disabled) return;
    handle = handle.toLowerCase();
    const verb = action === 'unfollow' ? '取消关注' : '关注';
    const timeoutMessage = `未确认${verb}结果，请稍后重试`;
    const header = details?.closest('[data-testid="User-Name"], [data-testid="UserName"]');
    const article = header?.closest('article');
    const caret = article?.querySelector('[data-testid="caret"]');
    const original = getProfile(handle) || {};
    if (!article || !belongsTo(header, handle) || article.querySelector('[data-testid="User-Name"], [data-testid="UserName"]') !== header
      || !caret || !canStart(action, original, states.get(handle))) return;
    if (document.querySelector('[role="menu"], [role="dialog"]')) {
      update(handle, 'error', `请先关闭打开的菜单或弹窗，再点击${verb}`, action);
      return;
    }

    active = true;
    const aborter = new AbortController();
    let ownedMenu;
    let confirmedDialog = false;
    const stillSameAuthor = () => {
      if (!button.isConnected || !belongsTo(header, handle) || details.dataset.xfcHandle !== handle) {
        throw new Error(`页面中的作者已变化，请重新点击${verb}`);
      }
    };
    const cancelOnLeave = () => aborter.abort();
    window.addEventListener('pagehide', cancelOnLeave, { once: true });
    update(handle, 'pending', '', action);
    try {
      // 复用 X 原生菜单，不保存登录信息，不自己构造写入请求。
      document.documentElement.setAttribute('data-xfc-follow-menu', '');
      caret.click();
      ownedMenu = await waitFor(() => {
        stillSameAuthor();
        if (caret.getAttribute('aria-expanded') !== 'true') return false;
        return document.querySelector('[role="menu"]');
      }, 2000, aborter.signal, 'xpandmax:profiles', timeoutMessage);
      stillSameAuthor();
      const items = [...ownedMenu.querySelectorAll('[role="menuitem"]')];
      const match = items.find(node => menuLabels(handle, action).includes(textOf(node)));
      if (!match) {
        if (action === 'follow' && items.some(node => menuLabels(handle, 'unfollow').includes(textOf(node)))) {
          update(handle, 'success', '', 'follow');
          return;
        }
        // 菜单已经回到「关注」说明并未处于已关注，不点击，避免误关注。
        if (action === 'unfollow' && items.some(node => menuLabels(handle, 'follow').includes(textOf(node)))) {
          clearState(handle);
          return;
        }
        throw new Error(action === 'follow' ? 'X 当前没有提供关注入口，请打开作者主页查看' : 'X 当前没有提供取消关注入口，请打开作者主页查看');
      }
      const beforeRevision = getProfile(handle)?.followingRevision || 0;
      match.click();
      if (caret.getAttribute('aria-expanded') === 'true' && ownedMenu.isConnected) caret.click();
      document.documentElement.removeAttribute('data-xfc-follow-menu');
      const result = await waitFor(() => {
        stillSameAuthor();
        if (action === 'unfollow') {
          const dialogButton = confirmUnfollow(handle);
          if (dialogButton && !confirmedDialog) {
            confirmedDialog = true;
            dialogButton.click();
            return false;
          }
          const profile = getProfile(handle) || {};
          if ((profile.followingRevision || 0) <= beforeRevision || profile.following !== false) return false;
          return 'removed';
        }
        const profile = getProfile(handle) || {};
        return profile.followRequestSent ? 'requested' : profile.following === true ? 'success' : false;
      }, 10000, aborter.signal, 'xpandmax:profiles', timeoutMessage);
      if (result === 'removed') clearState(handle);
      else update(handle, result, '', 'follow');
    } catch (error) {
      update(handle, 'error', error.message, action);
    } finally {
      aborter.abort();
      if (ownedMenu?.isConnected && caret?.isConnected && caret.getAttribute('aria-expanded') === 'true') caret.click();
      document.documentElement.removeAttribute('data-xfc-follow-menu');
      window.removeEventListener('pagehide', cancelOnLeave);
      active = false;
    }
  }

  window.xpandmaxFollow = {
    start: args => begin({ ...args, action: 'follow' }),
    unfollow: args => begin({ ...args, action: 'unfollow' }),
    state: handle => states.get(handle)
  };
})();
