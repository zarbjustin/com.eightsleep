'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { EightSleepClient, EightSleepError } = require('../.homeybuild/lib/EightSleepClient.js');

const okJson = (value) => ({
  ok: true, status: 200, json: async () => value, text: async () => '',
});
const errStatus = (status, body = '') => ({
  ok: false, status, json: async () => ({}), text: async () => body,
});

/** Build a client with a routed fetch stub and a virtual clock/sleep. */
function makeClient(router, extra = {}) {
  const slept = [];
  let clock = 0;
  const client = new EightSleepClient({
    email: 'a@b.com',
    password: 'pw',
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    fetchImpl: (url, init) => router(url, init),
    ...extra,
  });
  return { client, slept };
}

test('invalid credentials throw an EightSleepError with the auth status', async () => {
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(errStatus(401, 'bad creds'));
    return Promise.resolve(okJson({}));
  });
  await assert.rejects(client.authenticate(), (e) => {
    assert.ok(e instanceof EightSleepError);
    assert.strictEqual(e.status, 401);
    return true;
  });
});

test('authenticate resolves the primary user id from /users/me', async () => {
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    return Promise.resolve(okJson({}));
  });
  const token = await client.authenticate();
  assert.strictEqual(token.userId, 'u1');
  assert.strictEqual(client.userId, 'u1');
});

test('a 401 on an API call triggers exactly one re-auth then retries', async () => {
  let auths = 0;
  let deviceCalls = 0;
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) { auths += 1; return Promise.resolve(okJson({ access_token: `t${auths}`, expires_in: 3600 })); }
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/devices/')) {
      deviceCalls += 1;
      if (deviceCalls === 1) return Promise.resolve(errStatus(401));
      return Promise.resolve(okJson({ result: { leftUserId: 'u1' } }));
    }
    return Promise.resolve(okJson({}));
  });

  const out = await client.getDevice('dev1');
  assert.strictEqual(out.result.leftUserId, 'u1');
  assert.strictEqual(auths, 2, 'should authenticate once up-front and once after the 401');
  assert.strictEqual(deviceCalls, 2);
});

test('a 429 backs off with exponential delay then succeeds', async () => {
  let deviceCalls = 0;
  const { client, slept } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/devices/')) {
      deviceCalls += 1;
      if (deviceCalls <= 2) return Promise.resolve(errStatus(429));
      return Promise.resolve(okJson({ result: { leftUserId: 'u1' } }));
    }
    return Promise.resolve(okJson({}));
  });

  const out = await client.getDevice('dev1');
  assert.strictEqual(out.result.leftUserId, 'u1');
  assert.strictEqual(deviceCalls, 3);
  assert.ok(slept.includes(1000), `expected 1000ms backoff, got ${JSON.stringify(slept)}`);
  assert.ok(slept.includes(2000), `expected 2000ms backoff, got ${JSON.stringify(slept)}`);
});

test('discoverBedSides returns one ref per occupied side', async () => {
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1', devices: ['dev1'] } }));
    if (url.includes('/devices/')) return Promise.resolve(okJson({ result: { leftUserId: 'u1', rightUserId: 'u2' } }));
    return Promise.resolve(okJson({}));
  });

  const sides = await client.discoverBedSides();
  assert.strictEqual(sides.length, 2);
  assert.deepStrictEqual(sides.map((s) => s.side).sort(), ['left', 'right']);
  assert.deepStrictEqual(sides.map((s) => s.userId).sort(), ['u1', 'u2']);
});

test('a single-occupant bed yields one solo side', async () => {
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1', devices: ['dev1'] } }));
    if (url.includes('/devices/')) return Promise.resolve(okJson({ result: { leftUserId: 'u1', rightUserId: 'u1' } }));
    return Promise.resolve(okJson({}));
  });

  const sides = await client.discoverBedSides();
  assert.strictEqual(sides.length, 1);
  assert.strictEqual(sides[0].side, 'solo');
});

