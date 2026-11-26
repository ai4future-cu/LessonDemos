import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import systemPrompt from './system-prompt.js';

const directory = dirname(fileURLToPath(import.meta.url));
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function failure(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

async function readMessages(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw failure('conversation_too_long', 413);
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('invalid_request'); }
  const messages = data?.messages;
  if (!Array.isArray(messages) || !messages.length) throw failure('invalid_request');
  if (messages.length > 40) throw failure('conversation_too_long');
  let characters = 0;
  const clean = messages.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' || !message.content.trim()) throw failure('invalid_request');
    const content = message.content.trim();
    characters += content.length;
    if (content.length > 16000 || characters > 40000) throw failure('conversation_too_long');
    return { role: message.role, content };
  });
  if (clean[0].role !== 'user' || clean.at(-1).role !== 'user') throw failure('invalid_request');
  return clean;
}

// Provider adapter: edit this function when connecting a different API format.
// The browser-facing interface stays POST /api/chat -> { reply, model }.
export async function callModernAPI(messages, config, fetchImpl = fetch) {
  const base = config.baseURL.replace(/\/+$/, '');
  const chatCompletions = config.format === 'chat-completions';
  const url = new URL(base + (chatCompletions ? '/chat/completions' : '/responses'));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw failure('request_failed', 502);
  }
  const instructions = systemPrompt;
  const deepseek = url.hostname === 'api.deepseek.com';
  const payload = chatCompletions ? {
    model: config.model,
    messages: [{ role: 'system', content: instructions }, ...messages],
    ...(deepseek ? { max_tokens: 2048, thinking: { type: 'disabled' } } : { max_completion_tokens: 2048 })
  } : {
    model: config.model, instructions, input: messages,
    max_output_tokens: 2048, store: false
  };
  const response = await fetchImpl(url.href, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw failure(response.status === 429 ? 'rate_limited' : 'request_failed', response.status === 429 ? 429 : 502);
  const data = await response.json();
  const output = Array.isArray(data?.output) ? data.output : [];
  const text = chatCompletions ? data?.choices?.[0]?.message?.content :
    output.filter(item => item.type === 'message').flatMap(item => item.content || [])
      .map(part => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '').join('\n');
  if (typeof text !== 'string' || !text.trim()) throw failure('invalid_response', 502);
  return { reply: text.trim(), model: typeof data.model === 'string' ? data.model : config.model };
}

export function createComparisonServer({ env = process.env, fetchImpl = fetch, root = resolve(directory, '..') } = {}) {
  const config = {
    key: (env.MODERN_API_KEY || '').trim(),
    model: (env.MODERN_MODEL || '').trim(),
    baseURL: (env.MODERN_BASE_URL || 'https://api.openai.com/v1').trim(),
    format: (env.MODERN_API_FORMAT || 'responses').trim()
  };
  const configured = !!config.key && !!config.model && ['responses', 'chat-completions'].includes(config.format);
  const rootPath = resolve(root);

  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      const origin = new URL('http://' + request.headers.host);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
        return json(response, 403, { error: { code: 'forbidden' } });
      }
      const url = new URL(request.url, origin);
      if (url.pathname === '/api/status' && request.method === 'GET') {
        return json(response, 200, { configured, model: configured ? config.model : '' });
      }
      if (url.pathname === '/api/chat') {
        if (request.method !== 'POST') return json(response, 405, { error: { code: 'method_not_allowed' } });
        if (request.headers.origin && request.headers.origin !== origin.origin) {
          return json(response, 403, { error: { code: 'forbidden' } });
        }
        if (!(request.headers['content-type'] || '').startsWith('application/json')) throw failure('invalid_request');
        const messages = await readMessages(request);
        if (!configured) return json(response, 503, { error: { code: 'not_configured' } });
        const result = await callModernAPI(messages, config, fetchImpl);
        return json(response, 200, result);
      }
      if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: { code: 'method_not_allowed' } });
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { throw failure('invalid_request'); }
      if (path.includes('\0') || path.split(/[\\/]/).some(part => part.startsWith('.'))) {
        return json(response, 404, { error: { code: 'not_found' } });
      }
      let candidate = resolve(rootPath, '.' + path);
      if (candidate !== rootPath && !candidate.startsWith(rootPath + sep)) throw failure('not_found', 404);
      try {
        if ((await stat(candidate)).isDirectory()) candidate = resolve(candidate, 'index.html');
        candidate = await realpath(candidate);
      } catch { throw failure('not_found', 404); }
      const actualRoot = await realpath(rootPath);
      if (!candidate.startsWith(actualRoot + sep) || !mimeTypes[extname(candidate)]) throw failure('not_found', 404);
      const content = await readFile(candidate);
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(candidate)], 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const code = error.name === 'TimeoutError' ? 'timeout' : error.code || 'request_failed';
      const allowed = ['invalid_request', 'conversation_too_long', 'not_found', 'rate_limited', 'timeout', 'invalid_response', 'request_failed'];
      if (!response.headersSent) json(response, error.status || 502, { error: { code: allowed.includes(code) ? code : 'request_failed' } });
      else response.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = resolve(directory, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = createComparisonServer();
  server.on('error', error => { console.error('Could not start the demo server: ' + error.code); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log('Compare chatbots: http://127.0.0.1:' + port + '/eliza/index.html#compare');
    console.log('Modern API: ' + (process.env.MODERN_API_KEY && process.env.MODERN_MODEL ? 'configured' : 'not configured; add compare/.env when ready'));
  });
}
