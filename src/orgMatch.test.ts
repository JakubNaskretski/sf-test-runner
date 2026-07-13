import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameOrg } from './orgMatch';

test('sameOrg: identical usernames match', () => {
  assert.equal(sameOrg('alice@example.com', 'alice@example.com'), true);
});

test('sameOrg: case-insensitive (the CLI treats usernames case-insensitively)', () => {
  assert.equal(sameOrg('Alice@Example.com', 'alice@example.com'), true);
});

test('sameOrg: different usernames do not match', () => {
  assert.equal(sameOrg('alice@example.com', 'bob@example.com'), false);
});

test('sameOrg: a since-cleared org (undefined current) never matches', () => {
  // The guard use: captured run/coverage org vs a current org that was cleared.
  assert.equal(sameOrg('alice@example.com', undefined), false);
});

test('sameOrg: an undefined captured org never matches', () => {
  assert.equal(sameOrg(undefined, 'alice@example.com'), false);
});

test('sameOrg: both undefined is not a match', () => {
  assert.equal(sameOrg(undefined, undefined), false);
});

test('sameOrg: an empty username is treated as no org', () => {
  assert.equal(sameOrg('', 'alice@example.com'), false);
  assert.equal(sameOrg('alice@example.com', ''), false);
});
