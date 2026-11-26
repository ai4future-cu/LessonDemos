'use strict';

// Temporary personal-demo credentials live only inside this closure.
// No key is written to storage, cookies, the URL, or configuration files.
// Without a temporary key, the optional backend contract remains available.
window.ChatbotComparisonAPI = (() => {
  const config = window.CHATBOT_COMPARISON_CONFIG;
  let directConnection = null;
  let disconnected = false;
  const messages = {
    not_configured: 'The modern chatbot is not connected yet.',
    invalid_settings: 'Enter a key, a model ID, and a valid HTTPS API base URL.',
    authentication: 'The API rejected the connection. Check your key, model, and service availability.',
    browser_connection: 'Could not reach this API. Check the URL and whether it allows browser requests.',
    rate_limited: 'The API usage or rate limit was reached. Please check your account and try again.',
    conversation_too_long: 'Start a new conversation to continue.',
    timeout: 'The reply took too long. Please try again.',
    request_failed: 'The modern chatbot could not reply. Please try again.',
    invalid_response: 'The connection returned an unreadable reply.'
  };

  function failure(code) {
    return Object.assign(new Error(messages[code] || messages.request_failed), { code });
  }

  function endpoint(path) {
    const url = new URL(path, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  }

  function configure({ key, model, baseURL, format = 'responses' } = {}) {
    if (![key, model, baseURL].every(value => typeof value === 'string')) throw failure('invalid_settings');
    let url;
    try { url = new URL(baseURL.trim()); } catch { throw failure('invalid_settings'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
        url.username || url.password || url.search || url.hash || !key.trim() || !model.trim() ||
        !['responses', 'chat-completions'].includes(format)) throw failure('invalid_settings');
    const base = url.href.replace(/\/+$/, '').replace(/\/(?:responses|chat\/completions)$/, '');
    directConnection = Object.freeze({ key: key.trim(), model: model.trim(), baseURL: base, format });
    disconnected = false;
    return { configured: true, temporary: true, model: directConnection.model };
  }

  function clearCredentials() {
    directConnection = null;
    disconnected = true;
  }

  async function status() {
    if (directConnection) return { configured: true, temporary: true, model: directConnection.model };
    if (disconnected) return { configured: false };
    const url = endpoint(config.statusEndpoint);
    if (!url) return { configured: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) return { configured: false };
      const data = await response.json();
      return { configured: data.configured === true, model: typeof data.model === 'string' ? data.model : '' };
    } catch {
      return { configured: false };
    } finally { clearTimeout(timer); }
  }

  async function send(history, { signal } = {}) {
    const direct = directConnection;
    if (!direct && disconnected) throw failure('not_configured');
    const instructions = window.CHATBOT_COMPARISON_SYSTEM_PROMPT;
    if (direct && (typeof instructions !== 'string' || !instructions.trim())) throw failure('invalid_settings');
    const chatCompletions = direct?.format === 'chat-completions';
    const url = direct ? direct.baseURL + (chatCompletions ? '/chat/completions' : '/responses') : endpoint(config.endpoint);
    if (!url) throw failure('not_configured');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
    const headers = { 'Content-Type': 'application/json' };
    let payload = { messages: history };
    if (direct) {
      headers.Authorization = 'Bearer ' + direct.key;
      const deepseek = new URL(direct.baseURL).hostname === 'api.deepseek.com';
      payload = chatCompletions ? {
        model: direct.model, messages: [{ role: 'system', content: instructions }, ...history],
        ...(deepseek ? { max_tokens: 2048, thinking: { type: 'disabled' } } : { max_completion_tokens: 2048 })
      } : { model: direct.model, input: history, instructions, max_output_tokens: 2048, store: false };
    }
    try {
      const response = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store'
      });
      let data;
      try { data = await response.json(); }
      catch { throw failure(response.ok ? 'invalid_response' : 'request_failed'); }
      if (!response.ok) {
        if (direct) throw failure(response.status === 429 ? 'rate_limited' : [401, 403].includes(response.status) ? 'authentication' : 'request_failed');
        throw failure(data.error?.code || (response.status === 429 ? 'rate_limited' : 'request_failed'));
      }
      let reply = data?.reply;
      if (direct) {
        reply = chatCompletions ? data?.choices?.[0]?.message?.content :
          (Array.isArray(data?.output) ? data.output : []).filter(item => item.type === 'message')
            .flatMap(item => item.content || []).map(part => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '').join('\n');
      }
      if (typeof reply !== 'string' || !reply.trim()) throw failure('invalid_response');
      return { reply: reply.trim(), model: typeof data.model === 'string' ? data.model : direct?.model || '' };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timedOut) throw failure('timeout');
      if (error.code && messages[error.code]) throw error;
      throw failure(direct ? 'browser_connection' : 'request_failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  return Object.freeze({ status, send, configure, clearCredentials, hasDirectCredentials: () => directConnection !== null });
})();
