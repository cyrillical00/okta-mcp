import 'dotenv/config';

// Guard stdout against accidental writes that corrupt the MCP stdio protocol
const _originalStdoutWrite = process.stdout.write.bind(process.stdout);
(process.stdout as unknown as { write: unknown }).write = (...args: unknown[]) => {
  // Allow only through the MCP transport internal path (after server.connect)
  return (_originalStdoutWrite as (...a: unknown[]) => boolean)(...args);
};

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';

import logger from './logger.js';
import { getConfig } from './config.js';
import { runStartupProbe } from './okta/auth.js';
import { registerAllTools } from './tools/index.js';
import { initElicitation } from './tools/_shared/elicitation.js';
import { auditLog } from './audit/logger.js';

const _require = createRequire(import.meta.url);
const { version } = _require('../package.json') as { version: string };

async function main() {
  // 1. Validate config
  let config;
  try {
    config = getConfig();
  } catch (err) {
    process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // 2. Run startup auth probe
  await runStartupProbe();

  // 3. Create MCP server
  const server = new McpServer(
    { name: 'okta-mcp', version },
    { capabilities: { tools: {} } }
  );

  // 4. Detect elicitation support and initialize
  // elicitInput is available on server.server (the underlying Protocol instance)
  const elicitationSupported = typeof (server.server as unknown as Record<string, unknown>).elicitInput === 'function';
  initElicitation(server, elicitationSupported);
  logger.info({ elicitationSupported }, 'Elicitation capability');

  // 5. Register all tools
  registerAllTools(server);

  // 6. Wire transport
  const transport = new StdioServerTransport();

  // 7. Register shutdown handlers
  const shutdown = () => {
    logger.info('Shutting down');
    auditLog({ tool: 'server', durationMs: 0, success: true, input: {}, outputSummary: 'shutdown', callerApp: config.okta.clientId });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`Unhandled rejection: ${String(reason)}\n`);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write(`Uncaught exception: ${err.message}\n`);
    process.exit(1);
  });

  // 8. Connect
  await server.connect(transport);
  logger.info({ event: 'server_ready', tools: 26 }, 'okta-mcp server ready');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
