import { z } from 'zod';
import { existsSync } from 'node:fs';

const ConfigSchema = z.object({
  OKTA_DOMAIN: z.string().min(1, 'OKTA_DOMAIN is required (e.g. yourco.okta.com)'),
  OKTA_CLIENT_ID: z.string().min(1, 'OKTA_CLIENT_ID is required'),
  OKTA_PRIVATE_KEY_PATH: z.string().min(1, 'OKTA_PRIVATE_KEY_PATH is required'),
  OKTA_SCOPES: z.string().min(1, 'OKTA_SCOPES is required'),
  OKTA_MCP_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  OKTA_MCP_MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(200),
  OKTA_MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  OKTA_MCP_ALLOW_WRITES: z.enum(['true', 'false']).default('true'),
  OKTA_MCP_AUDIT_DIR: z.string().default('./logs'),
});

function loadConfig() {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const c = result.data;

  if (!existsSync(c.OKTA_PRIVATE_KEY_PATH)) {
    throw new Error(
      `OKTA_PRIVATE_KEY_PATH does not exist or is not readable: ${c.OKTA_PRIVATE_KEY_PATH}`
    );
  }

  return {
    okta: {
      domain: c.OKTA_DOMAIN,
      orgUrl: `https://${c.OKTA_DOMAIN}`,
      clientId: c.OKTA_CLIENT_ID,
      privateKeyPath: c.OKTA_PRIVATE_KEY_PATH,
      scopes: c.OKTA_SCOPES.split(' ').filter(Boolean),
    },
    server: {
      logLevel: c.OKTA_MCP_LOG_LEVEL,
      maxPageSize: c.OKTA_MCP_MAX_PAGE_SIZE,
      requestTimeoutMs: c.OKTA_MCP_REQUEST_TIMEOUT_MS,
      allowWrites: c.OKTA_MCP_ALLOW_WRITES === 'true',
      auditDir: c.OKTA_MCP_AUDIT_DIR,
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
