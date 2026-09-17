import jwt from 'jsonwebtoken';
import { getConfig } from '../config/index.js';
import { invalidToken } from '../errors/index.js';
import * as userRepo from '../repositories/user.repository.js';
import type { User } from '../models/types.js';

/**
 * Anonymous, device-bound sessions (D8).
 *
 * The PDF requires owner/admin *authorization* but never asks for accounts,
 * passwords or profiles. This is the smallest mechanism that makes "only the
 * owner can start a spin" enforceable: a signed, expiring bearer token that
 * names a user id. No credentials are stored, so none can leak.
 */

export interface SessionClaims {
  sub: string;
  name: string;
}

export interface SessionResult {
  token: string;
  expiresIn: number;
  user: User;
}

export async function createSession(displayName: string, deviceId: string): Promise<SessionResult> {
  const cfg = getConfig();
  const user = await userRepo.upsertByDevice(displayName, deviceId);

  const token = jwt.sign({ name: user.displayName } satisfies Omit<SessionClaims, 'sub'>, cfg.AUTH_SECRET, {
    subject: user.id,
    expiresIn: cfg.AUTH_TOKEN_TTL_SECONDS,
    algorithm: 'HS256',
    issuer: 'roxstar-backend',
  });

  return { token, expiresIn: cfg.AUTH_TOKEN_TTL_SECONDS, user };
}

/**
 * Verify a bearer token.
 *
 * `algorithms` is pinned to HS256 on purpose: without it, a token claiming
 * `alg: none` would be accepted by some verifier configurations. Every failure
 * returns the same generic error so a caller cannot distinguish "expired" from
 * "forged".
 */
export function verifyToken(token: string): SessionClaims {
  const cfg = getConfig();
  try {
    const decoded = jwt.verify(token, cfg.AUTH_SECRET, {
      algorithms: ['HS256'],
      issuer: 'roxstar-backend',
    });

    if (typeof decoded === 'string' || !decoded.sub) throw new Error('malformed claims');

    return { sub: String(decoded.sub), name: String((decoded as { name?: unknown }).name ?? '') };
  } catch {
    throw invalidToken();
  }
}

/** Extract a bearer token from an Authorization header. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || !value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}

/**
 * Resolve a token to a live user.
 *
 * The database lookup is not redundant: a token stays cryptographically valid
 * for seven days, so it must not outlive a deleted user.
 */
export async function resolveUser(token: string): Promise<User> {
  const claims = verifyToken(token);
  const user = await userRepo.findById(claims.sub);
  if (!user) throw invalidToken('The session refers to a user that no longer exists.');
  return user;
}
