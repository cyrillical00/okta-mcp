import type { ToolError } from '../../okta/errors.js';

export interface ToolContent {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
}

export function okResult<T>(data: T): ToolContent {
  const structuredContent: Record<string, unknown> = { ok: true, data: data as unknown };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function errResult(error: ToolError): ToolContent {
  const structuredContent: Record<string, unknown> = { ok: false, error };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}
