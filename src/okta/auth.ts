import { readFileSync } from 'node:fs';
import { getConfig } from '../config.js';
import { getOktaClient } from './client.js';
import logger from '../logger.js';

type OrgState = {
  orgId: string;
  pipeline: string;
  roles: string[];
};

let _orgState: OrgState | null = null;

export function getOrgState(): OrgState {
  if (!_orgState) throw new Error('Auth probe has not run yet');
  return _orgState;
}

function validatePrivateKey(path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw Object.assign(new Error(`Cannot read private key at ${path}`), { code: 'KEY_INVALID' });
  }
  const key = parsed as Record<string, unknown>;
  if (!key.kty || !key.kid) {
    throw Object.assign(
      new Error('Private key JSON is missing required fields: kty and/or kid'),
      { code: 'KEY_INVALID' }
    );
  }
}

export async function runStartupProbe(): Promise<void> {
  const config = getConfig();

  validatePrivateKey(config.okta.privateKeyPath);

  const client = getOktaClient();

  // Trigger the token exchange by making a real API call with a granted scope.
  // Using listUsers with limit=1 since okta.users.read is always in our scope list.
  try {
    const collection = await client.userApi.listUsers({ limit: 1 });
    await collection.next();
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    const msg = err instanceof Error ? err.message : String(err);
    const diagnostic = {
      code: status === 403 ? 'FORBIDDEN_ROLE' : 'OAUTH_FAILED',
      message: msg,
      hint: status === 403
        ? 'Token was issued but API returned 403. Make sure the service app has an admin role assigned in Security > Administrators.'
        : 'Verify OKTA_DOMAIN, OKTA_CLIENT_ID, and OKTA_PRIVATE_KEY_PATH. Make sure the private key matches the public key registered on the service app.',
    };
    process.stderr.write(JSON.stringify(diagnostic) + '\n');
    process.exit(1);
  }

  // Check admin role assignment via IAM API.
  let roles: string[] = [];
  try {
    const res = await (client.roleAssignmentApi as unknown as {
      listRolesForClient: (opts: { clientId: string }) => Promise<AsyncIterator<{ type?: string; label?: string }>>;
    }).listRolesForClient({ clientId: config.okta.clientId });
    const page = await res.next();
    const roleObj = page.value as { type?: string; label?: string } | undefined;
    if (roleObj) roles.push(roleObj.type ?? roleObj.label ?? 'assigned');
  } catch {
    logger.warn('Could not verify admin role assignment; continuing');
  }

  _orgState = { orgId: config.okta.clientId, pipeline: 'v2', roles };

  logger.info({ event: 'auth_ok', orgId: config.okta.clientId, roles }, 'Okta auth probe passed');
}
