import { strict as assert } from 'node:assert';
import test from 'node:test';
import childProcess = require('child_process');
import { resolveSfCommand, SfCliService } from './kit/sfCli';

// Every child process the kit starts must pass windowsHide: without it the
// extension host (no console of its own) opens a console window on Windows for
// each sf call. Patched on the module object, which the compiled kit reads at
// call time.
const cp = childProcess as unknown as Record<string, unknown>;

function capture(name: 'spawn' | 'execFileSync', run: () => unknown): Record<string, unknown> {
  const original = cp[name];
  let options: Record<string, unknown> | undefined;
  cp[name] = (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
    options = opts;
    throw new Error('stubbed');
  };
  try {
    run();
  } catch {
    /* the stub's throw */
  } finally {
    cp[name] = original;
  }
  assert.ok(options, `${name} was not called`);
  return options;
}

test('sf is spawned with windowsHide', async () => {
  let pending: Promise<unknown> | undefined;
  const options = capture('spawn', () => {
    pending = new SfCliService().runCancellable(['--version']).promise;
  });
  await pending?.catch(() => undefined);
  assert.equal(options.windowsHide, true);
});

test('the `where sf` lookup runs with windowsHide', () => {
  const options = capture('execFileSync', () => resolveSfCommand('win32', { PATH: '' }, () => false));
  assert.equal(options.windowsHide, true);
});
