import { describe, expect, it } from 'vitest';
import { computeNextDeadline } from '../../src/services/spin.service.js';

/**
 * Timer policy (D15).
 *
 * Pure function, no database: this is the rule that decides whether a spin
 * drifts, bursts, or paces correctly after the process was slow or restarted.
 */
describe('computeNextDeadline', () => {
  const INTERVAL = 5000;
  const MAX_LAG = 15_000;

  it('anchors on the scheduled time, not on now, so jitter does not accumulate', () => {
    const scheduled = new Date('2026-01-01T00:00:00.000Z');
    // The tick fired 120ms late, as real schedulers do.
    const now = new Date('2026-01-01T00:00:00.120Z');

    const next = computeNextDeadline(scheduled, INTERVAL, MAX_LAG, now);

    // 00:00:05.000, not 00:00:05.120 -- the 120ms is absorbed, not carried.
    expect(next.toISOString()).toBe('2026-01-01T00:00:05.000Z');
  });

  it('does not drift across many late ticks', () => {
    let scheduled = new Date('2026-01-01T00:00:00.000Z');
    let now = new Date(scheduled);

    // 100 consecutive ticks, each 80ms late. Naive `now + interval` would end
    // up 8 seconds behind schedule.
    for (let i = 0; i < 100; i += 1) {
      now = new Date(scheduled.getTime() + 80);
      scheduled = computeNextDeadline(scheduled, INTERVAL, MAX_LAG, now);
    }

    expect(scheduled.toISOString()).toBe('2026-01-01T00:08:20.000Z');
  });

  it('re-anchors instead of catching up when the lag exceeds the budget', () => {
    const scheduled = new Date('2026-01-01T00:00:00.000Z');
    // The process was down for a minute -- far beyond the 15s budget.
    const now = new Date('2026-01-01T00:01:00.000Z');

    const next = computeNextDeadline(scheduled, INTERVAL, MAX_LAG, now);

    // now + interval, NOT scheduled + interval. Users must not see eleven
    // eliminations replayed in one frame because a deploy took a minute.
    expect(next.toISOString()).toBe('2026-01-01T00:01:05.000Z');
  });

  it('still catches up when the lag is inside the budget', () => {
    const scheduled = new Date('2026-01-01T00:00:00.000Z');
    // 12s late: over one interval, but under the 15s re-anchor threshold.
    const now = new Date('2026-01-01T00:00:12.000Z');

    const next = computeNextDeadline(scheduled, INTERVAL, MAX_LAG, now);

    // Fires immediately on the next tick, restoring the original cadence.
    expect(next.toISOString()).toBe('2026-01-01T00:00:05.000Z');
    expect(next.getTime()).toBeLessThan(now.getTime());
  });

  it('treats the boundary as catch-up, not re-anchor', () => {
    const scheduled = new Date('2026-01-01T00:00:00.000Z');
    // Exactly MAX_LAG behind the candidate deadline.
    const now = new Date(scheduled.getTime() + INTERVAL + MAX_LAG);

    const next = computeNextDeadline(scheduled, INTERVAL, MAX_LAG, now);

    expect(next.getTime()).toBe(scheduled.getTime() + INTERVAL);
  });
});
