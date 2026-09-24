import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { debugLines, debugLogDocument, planTraceFlag } from './debugLogs';

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const TTL = 10 * 60 * 1000;

test('planTraceFlag creates when the user has no USER_DEBUG flag', () => {
  assert.deepEqual(planTraceFlag([], NOW, TTL), { action: 'create' });
});

const DEBUG = { ApexCode: 'DEBUG' };

test('planTraceFlag extends an expired flag instead of creating a second one', () => {
  const rows = [{ Id: '7tf000000000001', ExpirationDate: '2025-07-29T22:29:00.000+0000', DebugLevel: DEBUG }];
  assert.deepEqual(planTraceFlag(rows, NOW, TTL), { action: 'extend', id: '7tf000000000001', relevel: false });
});

test('planTraceFlag asks to repoint a flag whose level would swallow System.debug', () => {
  const later = new Date(NOW + TTL * 2).toISOString();
  const low = [{ Id: '7tf000000000001', ExpirationDate: later, DebugLevel: { ApexCode: 'INFO' } }];
  assert.deepEqual(planTraceFlag(low, NOW, TTL), { action: 'keep', id: '7tf000000000001', relevel: true });
  const none = [{ Id: '7tf000000000001', ExpirationDate: later, DebugLevel: null }];
  assert.deepEqual(planTraceFlag(none, NOW, TTL), { action: 'keep', id: '7tf000000000001', relevel: true });
  const finest = [{ Id: '7tf000000000001', ExpirationDate: later, DebugLevel: { ApexCode: 'FINEST' } }];
  assert.deepEqual(planTraceFlag(finest, NOW, TTL), { action: 'keep', id: '7tf000000000001', relevel: false });
});

test('planTraceFlag extends a flag that would expire before the run ceiling', () => {
  const soon = new Date(NOW + TTL / 4).toISOString();
  const rows = [{ Id: '7tf000000000001', ExpirationDate: soon, DebugLevel: DEBUG }];
  assert.equal(planTraceFlag(rows, NOW, TTL).action, 'extend');
});

test('planTraceFlag keeps a flag it extended a moment ago (the margin is slack)', () => {
  const justSet = new Date(NOW + TTL - 5_000).toISOString();
  const rows = [{ Id: '7tf000000000001', ExpirationDate: justSet, DebugLevel: DEBUG }];
  assert.equal(planTraceFlag(rows, NOW, TTL).action, 'keep');
});

test('planTraceFlag keeps a flag that outlives the run', () => {
  const later = new Date(NOW + TTL * 2).toISOString();
  const rows = [{ Id: '7tf000000000001', ExpirationDate: later, DebugLevel: DEBUG }];
  assert.deepEqual(planTraceFlag(rows, NOW, TTL), { action: 'keep', id: '7tf000000000001', relevel: false });
});

const RAW = [
  '67.0 APEX_CODE,DEBUG;APEX_PROFILING,NONE',
  '12:10:59.9 (9923860)|CODE_UNIT_STARTED|[EXTERNAL]|01p000000000001|AcmeTest.testAdd()',
  '12:10:59.9 (10930020)|USER_DEBUG|[5]|DEBUG|probe: adding 2 and 3',
  '12:10:59.9 (11197862)|USER_DEBUG|[6]|WARN|probe: a | b',
  '12:10:59.9 (11197900)|EXCEPTION_THROWN|[9]|System.AssertException: Assertion Failed',
  '12:10:59.16 (16968625)|CODE_UNIT_FINISHED|AcmeTest.testAdd()',
].join('\n');

test('debugLines keeps System.debug and exception lines only, with line and level', () => {
  assert.deepEqual(debugLines(RAW), [
    '[5] DEBUG probe: adding 2 and 3',
    '[6] WARN probe: a | b',
    '[9] System.AssertException: Assertion Failed',
  ]);
});

test('debugLogDocument leads with the debug output and ends with the full log', () => {
  const doc = debugLogDocument('AcmeTest.testAdd', RAW);
  const lines = doc.split('\n');
  assert.equal(lines[0], 'AcmeTest.testAdd');
  assert.equal(lines[3], '[5] DEBUG probe: adding 2 and 3');
  assert.ok(doc.endsWith(RAW));
});

test('debugLogDocument says so when the test printed nothing', () => {
  const quiet = RAW.split('\n').filter((l) => !l.includes('USER_DEBUG') && !l.includes('EXCEPTION')).join('\n');
  assert.ok(debugLogDocument('AcmeTest.testAdd', quiet).includes('(no System.debug output in this test)'));
});
