'use strict';

import Homey from 'homey';
import { EightSleepClient } from '../../lib/EightSleepClient';
import { celsiusToLevel, levelToCelsius } from '../../lib/temperature';
import type { SideMetrics } from '../../lib/types';

interface BedSideStore {
  deviceId: string;
  userId: string;
  side: 'left' | 'right' | 'solo';
  email: string;
  password: string;
}

interface EightSleepAppApi {
  getClient(email: string, password: string): EightSleepClient;
  releaseClient(email: string, password: string): void;
}

module.exports = class EightSleepBedSideDevice extends Homey.Device {

  private client!: EightSleepClient;

  private pollTimer: NodeJS.Timeout | null = null;

  private nextAlarmId: string | null = null;

  private lastPresence: boolean | null = null;

  private lastStage: string | null = null;

  private lastRinging: boolean | null = null;

  private lastWaterLow: boolean | null = null;

  private lastPriming: boolean | null = null;

  private lastSnore: boolean | null = null;

  private baseBound = false;

  private cycle = 0;

  private failures = 0;

  private immediateTimer: NodeJS.Timeout | null = null;

  private static readonly CAPABILITIES = [
    'onoff', 'target_temperature', 'measure_temperature', 'measure_temperature.room',
    'alarm_presence', 'measure_heart_rate', 'measure_hrv', 'measure_breath_rate',
    'sleep_stage', 'sleep_fitness_score', 'sleep_quality_score', 'sleep_routine_score', 'time_slept',
    'next_alarm', 'away_mode', 'alarm_water_low', 'is_priming', 'sleep_fitness_weekly',
    'button.alarm_snooze', 'button.alarm_stop', 'button.prime',
  ];

  private static readonly SNOOZE_MINUTES = 9;

  async onInit(): Promise<void> {
    await this.ensureCapabilities();
    this.lastPresence = this.getStoreValue('lastPresence') ?? null;
    this.lastStage = this.getStoreValue('lastStage') ?? null;
    this.client = this.buildClient();

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await this.client.setSidePower(this.userId(), value);
      this.scheduleImmediateRefresh();
    });

    this.registerCapabilityListener('target_temperature', async (value: number) => {
      await this.client.setSideLevel(this.userId(), celsiusToLevel(value));
      this.scheduleImmediateRefresh();
    });

    this.registerCapabilityListener('button.alarm_snooze', async () => {
      if (!this.nextAlarmId) throw new Error('No alarm to snooze.');
      await this.client.snoozeAlarm(this.userId(), this.nextAlarmId, EightSleepBedSideDevice.SNOOZE_MINUTES);
    });

    this.registerCapabilityListener('button.alarm_stop', async () => {
      if (!this.nextAlarmId) throw new Error('No alarm to stop.');
      await this.client.dismissAlarm(this.userId(), this.nextAlarmId);
    });

    this.registerCapabilityListener('away_mode', async (value: boolean) => {
      await this.client.setAwayMode(this.userId(), value ? 'start' : 'end');
      this.scheduleImmediateRefresh();
    });

    this.registerCapabilityListener('button.prime', async () => {
      await this.client.primePod(this.deviceId(), this.userId());
      this.scheduleImmediateRefresh();
    });

    await this.refresh(true);
    this.scheduleNextPoll();
    this.log(`Eight Sleep bed side initialized (${this.getStoreValue('side')})`);
  }

  /** Add any capabilities introduced after a device was first paired. */
  private async ensureCapabilities(): Promise<void> {
    for (const cap of EightSleepBedSideDevice.CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((err) => this.error(`addCapability ${cap}`, err));
      }
    }
  }

  private buildClient(): EightSleepClient {
    const store = this.getStore() as BedSideStore;
    const app = this.homey.app as unknown as EightSleepAppApi;
    return app.getClient(store.email, store.password);
  }

  private releaseClient(): void {
    const store = this.getStore() as BedSideStore;
    const app = this.homey.app as unknown as EightSleepAppApi;
    app.releaseClient(store.email, store.password);
  }

  private userId(): string {
    return this.getStoreValue('userId');
  }

  private deviceId(): string {
    return this.getStoreValue('deviceId');
  }

  private async refresh(full = true): Promise<void> {
    let reachable = false;
    let lastError: unknown = null;

    try {
      const state = await this.client.getSideState(this.userId());
      await this.setCapabilityValue('onoff', state.isOn);
      await this.setCapabilityValue('target_temperature', levelToCelsius(state.currentLevel));
      reachable = true;
    } catch (err) {
      lastError = err;
      this.error('Failed to refresh Eight Sleep state', err);
    }

    try {
      await this.refreshMetrics();
      reachable = true;
    } catch (err) {
      lastError = err;
      this.error('Failed to refresh Eight Sleep metrics', err);
    }

    if (full) {
      const set = async (cap: string, value: number | boolean | string | null): Promise<void> => {
        await this.setCapabilityValue(cap, value).catch((e) => this.error(`setCapabilityValue ${cap}`, e));
      };
      try {
        await this.refreshDeviceStatus(set);
      } catch (err) {
        this.error('Failed to refresh Eight Sleep device status', err);
      }
      try {
        await this.refreshBase();
      } catch (err) {
        this.error('Failed to refresh Eight Sleep base', err);
      }
      try {
        await this.maybeWeeklySummary();
      } catch (err) {
        this.error('Failed to compute Eight Sleep weekly summary', err);
      }
    }

    this.failures = reachable ? 0 : this.failures + 1;

    if (reachable) {
      if (!this.getAvailable()) await this.setAvailable();
    } else {
      await this.setUnavailable(this.unavailableMessage(lastError)).catch(() => undefined);
    }
  }

  private unavailableMessage(err: unknown): string {
    const status = (err && typeof err === 'object' && 'status' in err)
      ? (err as { status?: number }).status : undefined;
    if (status === 401 || status === 400) {
      return 'Eight Sleep credentials expired — use Repair to re-enter your password.';
    }
    if (status === 429) return 'Eight Sleep rate limit reached — will retry automatically.';
    return 'Could not reach Eight Sleep. Check your internet connection.';
  }

  private async refreshMetrics(): Promise<void> {
    const tz = this.homey.clock.getTimezone();
    const day = 24 * 60 * 60 * 1000;
    const fmt = (d: Date): string => d.toISOString().slice(0, 10);
    const now = Date.now();

    const m = await this.client.getSideMetrics(this.userId(), {
      tz,
      from: fmt(new Date(now - day)),
      to: fmt(new Date(now + day)),
    });

    const set = async (cap: string, value: number | boolean | string | null): Promise<void> => {
      await this.setCapabilityValue(cap, value).catch((err) => this.error(`setCapabilityValue ${cap}`, err));
    };

    await set('alarm_presence', m.bedPresence);
    await set('measure_heart_rate', m.heartRate);
    await set('measure_hrv', m.hrv);
    await set('measure_breath_rate', m.breathRate);
    await set('measure_temperature', m.bedTemp);
    await set('measure_temperature.room', m.roomTemp);
    await set('sleep_stage', m.sleepStage);
    await set('sleep_fitness_score', m.sleepFitnessScore);
    await set('sleep_quality_score', m.sleepQualityScore);
    await set('sleep_routine_score', m.sleepRoutineScore);
    await set('time_slept', m.timeSleptSeconds === null ? null : Math.round((m.timeSleptSeconds / 3600) * 10) / 10);

    await this.fireStateTriggers(m);
    await this.refreshNextAlarm(set);
  }

  /** Helper to fire a device trigger card, swallowing errors. */
  private async fire(card: string, tokens: Record<string, unknown>): Promise<void> {
    await this.homey.flow.getDeviceTriggerCard(card).trigger(this, tokens, {})
      .catch((e) => this.error(`trigger ${card}`, e));
  }

  /** Once per local day, compute 7-day score averages and fire a summary. */
  private async maybeWeeklySummary(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const prev = this.getStoreValue('lastSummaryDate');
    if (prev === today) return;

    const tz = this.homey.clock.getTimezone();
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const fmt = (d: Date): string => d.toISOString().slice(0, 10);
    const avg = await this.client.getWeeklyAverages(this.userId(), {
      tz,
      from: fmt(new Date(now - 7 * dayMs)),
      to: fmt(new Date(now + dayMs)),
    });

    await this.setStoreValue('lastSummaryDate', today).catch(() => undefined);
    await this.setCapabilityValue('sleep_fitness_weekly', avg.fitness).catch(() => undefined);

    if (prev) {
      await this.fire('weekly_summary', {
        avg_fitness: avg.fitness ?? 0,
        avg_quality: avg.quality ?? 0,
        avg_routine: avg.routine ?? 0,
        avg_hours: avg.hours ?? 0,
      });
    }
  }

  private async refreshDeviceStatus(
    set: (cap: string, value: number | boolean | string | null) => Promise<void>,
  ): Promise<void> {
    const status = await this.client.getDeviceStatus(this.deviceId());

    const waterLow = status.hasWater === null ? null : !status.hasWater;
    await set('alarm_water_low', waterLow);
    if (waterLow !== null) {
      if (this.lastWaterLow !== null && waterLow !== this.lastWaterLow) {
        await this.fire(waterLow ? 'water_became_low' : 'water_refilled', {});
      }
      this.lastWaterLow = waterLow;
    }

    await set('is_priming', status.isPriming);
    if (status.isPriming !== null) {
      if (this.lastPriming !== null && status.isPriming !== this.lastPriming) {
        await this.fire(status.isPriming ? 'priming_started' : 'priming_finished', {});
      }
      this.lastPriming = status.isPriming;
    }

    await set('away_mode', status.awayUserIds.includes(this.userId()));
  }

  /** Detect and reflect an adjustable base, adding its capabilities on demand. */
  private async refreshBase(): Promise<void> {
    const side = this.getStoreValue('side');
    const base = await this.client.getBase(this.userId(), side);
    if (!base) return;

    await this.bindBaseCapabilities();

    const set = async (cap: string, value: number | boolean | string | null): Promise<void> => {
      await this.setCapabilityValue(cap, value).catch((err) => this.error(`setCapabilityValue ${cap}`, err));
    };
    await set('base_head_angle', base.torsoAngle);
    await set('base_feet_angle', base.legAngle);
    await set('base_snore_mitigation', base.snoreMitigation);
    if (base.preset) await set('base_preset', base.preset);

    if (this.lastSnore !== null && base.snoreMitigation !== this.lastSnore) {
      await this.fire(base.snoreMitigation ? 'snore_mitigation_started' : 'snore_mitigation_stopped', {});
    }
    this.lastSnore = base.snoreMitigation;
  }

  private async bindBaseCapabilities(): Promise<void> {
    if (this.baseBound) return;
    this.baseBound = true;

    for (const cap of ['base_head_angle', 'base_feet_angle', 'base_snore_mitigation', 'base_preset']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((err) => this.error(`addCapability ${cap}`, err));
      }
    }

    this.registerCapabilityListener('base_head_angle', async (value: number) => {
      const feet = Number(this.getCapabilityValue('base_feet_angle') ?? 0);
      await this.client.setBaseAngle(this.userId(), this.deviceId(), feet, value);
    });

    this.registerCapabilityListener('base_feet_angle', async (value: number) => {
      const head = Number(this.getCapabilityValue('base_head_angle') ?? 0);
      await this.client.setBaseAngle(this.userId(), this.deviceId(), value, head);
    });

    this.registerCapabilityListener('base_preset', async (value: string) => {
      await this.client.setBasePreset(this.userId(), this.deviceId(), value);
    });
  }

  private async fireStateTriggers(m: SideMetrics): Promise<void> {
    const presence = m.bedPresence;
    if (presence !== null && presence !== this.lastPresence) {
      if (this.lastPresence !== null) {
        if (presence) {
          await this.fire('presence_started', {
            bed_temperature: m.bedTemp ?? 0,
            target_temperature: Number(this.getCapabilityValue('target_temperature') ?? 0),
          });
        } else {
          await this.fire('presence_stopped', {});
          await this.fire('sleep_session_ended', {
            hours_slept: m.timeSleptSeconds === null ? 0 : Math.round((m.timeSleptSeconds / 3600) * 10) / 10,
            fitness_score: m.sleepFitnessScore ?? 0,
            quality_score: m.sleepQualityScore ?? 0,
            routine_score: m.sleepRoutineScore ?? 0,
          });
        }
      }
      this.lastPresence = presence;
      await this.setStoreValue('lastPresence', presence).catch(() => undefined);
    }

    const stage = m.sleepStage;
    if (stage !== null && stage !== this.lastStage) {
      if (this.lastStage !== null) {
        await this.fire('sleep_stage_changed', { stage, previous_stage: this.lastStage });
      }
      this.lastStage = stage;
      await this.setStoreValue('lastStage', stage).catch(() => undefined);
    }
  }

  private async refreshNextAlarm(
    set: (cap: string, value: number | boolean | string | null) => Promise<void>,
  ): Promise<void> {
    const alarm = await this.client.getNextAlarm(this.userId());
    this.nextAlarmId = alarm?.id ?? null;

    // Detect ring start/stop for Flow.
    const now = Date.now();
    const start = alarm?.startTimestamp ? Date.parse(alarm.startTimestamp) : NaN;
    const end = alarm?.endTimestamp ? Date.parse(alarm.endTimestamp) : NaN;
    const ringing = !!alarm
      && (alarm.snoozing === true
        || (Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end));
    if (this.lastRinging !== null && ringing !== this.lastRinging) {
      if (ringing) await this.fire('alarm_ringing', { time: alarm?.time ?? '' });
      else await this.fire('alarm_dismissed', {});
    }
    this.lastRinging = ringing;

    if (!alarm?.nextTimestamp) {
      await set('next_alarm', null);
      return;
    }

    const when = new Date(alarm.nextTimestamp);
    const tz = this.homey.clock.getTimezone();
    const lang = this.homey.i18n.getLanguage() || 'en-GB';
    const label = when.toLocaleString(lang, {
      weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz,
    });
    await set('next_alarm', label);
  }

  /** Self-scheduling poll with jitter, error backoff and a slow tier. */
  private scheduleNextPoll(): void {
    this.stopPolling();
    const minutes = Math.max(1, Number(this.getSetting('poll_interval') ?? 5));
    const base = minutes * 60_000;
    const backoff = 2 ** Math.min(this.failures, 4); // up to 16x on repeated failures
    const jitter = 0.85 + Math.random() * 0.3; // ±15%
    const delay = Math.min(base * backoff * jitter, 60 * 60_000);
    this.pollTimer = this.homey.setTimeout(() => {
      this.poll().catch(() => undefined).finally(() => this.scheduleNextPoll());
    }, delay);
  }

  private async poll(): Promise<void> {
    this.cycle += 1;
    // Run the slow tier (water/priming/base) roughly every 30 minutes.
    const minutes = Math.max(1, Number(this.getSetting('poll_interval') ?? 5));
    const slowEvery = Math.max(1, Math.round(30 / minutes));
    const full = this.cycle % slowEvery === 0;
    await this.refresh(full);
  }

  /** Re-read state shortly after a write so the UI reflects it quickly. */
  private scheduleImmediateRefresh(): void {
    if (this.immediateTimer) this.homey.clearTimeout(this.immediateTimer);
    this.immediateTimer = this.homey.setTimeout(() => {
      this.refresh(false).catch(() => undefined);
    }, 2_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async onSettings({ changedKeys }: { changedKeys: string[] }): Promise<void> {
    if (changedKeys.includes('poll_interval')) this.scheduleNextPoll();
  }

  // ---- Methods invoked by Flow cards (registered in the driver) ----

  async flowSetTemperature(celsius: number): Promise<void> {
    await this.client.setSideLevel(this.userId(), celsiusToLevel(celsius));
    await this.setCapabilityValue('target_temperature', celsius).catch(() => undefined);
  }

  async flowSetPower(on: boolean): Promise<void> {
    await this.client.setSidePower(this.userId(), on);
    await this.setCapabilityValue('onoff', on).catch(() => undefined);
  }

  async flowSnoozeAlarm(minutes: number): Promise<void> {
    if (!this.nextAlarmId) throw new Error('No alarm to snooze.');
    await this.client.snoozeAlarm(this.userId(), this.nextAlarmId, minutes);
  }

  async flowStopAlarm(): Promise<void> {
    if (!this.nextAlarmId) throw new Error('No alarm to stop.');
    await this.client.dismissAlarm(this.userId(), this.nextAlarmId);
  }

  async flowSetOneOffAlarm(time: string): Promise<void> {
    await this.client.setOneOffAlarm(this.userId(), { time });
  }

  async flowSetAway(on: boolean): Promise<void> {
    await this.client.setAwayMode(this.userId(), on ? 'start' : 'end');
    await this.setCapabilityValue('away_mode', on).catch(() => undefined);
  }

  async flowPrime(): Promise<void> {
    await this.client.primePod(this.deviceId(), this.userId());
  }

  async flowSetBasePreset(preset: string): Promise<void> {
    await this.client.setBasePreset(this.userId(), this.deviceId(), preset);
    await this.setCapabilityValue('base_preset', preset).catch(() => undefined);
  }

  async flowSetHeadAngle(angle: number): Promise<void> {
    const feet = Number(this.getCapabilityValue('base_feet_angle') ?? 0);
    await this.client.setBaseAngle(this.userId(), this.deviceId(), feet, angle);
    await this.setCapabilityValue('base_head_angle', angle).catch(() => undefined);
  }

  async flowSetFeetAngle(angle: number): Promise<void> {
    const head = Number(this.getCapabilityValue('base_head_angle') ?? 0);
    await this.client.setBaseAngle(this.userId(), this.deviceId(), angle, head);
    await this.setCapabilityValue('base_feet_angle', angle).catch(() => undefined);
  }

  isAway(): boolean {
    return this.getCapabilityValue('away_mode') === true;
  }

  /** Snapshot of the side's state for the dashboard widget. */
  getWidgetState(): {
    name: string; on: boolean; target: number | null; bedTemp: number | null;
    presence: boolean; heartRate: number | null; stage: string | null;
    nextAlarm: string | null; away: boolean; waterLow: boolean;
    } {
    return {
      name: this.getName(),
      on: this.getCapabilityValue('onoff') === true,
      target: this.getCapabilityValue('target_temperature') ?? null,
      bedTemp: this.getCapabilityValue('measure_temperature') ?? null,
      presence: this.getCapabilityValue('alarm_presence') === true,
      heartRate: this.getCapabilityValue('measure_heart_rate') ?? null,
      stage: this.getCapabilityValue('sleep_stage') ?? null,
      nextAlarm: this.getCapabilityValue('next_alarm') ?? null,
      away: this.getCapabilityValue('away_mode') === true,
      waterLow: this.getCapabilityValue('alarm_water_low') === true,
    };
  }

  isPresent(): boolean {
    return this.getCapabilityValue('alarm_presence') === true;
  }

  isSideOn(): boolean {
    return this.getCapabilityValue('onoff') === true;
  }

  async onUninit(): Promise<void> {
    this.stopPolling();
    if (this.immediateTimer) this.homey.clearTimeout(this.immediateTimer);
    this.releaseClient();
  }

  async onDeleted(): Promise<void> {
    this.stopPolling();
    if (this.immediateTimer) this.homey.clearTimeout(this.immediateTimer);
    this.releaseClient();
  }

};
