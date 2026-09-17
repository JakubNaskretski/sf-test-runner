import { strict as assert } from 'node:assert';
import test from 'node:test';
import { firstErrorLine } from './kit/sfCli';

// Verbatim stderr from `sf apex run test --tests NoSuchProbeClassXyz` against a
// live org (sf 2.137.7): the CLI writes nothing to stdout, an update notice
// comes first, and the reason the run failed is the second line.
const LIVE_STDERR =
  ' ›   Warning: @salesforce/cli update available from 2.137.7 to 2.150.6.\n' +
  "Error (INVALID_INPUT): This class name's value is invalid: NoSuchProbeClassXyz. " +
  'Provide the name of an Apex class that has test methods.\n\n';

test('the CLI update notice is skipped in favour of the real error', () => {
  assert.equal(
    firstErrorLine(LIVE_STDERR),
    "INVALID_INPUT: This class name's value is invalid: NoSuchProbeClassXyz. " +
      'Provide the name of an Apex class that has test methods.',
  );
});

test('an unprefixed error line survives intact', () => {
  assert.equal(firstErrorLine('something broke\n'), 'something broke');
});

test('colour escapes are stripped', () => {
  assert.equal(firstErrorLine('[31mError: boom[0m'), 'boom');
});

test('nothing usable yields null, so the caller keeps its own wording', () => {
  assert.equal(firstErrorLine('   \n\n'), null);
  assert.equal(firstErrorLine(undefined), null);
});