test('setSideLevel PUTs a clamped integer currentLevel', async () => {
  let captured = null;
  const { client } = makeClient((url, init) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/temperature')) { captured = init; return Promise.resolve(okJson({})); }
    return Promise.resolve(okJson({}));
  });

  await client.setSideLevel('u1', 250.7);
  assert.strictEqual(captured.method, 'put');
  assert.deepStrictEqual(JSON.parse(captured.body), { currentLevel: 100 });
});

test('getSideMetrics parses biometrics and sleep scores from the latest trend day', async () => {
  const trends = {
    days: [
      {
        score: 82,
        sleepDuration: 27000,
        presenceStart: '2026-06-19T23:00:00.000Z',
        sleepQualityScore: { total: 90, hrv: { current: 55 }, respiratoryRate: { current: 14.2 } },
        sleepRoutineScore: { total: 75 },
        sessions: [
          {
            timeseries: {
              heartRate: [['t1', 60], ['t2', 58]],
              tempRoomC: [['t1', 20.5]],
              tempBedC: [['t1', 30.1]],
            },
            stages: [{ stage: 'light' }, { stage: 'deep' }],
          },
        ],
      },
    ],
  };
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/trends')) return Promise.resolve(okJson(trends));
    return Promise.resolve(okJson({}));
  });

  const m = await client.getSideMetrics('u1', { tz: 'Europe/London', from: '2026-06-18', to: '2026-06-20' });
  assert.strictEqual(m.heartRate, 58);
  assert.strictEqual(m.hrv, 55);
  assert.strictEqual(m.breathRate, 14.2);
  assert.strictEqual(m.roomTemp, 20.5);
  assert.strictEqual(m.bedTemp, 30.1);
  assert.strictEqual(m.sleepStage, 'deep');
  assert.strictEqual(m.sleepFitnessScore, 82);
  assert.strictEqual(m.sleepQualityScore, 90);
  assert.strictEqual(m.sleepRoutineScore, 75);
  assert.strictEqual(m.timeSleptSeconds, 27000);
  assert.strictEqual(m.bedPresence, true);
});

test('getSideMetrics reports bed empty (false) once presence has ended', async () => {
  const trends = {
    days: [{
      score: 80,
      presenceStart: '2026-06-19T23:00:00.000Z',
      presenceEnd: '2026-06-20T06:30:00.000Z',
      sessions: [{ timeseries: { heartRate: [['t1', 55]] }, stages: [{ stage: 'awake' }] }],
    }],
  };
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/trends')) return Promise.resolve(okJson(trends));
    return Promise.resolve(okJson({}));
  });
  const m = await client.getSideMetrics('u1', { tz: 'UTC', from: '2026-06-18', to: '2026-06-20' });
  assert.strictEqual(m.bedPresence, false);
});

test('getSideMetrics reports present again when presenceStart is newer than presenceEnd', async () => {
  // The sleeper got out of bed (presenceEnd) and then got back in (a newer
  // presenceStart) within the same trend-day record. Presence must read true.
  const trends = {
    days: [{
      score: 80,
      presenceEnd: '2026-06-20T06:30:00.000Z',
      presenceStart: '2026-06-20T07:15:00.000Z',
      sessions: [{ timeseries: { heartRate: [['t1', 55]] }, stages: [{ stage: 'light' }] }],
    }],
  };
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/trends')) return Promise.resolve(okJson(trends));
    return Promise.resolve(okJson({}));
  });
  const m = await client.getSideMetrics('u1', { tz: 'UTC', from: '2026-06-18', to: '2026-06-20' });
  assert.strictEqual(m.bedPresence, true);
});

