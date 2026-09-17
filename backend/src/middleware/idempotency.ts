import type { FastifyReply, FastifyRequest } from 'fastify';
import { idempotencyKeyReused } from '../errors/index.js';
import * as idempotencyRepo from '../repositories/idempotency.repository.js';
import { currentUser } from './auth.js';

/**
 * Idempotent POST handling (D18).
 *
 * Wrapping the handler rather than using two hooks keeps the whole rule in one
 * place: look up, replay or execute, store. The header is optional everywhere
 * except Start Spin, which the route marks required -- a retried start that
 * created a second spin would be the worst failure this system can produce.
 *
 * Replay semantics:
 *   same key + same body  -> the stored response, byte for byte
 *   same key + other body -> 409 IDEMPOTENCY_KEY_REUSED
 *   no key                -> executed normally
 */
export async function withIdempotency<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  endpoint: string,
  successStatus: number,
  handler: () => Promise<T>,
): Promise<T | unknown> {
  const key = readKey(req);
  if (!key) {
    reply.status(successStatus);
    return handler();
  }

  const user = currentUser(req);
  const requestHash = idempotencyRepo.hashRequest(req.body ?? null);

  const stored = await idempotencyRepo.findStored(key, user.id, endpoint);
  if (stored) {
    if (stored.requestHash !== requestHash) throw idempotencyKeyReused();
    req.log.info({ endpoint, key }, 'Replaying stored idempotent response');
    reply.status(stored.responseStatus);
    return stored.responseBody;
  }

  const result = await handler();

  // Stored after the handler succeeds. A failed request must stay retryable --
  // caching a 500 under the key would make the operation permanently broken
  // for that client.
  await idempotencyRepo.store(key, user.id, endpoint, requestHash, successStatus, result);

  reply.status(successStatus);
  return result;
}

function readKey(req: FastifyRequest): string | null {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const trimmed = value.trim();
  // Bounded: the key is a database column, not a place to put a payload.
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
}

export const hasIdempotencyKey = (req: FastifyRequest): boolean => readKey(req) !== null;
