'use strict';

import Homey from 'homey';
import { createClient, EightSleepClient } from './lib/EightSleepClient';

interface ClientEntry {
  client: EightSleepClient;
  refs: number;
}

module.exports = class EightSleepApp extends Homey.App {

  // Shared OAuth clients keyed by account, so both sides of a bed reuse a
  // single token, rate limiter and request queue instead of logging in twice.
  private readonly clients: Map<string, ClientEntry> = new Map();

  async onInit(): Promise<void> {
    this.registerFlowCards();
    this.log('Eight Sleep app has been initialized');
  }

  private registerFlowCards(): void {
    this.homey.flow.getConditionCard('all_sides_away')
      .registerRunListener(async () => {
        const devices = this.homey.drivers.getDriver('bed-side').getDevices();
        const isAway = (d: Homey.Device): boolean => (d as unknown as { isAway(): boolean }).isAway();
        return devices.length > 0 && devices.every(isAway);
      });
  }

  /** Get (or create) the shared client for an account and take a reference. */
  getClient(email: string, password: string): EightSleepClient {
    const key = `${email}\u0000${password}`;
    let entry = this.clients.get(key);
    if (!entry) {
      entry = {
        client: createClient({ email, password, log: (...args: unknown[]) => this.log(...args) }),
        refs: 0,
      };
      this.clients.set(key, entry);
    }
    entry.refs += 1;
    return entry.client;
  }

  /** Release a reference; the client is discarded once no devices use it. */
  releaseClient(email: string, password: string): void {
    const key = `${email}\u0000${password}`;
    const entry = this.clients.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) this.clients.delete(key);
  }

};
