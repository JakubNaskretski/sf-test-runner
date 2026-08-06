import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SfCliError, SfCliService } from './kit/sfCli';

// Kit tests live here rather than beside kit/sfCli.ts: sync-kit.mjs prunes every
// .ts under src/kit/ that the kit itself doesn't provide.

/** A kit service whose `runJson` returns `envelope` instead of spawning `sf`. */
function withEnvelope(envelope: unknown): SfCliService {
  const svc = new SfCliService();
  (svc as any).runJson = async (): Promise<unknown> => envelope;
  return svc;
}

test('listOrgs merges the buckets, tagging scratch/sandbox and keeping the edition', async () => {
  const orgs = await withEnvelope({
    status: 0,
    result: {
      nonScratchOrgs: [{ username: 'a@example.com', orgEdition: 'Developer Edition' }],
      scratchOrgs: [{ username: 'b@example.com' }],
      sandboxes: [{ username: 'c@example.com' }],
    },
  }).listOrgs();
  assert.deepEqual(
    orgs.map((o) => o.username),
    ['a@example.com', 'b@example.com', 'c@example.com'],
  );
  assert.equal(orgs[0].orgEdition, 'Developer Edition');
  assert.equal(orgs[1].isScratch, true);
  assert.equal(orgs[2].isSandbox, true);
});

test('listOrgs returns [] for a present-but-empty result', async () => {
  assert.deepEqual(await withEnvelope({ status: 0, result: {} }).listOrgs(), []);
  assert.deepEqual(await withEnvelope({ status: 0, result: { nonScratchOrgs: [] } }).listOrgs(), []);
});

test('listOrgs throws the CLI envelope error instead of reporting no orgs', async () => {
  const err = await withEnvelope({
    status: 1,
    name: 'NamedOrgNotFound',
    message: 'No authorization information found',
    actions: ['Run `sf org login web`', '   '],
  })
    .listOrgs()
    .then(() => null, (e: unknown) => e as SfCliError);
  assert.ok(err instanceof SfCliError);
  assert.equal(err!.message, 'NamedOrgNotFound: No authorization information found');
  assert.equal(err!.errorName, 'NamedOrgNotFound');
  assert.deepEqual(err!.actions, ['Run `sf org login web`']);
});

test('listOrgs throws on a non-zero status even when a result is present', async () => {
  await assert.rejects(
    () => withEnvelope({ status: 68, result: { nonScratchOrgs: [] } }).listOrgs(),
    /returned no result \(status 68\)/,
  );
});
