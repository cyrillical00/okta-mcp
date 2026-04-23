import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getOktaClient } from '../okta/client.js';
import { safeOktaCall } from '../okta/errors.js';
import { collectPage, collectAll } from './_shared/pagination.js';
import { resolveUser } from './_shared/resolve.js';
import { okResult, errResult } from './_shared/responses.js';
import { confirmOrAbort } from './_shared/elicitation.js';
import { auditLog } from '../audit/logger.js';
import { getConfig } from '../config.js';
import { AppId, PaginationInput } from './_shared/schemas.js';
import type { Application, AppUser } from '@okta/okta-sdk-nodejs';

function appSummary(a: Application) {
  return {
    id: a.id,
    label: a.label,
    name: (a as unknown as Record<string, unknown>).name,
    status: a.status,
    signOnMode: a.signOnMode,
    created: a.created,
    lastUpdated: a.lastUpdated,
  };
}

export function register(server: McpServer): void {
  // ---- okta_list_apps ----
  server.registerTool('okta_list_apps', {
    title: 'List Okta Applications',
    description: 'List Okta applications with optional filter and status. Returns paginated application summaries.',
    inputSchema: z.object({
      filter: z.string().optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
      ...PaginationInput.shape,
    }),
  }, async ({ filter, status, limit, cursor }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const opts: Record<string, unknown> = { limit: Math.min(limit, 200) };
      if (filter) opts.filter = filter;
      if (status) opts.filter = `status eq "${status}"${filter ? ` and (${filter})` : ''}`;
      const collection = await client.applicationApi.listApplications(opts as never);
      return collectPage<Application>(collection, limit, cursor);
    });
    const success = result.ok;
    auditLog({ tool: 'okta_list_apps', durationMs: Date.now() - start, success, input: { filter, status, limit }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    if (!result.ok) return errResult(result.error);
    return okResult({ items: result.data.items.map(appSummary), nextCursor: result.data.nextCursor });
  });

  // ---- okta_list_user_apps ----
  server.registerTool('okta_list_user_apps', {
    title: 'List Apps Assigned to User',
    description: 'List all Okta applications assigned to a specific user, including assignment type (direct or via group).',
    inputSchema: z.object({ userId: z.string().min(1) }),
  }, async ({ userId }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const user = await resolveUser(userId);
      const collection = await client.userApi.listAppLinks({ userId: user.id! });
      const links: unknown[] = [];
      for await (const link of collection) {
        if (!link) continue;
        const l = link as Record<string, unknown>;
        links.push({ id: l.id, label: l.label, appName: l.appName, status: l.appAssignmentId ? 'ACTIVE' : undefined, assignmentType: l.directAssignment ? 'direct' : 'group', lastUpdated: l.lastUpdated });
      }
      return { apps: links };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_list_user_apps', durationMs: Date.now() - start, success, input: { userId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_assign_app_to_user (write) ----
  server.registerTool('okta_assign_app_to_user', {
    title: 'Assign App to User',
    description: 'Directly assign an Okta application to a user. Optionally pass a profile for provisioning. Requires confirmation.',
    inputSchema: z.object({
      userId: z.string().min(1),
      appId: AppId,
      profile: z.record(z.unknown()).optional(),
      _confirmed: z.boolean().optional(),
    }),
  }, async ({ userId, appId, profile, _confirmed }) => {
    const start = Date.now();
    const user = await resolveUser(userId).catch(() => null);
    const userLabel = user?.profile?.login ?? userId;

    const denied = await confirmOrAbort({ message: `Assign app ${appId} to user ${userLabel}? This grants direct application access.`, confirmed: _confirmed });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const u = user ?? await resolveUser(userId);
      const appUser = await getOktaClient().applicationApi.assignUserToApplication({
        appId,
        appUser: { id: u.id!, ...(profile ? { profile } : {}) } as never,
      });
      const au = appUser as unknown as Record<string, unknown>;
      return { assignmentId: au.id, appId, appLabel: undefined, userId: u.id, profile: au.profile };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_assign_app_to_user', durationMs: Date.now() - start, success, input: { userId, appId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_remove_app_from_user (write) ----
  server.registerTool('okta_remove_app_from_user', {
    title: 'Remove App from User',
    description: 'Remove a direct application assignment from an Okta user. Group-based assignments are not affected. Requires confirmation.',
    inputSchema: z.object({
      userId: z.string().min(1),
      appId: AppId,
      _confirmed: z.boolean().optional(),
    }),
  }, async ({ userId, appId, _confirmed }) => {
    const start = Date.now();
    const user = await resolveUser(userId).catch(() => null);
    const userLabel = user?.profile?.login ?? userId;

    const denied = await confirmOrAbort({ message: `Remove app ${appId} from user ${userLabel}? Only direct assignments are affected; group-based access remains.`, confirmed: _confirmed });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const u = user ?? await resolveUser(userId);
      await getOktaClient().applicationApi.unassignUserFromApplication({ appId, userId: u.id! });
      return { appId, userId: u.id, result: 'removed' };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_remove_app_from_user', durationMs: Date.now() - start, success, input: { userId, appId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });
}
