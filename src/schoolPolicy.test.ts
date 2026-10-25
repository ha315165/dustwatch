/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateHeatIndex,
  DEFAULT_UNCONFIGURED_POLICY,
  FICTIONAL_DEMO_POLICY,
  evaluateActivityPolicy,
} from './schoolPolicy.ts';
import { RawHourlyVariables } from './types.ts';

test('Heat Index: calculates correct values under moderate and extreme conditions', () => {
  // 1. Moderate heat: 30°C and 50% RH -> ~31°C (Caution)
  const hiModerate = calculateHeatIndex(30, 50);
  assert.equal(hiModerate.isAvailable, true);
  assert.ok(hiModerate.heatIndexCelsius! >= 30 && hiModerate.heatIndexCelsius! <= 33);
  assert.equal(hiModerate.category, 'Caution');

  // 2. High heat: 36°C and 45% RH -> Danger (41 - 54°C)
  const hiDanger = calculateHeatIndex(36, 45);
  assert.equal(hiDanger.isAvailable, true);
  assert.ok(hiDanger.heatIndexCelsius! >= 41 && hiDanger.heatIndexCelsius! < 54);
  assert.equal(hiDanger.category, 'Danger');

  // 3. Cool condition: 18°C (< 20°C / 68°F threshold) -> not applicable
  const hiCool = calculateHeatIndex(18, 55);
  assert.equal(hiCool.isAvailable, false);
  assert.equal(hiCool.heatIndexCelsius, null);
  assert.equal(hiCool.category, 'not applicable');

  // 4. Mild condition: 23°C and 40% RH -> Below Caution range
  const hiMild = calculateHeatIndex(23, 40);
  assert.equal(hiMild.isAvailable, true);
  assert.equal(hiMild.category, 'Below Caution range');
});

test('Heat Index: missing inputs return not applicable and never substitute zero', () => {
  const missingTemp = calculateHeatIndex(null, 50);
  assert.equal(missingTemp.isAvailable, false);
  assert.equal(missingTemp.heatIndexCelsius, null);
  assert.equal(missingTemp.category, 'not applicable');
  assert.ok(missingTemp.notes.includes('Assessment unavailable'));

  const missingHumidity = calculateHeatIndex(35, null);
  assert.equal(missingHumidity.isAvailable, false);
  assert.equal(missingHumidity.heatIndexCelsius, null);
  assert.equal(missingHumidity.category, 'not applicable');
});

test('School Policy: unconfigured policy shows explicit configuration required state', () => {
  const sampleRaw: RawHourlyVariables = {
    time: '2026-10-21T10:00',
    temperature_2m: 32,
    relative_humidity_2m: 40,
    pm10: 100,
    pm2_5: 30,
    dust: 50,
    wind_speed_10m: 15,
    wind_gusts_10m: 25,
    wind_direction_10m: 300,
    visibility: 9000,
    aerosol_optical_depth: 0.3,
  };

  const hi = calculateHeatIndex(sampleRaw.temperature_2m, sampleRaw.relative_humidity_2m);
  const result = evaluateActivityPolicy(sampleRaw, hi, DEFAULT_UNCONFIGURED_POLICY, 'break');

  assert.equal(result.actionTitle, 'School policy configuration required');
  assert.ok(result.primaryGuidance.includes('Review the applicable school policy'));
  assert.equal(result.triggeredRules.length, 0);
});

test('School Policy: triggers activity-specific rule when threshold is exceeded', () => {
  // For PE under FICTIONAL_DEMO_POLICY, Heat Index >= 35°C triggers 'modified'
  const warmRaw: RawHourlyVariables = {
    time: '2026-10-21T11:00',
    temperature_2m: 34,
    relative_humidity_2m: 55, // yields HI ~40°C
    pm10: 80,
    pm2_5: 25,
    dust: 40,
    wind_speed_10m: 12,
    wind_gusts_10m: 20,
    wind_direction_10m: 300,
    visibility: 10000,
    aerosol_optical_depth: 0.2,
  };

  const hi = calculateHeatIndex(warmRaw.temperature_2m, warmRaw.relative_humidity_2m);
  const peRes = evaluateActivityPolicy(warmRaw, hi, FICTIONAL_DEMO_POLICY, 'pe');

  assert.equal(peRes.recommendedAction, 'modified');
  assert.ok(peRes.reason.includes('A configured threshold has been exceeded'));
  assert.ok(peRes.triggeredRules.some((r) => r.rule.id === 'heat-caution-pe' && r.isTriggered));
});

