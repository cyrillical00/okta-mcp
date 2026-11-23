import { readFileSync, statSync } from 'node:fs';

function keyError(message: string): Error {
  return Object.assign(new Error(message), { code: 'KEY_INVALID' });
}

/**
 * Read the service app's private JWK from disk.
 *
 * The key is stored unencrypted, so the file mode is the only thing keeping
 * other local accounts away from it. Like ssh, refuse a key file that the
 * group or everyone else can read or write, instead of loading it and carrying on.
 * Windows has no POSIX mode bits, so the check is skipped there.
 */
export function loadPrivateKey(
  path: string,
  platform: NodeJS.Platform = process.platform
): Record<string, unknown> {
  let mode: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a regular file');
    mode = stat.mode;
  } catch {
    throw keyError(`Cannot read private key at ${path}`);
  }

  if (platform !== 'win32' && (mode & 0o077) !== 0) {
    throw keyError(
      `Private key file ${path} is accessible to other users (mode ${(mode & 0o777).toString(8).padStart(3, '0')}). ` +
        `Restrict it to its owner and start again: chmod 600 "${path}"`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw keyError(`Cannot read private key at ${path}`);
  }

  const key = parsed as Record<string, unknown> | null;
  if (!key || typeof key !== 'object' || !key.kty || !key.kid) {
    throw keyError('Private key JSON is missing required fields: kty and/or kid');
  }
  return key;
}
