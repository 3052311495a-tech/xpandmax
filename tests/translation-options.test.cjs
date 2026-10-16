const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function setup(granted = true) {
  const dom = new JSDOM(fs.readFileSync('extension/translation-options.html', 'utf8'), { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [], origins = [];
  w.chrome = {
    permissions: { request: async request => { origins.push(request.origins); return granted; } },
    runtime: { sendMessage: async message => {
      calls.push(message);
      if (message.type === 'translation-config') return { provider: 'local' };
      if (message.type === 'translation-save') return { saved: true };
      return { text: '<img src=x onerror=alert(1)>' };
    } }
  };
  w.eval(fs.readFileSync('extension/translation-options.js', 'utf8'));
  await tick();
  const $ = id => w.document.getElementById(id);
  $('provider').value = 'custom';
  $('provider').dispatchEvent(new w.Event('change', { bubbles: true }));
  $('endpoint').value = 'https://api.example/v1/chat/completions';
  $('model').value = 'test-model';
  $('api-key').value = 'synthetic-key';
  return { w, $, calls, origins, close: () => w.close() };
}

test('save requests only the configured host, then enables a synthetic connection test', async () => {
  const { w, $, calls, origins, close } = await setup();
  try {
    assert.equal($('test').disabled, true);
    $('translation-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await tick();
    assert.equal(origins[0][0], 'https://api.example/*');
    assert.equal(calls[1].config.apiKey, 'synthetic-key');
    assert.equal($('test').disabled, false);
    $('test').click();
    await tick();
    assert.equal(calls[2].type, 'translation-test');
    assert.equal($('status').querySelector('img'), null);
    assert.match($('status').textContent, /<img/);
    $('model').dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal($('test').disabled, true);
  } finally { close(); }
});

test('declining host permission does not save settings or send a test request', async () => {
  const { w, $, calls, close } = await setup(false);
  try {
    $('translation-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await tick();
    assert.equal(calls.length, 1);
    assert.match($('status').textContent, /设置未保存/);
    assert.equal($('test').disabled, true);
  } finally { close(); }
});

test('Google needs no custom fields and requests only its fixed host', async () => {
  const { w, $, calls, origins, close } = await setup();
  try {
    $('provider').value = 'google';
    $('provider').dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal($('custom-fields').hidden, true);
    assert.equal($('google-note').hidden, false);
    $('translation-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await tick();
    assert.equal(origins[0][0], 'https://translate.googleapis.com/*');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[1].config)), { provider: 'google' });
    assert.equal($('test').disabled, false);
    assert.equal($('api-key').value, '');
  } finally { close(); }
});

for (const provider of ['gemini', 'anthropic']) test(`${provider} settings save generic host, model and key`, async () => {
  const { w, $, calls, origins, close } = await setup();
  try {
    $('provider').value = provider;
    $('provider').dispatchEvent(new w.Event('change', { bubbles: true }));
    $('endpoint').value = 'https://api.example';
    assert.equal($('custom-fields').hidden, false);
    $('translation-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await tick();
    assert.equal(calls[1].config.provider, provider);
    assert.equal(calls[1].config.model, 'test-model');
    assert.equal(calls[1].config.apiKey, 'synthetic-key');
    assert.equal(origins[0][0], 'https://api.example/*');
    assert.equal($('test').disabled, false);
  } finally { close(); }
});
