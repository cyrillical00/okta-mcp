import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { Client as OktaClientType } from '@okta/okta-sdk-nodejs';
import { getConfig } from '../config.js';

const _require = createRequire(import.meta.url);
const { Client, DefaultRequestExecutor } = _require('@okta/okta-sdk-nodejs') as {
  Client: typeof OktaClientType;
  DefaultRequestExecutor: new (opts: { maxRetries: number; requestTimeout: number }) => unknown;
};

let _client: OktaClientType | null = null;

export function getOktaClient(): OktaClientType {
  if (_client) return _client;

  const config = getConfig();
  const privateKey = JSON.parse(readFileSync(config.okta.privateKeyPath, 'utf-8')) as Record<string, unknown>;

  _client = new Client({
    orgUrl: config.okta.orgUrl,
    authorizationMode: 'PrivateKey',
    clientId: config.okta.clientId,
    scopes: config.okta.scopes,
    privateKey,
    requestExecutor: new DefaultRequestExecutor({
      maxRetries: 3,
      requestTimeout: config.server.requestTimeoutMs,
    }) as never,
  });

  return _client;
}
