'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { RateLimiter } = require('../.homeybuild/lib/RateLimiter.js');

test('tasks run serially in submission order', async () => {
  // Virtual clock: sleep advances time, now reads it.
  let clock = 0;
  const now = () => clock;
  const sleep = async (ms) => { clock += ms; };
  const limiter = new RateLimiter(100, now, sleep);

  const order = [];
  const a = limiter.run(async () => { order.push('a-start'); order.push('a-end'); return 1; });
  const b = limiter.run(async () => { order.push('b-start'); order.push('b-end'); return 2; });

  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra, 1);
  assert.strictEqual(rb, 2);
  // b must not start before a finished (serialisation).
  assert.deepStrictEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('a rejecting task does not break the chain', async () => {
  const limiter = new RateLimiter(0);
  await assert.rejects(limiter.run(async () => { throw new Error('boom'); }));
  const ok = await limiter.run(async () => 'recovered');
  assert.strictEqual(ok, 'recovered');
});

test('minimum gap is enforced via sleep', async () => {
  let clock = 0;
  const slept = [];
  const now = () => clock;
  const sleep = async (ms) => { slept.push(ms); clock += ms; };
  const limiter = new RateLimiter(250, now, sleep);

  await limiter.run(async () => 'x');
  await limiter.run(async () => 'y');
  // Second run had to wait the full gap.
  assert.ok(slept.includes(250), `expected a 250ms wait, got ${JSON.stringify(slept)}`);
});
