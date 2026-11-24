import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrivateKey } from '../src/okta/privateKey.js';

// Not a key: only the two fields the loader checks for.
const STUB_JWK = JSON.stringify({ kty: 'RSA', kid: 'test-kid' });

function withKeyFile(mode: number, body: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'okta-mcp-key-'));
  const path = join(dir, 'key.json');
  try {
    writeFileSync(path, body);
    chmodSync(path, mode);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const posix = process.platform !== 'win32';

test('an owner-only key file is loaded', { skip: !posix }, () => {
  withKeyFile(0o600, STUB_JWK, path => {
    assert.deepEqual(loadPrivateKey(path), { kty: 'RSA', kid: 'test-kid' });
  });
  withKeyFile(0o400, STUB_JWK, path => {
    assert.equal(loadPrivateKey(path).kid, 'test-kid');
  });
});

test('a key file other users can read or write is refused', { skip: !posix }, () => {
  for (const mode of [0o644, 0o640, 0o604, 0o660, 0o620, 0o602, 0o666]) {
    withKeyFile(mode, STUB_JWK, path => {
      assert.throws(
        () => loadPrivateKey(path),
        (err: Error & { code?: string }) => err.code === 'KEY_INVALID' && /chmod 600/.test(err.message),
        `mode ${mode.toString(8)} should be refused`
      );
    });
  }
});

test('the mode check is skipped where mode bits mean nothing', { skip: !posix }, () => {
  withKeyFile(0o644, STUB_JWK, path => {
    assert.equal(loadPrivateKey(path, 'win32').kid, 'test-kid');
  });
});

test('missing, non-file, malformed and incomplete keys are refused', { skip: !posix }, () => {
  const isKeyInvalid = (err: Error & { code?: string }) => err.code === 'KEY_INVALID';

  assert.throws(() => loadPrivateKey(join(tmpdir(), 'okta-mcp-no-such-key.json')), isKeyInvalid);

  const dir = mkdtempSync(join(tmpdir(), 'okta-mcp-key-'));
  try {
    const sub = join(dir, 'sub');
    mkdirSync(sub, { mode: 0o700 });
    assert.throws(() => loadPrivateKey(sub), isKeyInvalid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  withKeyFile(0o600, 'not json', path => assert.throws(() => loadPrivateKey(path), isKeyInvalid));
  withKeyFile(0o600, 'null', path => assert.throws(() => loadPrivateKey(path), isKeyInvalid));
  withKeyFile(0o600, JSON.stringify({ kty: 'RSA' }), path => assert.throws(() => loadPrivateKey(path), isKeyInvalid));
});
