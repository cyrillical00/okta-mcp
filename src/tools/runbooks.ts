import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getOktaClient } from '../okta/client.js';
import { safeOktaCall } from '../okta/errors.js';
import { collectAll } from './_shared/pagination.js';
import { resolveUser, resolveGroup } from './_shared/resolve.js';
import { okResult, errResult } from './_shared/responses.js';
import { confirmOrAbort } from './_shared/elicitation.js';
import { auditLog } from '../audit/logger.js';
import { getConfig } from '../config.js';
import { AppId } from './_shared/schemas.js';

export function register(server: McpServer): void {
  // ---- okta_runbook_device_trust_bypass_audit ----
  server.registerTool('okta_runbook_device_trust_bypass_audit', {
    title: 'Runbook: Device Trust Bypass Audit',
    description: 'Audit all members of a device trust bypass group. Returns per-member device status, managed device count, and days in bypass. Identifies stale members who should be reviewed.',
    inputSchema: z.object({ groupIdOrName: z.string().min(1) }),
  }, async ({ groupIdOrName }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const group = await resolveGroup(groupIdOrName);
      const users = await collectAll(await client.groupApi.listGroupUsers({ groupId: group.id! }), 500);
      const now = Date.now();
      const rows: unknown[] = [];

      for (const u of users) {
        const user = u as unknown as Record<string, unknown>;
        const profile = user.profile as Record<string, unknown> | undefined;
        const lastLoginMs = user.lastLogin ? new Date(user.lastLogin as string).getTime() : null;

        let deviceCount = 0;
        let managedDeviceCount = 0;
        try {
          const devices = await collectAll(await client.userApi.listUserDevices({ userId: user.id as string }), 20);
          deviceCount = devices.length;
          managedDeviceCount = devices.filter(d => {
            const dv = d as unknown as Record<string, unknown>;
            return dv.managementType !== 'NOT_MANAGED';
          }).length;
        } catch { /* skip */ }

        rows.push({
          login: profile?.login,
          email: profile?.email,
          status: user.status,
          lastLogin: user.lastLogin,
          daysSinceLastLogin: lastLoginMs ? Math.floor((now - lastLoginMs) / 86400000) : null,
          deviceCount,
          managedDeviceCount,
        });
      }

      const noManagedDevice = rows.filter(r => (r as Record<string, unknown>).managedDeviceCount === 0).length;
      const staleLogin = rows.filter(r => {
        const days = (r as Record<string, unknown>).daysSinceLastLogin as number | null;
        return days === null || days > 30;
      }).length;

      return {
        group: { id: group.id, name: group.profile?.name },
        members: rows,
        summary: { totalMembers: rows.length, membersWithNoManagedDevice: noManagedDevice, membersWithStaleLogin: staleLogin },
      };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_runbook_device_trust_bypass_audit', durationMs: Date.now() - start, success, input: { groupIdOrName }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_runbook_offboard_user ----
  server.registerTool('okta_runbook_offboard_user', {
    title: 'Runbook: Offboard User',
    description: 'Full offboarding sequence: suspend user, clear sessions and OAuth tokens, return audit record with group and app state at time of offboard. Requires confirmation for the full plan.',
    inputSchema: z.object({ userId: z.string().min(1), _confirmed: z.boolean().optional() }),
  }, async ({ userId, _confirmed }) => {
    const start = Date.now();
    const client = getOktaClient();

    const user = await resolveUser(userId).catch(() => null);
    const label = user ? `${user.profile?.login ?? userId} (currently ${user?.status})` : userId;

    const denied = await confirmOrAbort({
      message: `Offboard ${label}? Plan: (1) suspend user, (2) clear all sessions and OAuth tokens. Group memberships and app assignments are preserved for audit and must be removed separately if needed.`,
      confirmed: _confirmed,
    });
    if (denied) return denied;

    const result = await safeOktaCall(async () => {
      const u = user ?? await resolveUser(userId);
      const uid = u.id!;
      const prevStatus = u.status;

      const [groups, appLinks] = await Promise.all([
        collectAll(await client.userApi.listUserGroups({ userId: uid }), 200),
        collectAll(await client.userApi.listAppLinks({ userId: uid }), 100),
      ]);

      await client.userApi.suspendUser({ userId: uid });
      await client.userApi.revokeUserSessions({ userId: uid, oauthTokens: true });

      return {
        user: { id: uid, login: u.profile?.login, email: u.profile?.email },
        previousStatus: prevStatus,
        newStatus: 'SUSPENDED',
        groupsAtOffboardTime: groups.map(g => {
          const grp = g as unknown as Record<string, unknown>;
          const profile = grp.profile as Record<string, unknown> | undefined;
          return { id: grp.id, name: profile?.name };
        }),
        appsAtOffboardTime: appLinks.map(a => {
          const app = a as unknown as Record<string, unknown>;
          return { id: app.id, label: app.label, appName: app.appName };
        }),
        sessionsRevoked: true,
        tokensRevoked: true,
        offboardTimestamp: new Date().toISOString(),
      };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_runbook_offboard_user', durationMs: Date.now() - start, success, input: { userId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_runbook_access_review_for_app ----
  server.registerTool('okta_runbook_access_review_for_app', {
    title: 'Runbook: Access Review for App',
    description: 'Generate a structured access review for a specific Okta application. Lists all users with access (direct and via group), last login, and assignment path. Suitable for SOC2 or SOX access reviews.',
    inputSchema: z.object({ appId: AppId }),
  }, async ({ appId }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const app = await client.applicationApi.getApplication({ appId });
      const appData = app as unknown as Record<string, unknown>;

      const directUsers = await collectAll(await client.applicationApi.listApplicationUsers({ appId }), 500);
      const groupAssignments = await collectAll(await client.applicationApi.listApplicationGroupAssignments({ appId }), 100);

      const userMap = new Map<string, Record<string, unknown>>();

      for (const au of directUsers) {
        const u = au as unknown as Record<string, unknown>;
        const uid = u.id as string;
        if (!uid) continue;
        try {
          const fullUser = await resolveUser(uid);
          const profile = fullUser.profile as Record<string, unknown> | undefined;
          userMap.set(uid, {
            id: uid,
            email: profile?.email,
            login: profile?.login,
            status: fullUser.status,
            lastLogin: fullUser.lastLogin,
            assignmentPath: 'direct',
          });
        } catch { /* skip */ }
      }

      for (const ga of groupAssignments) {
        const g = ga as unknown as Record<string, unknown>;
        const groupId = g.id as string;
        if (!groupId) continue;
        try {
          const grp = await client.groupApi.getGroup({ groupId });
          const groupMembers = await collectAll(await client.groupApi.listGroupUsers({ groupId }), 200);
          for (const gu of groupMembers) {
            const u = gu as unknown as Record<string, unknown>;
            const uid = u.id as string;
            if (!uid || userMap.has(uid)) continue;
            const profile = u.profile as Record<string, unknown> | undefined;
            userMap.set(uid, {
              id: uid,
              email: profile?.email,
              login: profile?.login,
              status: u.status,
              lastLogin: u.lastLogin,
              assignmentPath: `via group: ${grp.profile?.name ?? groupId}`,
            });
          }
        } catch { /* skip */ }
      }

      return {
        app: { id: appData.id, label: appData.label, name: appData.name, status: appData.status },
        users: Array.from(userMap.values()),
        totalUsers: userMap.size,
        reviewGeneratedAt: new Date().toISOString(),
      };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_runbook_access_review_for_app', durationMs: Date.now() - start, success, input: { appId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });
}
