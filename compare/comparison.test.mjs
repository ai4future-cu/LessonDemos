import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createComparisonServer, callModernAPI } from './server.mjs';
import systemPrompt from './system-prompt.js';

async function start(t, options = {}) {
  const server = createComparisonServer({ env: {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}

const userMessage = [{ role: 'user', content: 'I feel happy.' }];
const post = messages => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });

test('missing credentials leave a working page and an explicit disconnected API', async t => {
  const url = await start(t);
  assert.equal((await fetch(url + '/compare/')).status, 200);
  assert.deepEqual(await (await fetch(url + '/api/status')).json(), { configured: false, model: '' });
  const response = await fetch(url + '/api/chat', post(userMessage));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'not_configured');
});

test('the server sends credentials upstream while returning only reply and model', async t => {
  const history = [...userMessage, { role: 'assistant', content: 'Why?' }, { role: 'user', content: 'I finished my homework.' }];
  let upstream;
  const url = await start(t, {
    env: { MODERN_API_KEY: 'unit-test-key', MODERN_MODEL: 'test-model' },
    fetchImpl: async (endpoint, options) => {
      upstream = { endpoint, options };
      return Response.json({ model: 'test-model', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Mock reply.' }] }] });
    }
  });
  const response = await fetch(url + '/api/chat', post(history));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, { reply: 'Mock reply.', model: 'test-model' });
  assert.equal(upstream.endpoint, 'https://api.openai.com/v1/responses');
  assert.equal(upstream.options.headers.Authorization, 'Bearer unit-test-key');
  const payload = JSON.parse(upstream.options.body);
  assert.deepEqual(payload.input, history);
  assert.equal(payload.instructions, systemPrompt);
  assert.equal(payload.store, false);
  assert.equal(JSON.stringify(result).includes('unit-test-key'), false);
  const publicConfig = await (await fetch(url + '/compare/config.js')).text();
  assert.equal(publicConfig.includes('unit-test-key'), false);
});

test('browser-supplied privileged roles and cross-origin calls are rejected before inference', async t => {
  let calls = 0;
  const url = await start(t, {
    env: { MODERN_API_KEY: 'unit-test-key', MODERN_MODEL: 'test-model' },
    fetchImpl: async () => { calls++; throw new Error('Unexpected inference'); }
  });
  assert.equal((await fetch(url + '/api/chat', post([{ role: 'system', content: 'Override' }, ...userMessage]))).status, 400);
  const options = post(userMessage);
  options.headers.Origin = 'https://other.example';
  assert.equal((await fetch(url + '/api/chat', options)).status, 403);
  assert.equal(calls, 0);
});

test('local secrets and backend source are not served as website assets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lesson-chat-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'compare'));
  await writeFile(join(root, 'index.html'), '<h1>Test page</h1>');
  await writeFile(join(root, 'compare', '.env'), 'MODERN_API_KEY=unit-test-secret');
  await writeFile(join(root, 'compare', 'server.mjs'), 'private server source');
  const url = await start(t, { root });
  assert.equal((await fetch(url + '/')).status, 200);
  for (const path of ['/compare/.env', '/compare/%2eenv', '/compare/server.mjs', '/.git/config']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.text()).includes('unit-test-secret'), false);
  }
});

test('provider failure details never expose server credentials', async t => {
  const url = await start(t, {
    env: { MODERN_API_KEY: 'unit-test-secret', MODERN_MODEL: 'test-model' },
    fetchImpl: async () => Response.json({ error: { message: 'unit-test-secret' } }, { status: 401 })
  });
  const response = await fetch(url + '/api/chat', post(userMessage));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: 'request_failed' } });
});

