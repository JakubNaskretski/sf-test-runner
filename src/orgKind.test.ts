import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type { OrgInfo } from './kit/sfCli';

// The classification helpers are pure, but kit/orgs.ts imports `vscode` at
// module load for its setting/UI helpers — stub the module so the import
// resolves outside the extension host. The test sits here rather than beside
// kit/orgs.ts because sync-kit.mjs prunes every .ts under src/kit/ that the kit
// itself doesn't provide.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]): unknown {
  return request === 'vscode' ? {} : realLoad.call(this, request, ...rest);
};

let orgs: typeof import('./kit/orgs');
before(async () => {
  orgs = await import('./kit/orgs');
});

const org = (o: Partial<OrgInfo>): OrgInfo => ({
  username: 'u@example.com',
  instanceUrl: 'https://acme.my.salesforce.com',
  ...o,
});

test('a Developer Edition org is dev, not prod', () => {
  const dev = org({ orgEdition: 'Developer Edition' });
  assert.equal(orgs.kindOf(dev), 'dev');
  assert.equal(orgs.orgBadge(dev), 'DEV');
  assert.equal(orgs.isLikelyProduction(dev), false);
});

test('edition matching is case-insensitive', () => {
  assert.equal(orgs.kindOf(org({ orgEdition: 'developer edition' })), 'dev');
});

test('scratch/sandbox flags win over the edition', () => {
  assert.equal(orgs.kindOf(org({ orgEdition: 'Developer Edition', isScratch: true })), 'scratch');
  assert.equal(orgs.kindOf(org({ orgEdition: 'Developer Edition', isSandbox: true })), 'sandbox');
});

test('a sandbox URL wins over the edition', () => {
  const sbx = org({
    orgEdition: 'Developer Edition',
    instanceUrl: 'https://acme--dev.sandbox.my.salesforce.com',
  });
  assert.equal(orgs.kindOf(sbx), 'sandbox');
});

test('another edition (or none) still defaults to production', () => {
  const ent = org({ orgEdition: 'Enterprise Edition' });
  assert.equal(orgs.kindOf(ent), 'prod');
  assert.equal(orgs.orgBadge(ent), 'PROD');
  assert.equal(orgs.isLikelyProduction(ent), true);
  assert.equal(orgs.kindOf(org({})), 'prod');
});

test('an undefined org still maps to production (over-warn preserved)', () => {
  assert.equal(orgs.kindOf(undefined), 'unknown');
  assert.equal(orgs.orgBadge(undefined), 'ORG');
  assert.equal(orgs.isLikelyProduction(undefined), true);
});
