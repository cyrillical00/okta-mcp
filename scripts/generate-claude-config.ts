import 'dotenv/config';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Use forward slashes for JSON safety on Windows
const nodePath = process.execPath.replace(/\\/g, '/');
const entryPoint = join(projectRoot, 'src', 'index.ts').replace(/\\/g, '/');
const cwd = projectRoot.replace(/\\/g, '/');
const privateKeyPath = process.env.OKTA_PRIVATE_KEY_PATH?.replace(/\\/g, '/') ?? '';

const config = {
  'okta-mcp': {
    command: nodePath,
    args: [
      join(projectRoot, 'node_modules', '.bin', 'tsx').replace(/\\/g, '/'),
      entryPoint,
    ],
    cwd,
    env: {
      OKTA_DOMAIN: process.env.OKTA_DOMAIN ?? '',
      OKTA_CLIENT_ID: process.env.OKTA_CLIENT_ID ?? '',
      OKTA_PRIVATE_KEY_PATH: privateKeyPath,
      OKTA_SCOPES: process.env.OKTA_SCOPES ?? '',
      OKTA_MCP_LOG_LEVEL: process.env.OKTA_MCP_LOG_LEVEL ?? 'info',
      OKTA_MCP_ALLOW_WRITES: process.env.OKTA_MCP_ALLOW_WRITES ?? 'true',
      OKTA_MCP_AUDIT_DIR: join(projectRoot, 'logs').replace(/\\/g, '/'),
    },
  },
};

const snippet = JSON.stringify({ mcpServers: config }, null, 2);

process.stdout.write('\n=== Paste this into your claude_desktop_config.json under "mcpServers" ===\n\n');
process.stdout.write(snippet + '\n\n');
process.stdout.write('Config file location: %APPDATA%\\Claude\\claude_desktop_config.json\n\n');
