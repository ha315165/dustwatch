/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearClientAdviceCache,
  clearClientSchoolCache,
  getSchoolModeAdvice,
  makeGeminiCacheKey,
  schoolCache,
  serializeGeminiAdviceInputs,
  serializeSchoolAdviceInputs,
} from './geminiService.ts';

test('Client Cache Key: serializeSchoolAdviceInputs is canonical and order-independent', () => {
  const payloadA = {
    city: 'Dubai',
    activity: 'break',
    action: 'normal',
    hour: '10:00',
    temperature: 34,
    humidity: 45,
    pm10: 80,
  };

  const payloadB = {
    pm10: 80,
    humidity: 45,
    temperature: 34,
    hour: '10:00',
    action: 'normal',
    activity: 'break',
    city: 'Dubai',
  };

  const keyA = serializeSchoolAdviceInputs(payloadA);
  const keyB = serializeSchoolAdviceInputs(payloadB);
  assert.equal(keyA, keyB, 'Key order must not affect serialized output');
});

test('Client Cache Key: every prompt-relevant input alters the school-advice cache key', () => {
  const base = {
    city: 'Abu Dhabi',
    activity: 'break',
    hour: '11:00',
    action: 'normal',
    reason: 'Dust within threshold',
    heatIndex: 35,
    temperature: 33,
    humidity: 50,
    pm10: 70,
    dust: 55,
    windSpeed: 15,
    triggeredRules: [{ ruleId: 'R1', metric: 'pm10' }],
    levelNow: 'Moderate',
    peakLevel: 'Moderate',
    peakWindow: '11:00 - 13:00',
    confidence: 'High',
    lunchEnabled: false,
  };

  const baseKey = serializeSchoolAdviceInputs(base);

  // 1. Activity
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, activity: 'pe' }), baseKey);
  // 2. Action
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, action: 'shorten' }), baseKey);
  // 3. Peak window
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, peakWindow: '14:00 - 16:00' }), baseKey);
  // 4. Temperature
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, temperature: 40 }), baseKey);
  // 5. Humidity
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, humidity: 75 }), baseKey);
  // 6. PM10
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, pm10: 180 }), baseKey);
  // 7. Dust
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, dust: 200 }), baseKey);
  // 8. Wind speed
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, windSpeed: 30 }), baseKey);
  // 9. Heat index
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, heatIndex: 42 }), baseKey);
  // 10. Triggered rules
  assert.notEqual(
    serializeSchoolAdviceInputs({
      ...base,
      triggeredRules: [{ ruleId: 'R2', metric: 'dust' }],
    }),
    baseKey
  );
  // 11. Hour
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, hour: '12:00' }), baseKey);
  // 12. Reason
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, reason: 'High dust' }), baseKey);
  // 13. Level now
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, levelNow: 'High' }), baseKey);
  // 14. Peak level
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, peakLevel: 'Very High' }), baseKey);
  // 15. Confidence
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, confidence: 'Low' }), baseKey);
  // 16. Lunch enabled
  assert.notEqual(serializeSchoolAdviceInputs({ ...base, lunchEnabled: true }), baseKey);
});

test('Client Cache Key: general advice makeGeminiCacheKey and serializeGeminiAdviceInputs', () => {
  const objA = {
    city: 'Sharjah',
    levelNow: 'Low',
    peakLevel: 'Moderate',
    peakWindow: '08:00 - 11:00',
    confidence: 'Medium',
    topFactors: [{ name: 'PM10', value: 85, unit: 'µg/m³' }],
    dataSourceType: 'live',
  };

  const objB = {
    dataSourceType: 'live',
    topFactors: [{ name: 'PM10', value: 85, unit: 'µg/m³' }],
    confidence: 'Medium',
    peakWindow: '08:00 - 11:00',
    peakLevel: 'Moderate',
    levelNow: 'Low',
    city: 'Sharjah',
  };

  const keyA = serializeGeminiAdviceInputs(objA);
  const keyB = serializeGeminiAdviceInputs(objB);
  assert.equal(keyA, keyB, 'Key order must not affect general advice cache key');

  // Verify makeGeminiCacheKey with object parameter
  assert.equal(makeGeminiCacheKey(objA), keyA);

  // Field variations produce cache misses
  assert.notEqual(serializeGeminiAdviceInputs({ ...objA, city: 'Ajman' }), keyA);
  assert.notEqual(serializeGeminiAdviceInputs({ ...objA, levelNow: 'Moderate' }), keyA);
  assert.notEqual(serializeGeminiAdviceInputs({ ...objA, peakLevel: 'High' }), keyA);
  assert.notEqual(serializeGeminiAdviceInputs({ ...objA, peakWindow: '12:00 - 15:00' }), keyA);
  assert.notEqual(serializeGeminiAdviceInputs({ ...objA, confidence: 'High' }), keyA);
  assert.notEqual(serializeGeminiAdviceInputs({ ...objA, dataSourceType: 'sample' }), keyA);
  assert.notEqual(
    serializeGeminiAdviceInputs({ ...objA, topFactors: [{ name: 'Wind', value: 35, unit: 'km/h' }] }),
    keyA
  );
});

test('Missing Data Safety: getSchoolModeAdvice returns non-reassuring deterministic fallback without AI call', async () => {
  clearClientSchoolCache();

  // Case 1: dataMissingForAssessment is true
  const resMissing = await getSchoolModeAdvice(
    'Dubai',
    'break',
    '10:00',
    {
      recommendedAction: 'normal',
      actionTitle: 'Assessment unavailable: required data is missing',
      primaryGuidance:
        'Review the applicable school policy. Some environmental readings are unavailable and cannot be verified against school thresholds.',
      reason: 'One or more required inputs are missing.',
      triggeredRules: [],
      dataMissingForAssessment: true,
      isPolicyConfigured: true,
    },
    {
      temperature: null,
      relativeHumidity: null,
      heatIndex: { heatIndexCelsius: null, category: 'not applicable' },
      pm10: null,
      dust: null,
      windSpeed: null,
    }
  );

  assert.equal(resMissing.isAI, false, 'Must not call Gemini AI when critical data is missing');
  assert.ok(
    resMissing.summary.includes('unavailable') || resMissing.summary.includes('missing'),
    'Must return deterministic missing-data guidance'
  );
  assert.ok(
    !resMissing.summary.toLowerCase().includes('safe') && !resMissing.summary.toLowerCase().includes('clear'),
    'Must not produce reassuring safe status when data is missing'
  );

  // Case 2: unconfigured policy
  const resUnconfigured = await getSchoolModeAdvice(
    'Dubai',
    'break',
    '10:00',
    {
      recommendedAction: 'normal',
      actionTitle: 'School policy configuration required',
      primaryGuidance: 'Review the applicable school policy. Authorized school thresholds have not been configured yet.',
      reason: 'No approved school rules configured for this activity.',
      triggeredRules: [],
      dataMissingForAssessment: false,
      isPolicyConfigured: false,
    },
    {
      temperature: 30,
      relativeHumidity: 40,
      heatIndex: { heatIndexCelsius: 31, category: 'Caution' },
      pm10: 50,
      dust: 30,
      windSpeed: 12,
    }
  );

  assert.equal(resUnconfigured.isAI, false, 'Must not call AI when policy is unconfigured');
  assert.ok(
    resUnconfigured.summary.toLowerCase().includes('configured') ||
      resUnconfigured.summary.toLowerCase().includes('policy'),
    'Must indicate policy configuration is required/unconfigured'
  );
});
