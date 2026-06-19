'use strict';

import Homey from 'homey';
import { createClient, EightSleepClient } from '../../lib/EightSleepClient';
import { celsiusToLevel, levelToCelsius } from '../../lib/temperature';

interface BedSideStore {
  deviceId: string;
  userId: string;
  side: 'left' | 'right' | 'solo';
  email: string;
  password: string;
}

module.exports = class EightSleepBedSideDevice extends Homey.Device {

  private client!: EightSleepClient;

  private pollTimer: NodeJS.Timeout | null = null;

  private nextAlarmId: string | null = null;

  private lastPresence: boolean | null = null;

  private lastStage: string | null = null;

  private static readonly CAPABILITIES = [
    'onoff', 'target_temperature', 'measure_temperature', 'measure_temperature.room',
    'alarm_presence', 'measure_heart_rate', 'measure_hrv', 'measure_breath_rate',
    'sleep_stage', 'sleep_fitness_score', 'sleep_quality_score', 'sleep_routine_score', 'time_slept',
    'next_alarm', 'away_mode', 'alarm_water_low', 'is_priming',
    'button.alarm_snooze', 'button.alarm_stop', 'button.prime',
  ];

  private static readonly SNOOZE_MINUTES = 9;

  async onInit(): Promise<void> {
    await this.ensureCapabilities();
    this.client = this.buildClient();

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await this.client.setSidePower(this.userId(), value);
    });

    this.registerCapabilityListener('target_temperature', async (value: number) => {
      await this.client.setSideLevel(this.userId(), celsiusToLevel(value));
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
    });

    this.registerCapabilityListener('button.prime', async () => {
      await this.client.primePod(this.deviceId(), this.userId());
    });

    await this.refresh();
    this.startPolling();
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
    return createClient({
      email: store.email,
      password: store.password,
      log: (...args: unknown[]) => this.log(...args),
    });
  }

  private userId(): string {
    return this.getStoreValue('userId');
  }

  private deviceId(): string {
    return this.getStoreValue('deviceId');
  }

  private async refresh(): Promise<void> {
    let reachable = false;
    try {
      const state = await this.client.getSideState(this.userId());
      await this.setCapabilityValue('onoff', state.isOn);
      await this.setCapabilityValue('target_temperature', levelToCelsius(state.currentLevel));
      reachable = true;
    } catch (err) {
      this.error('Failed to refresh Eight Sleep state', err);
    }

    try {
      await this.refreshMetrics();
      reachable = true;
    } catch (err) {
      this.error('Failed to refresh Eight Sleep metrics', err);
    }

    if (reachable) {
      if (!this.getAvailable()) await this.setAvailable();
    } else {
      await this.setUnavailable('Could not reach Eight Sleep.').catch(() => undefined);
    }
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

    await this.fireStateTriggers(m.bedPresence, m.sleepStage);
    await this.refreshNextAlarm(set);
    await this.refreshDeviceStatus(set);
  }

  private async refreshDeviceStatus(
    set: (cap: string, value: number | boolean | string | null) => Promise<void>,
  ): Promise<void> {
    const status = await this.client.getDeviceStatus(this.deviceId());
    await set('alarm_water_low', status.hasWater === null ? null : !status.hasWater);
    await set('is_priming', status.isPriming);
    await set('away_mode', status.awayUserIds.includes(this.userId()));
  }

  private async fireStateTriggers(presence: boolean | null, stage: string | null): Promise<void> {
    if (presence !== null && presence !== this.lastPresence) {
      const card = presence ? 'presence_started' : 'presence_stopped';
      if (this.lastPresence !== null) {
        await this.homey.flow.getDeviceTriggerCard(card).trigger(this, {}, {}).catch((e) => this.error('trigger', e));
      }
      this.lastPresence = presence;
    }

    if (stage !== null && stage !== this.lastStage) {
      if (this.lastStage !== null) {
        await this.homey.flow.getDeviceTriggerCard('sleep_stage_changed')
          .trigger(this, { stage }, {}).catch((e) => this.error('trigger', e));
      }
      this.lastStage = stage;
    }
  }

  private async refreshNextAlarm(
    set: (cap: string, value: number | boolean | string | null) => Promise<void>,
  ): Promise<void> {
    const alarm = await this.client.getNextAlarm(this.userId());
    this.nextAlarmId = alarm?.id ?? null;

    if (!alarm?.nextTimestamp) {
      await set('next_alarm', null);
      return;
    }

    const when = new Date(alarm.nextTimestamp);
    const tz = this.homey.clock.getTimezone();
    const label = when.toLocaleString('en-GB', {
      weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz,
    });
    await set('next_alarm', label);
  }

  private startPolling(): void {
    this.stopPolling();
    const minutes = Number(this.getSetting('poll_interval') ?? 5);
    const intervalMs = Math.max(1, minutes) * 60_000;
    this.pollTimer = this.homey.setInterval(() => {
      this.refresh().catch(() => undefined);
    }, intervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      this.homey.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async onSettings({ changedKeys }: { changedKeys: string[] }): Promise<void> {
    if (changedKeys.includes('poll_interval')) this.startPolling();
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

  isAway(): boolean {
    return this.getCapabilityValue('away_mode') === true;
  }

  isPresent(): boolean {
    return this.getCapabilityValue('alarm_presence') === true;
  }

  isSideOn(): boolean {
    return this.getCapabilityValue('onoff') === true;
  }

  async onUninit(): Promise<void> {
    this.stopPolling();
  }

  async onDeleted(): Promise<void> {
    this.stopPolling();
  }

};
