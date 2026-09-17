import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthenticated } from '../errors/index.js';
import { extractBearer, resolveUser } from '../services/auth.service.js';
import type { User } from '../models/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`. Absent on public routes. */
    currentUser?: User;
  }
}

/**
 * Bearer authentication (D8).
 *
 * Applied per-route rather than globally: `/health`, `/ready` and the session
 * endpoint must stay reachable without a token, and an allowlist of public
 * paths would be easy to widen by accident.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearer(req.headers.authorization);
  if (!token) throw unauthenticated('Provide a bearer token in the Authorization header.');

  req.currentUser = await resolveUser(token);
}

/** Narrowing helper: `req.currentUser` is optional on the Fastify type. */
export function currentUser(req: FastifyRequest): User {
  if (!req.currentUser) throw unauthenticated();
  return req.currentUser;
}
