import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { register as registerUsers } from './users.js';
import { register as registerGroups } from './groups.js';
import { register as registerApps } from './apps.js';
import { register as registerPolicy } from './policy.js';
import { register as registerSystem } from './system.js';
import { register as registerRunbooks } from './runbooks.js';

export function registerAllTools(server: McpServer): void {
  registerUsers(server);
  registerGroups(server);
  registerApps(server);
  registerPolicy(server);
  registerSystem(server);
  registerRunbooks(server);
}
