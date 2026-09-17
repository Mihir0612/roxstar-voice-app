import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { getConfig } from './config/index.js';
import { getLogger } from './logging/index.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerRoutes } from './routes/index.js';

/**
 * Fastify application.
 *
 * Kept separate from `server.ts` so tests can build an app and use
 * `app.inject()` without binding a port or starting the background workers.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const cfg = getConfig();

  const app = Fastify({
    // Cast: pino's Logger and Fastify's FastifyBaseLogger differ only by
    // `msgPrefix`, which Fastify never reads off an injected instance.
    loggerInstance: getLogger() as unknown as FastifyBaseLogger,
    // Cloud Run terminates TLS and forwards the client IP in X-Forwarded-For;
    // without this the rate limiter would see one proxy IP for every user.
    trustProxy: true,
    // Bounded body size: no endpoint here accepts anything large, and audio is
    // explicitly never uploaded (D10).
    bodyLimit: 256 * 1024,
    requestIdHeader: 'x-request-id',
  });

  // Sensible security headers. CSP is off because this service returns JSON
  // only -- there is no document for a policy to protect.
  await app.register(helmet, { contentSecurityPolicy: false });

  // D23: an empty allowlist in production denies all browser origins. The
  // Android client sends no Origin header, so the APK is unaffected.
  await app.register(cors, {
    origin: cfg.corsAllowedOrigins.length > 0 ? cfg.corsAllowedOrigins : false,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    credentials: true,
    maxAge: 600,
  });

  // D22: global ceiling, keyed per user when authenticated so one busy network
  // (an office, a carrier NAT) does not throttle everyone behind it.
  await app.register(rateLimit, {
    global: true,
    max: cfg.RATE_LIMIT_MAX,
    timeWindow: cfg.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => req.currentUser?.id ?? req.ip,
    // Skip entirely in tests: concurrency suites deliberately hammer endpoints.
    enableDraftSpec: false,
    ...(cfg.isTest ? { max: 100_000 } : {}),
  });

  // Several endpoints legitimately take no body -- POST /leave and POST
  // /spin/start carry their whole meaning in the URL and the bearer token.
  // Fastify's default JSON parser rejects an empty body outright when the
  // client still sends `Content-Type: application/json`, which every ordinary
  // HTTP client does on a POST with no payload. Treat an empty body as `{}`
  // rather than forcing callers to send a pointless `{}` literal.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string | Buffer, done) => {
      const raw = typeof body === 'string' ? body.trim() : body.toString('utf8').trim();
      if (raw.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(raw));
      } catch {
        // Surfaced as a 400 by the error handler -- never as a 500.
        const err = Object.assign(new SyntaxError('Request body is not valid JSON.'), {
          statusCode: 400,
        });
        done(err, undefined);
      }
    },
  );

  registerErrorHandler(app);
  await registerRoutes(app);

  return app;
}
