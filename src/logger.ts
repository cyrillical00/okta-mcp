import pino from 'pino';

const logger = pino({
  level: process.env.OKTA_MCP_LOG_LEVEL ?? 'info',
  transport: undefined,
}, pino.destination(2)); // 2 = stderr fd

export default logger;