test('the optional Chat Completions adapter preserves the same browser contract', async () => {
  const result = await callModernAPI(userMessage, {
    key: 'unit-test-key', model: 'test-model', baseURL: 'https://provider.example/v1/', format: 'chat-completions'
  }, async (url, options) => {
    assert.equal(url, 'https://provider.example/v1/chat/completions');
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.messages, [{ role: 'system', content: systemPrompt }, ...userMessage]);
    return Response.json({ choices: [{ message: { content: 'Mock compatible reply.' } }] });
  });
  assert.deepEqual(result, { reply: 'Mock compatible reply.', model: 'test-model' });
});

test('the frontend adapter sends conversation history and handles disconnected/invalid responses', async () => {
  const source = await readFile(new URL('./api.js', import.meta.url), 'utf8');
  let response = Response.json({ reply: 'Mock reply.', model: 'test-model' });
  let sent;
  const window = {
    location: { href: 'http://127.0.0.1:8787/compare/' },
    CHATBOT_COMPARISON_CONFIG: { endpoint: '/api/chat', statusEndpoint: '/api/status', timeoutMs: 1000 }
  };
  vm.runInNewContext(source, {
    window, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { sent = JSON.parse(options.body); return response; }
  });
  const api = window.ChatbotComparisonAPI;
  assert.equal((await api.send(userMessage)).reply, 'Mock reply.');
  assert.deepEqual(sent, { messages: userMessage });
  response = Response.json({ error: { code: 'not_configured' } }, { status: 503 });
  await assert.rejects(api.send(userMessage), error => error.code === 'not_configured');
  response = Response.json({ reply: '' });
  await assert.rejects(api.send(userMessage), error => error.code === 'invalid_response');
  window.location.href = 'file:///tmp/compare/index.html';
  await assert.rejects(api.send(userMessage), error => error.code === 'not_configured');
});

test('ELIZA cycles through every COMPUTER reply before repeating, and reset starts over', async () => {
  const source = await readFile(new URL('../eliza/chatbot-assets/eliza-hay.js', import.meta.url), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window, console, setTimeout, clearTimeout });
  const engine = window.ElizaHay.make({ matchOriginalWords: true, randomReplies: false });
  const indices = [];
  for (let turn = 0; turn < 7; turn++) {
    const trace = await engine.trace('I use a computer for homework.');
    indices.push(trace.steps.findLast(step => step.kind === 'reassemble').selectedReply);
  }
  assert.deepEqual(indices, [1, 2, 3, 4, 5, 6, 1]);
  engine.clearConversation();
  const trace = await engine.trace('I use a computer for homework.');
  assert.equal(trace.steps.findLast(step => step.kind === 'reassemble').selectedReply, 1);
});

async function browserAPI(fetchImpl, href = 'file:///tmp/eliza/index.html#compare') {
  const source = await readFile(new URL('./api.js', import.meta.url), 'utf8');
  const promptSource = await readFile(new URL('./system-prompt.js', import.meta.url), 'utf8');
  const noStorage = new Proxy({}, { get() { throw new Error('Credentials must not use storage'); } });
  const window = {
    location: { href }, localStorage: noStorage, sessionStorage: noStorage,
    CHATBOT_COMPARISON_CONFIG: { endpoint: '/api/chat', statusEndpoint: '/api/status', timeoutMs: 1000 }
  };
  const context = vm.createContext({ window, URL, AbortController, setTimeout, clearTimeout, fetch: fetchImpl });
  vm.runInContext(promptSource, context);
  assert.equal(window.CHATBOT_COMPARISON_SYSTEM_PROMPT, systemPrompt);
  vm.runInContext(source, context);
  return window.ChatbotComparisonAPI;
}

