'use strict';

export type NowFn = () => number;
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Serialises async tasks and guarantees a minimum gap between consecutive
 * runs. Keeps the app from hammering Eight Sleep's API. The clock and sleep
 * functions are injectable so the behaviour can be unit-tested deterministically.
 */
export class RateLimiter {
  private last = 0;

  private chain: Promise<unknown> = Promise.resolve();

  private readonly minGapMs: number;

  private readonly now: NowFn;

  private readonly sleep: SleepFn;

  constructor(minGapMs: number, now: NowFn = Date.now, sleep: SleepFn = defaultSleep) {
    this.minGapMs = minGapMs;
    this.now = now;
    this.sleep = sleep;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = this.minGapMs - (this.now() - this.last);
      if (wait > 0) await this.sleep(wait);
      try {
        return await task();
      } finally {
        this.last = this.now();
      }
    });
    // Keep the chain alive even when a task rejects.
    this.chain = result.then(() => undefined, () => undefined);
    return result as Promise<T>;
  }
}
