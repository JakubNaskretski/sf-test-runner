import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { SfCliError } from '../kit/sfCli';

// The service imports `vscode` for its command-log emitter and settings; the
// coverage-envelope logic under test touches neither, so a minimal stub is
// enough to load the module outside the extension host.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]): unknown {
  if (request !== 'vscode') return realLoad.call(this, request, ...rest);
  return {
    EventEmitter: class {
      event = (): void => {};
      fire = (): void => {};
      dispose = (): void => {};
    },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  };
};

let mod: typeof import('./sfCliService');
let kitOrgs: typeof import('../kit/orgs');
before(async () => {
  mod = await import('./sfCliService');
  kitOrgs = await import('../kit/orgs');
});

/** A service whose kit call returns `envelope` instead of spawning `sf`. */
function withEnvelope(envelope: unknown): InstanceType<typeof mod.SfCliService> {
  const svc = new mod.SfCliService({ appendLine: () => {} } as any);
  (svc as any).kit = { runJson: async (): Promise<unknown> => envelope };
  return svc;
}

test('getCoverageForClass maps a coverage row', async () => {
  const info = await withEnvelope({
    status: 0,
    result: {
      records: [
        {
          ApexClassOrTrigger: { Name: 'AccountService' },
          NumLinesCovered: 3,
          NumLinesUncovered: 1,
          Coverage: { coveredLines: [1, 2, 3], uncoveredLines: [4] },
        },
      ],
    },
  }).getCoverageForClass('AccountService', 'u@example.com');
  assert.equal(info?.className, 'AccountService');
  assert.equal(info?.numLinesCovered, 3);
  assert.deepEqual(info?.uncoveredLines, [4]);
});

test('getCoverageForClass returns null only for a genuinely empty record set', async () => {
  const info = await withEnvelope({ status: 0, result: { records: [] } }).getCoverageForClass(
    'AccountService',
    'u@example.com',
  );
  assert.equal(info, null);
});

test('getCoverageForClass throws the CLI envelope error instead of returning null', async () => {
  const err = await withEnvelope({
    status: 1,
    name: 'RefreshTokenAuthError',
    message: 'expired access/refresh token',
  })
    .getCoverageForClass('AccountService', 'u@example.com')
    .then(() => null, (e: unknown) => e as SfCliError);
  assert.ok(err instanceof SfCliError);
  assert.equal(err!.message, 'RefreshTokenAuthError: expired access/refresh token');
  assert.equal(err!.errorName, 'RefreshTokenAuthError');
});

test('listOrgs keeps the fields the org badge classifies on', async () => {
  const svc = new mod.SfCliService({ appendLine: () => {} } as any);
  (svc as any).kit = {
    listOrgs: async (): Promise<unknown[]> => [
      {
        username: 'dev@example.com',
        alias: 'DevOrg',
        instanceUrl: 'https://dev.my.salesforce.com',
        orgEdition: 'Developer Edition',
      },
    ],
  };
  const [org] = await svc.listOrgs();
  assert.equal(org.orgEdition, 'Developer Edition');
  assert.equal(kitOrgs.orgBadge(org), 'DEV');
  assert.equal(kitOrgs.isLikelyProduction(org), false);
});

test('getCoverageForClass throws when the query result carries no records array', async () => {
  await assert.rejects(
    () => withEnvelope({ status: 0, result: {} }).getCoverageForClass('X', 'u@example.com'),
    /returned no result/,
  );
});

test('listRecentTestRuns throws the CLI envelope error instead of returning []', async () => {
  await assert.rejects(
    withEnvelope({ status: 1, name: 'RefreshTokenAuthError', message: 'expired access/refresh token' })
      .listRecentTestRuns('u@example.com'),
    (err: unknown) => {
      assert.ok(err instanceof SfCliError);
      assert.match((err as Error).message, /expired access\/refresh token/);
      return true;
    },
  );
});
