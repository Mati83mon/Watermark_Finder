/**
 * Identifiers, hashing and workspace tokens.
 *
 * Workspace tokens are stateless: `<workspace-id>.<hmac>`, verified with
 * WebCrypto against `SESSION_SECRET`. That gives every browser a private,
 * anonymous namespace without a user table, a password or a third-party
 * identity provider - all of which would cost money or personal data.
 */

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, no look-alikes

/** Time-sortable, collision-resistant id: 8 chars of time + 16 of randomness. */
export function newId(prefix = ''): string {
  const now = Date.now();
  let time = '';
  let remaining = now;
  for (let i = 0; i < 8; i += 1) {
    time = ID_ALPHABET[remaining % 32]! + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  for (const byte of bytes) {
    random += ID_ALPHABET[byte % 32]!;
  }
  return `${prefix}${time}${random}`;
}

export function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function signWorkspaceToken(workspaceId: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(workspaceId));
  return `${workspaceId}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify a token and return the workspace id it carries, or `null`.
 *
 * The comparison is constant time so a token cannot be recovered byte by byte
 * from response timing.
 */
export async function verifyWorkspaceToken(
  token: string,
  secret: string,
): Promise<string | null> {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const workspaceId = token.slice(0, separator);
  const expected = await signWorkspaceToken(workspaceId, secret);
  return constantTimeEquals(token, expected) ? workspaceId : null;
}

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
