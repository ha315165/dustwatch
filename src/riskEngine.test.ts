/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSubScore,
  scoreToCategory,
  calculateHourlyBaseline,
  predictRisk,
  calculateConfidence,
  find3HourWindows,
  validateModelConfig,
} from './riskEngine.ts';
import { APP_CONFIG } from './config.ts';
import { RawHourlyVariables, ModelFileConfig } from './types.ts';

test('Self-Check 1: all variables at low values yield score 0 and Low risk', () => {
  const lowRaw: RawHourlyVariables = {
    time: '2026-10-20T12:00',
    dust: 20,
    pm10: 50,
    wind_gusts_10m: 25,
    wind_speed_10m: 15,
    aerosol_optical_depth: 0.2,
    visibility: 10000, // clean visibility -> subScore 0
    relative_humidity_2m: 60, // normal humidity -> subScore 0
    pm2_5: 10,
    temperature_2m: 28,
    wind_direction_10m: 300,
  };

  const result = calculateHourlyBaseline(0, lowRaw, APP_CONFIG);
  assert.equal(result.baselineScore, 0);
  assert.equal(result.category, 'Low');
});

test('Self-Check 2: all variables at high values yield score 100 and Very High risk', () => {
  const highRaw: RawHourlyVariables = {
    time: '2026-10-20T12:00',
    dust: 300,
    pm10: 400,
    wind_gusts_10m: 70,
    wind_speed_10m: 50,
    aerosol_optical_depth: 1.5,
    visibility: 1000, // severely reduced visibility -> subScore 100
    relative_humidity_2m: 15, // dry -> subScore 100
    pm2_5: 120,
    temperature_2m: 42,
    wind_direction_10m: 320,
  };

  const result = calculateHourlyBaseline(0, highRaw, APP_CONFIG);
  assert.equal(result.baselineScore, 100);
  assert.equal(result.category, 'Very High');
});

test('Self-Check 3: missing dust or PM10 at peak hour drops confidence to Low', () => {
  const rawWithMissingDust: RawHourlyVariables = {
    time: '2026-10-20T12:00',
    dust: null,
    pm10: 100,
    wind_gusts_10m: 30,
    wind_speed_10m: 20,
    aerosol_optical_depth: 0.4,
    visibility: 8000,
    relative_humidity_2m: 40,
    pm2_5: 30,
    temperature_2m: 30,
    wind_direction_10m: 310,
  };

  const hourly = [calculateHourlyBaseline(0, rawWithMissingDust, APP_CONFIG)];
  const { confidence, reasons } = calculateConfidence(hourly, 0, true, 0.5, true, APP_CONFIG);
  assert.equal(confidence, 'Low');
  assert.ok(reasons.some((r) => r.includes('Key particle data')));
});

test('Self-Check 4: score exactly on cutoff goes into higher category', () => {
  assert.equal(scoreToCategory(24), 'Low');
  assert.equal(scoreToCategory(25), 'Moderate');
  assert.equal(scoreToCategory(49), 'Moderate');
  assert.equal(scoreToCategory(50), 'High');
  assert.equal(scoreToCategory(74), 'High');
  assert.equal(scoreToCategory(75), 'Very High');
});

test('Self-Check 5: particle cap prevents high wind from triggering High or Very High', () => {
  // Dust and PM10 very low (subScores < 10)
  // Extreme wind gusts (e.g. 90 km/h) and wind speed (60 km/h)
  const extremeWindCleanParticles: RawHourlyVariables = {
    time: '2026-10-20T12:00',
    dust: 20, // subScore 0 (< 10)
    pm10: 50, // subScore 0 (< 10)
    wind_gusts_10m: 90, // subScore 100
    wind_speed_10m: 70, // subScore 100
    aerosol_optical_depth: 1.5, // subScore 100
    visibility: 1000, // subScore 100
    relative_humidity_2m: 15, // subScore 100
    pm2_5: 5,
    temperature_2m: 25,
    wind_direction_10m: 300,
  };

  const result = calculateHourlyBaseline(0, extremeWindCleanParticles, APP_CONFIG);
  assert.equal(result.isParticleCapped, true);
  assert.ok(result.finalScore <= 24);
  assert.equal(result.category, 'Low');
});

test('Self-Check 6: predictRisk without model returns baseline, with model runs logistic regression', () => {
  const sampleRaw: RawHourlyVariables = {
    time: '2026-10-20T14:00',
    dust: 150,
    pm10: 200,
    wind_gusts_10m: 40,
    wind_speed_10m: 25,
    aerosol_optical_depth: 0.6,
    visibility: 5000,
    relative_humidity_2m: 35,
    pm2_5: 45,
    temperature_2m: 32,
    wind_direction_10m: 310,
  };

  // Without model
  const baselineRes = predictRisk(0, sampleRaw, null, APP_CONFIG);
  assert.equal(baselineRes.modelScore, undefined);
  assert.equal(baselineRes.finalScore, baselineRes.baselineScore);

  // With a test model
  const testModel: ModelFileConfig = {
    model_name: 'test_logistic',
    model_type: 'logistic_regression',
    version: '1.0',
    trained_on: 'Synthetic UAE dataset',
    trained_date: '2026-10-01',
    feature_names: ['dust', 'wind_speed_10m'],
    coefficients: [0.02, 0.05],
    intercept: -3.0,
    scaler: {
      mean: [100, 20],
      scale: [50, 10],
    },
    probability_cutoffs: {
      moderate: 0.3,
      high: 0.6,
      very_high: 0.8,
    },
  };

  const modelRes = predictRisk(0, sampleRaw, testModel, APP_CONFIG);
  assert.notEqual(modelRes.modelScore, undefined);
  assert.ok(modelRes.modelScore! >= 0 && modelRes.modelScore! <= 100);
  assert.equal(modelRes.finalScore, modelRes.modelScore);
});

test('3-hour window calculation identifies best and worst blocks', () => {
  const dummyHours = [10, 20, 30, 80, 90, 85, 40, 20, 15, 10, 10, 12].map((s, idx) => ({
    hourIndex: idx,
    time: `2026-10-20T${String(idx).padStart(2, '0')}:00`,
    displayHour: `${String(idx).padStart(2, '0')}:00`,
    baselineScore: s,
    baselineCategory: scoreToCategory(s),
    finalScore: s,
    category: scoreToCategory(s),
    missingVariables: [],
    subScores: {},
    topContributors: [],
    isParticleCapped: false,
    contextVariables: {
      pm2_5: { value: 10, unit: 'µg/m³' },
      temperature_2m: { value: 25, unit: '°C' },
    },
  }));

  const { bestWindow, worstWindow } = find3HourWindows(dummyHours);
  // Worst window should be hours 3-5 (80, 90, 85 -> avg 85)
  assert.equal(worstWindow.startHourIndex, 3);
  assert.equal(worstWindow.endHourIndex, 5);
  assert.equal(worstWindow.level, 'Very High');

  // Best window should be hours 8-10 or 9-11 (10, 10, 12 -> avg 10.7)
  assert.equal(bestWindow.level, 'Low');
});
