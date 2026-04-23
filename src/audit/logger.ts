import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { redact } from '../okta/errors.js';
import logger from '../logger.js';

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function auditPath(): string {
  const dir = getConfig().server.auditDir;
  return join(dir, `okta-mcp-audit-${todayStr()}.jsonl`);
}

function ensureDir(): void {
  try {
    mkdirSync(getConfig().server.auditDir, { recursive: true });
  } catch {
    // ignore
  }
}

export interface AuditEntry {
  tool: string;
  durationMs: number;
  success: boolean;
  input: unknown;
  outputSummary: string;
  errorCode?: string;
  oktaRequestId?: string;
  callerApp: string;
}

let _degraded = false;

export function auditLog(entry: AuditEntry): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
    input: redact(entry.input),
    outputSummary: entry.outputSummary.slice(0, 500),
  });

  if (_degraded) {
    logger.warn({ audit: line }, 'audit (degraded mode)');
    return;
  }

  try {
    ensureDir();
    appendFileSync(auditPath(), line + '\n', 'utf-8');
  } catch {
    _degraded = true;
    logger.warn({ audit: line }, 'audit log write failed, switching to stderr audit');
  }
}