test('getSideMetrics reports present when heart rate is live even though presenceEnd is set', async () => {
  // Real-world bug (Jeff's report): Eight Sleep writes a session presenceEnd that
  // lags the live data, but the Pod keeps streaming heart rate while the sleeper
  // is still in bed. A recent heart-rate sample must win over the stale marker.
  const now = Date.parse('2026-06-20T07:00:00.000Z');
  const trends = {
    days: [{
      score: 80,
      presenceStart: '2026-06-19T23:00:00.000Z',
      presenceEnd: '2026-06-20T06:30:00.000Z',
      sessions: [{ timeseries: { heartRate: [['2026-06-19T23:05:00.000Z', 60], ['2026-06-20T06:58:00.000Z', 58]] }, stages: [{ stage: 'light' }] }],
    }],
  };
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/trends')) return Promise.resolve(okJson(trends));
    return Promise.resolve(okJson({}));
  }, { now: () => now });
  const m = await client.getSideMetrics('u1', { tz: 'UTC', from: '2026-06-18', to: '2026-06-20' });
  assert.strictEqual(m.bedPresence, true);
});

test('getSideMetrics reports bed empty when the last heart-rate sample is stale', async () => {
  // No live heart rate for over the presence window and no active markers -> empty.
  const now = Date.parse('2026-06-20T07:00:00.000Z');
  const trends = {
    days: [{
      score: 80,
      presenceStart: '2026-06-19T23:00:00.000Z',
      presenceEnd: '2026-06-20T06:30:00.000Z',
      sessions: [{ timeseries: { heartRate: [['2026-06-20T06:00:00.000Z', 55]] }, stages: [{ stage: 'awake' }] }],
    }],
  };
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/trends')) return Promise.resolve(okJson(trends));
    return Promise.resolve(okJson({}));
  }, { now: () => now });
  const m = await client.getSideMetrics('u1', { tz: 'UTC', from: '2026-06-18', to: '2026-06-20' });
  assert.strictEqual(m.bedPresence, false);
});

test('getSideMetrics ignores a trailing empty trend day and reads the active one', async () => {
  // The API can return an empty placeholder "tomorrow" day. Selecting it would
  // wrongly report the bed as empty while the real night sits in the prior day.
  const trends = {
    days: [
      {
        score: 82,
        presenceStart: '2026-06-19T23:00:00.000Z',
        sessions: [{ timeseries: { heartRate: [['t1', 58]] }, stages: [{ stage: 'deep' }] }],
      },
      {},
    ],
  };
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/trends')) return Promise.resolve(okJson(trends));
    return Promise.resolve(okJson({}));
  });
  const m = await client.getSideMetrics('u1', { tz: 'UTC', from: '2026-06-18', to: '2026-06-20' });
  assert.strictEqual(m.bedPresence, true);
  assert.strictEqual(m.heartRate, 58);
  assert.strictEqual(m.sleepStage, 'deep');
});

test('getSideMetrics withholds scores while the night is still processing', async () => {
  const trends = {
    days: [{
      processing: true, score: 0, presenceStart: '2026-06-19T23:00:00.000Z', sessions: [],
    }],
  };
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/trends')) return Promise.resolve(okJson(trends));
    return Promise.resolve(okJson({}));
  });
  const m = await client.getSideMetrics('u1', { tz: 'UTC', from: '2026-06-18', to: '2026-06-20' });
  assert.strictEqual(m.sleepFitnessScore, null);
  assert.strictEqual(m.bedPresence, true);
});

test('getSideMetrics returns all-null metrics when there is no trend data', async () => {
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/trends')) return Promise.resolve(okJson({ days: [] }));
    return Promise.resolve(okJson({}));
  });

  const m = await client.getSideMetrics('u1', { tz: 'UTC', from: '2026-06-18', to: '2026-06-20' });
  assert.strictEqual(m.heartRate, null);
  assert.strictEqual(m.bedPresence, null);
  assert.strictEqual(m.sleepStage, null);
});

test('setSidePower PUTs smart when on and off when off', async () => {
  const bodies = [];
  const { client } = makeClient((url, init) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/temperature')) { bodies.push(JSON.parse(init.body)); return Promise.resolve(okJson({})); }
    return Promise.resolve(okJson({}));
  });

  await client.setSidePower('u1', true);
  await client.setSidePower('u1', false);
  assert.deepStrictEqual(bodies, [
    { currentState: { type: 'smart' } },
    { currentState: { type: 'off' } },
  ]);
});

