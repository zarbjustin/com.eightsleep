'use strict';

import Homey from 'homey';
import { createClient } from '../../lib/EightSleepClient';
import type { BedSideRef } from '../../lib/types';

interface Credentials {
  email: string;
  password: string;
}

// Structural type for the device methods the Flow cards call.
interface BedSideDevice extends Homey.Device {
  flowSetTemperature(celsius: number): Promise<void>;
  flowSetPower(on: boolean): Promise<void>;
  flowSnoozeAlarm(minutes: number): Promise<void>;
  flowStopAlarm(): Promise<void>;
  flowSetOneOffAlarm(time: string): Promise<void>;
  isPresent(): boolean;
  isSideOn(): boolean;
}

type FlowArgs<T> = T & { device: BedSideDevice };

function sideLabel(side: BedSideRef['side']): string {
  if (side === 'left') return 'Left Side';
  if (side === 'right') return 'Right Side';
  return 'Bed';
}

module.exports = class EightSleepBedSideDriver extends Homey.Driver {

  async onInit(): Promise<void> {
    this.registerFlowCards();
    this.log('Eight Sleep bed-side driver initialized');
  }

  private registerFlowCards(): void {
    this.homey.flow.getConditionCard('is_present')
      .registerRunListener(async ({ device }: FlowArgs<unknown>) => device.isPresent());

    this.homey.flow.getConditionCard('side_is_on')
      .registerRunListener(async ({ device }: FlowArgs<unknown>) => device.isSideOn());

    this.homey.flow.getActionCard('set_temperature')
      .registerRunListener(async ({ device, temperature }: FlowArgs<{ temperature: number }>) => {
        await device.flowSetTemperature(temperature);
      });

    this.homey.flow.getActionCard('turn_on')
      .registerRunListener(async ({ device }: FlowArgs<unknown>) => {
        await device.flowSetPower(true);
      });

    this.homey.flow.getActionCard('turn_off')
      .registerRunListener(async ({ device }: FlowArgs<unknown>) => {
        await device.flowSetPower(false);
      });

    this.homey.flow.getActionCard('snooze_alarm')
      .registerRunListener(async ({ device, minutes }: FlowArgs<{ minutes: number }>) => {
        await device.flowSnoozeAlarm(minutes);
      });

    this.homey.flow.getActionCard('stop_alarm')
      .registerRunListener(async ({ device }: FlowArgs<unknown>) => {
        await device.flowStopAlarm();
      });

    this.homey.flow.getActionCard('set_one_off_alarm')
      .registerRunListener(async ({ device, time }: FlowArgs<{ time: string }>) => {
        await device.flowSetOneOffAlarm(time);
      });
  }

  /**
   * Pairing: the login_credentials view validates the account, then we discover
   * every bed side on the account and present them as devices to add.
   */
  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    let credentials: Credentials | null = null;

    session.setHandler('login', async (data: { username: string; password: string }) => {
      const client = createClient({ email: data.username, password: data.password });
      await client.authenticate();
      credentials = { email: data.username, password: data.password };
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!credentials) throw new Error('Not logged in.');
      const creds = credentials;
      const client = createClient({ email: creds.email, password: creds.password });
      const sides = await client.discoverBedSides();

      return sides.map((s) => ({
        name: `Eight Sleep ${sideLabel(s.side)}`,
        data: { id: `${s.deviceId}:${s.side}` },
        store: {
          deviceId: s.deviceId,
          userId: s.userId,
          side: s.side,
          email: creds.email,
          password: creds.password,
        },
      }));
    });
  }

  /**
   * Repair: re-enter the Eight Sleep credentials for an existing device. We
   * validate them, then persist them to the device's store.
   */
  async onRepair(session: Homey.Driver.PairSession, device: Homey.Device): Promise<void> {
    session.setHandler('login', async (data: { username: string; password: string }) => {
      const client = createClient({ email: data.username, password: data.password });
      await client.authenticate();
      await device.setStoreValue('email', data.username);
      await device.setStoreValue('password', data.password);
      return true;
    });
  }

};
