import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStackLine, parseStackTrace, primaryFrame } from './stackParser';

test('parses a Class.method frame with line + column', () => {
  const f = parseStackLine('Class.MyTest.testThing: line 42, column 1');
  assert.deepEqual(f, { className: 'MyTest', method: 'testThing', line: 42, isTrigger: false });
});

test('parses a Class.method frame without column', () => {
  const f = parseStackLine('Class.Foo.bar: line 7');
  assert.deepEqual(f, { className: 'Foo', method: 'bar', line: 7, isTrigger: false });
});

test('parses a namespaced qualified name (class = 2nd-to-last, method = last)', () => {
  const f = parseStackLine('Class.MyNs.Helper.run: line 3, column 5');
  assert.deepEqual(f, { className: 'Helper', method: 'run', line: 3, isTrigger: false });
});

test('parses a bare Class.Name frame (no method)', () => {
  const f = parseStackLine('Class.Foo: line 12');
  assert.deepEqual(f, { className: 'Foo', line: 12, isTrigger: false });
});

test('parses a Trigger frame', () => {
  const f = parseStackLine('Trigger.AccountTrigger: line 9, column 1');
  assert.deepEqual(f, { className: 'AccountTrigger', line: 9, isTrigger: true });
});

test('leading whitespace is tolerated', () => {
  const f = parseStackLine('   Class.A.b: line 1');
  assert.ok(f);
  assert.equal(f!.className, 'A');
});

test('returns null for non-frame lines', () => {
  assert.equal(parseStackLine('System.AssertException: Assertion Failed'), null);
  assert.equal(parseStackLine(''), null);
  assert.equal(parseStackLine('just some text'), null);
});

test('parseStackTrace returns frames in order, skipping noise', () => {
  const stack = [
    'System.AssertException: Assertion Failed: expected X',
    'Class.MyTest.testThing: line 42, column 1',
    'Class.MyTest.helper: line 30, column 3',
  ].join('\n');
  const frames = parseStackTrace(stack);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].line, 42);
  assert.equal(frames[1].line, 30);
});

test('parseStackTrace handles null/undefined', () => {
  assert.deepEqual(parseStackTrace(null), []);
  assert.deepEqual(parseStackTrace(undefined), []);
});

test('primaryFrame prefers the preferred class frame', () => {
  const stack = [
    'Class.Helper.doWork: line 5, column 1',
    'Class.MyTest.testThing: line 42, column 1',
  ].join('\n');
  const f = primaryFrame(stack, 'MyTest');
  assert.equal(f!.className, 'MyTest');
  assert.equal(f!.line, 42);
});

test('primaryFrame falls back to the first frame when class not present', () => {
  const stack = 'Class.Helper.doWork: line 5, column 1';
  const f = primaryFrame(stack, 'MyTest');
  assert.equal(f!.className, 'Helper');
});

test('primaryFrame returns null for an unparseable stack', () => {
  assert.equal(primaryFrame('no frames here', 'X'), null);
  assert.equal(primaryFrame(null), null);
});
