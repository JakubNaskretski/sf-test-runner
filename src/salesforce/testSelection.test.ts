import { strict as assert } from 'node:assert';
import test from 'node:test';
import { SelectableTest, selectorsFor } from './testSelection';

function cls(id: string, methods: string[] = []): SelectableTest[] {
  const parent: SelectableTest = { id };
  return [parent, ...methods.map((m) => ({ id: `${id}.${m}`, parent }))];
}

test('a fully selected class collapses to the class selector', () => {
  assert.deepEqual(selectorsFor(cls('AccountServiceTest', ['testOne', 'testTwo'])), [
    'AccountServiceTest',
  ]);
});

test('methods selected without their class stay individual', () => {
  const [parent, one, two] = cls('AccountServiceTest', ['testOne', 'testTwo']);
  void parent;
  assert.deepEqual(selectorsFor([one, two]), [
    'AccountServiceTest.testOne',
    'AccountServiceTest.testTwo',
  ]);
});

test('a class selected alongside one of its methods still runs once', () => {
  const [parent, one] = cls('AccountServiceTest', ['testOne']);
  assert.deepEqual(selectorsFor([parent, one]), ['AccountServiceTest']);
});

test('several classes each contribute one selector', () => {
  const a = cls('AccountServiceTest', ['testOne']);
  const b = cls('ContactServiceTest', ['testTwo']);
  assert.deepEqual(selectorsFor([...a, ...b]), ['AccountServiceTest', 'ContactServiceTest']);
});

test('duplicates are collapsed', () => {
  const [parent] = cls('AccountServiceTest');
  assert.deepEqual(selectorsFor([parent, parent]), ['AccountServiceTest']);
});

test('nothing selected means nothing to run', () => {
  assert.deepEqual(selectorsFor([]), []);
});
