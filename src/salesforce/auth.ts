import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as jsforce from 'jsforce';
import { OrgInfo } from '../types';

const execAsync = promisify(exec);

interface SfOrgDisplay {
  status: number;
  result?: {
    accessToken: string;
    instanceUrl: string;
    username: string;
    alias?: string;
    apiVersion?: string;
  };
  message?: string;
  name?: string;
}

export class AuthError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function getOrgInfo(targetOrg?: string): Promise<OrgInfo> {
  const orgFlag = targetOrg ? `--target-org ${shellEscape(targetOrg)}` : '';
  const cmd = `sf org display ${orgFlag} --json --verbose`;

  let stdout: string;
  try {
    const result = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (err: any) {
    const out = err?.stdout ?? '';
    if (out) {
      try {
        const parsed = JSON.parse(out) as SfOrgDisplay;
        throw new AuthError(
          parsed.message ?? 'Failed to read org info from sf CLI',
          'Run `sf org login web` or set sfTestRunner.targetOrg to a valid alias.',
        );
      } catch (parseErr) {
        if (parseErr instanceof AuthError) throw parseErr;
      }
    }
    throw new AuthError(
      `Could not run \`sf\` CLI: ${err?.message ?? err}`,
      'Ensure the Salesforce CLI is installed and on PATH.',
    );
  }

  const parsed = JSON.parse(stdout) as SfOrgDisplay;
  if (parsed.status !== 0 || !parsed.result) {
    throw new AuthError(parsed.message ?? 'sf org display returned a non-zero status');
  }

  const config = vscode.workspace.getConfiguration('sfTestRunner');
  const apiVersion =
    parsed.result.apiVersion ?? (config.get<string>('apiVersion') || '60.0');

  return {
    accessToken: parsed.result.accessToken,
    instanceUrl: parsed.result.instanceUrl,
    username: parsed.result.username,
    alias: parsed.result.alias,
    apiVersion,
  };
}

export function createConnection(org: OrgInfo): jsforce.Connection {
  return new jsforce.Connection({
    instanceUrl: org.instanceUrl,
    accessToken: org.accessToken,
    version: org.apiVersion,
  });
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
