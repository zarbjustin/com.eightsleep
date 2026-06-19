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

  async onInit(): Promise<void> {
    this.client = this.buildClient();

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await this.client.setSidePower(this.userId(), value);
    });

    this.registerCapabilityListener('target_temperature', async (value: number) => {
      await this.client.setSideLevel(this.userId(), celsiusToLevel(value));
    });

    await this.refresh();
    this.startPolling();
    this.log(`Eight Sleep bed side initialized (${this.getStoreValue('side')})`);
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

  private async refresh(): Promise<void> {
    try {
      const state = await this.client.getSideState(this.userId());
      await this.setCapabilityValue('onoff', state.isOn);
      await this.setCapabilityValue('target_temperature', levelToCelsius(state.currentLevel));
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Failed to refresh Eight Sleep state', err);
      await this.setUnavailable('Could not reach Eight Sleep.').catch(() => undefined);
    }
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

  async onUninit(): Promise<void> {
    this.stopPolling();
  }

  async onDeleted(): Promise<void> {
    this.stopPolling();
  }

};
