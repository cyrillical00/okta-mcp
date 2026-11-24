import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'okta-mcp-audit-'));
const keyPath = join(dir, 'key.json');
writeFileSync(keyPath, '{}');

// getConfig() validates the whole environment on first use.
process.env.OKTA_DOMAIN = 'example.okta.com';
process.env.OKTA_CLIENT_ID = 'test-client';
process.env.OKTA_PRIVATE_KEY_PATH = keyPath;
process.env.OKTA_SCOPES = 'okta.users.read';
process.env.OKTA_MCP_LOG_LEVEL = 'fatal';
process.env.OKTA_MCP_AUDIT_DIR = join(dir, 'logs');

const { auditLog } = await import('../src/audit/logger.js');

const entry = {
  tool: 'okta_get_user',
  durationMs: 1,
  success: true,
  input: { userId: 'someone@example.com' },
  outputSummary: 'ok',
  callerApp: 'test-client',
};

function auditFile(): string {
  const logs = join(dir, 'logs');
  const files = readdirSync(logs);
  assert.equal(files.length, 1);
  return join(logs, files[0]!);
}

test('audit files are created readable by the owner only', { skip: process.platform === 'win32' }, () => {
  auditLog(entry);
  const path = auditFile();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'logs')).mode & 0o077, 0);
  assert.equal(readFileSync(path, 'utf-8').trim().split('\n').length, 1);
});

test('appending keeps the entries and the mode', { skip: process.platform === 'win32' }, () => {
  const path = auditFile();
  auditLog(entry);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf-8').trim().split('\n').length, 2);
});

test.after(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});
