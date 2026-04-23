import { getOktaClient } from '../../okta/client.js';
import { collectAll } from './pagination.js';
import type { User, Group } from '@okta/okta-sdk-nodejs';

const USER_ID_RE = /^00u[a-zA-Z0-9]+$/;
const GROUP_ID_RE = /^00g[a-zA-Z0-9]+$/;

export async function resolveUser(identifier: string): Promise<User> {
  const client = getOktaClient();
  if (USER_ID_RE.test(identifier)) {
    return client.userApi.getUser({ userId: identifier });
  }
  // email or login - use search
  const collection = await client.userApi.listUsers({ search: `profile.email eq "${identifier}" or profile.login eq "${identifier}"` });
  const users = await collectAll<User>(collection, 5);
  if (users.length === 0) {
    const err = new Error(`User not found: ${identifier}`) as Error & { status: number };
    err.status = 404;
    throw err;
  }
  return users[0];
}

export async function resolveGroup(identifier: string): Promise<Group> {
  const client = getOktaClient();
  if (GROUP_ID_RE.test(identifier)) {
    return client.groupApi.getGroup({ groupId: identifier });
  }
  // name search
  const collection = await client.groupApi.listGroups({ q: identifier });
  const groups = await collectAll<Group>(collection, 10);
  const exact = groups.find(g => g.profile?.name === identifier);
  if (exact) return exact;
  if (groups.length > 0) return groups[0];
  const err = new Error(`Group not found: ${identifier}`) as Error & { status: number };
  err.status = 404;
  throw err;
}
