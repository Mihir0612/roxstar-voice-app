import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, internalError, isAppError, validationError } from '../errors/index.js';

/**
 * The single place an error becomes a response (D21).
 *
 * Anything that is not a known AppError is reported as a generic
 * INTERNAL_ERROR: a Postgres driver message can name columns and constraints,
 * and a stack trace names file paths. Both are logged in full, and neither is
 * ever sent to a client.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id;

    if (isAppError(err)) {
      const log = err.expected ? req.log.warn.bind(req.log) : req.log.error.bind(req.log);
      log({ err, code: err.code, statusCode: err.statusCode }, 'Request failed');
      return reply.status(err.statusCode).send(err.toResponse(requestId));
    }

    if (err instanceof ZodError) {
      const appErr = validationError({ issues: err.issues.map(toIssue) });
      req.log.warn({ issues: err.issues }, 'Request validation failed');
      return reply.status(appErr.statusCode).send(appErr.toResponse(requestId));
    }

    // Fastify's own errors: rate limiting and malformed JSON are expected
    // failures with useful status codes, so they are passed through.
    const fastifyErr = err as FastifyError;
    if (fastifyErr.statusCode === 429) {
      const appErr = new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.');
      req.log.warn({ url: req.url }, 'Rate limit exceeded');
      return reply.status(429).send(appErr.toResponse(requestId));
    }
    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      const appErr = new AppError(
        fastifyErr.statusCode,
        'INVALID_REQUEST',
        'The request could not be processed.',
      );
      req.log.warn({ err }, 'Client error');
      return reply.status(fastifyErr.statusCode).send(appErr.toResponse(requestId));
    }

    req.log.error({ err }, 'Unhandled error');
    const generic = internalError();
    return reply.status(500).send(generic.toResponse(requestId));
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const err = new AppError(404, 'NOT_FOUND', 'Route not found.');
    return reply.status(404).send(err.toResponse(req.id));
  });
}

const toIssue = (i: { path: PropertyKey[]; message: string; code: string }) => ({
  path: i.path.join('.'),
  message: i.message,
  code: i.code,
});
