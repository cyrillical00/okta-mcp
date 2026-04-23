import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getOktaClient } from '../okta/client.js';
import { safeOktaCall } from '../okta/errors.js';
import { withRetry } from '../okta/rateLimit.js';
import { collectPage, collectAll } from './_shared/pagination.js';
import { resolveUser } from './_shared/resolve.js';
import { okResult, errResult } from './_shared/responses.js';
import { confirmOrAbort } from './_shared/elicitation.js';
import { auditLog } from '../audit/logger.js';
import { getConfig } from '../config.js';
import {
  UserIdentifier,
  FactorId,
  PaginationInput,
  SearchMode,
} from './_shared/schemas.js';
import type { User } from '@okta/okta-sdk-nodejs';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

function userSummary(u: User) {
  return {
    id: u.id,
    status: u.status,
    login: u.profile?.login,
    email: u.profile?.email,
    firstName: u.profile?.firstName,
    lastName: u.profile?.lastName,
    created: u.created,
    lastLogin: u.lastLogin,
    passwordChanged: u.passwordChanged,
  };
}

export function register(server: McpServer): void {
  // ---- okta_get_user ----
  server.registerTool('okta_get_user', {
    title: 'Get Okta User',
    description: 'Fetch a single Okta user by ID, email, or login. Returns full profile, status, and timestamps.',
    inputSchema: z.object({ identifier: UserIdentifier }),
  }, async ({ identifier }) => {
    const start = Date.now();
    const result = await safeOktaCall(() => withRetry(() => resolveUser(identifier)));
    const success = result.ok;
    auditLog({ tool: 'okta_get_user', durationMs: Date.now() - start, success, input: { identifier }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(userSummary(result.data)) : errResult(result.error);
  });

  // ---- okta_search_users ----
  server.registerTool('okta_search_users', {
    title: 'Search Okta Users',
    description: 'Search for Okta users by query string. Supports search, filter, or starts-with (q) modes. Returns paginated user summaries.',
    inputSchema: z.object({
      query: z.string().min(1),
      mode: SearchMode,
      ...PaginationInput.shape,
    }),
  }, async ({ query, mode, limit, cursor }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const searchParam = mode === 'search' ? { search: query }
        : mode === 'filter' ? { filter: query }
        : { q: query };
      const collection = await client.userApi.listUsers({ ...searchParam, limit: Math.min(limit, 200) });
      return collectPage<User>(collection, limit, cursor);
    });
    const success = result.ok;
    auditLog({ tool: 'okta_search_users', durationMs: Date.now() - start, success, input: { query, mode, limit }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    if (!result.ok) return errResult(result.error);
    return okResult({ items: result.data.items.map(userSummary), nextCursor: result.data.nextCursor });
  });

  // ---- okta_list_group_users ----
  server.registerTool('okta_list_group_users', {
    title: 'List Users in Okta Group',
    description: 'List members of an Okta group by group ID or exact name. Returns paginated user summaries.',
    inputSchema: z.object({
      groupIdOrName: z.string().min(1),
      ...PaginationInput.shape,
    }),
  }, async ({ groupIdOrName, limit, cursor }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const { resolveGroup } = await import('./_shared/resolve.js');
      const group = await resolveGroup(groupIdOrName);
      const collection = await client.groupApi.listGroupUsers({ groupId: group.id!, limit: Math.min(limit, 200) });
      const page = await collectPage<User>(collection, limit, cursor);
      return { group: { id: group.id, name: group.profile?.name }, users: { items: page.items.map(userSummary), nextCursor: page.nextCursor } };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_list_group_users', durationMs: Date.now() - start, success, input: { groupIdOrName, limit }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_list_user_factors ----
  server.registerTool('okta_list_user_factors', {
    title: 'List User MFA Factors',
    description: 'List all enrolled MFA factors for an Okta user. Returns factor type, provider, status, and profile.',
    inputSchema: z.object({ userId: UserIdentifier }),
  }, async ({ userId }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const user = await resolveUser(userId);
      const userFactorApi = (client as unknown as { userFactorApi: { listFactors: (opts: { userId: string }) => Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }> } }).userFactorApi;
      const collection = await userFactorApi.listFactors({ userId: user.id! });
      const factors: unknown[] = [];
      for await (const f of collection) {
        if (!f) continue;
        const factor = f as Record<string, unknown>;
        factors.push({ id: factor.id, factorType: factor.factorType, provider: factor.provider, status: factor.status, profile: factor.profile });
      }
      return { factors };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_list_user_factors', durationMs: Date.now() - start, success, input: { userId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_activate_user (write) ----
  server.registerTool('okta_activate_user', {
    title: 'Activate Okta User',
    description: 'Activate a deprovisioned or staged Okta user. Optionally sends an activation email. Requires confirmation.',
    inputSchema: z.object({ userId: UserIdentifier, sendEmail: z.boolean().default(false), _confirmed: z.boolean().optional() }),
  }, async ({ userId, sendEmail, _confirmed }) => {
    const start = Date.now();
    const user = await resolveUser(userId).catch(() => null);
    const label = user ? `${user.profile?.login ?? userId} (currently ${user.status})` : userId;

    const denied = await confirmOrAbort({ message: `Activate user ${label}? This transitions them out of their current inactive state.`, confirmed: _confirmed });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const u = user ?? await resolveUser(userId);
      const prevStatus = u.status;
      await getOktaClient().userApi.activateUser({ userId: u.id!, sendEmail });
      return { previousStatus: prevStatus, newStatus: 'ACTIVE' };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_activate_user', durationMs: Date.now() - start, success, input: { userId, sendEmail }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_deactivate_user (write) ----
  server.registerTool('okta_deactivate_user', {
    title: 'Deactivate Okta User',
    description: 'Deactivate an Okta user, revoking all sessions. May trigger downstream SCIM deprovisioning. Requires confirmation.',
    inputSchema: z.object({ userId: UserIdentifier, sendEmail: z.boolean().default(true), _confirmed: z.boolean().optional() }),
  }, async ({ userId, sendEmail, _confirmed }) => {
    const start = Date.now();
    const user = await resolveUser(userId).catch(() => null);
    const label = user ? `${user.profile?.login ?? userId} (currently ${user.status})` : userId;

    const denied = await confirmOrAbort({ message: `Deactivate user ${label}? This will sign them out of all apps and may trigger downstream SCIM deprovisioning.`, confirmed: _confirmed });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const u = user ?? await resolveUser(userId);
      const prevStatus = u.status;
      await getOktaClient().userApi.deactivateUser({ userId: u.id!, sendEmail });
      return { previousStatus: prevStatus, newStatus: 'DEPROVISIONED', warning: 'User is deprovisioned. App assignments are removed.' };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_deactivate_user', durationMs: Date.now() - start, success, input: { userId, sendEmail }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_suspend_user (write) ----
  server.registerTool('okta_suspend_user', {
    title: 'Suspend Okta User',
    description: 'Suspend an active Okta user. Suspended users cannot sign in but their profile and assignments are preserved. Requires confirmation.',
    inputSchema: z.object({ userId: UserIdentifier, _confirmed: z.boolean().optional() }),
  }, async ({ userId, _confirmed }) => {
    const start = Date.now();
    const user = await resolveUser(userId).catch(() => null);
    const label = user ? `${user.profile?.login ?? userId} (currently ${user.status})` : userId;

    const denied = await confirmOrAbort({ message: `Suspend user ${label}? They will be immediately signed out and cannot sign in until unsuspended.`, confirmed: _confirmed });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const u = user ?? await resolveUser(userId);
      const prevStatus = u.status;
      await getOktaClient().userApi.suspendUser({ userId: u.id! });
      return { previousStatus: prevStatus, newStatus: 'SUSPENDED' };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_suspend_user', durationMs: Date.now() - start, success, input: { userId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_unlock_user (write) ----
  server.registerTool('okta_unlock_user', {
    title: 'Unlock Okta User',
    description: 'Unlock an Okta user who is locked out due to too many failed sign-in attempts. Requires confirmation.',
    inputSchema: z.object({ userId: UserIdentifier, _confirmed: z.boolean().optional() }),
  }, async ({ userId, _confirmed }) => {
    const start = Date.now();
    const user = await resolveUser(userId).catch(() => null);
    const label = user ? `${user.profile?.login ?? userId} (currently ${user.status})` : userId;

    const denied = await confirmOrAbort({ message: `Unlock user ${label}? This will restore their ability to sign in.`, confirmed: _confirmed });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const u = user ?? await resolveUser(userId);
      const prevStatus = u.status;
      await getOktaClient().userApi.unlockUser({ userId: u.id! });
      return { previousStatus: prevStatus, newStatus: 'ACTIVE' };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_unlock_user', durationMs: Date.now() - start, success, input: { userId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_clear_user_sessions (write) ----
  server.registerTool('okta_clear_user_sessions', {
    title: 'Clear User Sessions',
    description: 'Revoke all active Okta sessions for a user. Optionally also revokes OAuth tokens. Requires confirmation.',
    inputSchema: z.object({ userId: UserIdentifier, oauthTokens: z.boolean().default(false), _confirmed: z.boolean().optional() }),
  }, async ({ userId, oauthTokens, _confirmed }) => {
    const start = Date.now();
    const user = await resolveUser(userId).catch(() => null);
    const label = user ? (user.profile?.login ?? userId) : userId;

    const denied = await confirmOrAbort({ message: `Clear all sessions for ${label}?${oauthTokens ? ' OAuth tokens will also be revoked.' : ''}`, confirmed: _confirmed });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const u = user ?? await resolveUser(userId);
      await getOktaClient().userApi.revokeUserSessions({ userId: u.id!, oauthTokens });
      return { sessionsRevoked: true, tokensRevoked: oauthTokens };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_clear_user_sessions', durationMs: Date.now() - start, success, input: { userId, oauthTokens }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_reset_user_factor (write) ----
  server.registerTool('okta_reset_user_factor', {
    title: 'Reset User MFA Factor',
    description: 'Reset a specific MFA factor enrollment for an Okta user. The user must re-enroll. Requires confirmation.',
    inputSchema: z.object({ userId: UserIdentifier, factorId: FactorId, _confirmed: z.boolean().optional() }),
  }, async ({ userId, factorId, _confirmed }) => {
    const start = Date.now();
    const user = await resolveUser(userId).catch(() => null);
    const label = user ? (user.profile?.login ?? userId) : userId;

    const denied = await confirmOrAbort({ message: `Reset factor ${factorId} for user ${label}? They will need to re-enroll this factor.`, confirmed: _confirmed });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const u = user ?? await resolveUser(userId);
      const userFactorApi = (getOktaClient() as unknown as { userFactorApi: { deleteFactor: (opts: { userId: string; factorId: string }) => Promise<void> } }).userFactorApi;
      await userFactorApi.deleteFactor({ userId: u.id!, factorId });
      return { factorId, result: 'reset' };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_reset_user_factor', durationMs: Date.now() - start, success, input: { userId, factorId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });
}
