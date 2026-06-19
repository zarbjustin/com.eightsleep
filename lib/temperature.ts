'use strict';

/**
 * Eight Sleep represents heating/cooling as a unit-less "level" from -100
 * (coldest) to +100 (hottest). The official app maps that level to an
 * approximate real-world temperature using the lookup tables below. We expose
 * helpers to convert in both directions so the Homey UI can show degrees while
 * the API still receives the raw level it expects.
 */

export const RAW_TO_CELSIUS: ReadonlyArray<readonly [number, number]> = [
  [-100, 13], [-97, 14], [-94, 15], [-91, 16], [-83, 17], [-75, 18], [-67, 19],
  [-58, 20], [-50, 21], [-42, 22], [-33, 23], [-25, 24], [-17, 25], [-8, 26],
  [0, 27], [6, 28], [11, 29], [17, 30], [22, 31], [28, 32], [33, 33], [39, 34],
  [44, 35], [50, 36], [56, 37], [61, 38], [67, 39], [72, 40], [78, 41], [83, 42],
  [89, 43], [100, 44],
];

export const RAW_TO_FAHRENHEIT: ReadonlyArray<readonly [number, number]> = [
  [-100, 55], [-99, 56], [-97, 57], [-95, 58], [-94, 59], [-92, 60], [-90, 61],
  [-86, 62], [-81, 63], [-77, 64], [-72, 65], [-68, 66], [-63, 67], [-58, 68],
  [-54, 69], [-49, 70], [-44, 71], [-40, 72], [-35, 73], [-31, 74], [-26, 75],
  [-21, 76], [-18, 77], [-12, 78], [-7, 79], [-3, 80], [1, 81], [4, 82], [7, 83],
  [10, 84], [14, 85], [16, 86], [20, 87], [23, 88], [26, 89], [29, 90], [32, 91],
  [35, 92], [38, 93], [41, 94], [44, 95], [48, 96], [51, 97], [54, 98], [57, 99],
  [60, 100], [63, 101], [66, 102], [69, 103], [72, 104], [75, 105], [78, 106],
  [80, 107], [85, 108], [88, 109], [92, 110], [100, 111],
];

export const MIN_LEVEL = -100;
export const MAX_LEVEL = 100;
export const MIN_TEMP_C = 13;
export const MAX_TEMP_C = 44;

function clampLevel(level: number): number {
  return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(level)));
}

/** Interpolate `x` against a sorted [from, to] table. */
function interpolate(
  table: ReadonlyArray<readonly [number, number]>,
  x: number,
  invert: boolean,
): number {
  const pts = invert
    ? table.map(([a, b]) => [b, a] as const)
    : table;
  const xs = pts.map((p) => p[0]);
  const lo = xs[0];
  const hi = xs[xs.length - 1];
  if (x <= lo) return pts[0][1];
  if (x >= hi) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (x >= x0 && x <= x1) {
      if (x1 === x0) return y0;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

/** Convert a raw -100..100 level to approximate degrees Celsius. */
export function levelToCelsius(level: number): number {
  const c = interpolate(RAW_TO_CELSIUS, clampLevel(level), false);
  return Math.round(c * 10) / 10;
}

/** Convert a raw -100..100 level to approximate degrees Fahrenheit. */
export function levelToFahrenheit(level: number): number {
  const f = interpolate(RAW_TO_FAHRENHEIT, clampLevel(level), false);
  return Math.round(f);
}

/** Convert degrees Celsius to the nearest raw -100..100 level. */
export function celsiusToLevel(celsius: number): number {
  return clampLevel(interpolate(RAW_TO_CELSIUS, celsius, true));
}

/** Convert degrees Fahrenheit to the nearest raw -100..100 level. */
export function fahrenheitToLevel(fahrenheit: number): number {
  return clampLevel(interpolate(RAW_TO_FAHRENHEIT, fahrenheit, true));
}
