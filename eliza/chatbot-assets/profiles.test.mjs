import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function factory() {
  const window = {};
  const context = vm.createContext({window, console, setTimeout, clearTimeout, TextEncoder, TextDecoder});
  for (const file of ['eliza-hay.js', 'profiles.js']) vm.runInContext(await readFile(new URL(file, import.meta.url), 'utf8'), context);
  return window;
}
const copy = value => JSON.parse(JSON.stringify(value));
const options = {matchOriginalWords:true, randomReplies:false, orderKeywordsByPriority:true};

test('saving and restoring the full classroom rules preserves family tags, links, substitutions, and reply cycling', async () => {
  const {ElizaHay} = await factory();
  const original = ElizaHay.make(options);
  const restored = ElizaHay.make({snapshot:copy(original.snapshot())});
  for (const input of ['Adults are all alike.', 'They always tell me what to do.', 'My dad makes me finish my homework.',
    'I think my exams are making me nervous.', 'I think my exams are making me nervous.', 'I use a computer.', 'You are afraid of me.']) {
    assert.equal((await restored.trace(input)).output, (await original.trace(input)).output, input);
  }
});

test('edited priorities, aliases, deleted groups, named slots and replies survive a JSON round trip without storing conversation text', async () => {
  const {ElizaHay} = await factory();
  const original = ElizaHay.make(options);
  original.addRule('AI', ['I','WISH','AI','COULD','0'], ['WHAT','WOULD','IT','MEAN','TO','YOU','IF','AI','COULD','5'], {'5':'slot 1'});
  original.setGroupWords('AI', ['AI'], ['AI','CHATGPT','DEEPSEEK']);
  original.setKeywordPriority('AI', 60);
  original.setGroupActive('COMPUTER', false);
  original.setGroupWords('COMPUTER', ['COMPUTER'], []);
  await original.trace('My private memory phrase');
  const snapshot = copy(original.snapshot());
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE MEMORY PHRASE'), false);
  const restored = ElizaHay.make({snapshot});
  assert.equal((await restored.trace('I wish AI could understand me.')).output, 'WHAT WOULD IT MEAN TO YOU IF AI COULD UNDERSTAND YOU');
  assert.equal(restored.dictionary().find(group => group.keyword === 'AI').precedence, 60);
  assert.equal(restored.dictionary().find(group => group.keyword === 'AI').transforms[0].slotLabels['5'], 'slot 1');
  assert.equal(restored.dictionary().find(group => group.keyword === 'COMPUTER').active, false);
  assert.equal((await restored.trace('ChatGPT')).output, (await original.trace('ChatGPT')).output);
});

test('the advanced blank challenge has one general reply, no keyword groups, and still supports pronoun substitution after building', async () => {
  const {ElizaHay} = await factory();
  const blank = ElizaHay.make({...options, blank:true});
  assert.equal(blank.dictionary().filter(group => !group.isMemory).length, 1);
  assert.equal((await blank.trace('Adults are all alike.')).output, 'TELL ME MORE');
  blank.addRule('AI', ['I','WISH','AI','COULD','0'], ['WHAT','IF','AI','COULD','5']);
  const restored = ElizaHay.make({snapshot:copy(blank.snapshot())});
  assert.equal((await restored.trace('I wish AI could understand me.')).output, 'WHAT IF AI COULD UNDERSTAND YOU');
  assert.equal((await restored.trace('No matching topic')).output, 'TELL ME MORE');
});

test('three saved versions persist across library instances; updates rename without consuming a slot; deletion can be undone', async () => {
  const {ElizaHay, ElizaLibrary} = await factory();
  const stored = new Map();
  const storage = {getItem:key => stored.get(key) || null, setItem:(key,value) => stored.set(key,value)};
  const valid = snapshot => !!ElizaHay.make({snapshot});
  const library = ElizaLibrary.create(storage, valid);
  const snapshot = ElizaHay.make({...options, blank:true}).snapshot();
  const first = library.save({name:'myELIZA', snapshot});
  library.save({name:'second', snapshot});
  library.save({name:'third', snapshot});
  assert.throws(() => library.save({name:'fourth', snapshot}), /3 saved ELIZAs/);
  library.save({id:first.id, name:'Renamed ELIZA', snapshot});
  const reloaded = ElizaLibrary.create(storage, valid);
  assert.equal(reloaded.list().length, 3);
  assert.equal(reloaded.get(first.id).name, 'Renamed ELIZA');
  const deleted = reloaded.get(first.id);
  reloaded.remove(first.id);
  reloaded.restore(deleted);
  assert.equal(reloaded.list().length, 3);
  assert.equal(JSON.stringify(reloaded.list()).includes('conversation'), false);
});

test('blocked storage keeps a usable temporary library, and malformed saved versions cannot break the page', async () => {
  const {ElizaHay, ElizaLibrary} = await factory();
  const valid = snapshot => !!ElizaHay.make({snapshot});
  const blocked = {getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
  const library = ElizaLibrary.create(blocked, valid);
  library.save({name:'Temporary', snapshot:ElizaHay.make({...options, blank:true}).snapshot()});
  assert.equal(library.list().length, 1);
  assert.equal(library.isPersistent(), false);
  const bad = ElizaLibrary.create({getItem:() => '[{"id":"bad","name":"Broken","snapshot":{"schemaVersion":1}}]'}, valid);
  assert.equal(bad.list().length, 0);
  assert.throws(() => ElizaHay.make({snapshot:{schemaVersion:1}}), /could not be read/);
});
