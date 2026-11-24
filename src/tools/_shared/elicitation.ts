import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { errResult, type ToolContent } from './responses.js';

export interface WriteGuardOptions {
  /** OKTA_MCP_ALLOW_WRITES. When false, every write tool is refused. */
  allowWrites: boolean;
  /**
   * OKTA_MCP_ALLOW_MODEL_CONFIRM. When true, a client that cannot show a
   * confirmation prompt may confirm through the `_confirmed` argument. The
   * model fills that argument in itself, so this is off unless the operator
   * opts in.
   */
  allowModelConfirm: boolean;
}

let _server: McpServer | null = null;
// Fail closed: until initElicitation runs, no write is allowed.
let _options: WriteGuardOptions = { allowWrites: false, allowModelConfirm: false };

export function initElicitation(server: McpServer, options: WriteGuardOptions): void {
  _server = server;
  _options = options;
}

/**
 * True when the connected client declared the elicitation capability.
 * Checked on every call: capabilities are only known after the MCP handshake,
 * and the SDK exposing `elicitInput` says nothing about what the client can do.
 */
export function isElicitationSupported(): boolean {
  if (!_server) return false;
  return Boolean(_server.server.getClientCapabilities()?.elicitation);
}

export interface ConfirmOptions {
  message: string;
  confirmed?: boolean;
}

/**
 * Gate for every write tool. Returns null when the operation may proceed,
 * or an error result to return to the caller unchanged.
 */
export async function confirmOrAbort(opts: ConfirmOptions): Promise<ToolContent | null> {
  const { message, confirmed } = opts;

  if (!_options.allowWrites) {
    return errResult({
      code: 'WRITES_DISABLED',
      message: 'Write operations are disabled on this server (OKTA_MCP_ALLOW_WRITES=false). Nothing was changed.',
    });
  }

  if (_server && isElicitationSupported()) {
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

  if (!_options.allowModelConfirm) {
    return errResult({
      code: 'CONFIRMATION_UNAVAILABLE',
      message:
        'This client cannot show a confirmation prompt, so nothing was changed. ' +
        'Use a client that supports MCP elicitation, or have the operator set OKTA_MCP_ALLOW_MODEL_CONFIRM=true.',
    });
  }

  // Operator opted in to argument-based confirmation.
  if (!confirmed) {
    return errResult({
      code: 'CONFIRMATION_REQUIRED',
      message,
      details: {
        requiredParam: '_confirmed',
        hint: 'Ask the user to confirm this action. Re-invoke with _confirmed: true only after they agree.',
      },
    });
  }
  return null;
}
