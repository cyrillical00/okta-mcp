import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { confirmOrAbort, initElicitation } from '../src/tools/_shared/elicitation.js';

interface FakeOptions {
  clientElicits: boolean;
  answer?: { action: string; content?: Record<string, unknown> };
}

function fakeServer({ clientElicits, answer }: FakeOptions) {
  const calls: unknown[] = [];
  const server = {
    server: {
      getClientCapabilities: () => (clientElicits ? { elicitation: {} } : {}),
      elicitInput: async (request: unknown) => {
        calls.push(request);
        return answer ?? { action: 'accept', content: { confirm: true } };
      },
    },
  } as unknown as McpServer;
  return { server, calls };
}

function code(result: Awaited<ReturnType<typeof confirmOrAbort>>): string | null {
  if (result === null) return null;
  const error = (result.structuredContent as { error: { code: string } }).error;
  return error.code;
}

test('writes are refused when OKTA_MCP_ALLOW_WRITES is false, even if confirmed', async () => {
  const { server, calls } = fakeServer({ clientElicits: true });
  initElicitation(server, { allowWrites: false, allowModelConfirm: true });
  assert.equal(code(await confirmOrAbort({ message: 'm', confirmed: true })), 'WRITES_DISABLED');
  assert.equal(calls.length, 0);
});

test('a client with elicitation is prompted and the answer decides', async () => {
  const accepted = fakeServer({ clientElicits: true });
  initElicitation(accepted.server, { allowWrites: true, allowModelConfirm: false });
  assert.equal(code(await confirmOrAbort({ message: 'm' })), null);
  assert.equal(accepted.calls.length, 1);

  const declined = fakeServer({ clientElicits: true, answer: { action: 'decline' } });
  initElicitation(declined.server, { allowWrites: true, allowModelConfirm: true });
  assert.equal(code(await confirmOrAbort({ message: 'm', confirmed: true })), 'USER_DECLINED');

  const unticked = fakeServer({ clientElicits: true, answer: { action: 'accept', content: { confirm: false } } });
  initElicitation(unticked.server, { allowWrites: true, allowModelConfirm: true });
  assert.equal(code(await confirmOrAbort({ message: 'm', confirmed: true })), 'USER_DECLINED');
});

test('_confirmed is ignored unless the operator opted in', async () => {
  const { server, calls } = fakeServer({ clientElicits: false });
  initElicitation(server, { allowWrites: true, allowModelConfirm: false });
  assert.equal(code(await confirmOrAbort({ message: 'm', confirmed: true })), 'CONFIRMATION_UNAVAILABLE');
  assert.equal(calls.length, 0);
});

test('with the opt-in, _confirmed is required and then accepted', async () => {
  const { server } = fakeServer({ clientElicits: false });
  initElicitation(server, { allowWrites: true, allowModelConfirm: true });
  assert.equal(code(await confirmOrAbort({ message: 'm' })), 'CONFIRMATION_REQUIRED');
  assert.equal(code(await confirmOrAbort({ message: 'm', confirmed: true })), null);
});
