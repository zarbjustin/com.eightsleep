'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  levelToCelsius, levelToFahrenheit, celsiusToLevel, fahrenheitToLevel,
} = require('../.homeybuild/lib/temperature.js');

test('level extremes map to documented temperatures', () => {
  assert.strictEqual(levelToCelsius(-100), 13);
  assert.strictEqual(levelToCelsius(100), 44);
  assert.strictEqual(levelToCelsius(0), 27);
  assert.strictEqual(levelToFahrenheit(-100), 55);
  assert.strictEqual(levelToFahrenheit(100), 111);
});

test('celsius round-trips back to a sensible level', () => {
  assert.strictEqual(celsiusToLevel(13), -100);
  assert.strictEqual(celsiusToLevel(44), 100);
  assert.strictEqual(celsiusToLevel(27), 0);
});

test('out-of-range input is clamped', () => {
  assert.strictEqual(levelToCelsius(-9999), 13);
  assert.strictEqual(levelToCelsius(9999), 44);
  assert.strictEqual(celsiusToLevel(5), -100);
  assert.strictEqual(celsiusToLevel(99), 100);
  assert.strictEqual(fahrenheitToLevel(0), -100);
});

test('celsius mapping is monotonic increasing in level', () => {
  let prev = -Infinity;
  for (let lvl = -100; lvl <= 100; lvl += 1) {
    const c = levelToCelsius(lvl);
    assert.ok(c >= prev, `level ${lvl} -> ${c} should be >= ${prev}`);
    prev = c;
  }
});
