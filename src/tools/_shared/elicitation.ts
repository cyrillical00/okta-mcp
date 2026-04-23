import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { errResult, type ToolContent } from './responses.js';

let _server: McpServer | null = null;
let _elicitationSupported = false;

export function initElicitation(server: McpServer, supported: boolean): void {
  _server = server;
  _elicitationSupported = supported;
}

export function isElicitationSupported(): boolean {
  return _elicitationSupported;
}

export interface ConfirmOptions {
  message: string;
  confirmed?: boolean;
}

export async function confirmOrAbort(opts: ConfirmOptions): Promise<ToolContent | null> {
  const { message, confirmed } = opts;

  if (_elicitationSupported && _server) {
    const result = await _server.server.elicitInput({
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Confirm this action' },
        },
        required: ['confirm'],
      },
    });

    const content = result.content as Record<string, unknown> | undefined;
    if (result.action !== 'accept' || !content?.confirm) {
      return errResult({ code: 'USER_DECLINED', message: 'User declined the operation.' });
    }
    return null;
  }

  // Fallback: require _confirmed param
  if (!confirmed) {
    return errResult({
      code: 'CONFIRMATION_REQUIRED',
      message,
      details: { requiredParam: '_confirmed', hint: 'Re-invoke this tool with _confirmed: true to proceed.' },
    });
  }
  return null;
}
