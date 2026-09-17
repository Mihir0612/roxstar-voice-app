import { z } from 'zod';

/**
 * Environment contract (D29).
 *
 * Configuration is validated once, at startup, and the process refuses to boot
 * if anything required is missing. A server that starts with a broken config
 * and fails on the first user request is strictly worse than one that never
 * starts: Cloud Run will not route traffic to a container that exits.
 */

const DEV_AUTH_SECRET = 'dev-only-insecure-secret-change-me';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Cloud Run injects PORT. Binding to anything else makes the container
  // look unhealthy no matter how well the app works.
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: booleanish.default('false'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 characters'),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(60 * 60 * 24 * 7),

  // Empty in production means "deny every browser origin" (D23). The Android
  // client sends no Origin header, so the APK is unaffected either way.
  CORS_ALLOWED_ORIGINS: z.string().default(''),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // --- Spin engine (PDF: one elimination every 5 seconds) -------------------
  SPIN_ELIMINATION_INTERVAL_MS: z.coerce.number().int().min(100).default(5000),
  SPIN_MIN_PARTICIPANTS: z.coerce.number().int().min(2).default(3),
  SPIN_MAX_PARTICIPANTS: z.coerce.number().int().min(3).default(20),
  // How often the scheduler asks the database for due spins. Must be well
  // below the elimination interval or ticks land late (D15).
  SPIN_SCHEDULER_TICK_MS: z.coerce.number().int().min(10).default(500),
  // Beyond this lag the deadline is re-anchored instead of catching up (D15).
  SPIN_MAX_CATCHUP_LAG_MS: z.coerce.number().int().min(0).default(15_000),

  // --- Presence (D13) -------------------------------------------------------
  PRESENCE_GRACE_MS: z.coerce.number().int().min(0).default(15_000),
  PRESENCE_SWEEP_TICK_MS: z.coerce.number().int().min(10).default(1000),

  // --- Rate limiting (D22) --------------------------------------------------
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_SPIN_START_MAX: z.coerce.number().int().min(1).default(6),

  // Set false in tests so the suite controls the clock explicitly.
  ENABLE_BACKGROUND_WORKERS: booleanish.default('true'),
});

export type AppConfig = z.infer<typeof schema> & {
  corsAllowedOrigins: string[];
  isProduction: boolean;
  isTest: boolean;
};

function build(env: NodeJS.ProcessEnv): AppConfig {
  if (!env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile();
    } catch {}
  }
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  const cfg = parsed.data;
  const isProduction = cfg.NODE_ENV === 'production';

  // Fail fast rather than shipping the development secret to the internet.
  if (isProduction && cfg.AUTH_SECRET === DEV_AUTH_SECRET) {
    throw new Error('AUTH_SECRET is still the development default; refusing to start in production.');
  }

  if (cfg.SPIN_MIN_PARTICIPANTS > cfg.SPIN_MAX_PARTICIPANTS) {
    throw new Error('SPIN_MIN_PARTICIPANTS cannot exceed SPIN_MAX_PARTICIPANTS.');
  }

  if (cfg.SPIN_SCHEDULER_TICK_MS >= cfg.SPIN_ELIMINATION_INTERVAL_MS) {
    throw new Error(
      'SPIN_SCHEDULER_TICK_MS must be smaller than SPIN_ELIMINATION_INTERVAL_MS, ' +
        'otherwise eliminations are systematically late.',
    );
  }

  return {
    ...cfg,
    isProduction,
    isTest: cfg.NODE_ENV === 'test',
    corsAllowedOrigins: cfg.CORS_ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

let cached: AppConfig | undefined;

/** Validated singleton config. Throws on first access if the env is invalid. */
export function getConfig(): AppConfig {
  cached ??= build(process.env);
  return cached;
}

/** Test seam: rebuild config from an explicit environment. */
export function loadConfigFrom(env: NodeJS.ProcessEnv): AppConfig {
  return build(env);
}

export function resetConfigCache(): void {
  cached = undefined;
}

export { DEV_AUTH_SECRET };
