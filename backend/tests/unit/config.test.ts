import { describe, expect, it } from 'vitest';
import { DEV_AUTH_SECRET, loadConfigFrom } from '../../src/config/index.js';

/**
 * Configuration is a security boundary (D29). These tests assert the
 * fail-fast rules -- a server that boots with a bad config and dies on the
 * first request is strictly worse than one that never boots.
 */
describe('configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    AUTH_SECRET: 'a-sufficiently-long-secret',
  };

  it('defaults the elimination interval to the 5 seconds the PDF requires', () => {
    const cfg = loadConfigFrom({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.SPIN_ELIMINATION_INTERVAL_MS).toBe(5000);
  });

  it('defaults participant bounds to the 3-20 the PDF requires', () => {
    const cfg = loadConfigFrom({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.SPIN_MIN_PARTICIPANTS).toBe(3);
    expect(cfg.SPIN_MAX_PARTICIPANTS).toBe(20);
  });

  it('refuses to start without a database URL', () => {
    expect(() => loadConfigFrom({ AUTH_SECRET: base.AUTH_SECRET } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a short auth secret', () => {
    expect(() =>
      loadConfigFrom({ ...base, AUTH_SECRET: 'tooshort' } as NodeJS.ProcessEnv),
    ).toThrow(/AUTH_SECRET/);
  });

  it('refuses to ship the development secret to production', () => {
    expect(() =>
      loadConfigFrom({
        ...base,
        NODE_ENV: 'production',
        AUTH_SECRET: DEV_AUTH_SECRET,
      } as NodeJS.ProcessEnv),
    ).toThrow(/development default/);
  });

  it('denies all browser origins when the allowlist is empty', () => {
    const cfg = loadConfigFrom({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(cfg.corsAllowedOrigins).toEqual([]);
  });

  it('parses and trims the CORS allowlist', () => {
    const cfg = loadConfigFrom({
      ...base,
      CORS_ALLOWED_ORIGINS: 'https://a.example , https://b.example',
    } as NodeJS.ProcessEnv);
    expect(cfg.corsAllowedOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects a scheduler tick that cannot keep up with the interval', () => {
    // A tick at or above the interval means every elimination lands late.
    expect(() =>
      loadConfigFrom({
        ...base,
        SPIN_SCHEDULER_TICK_MS: '5000',
        SPIN_ELIMINATION_INTERVAL_MS: '5000',
      } as NodeJS.ProcessEnv),
    ).toThrow(/systematically late/);
  });

  it('rejects inverted participant bounds', () => {
    expect(() =>
      loadConfigFrom({
        ...base,
        SPIN_MIN_PARTICIPANTS: '10',
        SPIN_MAX_PARTICIPANTS: '5',
      } as NodeJS.ProcessEnv),
    ).toThrow(/cannot exceed/);
  });
});
