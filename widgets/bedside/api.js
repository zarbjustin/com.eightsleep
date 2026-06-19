'use strict';

/**
 * Widget API. Each handler receives the app `homey` instance and reaches the
 * Eight Sleep bed-side devices through the driver. Devices are matched on the
 * data.id assigned during pairing.
 */

function getDevices(homey) {
  return homey.drivers.getDriver('bed-side').getDevices();
}

function resolveDevice(homey, id) {
  const devices = getDevices(homey);
  const device = (id && devices.find((d) => d.getData().id === id)) || devices[0];
  if (!device) throw new Error('No Eight Sleep bed side has been added yet.');
  return device;
}

module.exports = {
  async getSides({ homey }) {
    return getDevices(homey).map((d) => ({ id: d.getData().id, name: d.getName() }));
  },

  async getState({ homey, query }) {
    const device = resolveDevice(homey, query.id);
    return { id: device.getData().id, ...device.getWidgetState() };
  },

  async setPower({ homey, body }) {
    const device = resolveDevice(homey, body.id);
    await device.flowSetPower(Boolean(body.on));
    return { id: device.getData().id, ...device.getWidgetState() };
  },

  async setTemperature({ homey, body }) {
    const device = resolveDevice(homey, body.id);
    await device.flowSetTemperature(Number(body.celsius));
    return { id: device.getData().id, ...device.getWidgetState() };
  },
};
