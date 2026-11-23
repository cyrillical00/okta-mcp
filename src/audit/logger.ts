import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
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
    mkdirSync(getConfig().server.auditDir, { recursive: true, mode: 0o700 });
  } catch {
    // ignore
  }
}

// Entries hold user identifiers and the start of tool output (profile data),
// so the file is kept readable by its owner only.
let _ownerOnlyPath: string | null = null;

function appendOwnerOnly(path: string, line: string): void {
  appendFileSync(path, line, { encoding: 'utf-8', mode: 0o600 });
  if (_ownerOnlyPath !== path) {
    // The mode above only applies when the file is created; tighten a file
    // left behind by an earlier version. No effect on Windows.
    chmodSync(path, 0o600);
    _ownerOnlyPath = path;
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
    appendOwnerOnly(auditPath(), line + '\n');
  } catch {
    _degraded = true;
    logger.warn({ audit: line }, 'audit log write failed, switching to stderr audit');
  }
}
