'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const input = byId('compare-input');
  const sendButton = byId('compare-send');
  const examples = [...document.querySelectorAll('[data-message]')];
  const elizaLog = byId('eliza-log');
  const modernLog = byId('modern-log');
  const api = window.ChatbotComparisonAPI;
  const keyInput = byId('api-key');
  const useAPI = byId('use-api');
  const makeEliza = () => window.ElizaHay.make({ matchOriginalWords: true, randomReplies: false });
  let eliza = makeEliza();
  let modernHistory = [];
  let generation = 0;
  let pending = false;
  let activeRequest;

  function setBusy(busy) {
    pending = busy;
    [input, sendButton, useAPI, ...examples].forEach(control => { control.disabled = busy; });
    sendButton.textContent = busy ? 'Waiting…' : 'Send to both';
  }

  function setModernState(text, ready = false) {
    const badge = byId('modern-state');
    badge.textContent = text;
    badge.dataset.state = ready ? 'ready' : '';
  }

  function addMessage(log, text, role, name) {
    log.querySelector('.empty-message')?.remove();
    const message = document.createElement('p');
    message.className = 'message ' + role;
    const label = document.createElement('span');
    label.className = 'visually-hidden';
    label.textContent = name + ': ';
    message.append(label, document.createTextNode(text));
    log.append(message);
    log.scrollTop = log.scrollHeight;
  }

  function addNotice(log, text, error = false) {
    const notice = document.createElement('p');
    notice.className = 'conversation-notice' + (error ? ' error' : '');
    notice.textContent = text;
    log.append(notice);
    log.scrollTop = log.scrollHeight;
  }

  function formatEliza(text) {
    const line = text.toLowerCase().replace(/\b(?:i|ai|gpt)\b/g, word => word.toUpperCase())
      .replace(/\bchatgpt\b/g, 'ChatGPT').replace(/\s+/g, ' ').replace(/“\s+/g, '“')
      .replace(/\s+([,.!?”])/g, '$1').trim().replace(/(^|[.!?]\s+)[a-z]/g, word => word.toUpperCase());
    if (!line || /[.!?]$/.test(line)) return line;
    const question = /^(?:am|are|can|can't|could|do|don't|does|did|have|how|in what|is|isn't|of what|should|what|when|where|which|who|why|will|would|wouldn't|were)\b/i.test(line);
    return line + (question ? '?' : '.');
  }

  async function refreshConnection() {
    const current = generation;
    const connection = await api.status();
    if (current !== generation || pending) return;
    setModernState(connection.configured ? (connection.temporary ? 'Key ready' : 'Ready') : 'Not connected', connection.configured);
    byId('clear-api').disabled = !api.hasDirectCredentials();
    const placeholder = modernLog.querySelector('.empty-message');
    if (placeholder) placeholder.textContent = connection.configured ?
      'Send the same message to compare its reply.' : 'The modern chatbot is not connected yet.';
  }

  async function send(text) {
    const message = text.trim();
    if (!message || pending) return;
    if (modernHistory.length >= 39) {
      byId('compare-status').textContent = 'Start a new conversation to continue.';
      return;
    }
    const current = generation;
    const currentEliza = eliza;
    const controller = new AbortController();
    activeRequest = controller;
    setBusy(true);
    byId('compare-status').textContent = '';
    input.value = '';
    addMessage(elizaLog, message, 'user', 'You');
    addMessage(modernLog, message, 'user', 'You');
    modernHistory.push({ role: 'user', content: message });
    const history = modernHistory.map(item => ({ ...item }));
    byId('eliza-state').textContent = 'Thinking…';
    setModernState('Thinking…');

    const elizaReply = (async () => {
      try {
        const turn = await currentEliza.trace(message);
        if (current !== generation) return;
        addMessage(elizaLog, formatEliza(turn.output), 'assistant', 'ELIZA');
      } catch {
        if (current === generation) addNotice(elizaLog, 'ELIZA could not reply. Please try again.', true);
      } finally {
        if (current === generation) byId('eliza-state').textContent = 'Ready';
      }
    })();

    const modernReply = (async () => {
      try {
        const result = await api.send(history, { signal: controller.signal });
        if (current !== generation) return;
        modernHistory.push({ role: 'assistant', content: result.reply });
        addMessage(modernLog, result.reply, 'assistant', 'Modern chatbot');
        setModernState('Ready', true);
      } catch (error) {
        if (current !== generation) return;
        const disconnected = error.code === 'not_configured';
        addNotice(modernLog, error.message, !disconnected);
        setModernState(disconnected ? 'Not connected' : 'Try again');
      }
    })();

    await Promise.all([elizaReply, modernReply]);
    if (current !== generation) return;
    activeRequest = null;
    setBusy(false);
    input.focus({ preventScroll: true });
  }

  byId('compare-form').addEventListener('submit', event => {
    event.preventDefault();
    send(input.value);
  });
  examples.forEach(button => button.addEventListener('click', () => send(button.dataset.message)));
  function resetConversation() {
    generation++;
    activeRequest?.abort();
    activeRequest = null;
    eliza = makeEliza();
    modernHistory = [];
    for (const log of [elizaLog, modernLog]) {
      const empty = document.createElement('p');
      empty.className = 'empty-message';
      empty.textContent = 'Send a message to start the conversation.';
      log.replaceChildren(empty);
    }
    byId('compare-status').textContent = '';
    byId('eliza-state').textContent = 'Ready';
    input.value = '';
    setBusy(false);
    refreshConnection();
    input.focus({ preventScroll: true });
  }
  byId('new-conversation').addEventListener('click', resetConversation);

  // A personal demo can enter credentials here instead of running a backend.
  // Do not assign the key to textContent, attributes, URLs, or storage.
  keyInput.value = '';
  byId('api-settings-form').addEventListener('submit', event => {
    event.preventDefault();
    if (pending) return;
    const status = byId('api-settings-status');
    try {
      api.configure({
        key: keyInput.value,
        model: byId('api-model').value,
        baseURL: byId('api-base-url').value,
        format: byId('api-format').value
      });
      keyInput.value = '';
      status.textContent = 'Key ready for this tab. Send a message to try it.';
      status.classList.remove('error');
      byId('api-settings').open = false;
      resetConversation();
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
    }
  });
  byId('clear-api').addEventListener('click', () => {
    api.clearCredentials();
    keyInput.value = '';
    byId('api-settings-status').textContent = 'Key cleared.';
    byId('api-settings-status').classList.remove('error');
    resetConversation();
  });
  window.addEventListener('pagehide', () => {
    activeRequest?.abort();
    api.clearCredentials();
    keyInput.value = '';
  });
  window.addEventListener('pageshow', refreshConnection);
  useAPI.disabled = false;

  refreshConnection();
})();