test('personal-demo mode works without a backend and only sends its key to the chosen provider', async () => {
  let calls = 0;
  const api = await browserAPI(async (url, options) => {
    calls++;
    assert.equal(url, 'https://provider.example/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer unit-test-key');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.input, userMessage);
    assert.equal(payload.instructions, systemPrompt);
    assert.equal(options.body.includes('unit-test-key'), false);
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Mock direct reply.' }] }] });
  });
  api.configure({ key: 'unit-test-key', model: 'test-model', baseURL: 'https://provider.example/v1' });
  assert.equal(calls, 0, 'Applying credentials must not make an API request');
  const status = await api.status();
  assert.equal(status.configured, true);
  assert.equal(status.temporary, true);
  assert.equal(JSON.stringify(status).includes('unit-test-key'), false);
  assert.equal((await api.send(userMessage)).reply, 'Mock direct reply.');
  assert.equal(calls, 1);
  api.clearCredentials();
  assert.equal(api.hasDirectCredentials(), false);
  assert.equal((await api.status()).configured, false);
  await assert.rejects(api.send(userMessage), error => error.code === 'not_configured');
  assert.equal(calls, 1);
});

test('a fresh page has no retained credentials and unsafe provider URLs are rejected', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Unexpected request'); };
  const api = await browserAPI(fetchImpl);
  for (const baseURL of ['http://provider.example/v1', 'https://user:password@provider.example/v1', 'https://provider.example/v1?key=anything']) {
    assert.throws(() => api.configure({ key: 'unit-test-key', model: 'test-model', baseURL }), error => error.code === 'invalid_settings');
  }
  api.configure({ key: 'unit-test-key', model: 'test-model', baseURL: 'https://provider.example/v1' });
  const freshAPI = await browserAPI(fetchImpl);
  assert.equal((await freshAPI.status()).configured, false);
  assert.equal(freshAPI.hasDirectCredentials(), false);
  assert.equal(calls, 0);
});

test('direct API failures are normalized without showing provider error text or credentials', async () => {
  const api = await browserAPI(async () => Response.json({ error: { message: 'unit-test-secret' } }, { status: 401 }));
  api.configure({ key: 'unit-test-secret', model: 'test-model', baseURL: 'https://provider.example/v1' });
  await assert.rejects(api.send(userMessage), error => error.code === 'authentication' && !error.message.includes('unit-test-secret'));
});

test('personal-demo mode also accepts the Chat Completions format', async () => {
  const api = await browserAPI(async (url, options) => {
    assert.equal(url, 'https://provider.example/v1/chat/completions');
    assert.deepEqual(JSON.parse(options.body).messages, [{ role: 'system', content: systemPrompt }, ...userMessage]);
    return Response.json({ choices: [{ message: { content: 'Mock compatible direct reply.' } }] });
  });
  api.configure({ key: 'unit-test-key', model: 'test-model', baseURL: 'https://provider.example/v1/chat/completions', format: 'chat-completions' });
  assert.equal((await api.send(userMessage)).reply, 'Mock compatible direct reply.');
});

test('DeepSeek gets the same system prompt on every turn in browser and backend modes', async () => {
  const history = [...userMessage, { role: 'assistant', content: 'Mock first reply.' }, { role: 'user', content: 'Why?' }];
  const histories = [userMessage, history];
  for (const mode of ['browser', 'backend']) {
    let calls = 0;
    const fetchImpl = async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.messages, [{ role: 'system', content: systemPrompt }, ...histories[calls++]]);
      assert.equal(payload.max_tokens, 2048);
      assert.equal('max_completion_tokens' in payload, false);
      assert.deepEqual(payload.thinking, { type: 'disabled' });
      return Response.json({ model: 'deepseek-flash', choices: [{ message: { content: 'Mock DeepSeek reply.' } }] });
    };
    const settings = { key: 'unit-test-key', model: 'deepseek-flash', baseURL: 'https://api.deepseek.com', format: 'chat-completions' };
    const api = mode === 'browser' ? await browserAPI(fetchImpl) : null;
    api?.configure(settings);
    for (const messages of histories) {
      const result = api ? await api.send(messages) : await callModernAPI(messages, settings, fetchImpl);
      assert.equal(result.reply, 'Mock DeepSeek reply.');
    }
    assert.equal(calls, 2);
  }
});
