import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual UI event handlers with a small DOM stand-in. Model calls
// are local stubs so routing tests never use credentials or paid requests.
class Element {
  children = [];
  listeners = {};
  dataset = {};
  value = '';
  text = '';
  className = '';
  disabled = false;
  classList = { add() {}, remove() {} };
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.text = text; this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  querySelector() { return null; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  fire(type) { this.listeners[type]?.({ preventDefault() {} }); }
  focus() {}
}

const flush = () => new Promise(resolve => setImmediate(resolve));

async function harness(sendImpl) {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('compare-recipient').value = 'both';
  const example = new Element();
  example.dataset.message = 'An example message.';
  const modelCalls = [];
  const elizaCalls = [];
  const api = {
    status: async () => ({ configured: false }),
    hasDirectCredentials: () => false,
    send: async (history, options) => {
      modelCalls.push(JSON.parse(JSON.stringify(history)));
      return sendImpl ? sendImpl(history, options) : { reply: 'Modern reply.' };
    }
  };
  const window = {
    CHATBOT_COMPARISON_SYSTEM_PROMPT: 'Classroom prompt', ChatbotComparisonAPI: api,
    addEventListener() {},
    ElizaHay: { make: () => ({ trace: async text => {
      elizaCalls.push(text);
      return { output: 'Eliza reply' };
    } }) }
  };
  const document = {
    getElementById: get,
    querySelectorAll: () => [example],
    createElement: () => new Element(),
    createTextNode: text => Object.assign(new Element(), { textContent: text })
  };
  vm.runInNewContext(source, { window, document, AbortController });
  await flush();
  return {
    get, example, modelCalls, elizaCalls,
    select(value) { get('compare-recipient').value = value; get('compare-recipient').fire('change'); },
    async send(text) { get('compare-input').value = text; get('compare-form').fire('submit'); await flush(); },
    async reset() { get('new-conversation').fire('click'); await flush(); }
  };
}

test('recipient switching isolates logs, model history, and ELIZA calls; Both remains the default', async () => {
  const ui = await harness();
  assert.equal(ui.get('compare-send').textContent, 'Send to both');
  await ui.send('Shared first turn');
  const elizaBefore = ui.get('eliza-log').textContent;
  ui.select('modern');
  assert.equal(ui.get('compare-send').textContent, 'Send to modern');
  await ui.send('Modern follow-up');
  assert.equal(ui.get('eliza-log').textContent, elizaBefore);
  const modernBefore = ui.get('modern-log').textContent;
  ui.select('eliza');
  assert.equal(ui.get('compare-send').textContent, 'Send to ELIZA');
  ui.example.fire('click');
  await flush();
  assert.equal(ui.get('modern-log').textContent, modernBefore);
  assert.equal(ui.modelCalls.length, 2);
  ui.select('both');
  await ui.send('Shared last turn');
  assert.deepEqual(ui.elizaCalls, ['Shared first turn', 'An example message.', 'Shared last turn']);
  assert.deepEqual(ui.modelCalls.at(-1), [
    { role: 'user', content: 'Shared first turn' },
    { role: 'assistant', content: 'Modern reply.' },
    { role: 'user', content: 'Modern follow-up' },
    { role: 'assistant', content: 'Modern reply.' },
    { role: 'user', content: 'Shared last turn' }
  ]);
});

test('ELIZA-only chat works with a disconnected modern API without making a model request', async () => {
  const ui = await harness(async () => { throw Object.assign(new Error('Not connected'), { code: 'not_configured' }); });
  ui.select('eliza');
  const badge = ui.get('modern-state').textContent;
  await ui.send('Local message');
  assert.deepEqual(ui.elizaCalls, ['Local message']);
  assert.equal(ui.modelCalls.length, 0);
  assert.equal(ui.get('modern-state').textContent, badge);
  assert.equal(ui.get('modern-log').children.length, 0);
});

test('reset cancels a pending modern-only request and ignores its late reply', async () => {
  let resolveReply, signal;
  const ui = await harness((history, options) => {
    signal = options.signal;
    return new Promise(resolve => { resolveReply = resolve; });
  });
  ui.select('modern');
  await ui.send('Pending message');
  assert.equal(ui.get('compare-recipient').disabled, true);
  assert.equal(ui.get('compare-send').textContent, 'Waiting…');
  await ui.reset();
  assert.equal(signal.aborted, true);
  assert.equal(ui.get('compare-recipient').disabled, false);
  resolveReply({ reply: 'Stale reply' });
  await flush();
  assert.equal(ui.get('modern-log').textContent.includes('Stale reply'), false);
  ui.select('eliza');
  await ui.send('New local message');
  assert.deepEqual(ui.elizaCalls, ['New local message']);
  assert.equal(ui.modelCalls.length, 1);
});

test('a full modern conversation does not prevent ELIZA-only chat, and reset clears model history', async () => {
  const ui = await harness();
  ui.select('modern');
  for (let turn = 0; turn < 20; turn++) await ui.send('Turn ' + turn);
  await ui.send('Beyond limit');
  assert.equal(ui.modelCalls.length, 20);
  ui.select('eliza');
  await ui.send('Still local');
  assert.deepEqual(ui.elizaCalls, ['Still local']);
  await ui.reset();
  ui.select('modern');
  await ui.send('Fresh turn');
  assert.deepEqual(ui.modelCalls.at(-1), [{ role: 'user', content: 'Fresh turn' }]);
});
