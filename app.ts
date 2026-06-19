'use strict';

import Homey from 'homey';

module.exports = class EightSleepApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit(): Promise<void> {
    this.log('Eight Sleep app has been initialized');
  }

};