test('getNextAlarm picks the soonest enabled, not-yet-finished alarm', async () => {
  const future = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  const past = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  const alarms = {
    alarms: [
      { id: 'a-disabled', enabled: false, nextTimestamp: future(10) },
      { id: 'a-late', enabled: true, nextTimestamp: future(120) },
      { id: 'a-soon', enabled: true, nextTimestamp: future(30) },
      { id: 'a-done', enabled: true, nextTimestamp: past(60), endTimestamp: past(30) },
    ],
  };
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/alarms')) return Promise.resolve(okJson(alarms));
    return Promise.resolve(okJson({}));
  });

  const next = await client.getNextAlarm('u1');
  assert.strictEqual(next.id, 'a-soon');
});

test('snoozeAlarm PUTs snoozeMinutes to the alarm snooze endpoint', async () => {
  let captured = null;
  const { client } = makeClient((url, init) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/snooze')) { captured = { url, init }; return Promise.resolve(okJson({})); }
    return Promise.resolve(okJson({}));
  });

  await client.snoozeAlarm('u1', 'alarm-9', 9);
  assert.ok(captured.url.endsWith('/v1/users/u1/alarms/alarm-9/snooze'));
  assert.deepStrictEqual(JSON.parse(captured.init.body), { snoozeMinutes: 9, ignoreDeviceErrors: false });
});

test('concurrent requests trigger only one authentication', async () => {
  let auths = 0;
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) { auths += 1; return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 })); }
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/devices/')) return Promise.resolve(okJson({ result: { leftUserId: 'u1' } }));
    return Promise.resolve(okJson({}));
  });

  await Promise.all([client.getMe(), client.getDevice('d1'), client.getDevice('d2')]);
  assert.strictEqual(auths, 1);
});

test('a non-recoverable API error throws a sanitized EightSleepError carrying the status', async () => {
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/devices/')) return Promise.resolve(errStatus(500, 'secret response body'));
    return Promise.resolve(okJson({}));
  });

  await assert.rejects(client.getDevice('d1'), (e) => {
    assert.ok(e instanceof EightSleepError);
    assert.strictEqual(e.status, 500);
    assert.ok(!e.message.includes('d1'));
    assert.ok(!e.message.includes('secret response body'));
    assert.strictEqual(e.body, undefined);
    return true;
  });
});

test('getDeviceStatus normalises water, priming and away occupants', async () => {
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/devices/')) {
      return Promise.resolve(okJson({
        result: {
          hasWater: false, priming: true, needsPriming: true, awaySides: { left: 'u1' },
        },
      }));
    }
    return Promise.resolve(okJson({}));
  });

  const s = await client.getDeviceStatus('d1');
  assert.strictEqual(s.hasWater, false);
  assert.strictEqual(s.isPriming, true);
  assert.strictEqual(s.needsPriming, true);
  assert.deepStrictEqual(s.awayUserIds, ['u1']);
});

test('getWeeklyAverages averages finished days and ignores processing ones', async () => {
  const trends = {
    days: [
      { score: 80, sleepDuration: 25200, sleepQualityScore: { total: 90 }, sleepRoutineScore: { total: 70 } },
      { score: 90, sleepDuration: 28800, sleepQualityScore: { total: 80 }, sleepRoutineScore: { total: 80 } },
      { processing: true, score: 0, sleepDuration: 0 },
    ],
  };
  const { client } = makeClient((url) => {
    if (url.endsWith('/v1/tokens')) return Promise.resolve(okJson({ access_token: 't1', expires_in: 3600 }));
    if (url.endsWith('/users/me')) return Promise.resolve(okJson({ user: { userId: 'u1' } }));
    if (url.includes('/trends')) return Promise.resolve(okJson(trends));
    return Promise.resolve(okJson({}));
  });

  const a = await client.getWeeklyAverages('u1', { tz: 'UTC', from: '2026-06-13', to: '2026-06-20' });
  assert.strictEqual(a.days, 2);
  assert.strictEqual(a.fitness, 85);
  assert.strictEqual(a.quality, 85);
  assert.strictEqual(a.routine, 75);
  assert.strictEqual(a.hours, 7.5);
});
