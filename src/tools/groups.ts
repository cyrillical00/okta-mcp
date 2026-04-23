import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getOktaClient } from '../okta/client.js';
import { safeOktaCall } from '../okta/errors.js';
import { collectPage } from './_shared/pagination.js';
import { resolveGroup, resolveUser } from './_shared/resolve.js';
import { okResult, errResult } from './_shared/responses.js';
import { confirmOrAbort } from './_shared/elicitation.js';
import { auditLog } from '../audit/logger.js';
import { getConfig } from '../config.js';
import { PaginationInput, SearchMode } from './_shared/schemas.js';
import type { Group } from '@okta/okta-sdk-nodejs';

function groupSummary(g: Group) {
  return {
    id: g.id,
    name: g.profile?.name,
    description: g.profile?.description,
    type: g.type,
    created: g.created,
    lastMembershipUpdated: g.lastMembershipUpdated,
  };
}

export function register(server: McpServer): void {
  // ---- okta_list_groups ----
  server.registerTool('okta_list_groups', {
    title: 'List Okta Groups',
    description: 'List Okta groups with optional filtering. Supports search, filter, or starts-with query modes. Returns paginated group summaries.',
    inputSchema: z.object({
      filter: z.string().optional(),
      mode: SearchMode,
      ...PaginationInput.shape,
    }),
  }, async ({ filter, mode, limit, cursor }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const searchParam = filter
        ? (mode === 'search' ? { search: filter } : mode === 'filter' ? { filter } : { q: filter })
        : {};
      const collection = await client.groupApi.listGroups({ ...searchParam, limit: Math.min(limit, 200) });
      return collectPage<Group>(collection, limit, cursor);
    });
    const success = result.ok;
    auditLog({ tool: 'okta_list_groups', durationMs: Date.now() - start, success, input: { filter, mode, limit }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    if (!result.ok) return errResult(result.error);
    return okResult({ items: result.data.items.map(groupSummary), nextCursor: result.data.nextCursor });
  });

  // ---- okta_get_group ----
  server.registerTool('okta_get_group', {
    title: 'Get Okta Group',
    description: 'Fetch a single Okta group by ID or exact name. Returns full group detail including profile and metadata.',
    inputSchema: z.object({ groupIdOrName: z.string().min(1) }),
  }, async ({ groupIdOrName }) => {
    const start = Date.now();
    const result = await safeOktaCall(() => resolveGroup(groupIdOrName));
    const success = result.ok;
    auditLog({ tool: 'okta_get_group', durationMs: Date.now() - start, success, input: { groupIdOrName }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(groupSummary(result.data)) : errResult(result.error);
  });

  // ---- okta_add_user_to_group (write) ----
  server.registerTool('okta_add_user_to_group', {
    title: 'Add User to Okta Group',
    description: 'Add an Okta user to a group. Accepts user and group by ID or name. Requires confirmation.',
    inputSchema: z.object({
      userId: z.string().min(1),
      groupIdOrName: z.string().min(1),
      _confirmed: z.boolean().optional(),
    }),
  }, async ({ userId, groupIdOrName, _confirmed }) => {
    const start = Date.now();
    const [userResult, groupResult] = await Promise.all([
      resolveUser(userId).catch(() => null),
      resolveGroup(groupIdOrName).catch(() => null),
    ]);
    const userLabel = userResult?.profile?.login ?? userId;
    const groupLabel = groupResult?.profile?.name ?? groupIdOrName;

    const denied = await confirmOrAbort({ message: `Add ${userLabel} to group "${groupLabel}"? This grants all access the group provides.`, confirmed: _confirmed });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const user = userResult ?? await resolveUser(userId);
      const group = groupResult ?? await resolveGroup(groupIdOrName);
      await getOktaClient().groupApi.assignUserToGroup({ groupId: group.id!, userId: user.id! });
      return { userId: user.id, groupId: group.id, groupName: group.profile?.name };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_add_user_to_group', durationMs: Date.now() - start, success, input: { userId, groupIdOrName }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_remove_user_from_group (write) ----
  server.registerTool('okta_remove_user_from_group', {
    title: 'Remove User from Okta Group',
    description: 'Remove an Okta user from a group. Accepts user and group by ID or name. Requires confirmation.',
    inputSchema: z.object({
      userId: z.string().min(1),
      groupIdOrName: z.string().min(1),
      _confirmed: z.boolean().optional(),
    }),
  }, async ({ userId, groupIdOrName, _confirmed }) => {
    const start = Date.now();
    const [userResult, groupResult] = await Promise.all([
      resolveUser(userId).catch(() => null),
      resolveGroup(groupIdOrName).catch(() => null),
    ]);
    const userLabel = userResult?.profile?.login ?? userId;
    const groupLabel = groupResult?.profile?.name ?? groupIdOrName;

    const denied = await confirmOrAbort({ message: `Remove ${userLabel} from group "${groupLabel}"? This revokes all access the group provides.`, confirmed: _confirmed });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const user = userResult ?? await resolveUser(userId);
      const group = groupResult ?? await resolveGroup(groupIdOrName);
      await getOktaClient().groupApi.unassignUserFromGroup({ groupId: group.id!, userId: user.id! });
      return { userId: user.id, groupId: group.id, groupName: group.profile?.name };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_remove_user_from_group', durationMs: Date.now() - start, success, input: { userId, groupIdOrName }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });
}
