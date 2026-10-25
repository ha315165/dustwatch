/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AEROSOL_INDEX_LEVELS,
  UAE_GRID_CELLS,
  buildRasterImageData,
  clearOverlayCache,
  getAerosolDetectionConfig,
  getAirQualityColor,
  getContinuousColorRgba,
  getTemperatureColor,
  interpolateValueAtPoint,
} from './overlayService.ts';

test('Overlay Grid: all UAE_GRID_CELLS coordinates fall within UAE territory bounding box', () => {
  assert.ok(UAE_GRID_CELLS.length >= 25, 'Should have sufficient grid density across UAE');

  for (const cell of UAE_GRID_CELLS) {
    // UAE bounding box roughly 22.5°N - 26.5°N, 51.0°E - 57.0°E
    assert.ok(
      cell.lat >= 22.5 && cell.lat <= 26.5,
      `Cell latitude ${cell.lat} must fall within UAE bounds`
    );
    assert.ok(
      cell.lon >= 51.0 && cell.lon <= 57.0,
      `Cell longitude ${cell.lon} must fall within UAE bounds`
    );

    // Bounds must be properly ordered [[south, west], [north, east]]
    const [[south, west], [north, east]] = cell.bounds;
    assert.ok(south < north, 'South bound must be strictly less than north bound');
    assert.ok(west < east, 'West bound must be strictly less than east bound');
    assert.ok(cell.lat > south && cell.lat < north, 'Center lat must be within bounds');
    assert.ok(cell.lon > west && cell.lon < east, 'Center lon must be within bounds');
  }
});

test('Overlay Colors: temperature scales correctly and handles missing values without inventing numbers', () => {
  // Cold / Mild
  const cold = getTemperatureColor(18.5);
  assert.equal(cold.bg, '#3b82f6');
  assert.ok(cold.label.includes('< 20°C'));

  // Warm
  const warm = getTemperatureColor(28.0);
  assert.equal(warm.bg, '#10b981');
  assert.ok(warm.label.includes('26–31°C'));

  // Hot
  const hot = getTemperatureColor(35.5);
  assert.equal(hot.bg, '#f59e0b');
  assert.ok(hot.label.includes('32–37°C'));

  // Extreme
  const extreme = getTemperatureColor(46.0);
  assert.equal(extreme.bg, '#b91c1c');
  assert.ok(extreme.label.includes('≥ 44°C'));

  // Missing reading must NEVER invent a default 0°C or 25°C
  const missing = getTemperatureColor(null);
  assert.equal(missing.bg, '#9ca3af');
  assert.equal(missing.label, 'Unavailable');

  const nanVal = getTemperatureColor(NaN);
  assert.equal(nanVal.bg, '#9ca3af');
  assert.equal(nanVal.label, 'Unavailable');
});

test('Overlay Colors: US AQI 0-500 scale categories and missing handling', () => {
  // Good (0-50)
  const good = getAirQualityColor('us_aqi', 35);
  assert.equal(good.bg, '#10b981');
  assert.ok(good.category.includes('Good'));

  // Moderate (51-100)
  const mod = getAirQualityColor('us_aqi', 75);
  assert.equal(mod.bg, '#facc15');
  assert.ok(mod.category.includes('Moderate'));

  // Unhealthy for Sensitive (101-150)
  const usg = getAirQualityColor('us_aqi', 130);
  assert.equal(usg.bg, '#f97316');
  assert.ok(usg.category.includes('Unhealthy for Sensitive'));

  // Unhealthy (151-200)
  const unh = getAirQualityColor('us_aqi', 180);
  assert.equal(unh.bg, '#ef4444');
  assert.ok(unh.category.includes('Unhealthy'));

  // Very Unhealthy (201-300)
  const veryUnh = getAirQualityColor('us_aqi', 250);
  assert.equal(veryUnh.bg, '#8b5cf6');
  assert.ok(veryUnh.category.includes('Very Unhealthy'));

  // Hazardous (301+)
  const haz = getAirQualityColor('us_aqi', 380);
  assert.equal(haz.bg, '#881337');
  assert.ok(haz.category.includes('Hazardous'));

  // Missing data
  const missing = getAirQualityColor('us_aqi', null);
  assert.equal(missing.bg, '#9ca3af');
  assert.equal(missing.category, 'Data Missing');
});

test('Overlay Colors: PM10 and PM2.5 metric thresholds', () => {
  // PM10 low (30 µg/m³) vs elevated (180 µg/m³) vs hazardous (450 µg/m³)
  assert.ok(getAirQualityColor('pm10', 30).category.includes('Low'));
  assert.ok(getAirQualityColor('pm10', 180).category.includes('Elevated'));
  assert.ok(getAirQualityColor('pm10', 450).category.includes('Hazardous'));

  // PM2.5 good (8 µg/m³) vs high (75 µg/m³)
  assert.ok(getAirQualityColor('pm2_5', 8).category.includes('Good'));
  assert.ok(getAirQualityColor('pm2_5', 75).category.includes('Unhealthy'));
});