test('School Policy: precedence resolution gives most restrictive action when multiple rules trigger', () => {
  // Condition: Heat index 36°C (triggers PE 'modified'), BUT PM10 is 300 µg/m³ (triggers 'indoor_only')
  const multiHazardRaw: RawHourlyVariables = {
    time: '2026-10-21T12:00',
    temperature_2m: 32,
    relative_humidity_2m: 50, // HI ~35°C -> triggers 'modified'
    pm10: 300, // severe particulate -> triggers 'indoor_only'
    pm2_5: 90,
    dust: 180,
    wind_speed_10m: 20,
    wind_gusts_10m: 30,
    wind_direction_10m: 320,
    visibility: 4000,
    aerosol_optical_depth: 0.8,
  };

  const hi = calculateHeatIndex(multiHazardRaw.temperature_2m, multiHazardRaw.relative_humidity_2m);
  const peRes = evaluateActivityPolicy(multiHazardRaw, hi, FICTIONAL_DEMO_POLICY, 'pe');

  // 'indoor_only' takes precedence over 'modified' according to policy.precedenceOrder
  assert.equal(peRes.recommendedAction, 'indoor_only');
  assert.ok(peRes.triggeredRules.filter((r) => r.isTriggered).length >= 2);
  assert.ok(peRes.actionTitle.includes('indoors'));
});

test('School Policy: missing critical metric flags assessment unavailable and never claims safe', () => {
  const missingDataRaw: RawHourlyVariables = {
    time: '2026-10-21T13:00',
    temperature_2m: null, // missing temperature
    relative_humidity_2m: 45,
    pm10: 50,
    pm2_5: 15,
    dust: 20,
    wind_speed_10m: 10,
    wind_gusts_10m: 18,
    wind_direction_10m: 300,
    visibility: 10000,
    aerosol_optical_depth: 0.2,
  };

  const hi = calculateHeatIndex(missingDataRaw.temperature_2m, missingDataRaw.relative_humidity_2m);
  const breakRes = evaluateActivityPolicy(missingDataRaw, hi, FICTIONAL_DEMO_POLICY, 'break');

  assert.equal(breakRes.dataMissingForAssessment, true);
  assert.equal(breakRes.actionTitle, 'Assessment unavailable: required data is missing');
  assert.ok(breakRes.primaryGuidance.includes('Review the applicable school policy'));
});

test('School Policy: configured policy with no applicable rules is not labelled criteria met', () => {
  const raw: RawHourlyVariables = {
    time: '2026-10-21T10:00',
    temperature_2m: 32,
    relative_humidity_2m: 40,
    pm10: 100,
    pm2_5: 30,
    dust: 50,
    wind_speed_10m: 15,
    wind_gusts_10m: 25,
    wind_direction_10m: 300,
    visibility: 9000,
    aerosol_optical_depth: 0.3,
  };
  const policy = { ...FICTIONAL_DEMO_POLICY, rules: FICTIONAL_DEMO_POLICY.rules.filter((r) => r.activity === 'lunch_other') };
  const result = evaluateActivityPolicy(raw, calculateHeatIndex(32, 40), policy, 'break');
  assert.equal(result.actionTitle, 'No applicable rules for this activity');
  assert.ok(result.primaryGuidance.includes('Confirm the applicable policy'));
});

test('School Policy: incomplete precedence cannot downgrade an unlisted restrictive action to normal', () => {
  const raw: RawHourlyVariables = {
    time: '2026-10-21T12:00',
    temperature_2m: 32,
    relative_humidity_2m: 50,
    pm10: 300,
    pm2_5: 90,
    dust: 180,
    wind_speed_10m: 20,
    wind_gusts_10m: 30,
    wind_direction_10m: 320,
    visibility: 4000,
    aerosol_optical_depth: 0.8,
  };
  const policy = { ...FICTIONAL_DEMO_POLICY, precedenceOrder: ['normal'] as SchoolPolicyConfig['precedenceOrder'] };
  const result = evaluateActivityPolicy(raw, calculateHeatIndex(32, 50), policy, 'pe');
  assert.ok(['modified', 'indoor_only', 'suspend'].includes(result.recommendedAction));
  assert.equal(result.conflictingRules, true);
});
