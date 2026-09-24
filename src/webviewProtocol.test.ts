/**
 * The webview trust boundary, guarded from the Node side.
 *
 * A provider validates untrusted view input by looking the message up in one of
 * the shape tables and handing the shape to the kit's `validateMessage`. A union
 * member with no row therefore has NO validation at all — it is dropped, which
 * is safe, but silently, which is how a message stops working. The `Record<
 * Union['type'], MessageShape>` annotations already make that a compile error;
 * these tables restate the membership independently, so the two have to agree at
 * runtime as well and neither can be widened alone.
 *
 * `validateMessage` itself is NOT exercised here: it lives in kit/webviewHtml,
 * which imports `vscode` and `crypto` and so cannot be loaded by `node --test`.
 * What is checked instead is that the tables stay in the vocabulary that
 * function understands.
 *
 * This file sits at the src root rather than next to protocol.ts because
 * src/webview is a browser-only program (DOM lib, no @types/node) and is
 * excluded from the test compile; protocol.ts itself is DOM-free and comes along
 * through the import.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  COVERAGE_MESSAGE_SHAPES,
  RESULTS_MESSAGE_SHAPES,
  TESTS_MESSAGE_SHAPES,
  isResultsFilter,
  isRunScope,
} from './webview/protocol';
import type {
  CoverageViewMessage,
  MessageShape,
  ResultsViewMessage,
  TestsViewMessage,
} from './webview/protocol';

/** Every `type` the view side may send, restated. Annotated so a union member
 *  added without a row here fails to compile, and a row for a type the union
 *  does not have fails too. */
const TESTS_TYPES: Record<TestsViewMessage['type'], true> = {
  'tests:toggleMethod': true,
  'tests:setClass': true,
  'tests:clearSelection': true,
  'tests:run': true,
  'tests:cancel': true,
  'tests:rescan': true,
  'tests:fetchOrg': true,
  'tests:selectOrg': true,
  'tests:refreshOrgs': true,
  'tests:login': true,
  'tests:activeFile': true,
  'tests:open': true,
  'tests:setRunWithCoverage': true,
  'tests:setRunWithLogs': true,
  'tests:ready': true,
};

const RESULTS_TYPES: Record<ResultsViewMessage['type'], true> = {
  'results:open': true,
  'results:setFilter': true,
  'results:rerunFailed': true,
  'results:copySummary': true,
  'results:showLog': true,
  'results:loadRecent': true,
  'results:ready': true,
};

const COVERAGE_TYPES: Record<CoverageViewMessage['type'], true> = {
  'coverage:open': true,
  'coverage:setPaint': true,
  'coverage:clear': true,
  'coverage:fromOrg': true,
  'coverage:ready': true,
};

/** The field vocabulary `validateMessage` understands, `?` marking optional. */
const FIELD_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'string?',
  'number?',
  'boolean?',
  'object?',
  'array?',
]);

const TABLES: [string, Record<string, MessageShape>, Record<string, true>][] = [
  ['tests', TESTS_MESSAGE_SHAPES, TESTS_TYPES],
  ['results', RESULTS_MESSAGE_SHAPES, RESULTS_TYPES],
  ['coverage', COVERAGE_MESSAGE_SHAPES, COVERAGE_TYPES],
];

test('every view message type has exactly one validation shape', () => {
  for (const [view, shapes, types] of TABLES) {
    assert.deepEqual(
      Object.keys(shapes).sort(),
      Object.keys(types).sort(),
      `${view}: the shape table and the message union disagree`,
    );
  }
});

test('every shape validates the discriminator and uses only known field types', () => {
  for (const [view, shapes] of TABLES) {
    for (const [messageType, shape] of Object.entries(shapes)) {
      // Without this the discriminator the provider switched on is unchecked.
      assert.equal(shape.type, 'string', `${view}/${messageType}: type must be validated`);
      for (const [field, fieldType] of Object.entries(shape)) {
        assert.ok(
          FIELD_TYPES.has(fieldType),
          `${view}/${messageType}.${field}: unknown field type ${fieldType}`,
        );
      }
    }
  }
});

test('shape tables are keyed by their own view prefix', () => {
  for (const [view, shapes] of TABLES) {
    for (const messageType of Object.keys(shapes)) {
      assert.ok(messageType.startsWith(`${view}:`), `${messageType} is not a ${view} message`);
    }
  }
});

test('isRunScope accepts the three scopes and nothing else', () => {
  for (const scope of ['selected', 'allLocal', 'allInOrg']) assert.ok(isRunScope(scope));
  for (const junk of [
    'allLocal ',
    'ALLLOCAL',
    '',
    'runAllTestsInOrg',
    '__proto__',
    'constructor',
    0,
    1,
    null,
    undefined,
    true,
    {},
    [],
    ['allLocal'],
    { toString: () => 'allLocal' },
  ]) {
    assert.equal(isRunScope(junk), false, `isRunScope accepted ${JSON.stringify(junk)}`);
  }
});

test('isResultsFilter accepts the two filters and nothing else', () => {
  for (const filter of ['all', 'failed']) assert.ok(isResultsFilter(filter));
  for (const junk of ['All', 'passed', '', '__proto__', 0, null, undefined, true, {}, ['all']]) {
    assert.equal(isResultsFilter(junk), false, `isResultsFilter accepted ${JSON.stringify(junk)}`);
  }
});