test('Overlay Aerosol: Suomi-NPP OMPS UV Aerosol Index configuration, transparent tile URL, and scientific disclaimer', () => {
  const config = getAerosolDetectionConfig('2026-10-24');

  assert.equal(config.dateString, '2026-10-24');
  assert.ok(config.tileUrl.includes('gibs.earthdata.nasa.gov'));
  assert.ok(config.tileUrl.includes('OMPS_Aerosol_Index'));
  assert.ok(config.tileUrl.includes('GoogleMapsCompatible_Level6'));
  assert.ok(config.tileUrl.endsWith('.png'), 'Aerosol Index tiles must be transparent PNGs');
  assert.ok(config.attribution.includes('NASA'));
  assert.ok(config.instrument.includes('OMPS'));
  assert.equal(config.layerIdentifier, 'OMPS_Aerosol_Index');

  // Critical requirement: do not describe Aerosol Index as ground-level AQI, PM10 concentration or direct dust concentration
  assert.ok(
    config.disclaimer.includes('cannot independently identify the aerosol source') &&
      config.disclaimer.includes('directly quantify ground-level'),
    'Disclaimer must explicitly state that AI cannot independently identify aerosol source or quantify ground-level dust concentration'
  );
  assert.ok(
    config.disclaimer.includes('mineral dust') && config.disclaimer.includes('smoke'),
    'Disclaimer must clarify that aerosol detection responds to UV-absorbing aerosols including dust and smoke'
  );
  assert.equal(config.dataSourceNature, 'satellite_observation');
});

test('Overlay Aerosol: AEROSOL_INDEX_LEVELS qualitative scientific categories and absence of unverified hazard claims', () => {
  assert.equal(AEROSOL_INDEX_LEVELS.length, 4, 'Must have 4 qualitative signal levels');

  const labels = AEROSOL_INDEX_LEVELS.map((l) => l.label);
  assert.ok(labels.includes('Low / Near-Zero Signal'));
  assert.ok(labels.includes('Positive Aerosol Signal'));
  assert.ok(labels.includes('Moderate Aerosol Signal'));
  assert.ok(labels.includes('Stronger Aerosol Signal'));

  // Ensure unvalidated storm categories are not used as official thresholds
  const allText = JSON.stringify(AEROSOL_INDEX_LEVELS);
  assert.ok(!allText.includes('Dense Dust Storm'), 'Must not claim unverified "Dense Dust Storm" boundary');
  assert.ok(!allText.includes('Severe Dust / Thick Plume'), 'Must not claim unverified "Severe Dust" boundary');

  for (const lvl of AEROSOL_INDEX_LEVELS) {
    assert.ok(lvl.color.startsWith('#'), 'Color should be valid hex code');
    assert.ok(lvl.label.length > 0, 'Label must not be empty');
    assert.ok(lvl.description.length > 0, 'Description must not be empty');
  }
});

test('Continuous Interpolation: interpolateValueAtPoint produces smooth blends and never invents values', () => {
  const points = [
    { lat: 24.0, lon: 54.0, value: 50 },
    { lat: 25.0, lon: 54.0, value: 100 },
    { lat: 24.0, lon: 55.0, value: null }, // Missing reading
  ];

  // 1. Exact coordinate match returns the exact point value
  const exact = interpolateValueAtPoint(24.0, 54.0, points);
  assert.equal(exact, 50);

  // 2. Midpoint between 50 and 100 is smoothly interpolated around 75
  const mid = interpolateValueAtPoint(24.5, 54.0, points);
  assert.ok(mid !== null && mid >= 70 && mid <= 80, `Midpoint should be around 75, got ${mid}`);

  // 3. Point far outside UAE envelope (> 1.35 deg from valid points) returns null
  const far = interpolateValueAtPoint(30.0, 60.0, points);
  assert.equal(far, null, 'Must return null for coordinates outside data radius; never invent values');

  // 4. Missing value is skipped and not treated as zero
  const nearMissing = interpolateValueAtPoint(24.0, 54.9, points);
  assert.ok(nearMissing !== null && nearMissing > 30, 'Should interpolate from valid points only, not 0');
});

test('Continuous Color Ramp: getContinuousColorRgba produces smooth RGBA transitions and transparent missing values', () => {
  // Missing value is completely transparent (alpha = 0)
  const [mr, mg, mb, ma] = getContinuousColorRgba('us_aqi', null);
  assert.equal(ma, 0, 'Missing value must have 0 alpha');

  // Low AQI (Good - Green)
  const [gr, gg, gb, ga] = getContinuousColorRgba('us_aqi', 25);
  assert.ok(gg > gr && gg > gb, 'Good AQI should be green-dominated');
  assert.ok(ga > 150, 'Valid point must have visible opacity');

  // Smooth blend between 50 (greenish) and 100 (yellow)
  const [r75, g75, b75] = getContinuousColorRgba('us_aqi', 75);
  assert.ok(r75 > 100 && g75 > 150, '75 AQI should blend green to yellow');

  // Temperature continuous ramp: 15°C (blue) vs 45°C (red/crimson)
  const [trCold, tgCold, tbCold] = getContinuousColorRgba('temperature', 15);
  assert.ok(tbCold > trCold, '15°C must be blue-dominated');

  const [trHot, tgHot, tbHot] = getContinuousColorRgba('temperature', 45);
  assert.ok(trHot > tbHot && trHot > tgHot, '45°C must be red-dominated');
});

test('Continuous Raster Buffer: buildRasterImageData generates seamless RGBA buffer without rectangular borders', () => {
  const points = [
    { lat: 24.0, lon: 54.0, value: 30 },
    { lat: 24.8, lon: 55.0, value: 38 },
  ];
  const width = 20;
  const height = 15;
  const bounds: [[number, number], [number, number]] = [[23.5, 53.5], [25.5, 55.5]];

  const buffer = buildRasterImageData(width, height, bounds, points, 'temperature');
  assert.equal(buffer.length, width * height * 4, 'Buffer size must equal width * height * 4');

  // Pixels near valid points must have non-zero alpha
  let hasVisiblePixels = false;
  for (let i = 3; i < buffer.length; i += 4) {
    if (buffer[i] > 0) {
      hasVisiblePixels = true;
      break;
    }
  }
  assert.ok(hasVisiblePixels, 'Raster buffer must contain rendered pixels');
});

