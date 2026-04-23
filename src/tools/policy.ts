import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getOktaClient } from '../okta/client.js';
import { safeOktaCall } from '../okta/errors.js';
import { collectAll } from './_shared/pagination.js';
import { resolveUser, resolveGroup } from './_shared/resolve.js';
import { okResult, errResult } from './_shared/responses.js';
import { auditLog } from '../audit/logger.js';
import { getConfig } from '../config.js';
import { AppId, PaginationInput } from './_shared/schemas.js';

export function register(server: McpServer): void {
  // ---- okta_get_app_signon_policies ----
  server.registerTool('okta_get_app_signon_policies', {
    title: 'Get App Sign-On Policies',
    description: 'Retrieve the sign-on policy and rules for an Okta application. Shows MFA requirements, conditions, and access controls.',
    inputSchema: z.object({ appId: AppId }),
  }, async ({ appId }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const mappings = await collectAll(await client.policyApi.listPolicyMappings({ policyId: appId }).catch(async () => {
        // fallback: get app-level policies via policy list
        return client.policyApi.listPolicies({ type: 'ACCESS_POLICY' });
      }), 50);

      // Get policy rules for each policy found
      const policies: unknown[] = [];
      for (const mapping of mappings) {
        const m = mapping as Record<string, unknown>;
        const policyId = (m.policy as Record<string, unknown>)?.id as string ?? m.id as string;
        if (!policyId) continue;
        try {
          const policy = await client.policyApi.getPolicy({ policyId });
          const rules = await collectAll(await client.policyApi.listPolicyRules({ policyId }), 20);
          const p = policy as unknown as Record<string, unknown>;
          policies.push({
            id: p.id,
            name: p.name,
            priority: p.priority,
            status: p.status,
            rules: rules.map(r => {
              const rule = r as unknown as Record<string, unknown>;
              return { id: rule.id, name: rule.name, priority: rule.priority, status: rule.status, actions: rule.actions, conditions: rule.conditions };
            }),
          });
        } catch { continue; }
      }
      return { appId, policies };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_get_app_signon_policies', durationMs: Date.now() - start, success, input: { appId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_get_user_device_trust_status ----
  server.registerTool('okta_get_user_device_trust_status', {
    title: 'Get User Device Trust Status',
    description: 'Derive device trust status for an Okta user. Shows enrolled devices, managed status, bypass group memberships, and a summary derivation.',
    inputSchema: z.object({ userId: z.string().min(1) }),
  }, async ({ userId }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const user = await resolveUser(userId);
      const uid = user.id!;

      const [deviceLinks, groups] = await Promise.all([
        collectAll(await client.userApi.listUserDevices({ userId: uid }), 50),
        collectAll(await client.userApi.listUserGroups({ userId: uid }), 200),
      ]);

      const devices = deviceLinks.map(d => {
        const dv = d as unknown as Record<string, unknown>;
        return { id: dv.id, displayName: dv.displayName, platform: dv.platform, managed: dv.managementType !== 'NOT_MANAGED', managementType: dv.managementType, status: dv.status };
      });

      const bypassGroups = groups
        .filter(g => {
          const grp = g as unknown as Record<string, unknown>;
          const profile = grp.profile as Record<string, unknown> | undefined;
          const name = String(profile?.name ?? '').toLowerCase();
          return name.includes('bypass') || name.includes('trust') || name.includes('exempt');
        })
        .map(g => {
          const grp = g as unknown as Record<string, unknown>;
          const profile = grp.profile as Record<string, unknown> | undefined;
          return { id: grp.id, name: profile?.name };
        });

      const managedCount = devices.filter(d => d.managed).length;
      const derivation = devices.length === 0
        ? 'NO_DEVICES'
        : managedCount === 0
        ? 'UNMANAGED'
        : bypassGroups.length > 0
        ? 'BYPASS_GROUP_MEMBER'
        : 'MANAGED';

      return { userId: uid, login: user.profile?.login, devices, bypassGroupMemberships: bypassGroups, derivation, managedDeviceCount: managedCount, totalDeviceCount: devices.length };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_get_user_device_trust_status', durationMs: Date.now() - start, success, input: { userId }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_list_bypass_group_members ----
  server.registerTool('okta_list_bypass_group_members', {
    title: 'List Bypass Group Members',
    description: 'List all members of a device trust bypass or exemption group. Includes last login and days-in-group metrics for each member.',
    inputSchema: z.object({
      groupIdOrName: z.string().min(1),
      includeLastLogin: z.boolean().default(true),
      ...PaginationInput.shape,
    }),
  }, async ({ groupIdOrName, includeLastLogin, limit }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const group = await resolveGroup(groupIdOrName);
      const collection = await client.groupApi.listGroupUsers({ groupId: group.id!, limit: Math.min(limit, 200) });
      const members: unknown[] = [];
      const now = Date.now();
      for await (const u of collection) {
        if (!u) continue;
        const user = u as unknown as Record<string, unknown>;
        const profile = user.profile as Record<string, unknown> | undefined;
        const lastLoginMs = user.lastLogin ? new Date(user.lastLogin as string).getTime() : null;
        members.push({
          id: user.id,
          login: profile?.login,
          email: profile?.email,
          status: user.status,
          lastLogin: user.lastLogin,
          daysSinceLastLogin: lastLoginMs ? Math.floor((now - lastLoginMs) / 86400000) : null,
        });
        if (members.length >= limit) break;
      }
      return {
        group: { id: group.id, name: group.profile?.name },
        members,
        summary: {
          totalMembers: members.length,
          noRecentLogin: members.filter(m => {
            const mm = m as Record<string, unknown>;
            return (mm.daysSinceLastLogin as number | null) === null || (mm.daysSinceLastLogin as number) > 30;
          }).length,
        },
      };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_list_bypass_group_members', durationMs: Date.now() - start, success, input: { groupIdOrName, limit }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });
}
