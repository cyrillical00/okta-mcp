import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getOktaClient } from '../okta/client.js';
import { safeOktaCall } from '../okta/errors.js';
import { collectPage } from './_shared/pagination.js';
import { okResult, errResult } from './_shared/responses.js';
import { auditLog } from '../audit/logger.js';
import { getConfig } from '../config.js';
import { IsoDateTime } from './_shared/schemas.js';

export function register(server: McpServer): void {
  // ---- okta_get_system_log ----
  server.registerTool('okta_get_system_log', {
    title: 'Get Okta System Log',
    description: 'Query the Okta system log for audit events. Filter by actor, target, event type, or outcome. Defaults to last 1 hour.',
    inputSchema: z.object({
      since: IsoDateTime.optional(),
      until: IsoDateTime.optional(),
      limit: z.number().int().min(1).max(1000).default(50),
      actorId: z.string().optional(),
      targetId: z.string().optional(),
      eventType: z.string().optional(),
      outcome: z.enum(['SUCCESS', 'FAILURE', 'SKIPPED', 'ALLOW', 'DENY', 'CHALLENGE', 'UNKNOWN']).optional(),
      cursor: z.string().optional(),
    }),
  }, async ({ since, until, limit, actorId, targetId, eventType, outcome }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const sinceDate = since ?? new Date(Date.now() - 3600000).toISOString();

      let filter: string | undefined;
      const parts: string[] = [];
      if (actorId) parts.push(`actor.id eq "${actorId}"`);
      if (targetId) parts.push(`target.id eq "${targetId}"`);
      if (eventType) parts.push(`eventType eq "${eventType}"`);
      if (outcome) parts.push(`outcome.result eq "${outcome}"`);
      if (parts.length > 0) filter = parts.join(' and ');

      const collection = await client.systemLogApi.listLogEvents({
        since: sinceDate,
        ...(until ? { until } : {}),
        limit: Math.min(limit, 1000),
        ...(filter ? { filter } : {}),
      });

      const page = await collectPage(collection, limit);
      return {
        items: page.items.map(e => {
          const ev = e as unknown as Record<string, unknown>;
          return {
            published: ev.published,
            eventType: ev.eventType,
            displayMessage: ev.displayMessage,
            severity: ev.severity,
            outcome: ev.outcome,
            actor: ev.actor,
            target: ev.target,
            client: ev.client,
            uuid: ev.uuid,
          };
        }),
        nextCursor: page.nextCursor,
      };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_get_system_log', durationMs: Date.now() - start, success, input: { since, limit, eventType, outcome }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });

  // ---- okta_resolve_identifier ----
  server.registerTool('okta_resolve_identifier', {
    title: 'Resolve Okta Identifier',
    description: 'Resolve an ambiguous identifier (email, login, name, or ID prefix) to one or more Okta entities. Useful before running targeted operations.',
    inputSchema: z.object({
      identifier: z.string().min(1),
      preferredType: z.enum(['user', 'group', 'app']).optional(),
    }),
  }, async ({ identifier, preferredType }) => {
    const start = Date.now();
    const client = getOktaClient();
    const result = await safeOktaCall(async () => {
      const matches: unknown[] = [];

      if (!preferredType || preferredType === 'user') {
        try {
          const users = await client.userApi.listUsers({ search: `profile.email eq "${identifier}" or profile.login eq "${identifier}"` });
          for await (const u of users) {
            if (!u) continue;
            const user = u as unknown as Record<string, unknown>;
            const profile = user.profile as Record<string, unknown>;
            matches.push({ type: 'user', id: user.id, login: profile?.login, email: profile?.email, status: user.status });
          }
        } catch { /* skip */ }
      }

      if (!preferredType || preferredType === 'group') {
        try {
          const groups = await client.groupApi.listGroups({ q: identifier, limit: 5 });
          for await (const g of groups) {
            if (!g) continue;
            const grp = g as unknown as Record<string, unknown>;
            const profile = grp.profile as Record<string, unknown>;
            matches.push({ type: 'group', id: grp.id, name: profile?.name });
          }
        } catch { /* skip */ }
      }

      if (!preferredType || preferredType === 'app') {
        try {
          const apps = await client.applicationApi.listApplications({ q: identifier, limit: 5 } as never);
          for await (const a of apps) {
            if (!a) continue;
            const app = a as unknown as Record<string, unknown>;
            matches.push({ type: 'app', id: app.id, label: app.label, status: app.status });
          }
        } catch { /* skip */ }
      }

      return { matches, disambiguationNeeded: matches.length > 1 };
    });
    const success = result.ok;
    auditLog({ tool: 'okta_resolve_identifier', durationMs: Date.now() - start, success, input: { identifier, preferredType }, outputSummary: JSON.stringify(result).slice(0, 500), callerApp: getConfig().okta.clientId });
    return result.ok ? okResult(result.data) : errResult(result.error);
  });
}
