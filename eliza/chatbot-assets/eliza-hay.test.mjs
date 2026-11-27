import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function factory() {
  const source = await readFile(new URL('./eliza-hay.js', import.meta.url), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window, console, setTimeout, clearTimeout, TextEncoder, TextDecoder });
  return window.ElizaHay;
}

test('classroom replies substitute captured pronouns after matching and before reassembly', async () => {
  const api = await factory();
  for (const orderKeywordsByPriority of [false, true]) {
    const engine = api.make({ matchOriginalWords: true, orderKeywordsByPriority });
    const turn = await engine.trace('well, my boyfriend send me here');
    assert.equal(turn.output, 'YOUR BOYFRIEND SEND YOU HERE');
    const match = turn.steps.findLast(step => step.kind === 'decompose');
    const substitute = turn.steps.findLast(step => step.kind === 'substitute');
    const reply = turn.steps.findLast(step => step.kind === 'reassemble');
    assert.equal(match.components[1], 'MY', 'match the original wording');
    assert.equal(match.components[2], 'BOYFRIEND SEND ME HERE');
    assert.equal(substitute.parts[0].before, 'BOYFRIEND SEND ME HERE');
    assert.equal(substitute.parts[0].after, 'BOYFRIEND SEND YOU HERE');
    assert.ok(turn.steps.indexOf(match) < turn.steps.indexOf(substitute));
    assert.ok(turn.steps.indexOf(substitute) < turn.steps.indexOf(reply));
    assert.equal(reply.output, turn.output);
    const second = await engine.trace('well my boyfriend send me here');
    assert.equal(second.output, 'WHY DO YOU SAY YOUR BOYFRIEND SEND YOU HERE');
    assert.equal(second.steps.findLast(step => step.kind === 'reassemble').selectedReply, 2);
  }
});

test('substitutions run once on reused words and preserve literal reply-template pronouns', async () => {
  const api = await factory();
  const engine = api.make({ matchOriginalWords: true });
  engine.addRule('COMPUTER', ['0'], ['I', 'HEARD', 'YOU', 'SAY', '1']);
  assert.equal((await engine.trace('My computer helps me')).output,
    'I HEARD YOU SAY YOUR COMPUTER HELPS YOU');
  assert.equal((await engine.trace('You use my computer')).output,
    'I HEARD YOU SAY I USE YOUR COMPUTER');
  assert.equal((await engine.trace('I use your computer')).output,
    'I HEARD YOU SAY YOU USE MY COMPUTER');
});

test('captured pronouns are substituted even in older reply templates containing quotation marks', async () => {
  const api = await factory();
  const engine = api.make({ matchOriginalWords: true });
  engine.addRule('COMPUTER', ['0'], ['YOU', 'SAID', '“', '1', '”', '.']);
  const turn = await engine.trace('My computer helps me');
  assert.equal(turn.output, 'YOU SAID “ YOUR COMPUTER HELPS YOU ” .');
  const part = turn.steps.find(step => step.kind === 'substitute').parts[0];
  assert.equal(part.quoted, true);
  assert.notEqual(part.before, part.after);
  assert.equal(part.after, 'YOUR COMPUTER HELPS YOU');
});

test('the default I fallback substitutes the full clause, and saved older versions do the same', async () => {
  const api = await factory();
  const engine = api.make({matchOriginalWords:true, orderKeywordsByPriority:true});
  const turn = await engine.trace('I wish AI could understand me.');
  assert.equal(turn.output, 'YOU SAY THAT YOU WISH AI COULD UNDERSTAND YOU .');
  const part = turn.steps.find(step => step.kind === 'substitute').parts[0];
  assert.equal(part.before, 'I WISH AI COULD UNDERSTAND ME');
  assert.equal(part.after, 'YOU WISH AI COULD UNDERSTAND YOU');
  engine.editReply('I', 11, 0, ['YOU','SAID','“','1','”','.']);
  const saved = api.make({snapshot:JSON.parse(JSON.stringify(engine.snapshot()))});
  assert.equal((await saved.trace('I wish AI could understand me.')).output,
    'YOU SAID “ YOU WISH AI COULD UNDERSTAND YOU ” .');
});

test('new keyword groups and linked trigger words use the same substitutions', async () => {
  const api = await factory();
  const engine = api.make({ matchOriginalWords: true });
  engine.addRule('ROBOT', ['0'], ['YOU', 'SAID', '1']);
  engine.setGroupWords('ROBOT', [], ['AUTOMATON']);
  const turn = await engine.trace('My automaton helps me');
  assert.equal(turn.output, 'YOU SAID YOUR AUTOMATON HELPS YOU');
});

test('saved memory contains substituted fragments rather than the original first-person words', async () => {
  const api = await factory();
  const engine = api.make({ matchOriginalWords: true });
  const turn = await engine.trace('My boyfriend made me come here.');
  const saved = turn.steps.find(step => step.kind === 'memory-store');
  assert.match(saved.text, /YOUR BOYFRIEND MADE YOU COME HERE/);
  assert.doesNotMatch(saved.text, /MADE ME/);
});

test('other captured pronouns are substituted without changing ordinary words or spelling', async () => {
  const api = await factory();
  const engine = api.make({ matchOriginalWords: true });
  const turn = await engine.trace('You are afraid of me.');
  assert.equal(turn.output, 'WHAT MAKES YOU THINK I AM AFRAID OF YOU');
  const typo = await api.make({ matchOriginalWords: true }).trace('My boyfired send me here');
  assert.equal(typo.output, 'YOUR BOYFIRED SEND YOU HERE');
});

test('historical mode still reproduces the included 1966 conversation', async () => {
  const api = await factory();
  const engine = api.make();
  for (let index = 0; index < api.conversation.length; index += 2) {
    const turn = await engine.trace(api.conversation[index]);
    assert.equal(turn.output, api.conversation[index + 1], api.conversation[index]);
    assert.equal(turn.steps.some(step => step.kind === 'substitute'), false);
  }
});
