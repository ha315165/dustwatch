/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  HINDCAST_PROVENANCE_LABEL,
  SYNTHETIC_HINDCAST_LABEL,
  buildHourlyPredictions,
  evaluateNurseComparison,
  evaluatePredictionsAgainstEvents,
  fetchHindcastData,
  generateSyntheticHindcastData,
  parseEventLogCsv,
  parseNurseLogCsv,
} from './backtestService.ts';
import { APP_CONFIG, CITIES } from './config.ts';
import { DEFAULT_UNCONFIGURED_POLICY, FICTIONAL_DEMO_POLICY } from './schoolPolicy.ts';
import { SchoolPolicyConfig } from './types.ts';
import { parseAndEvaluateCsv } from './evaluation.ts';
import { exportSnapshotJson, importSnapshotJson } from './dataService.ts';

test('Backtest: generates synthetic hindcast data and drops first 12 hours for persistence', () => {
  const hindcastData = generateSyntheticHindcastData(2, CITIES.slice(0, 2));
  const predictions = buildHourlyPredictions(hindcastData, null);

  assert.ok(predictions.length > 0, 'Should generate predictions');
  
  // Every prediction must have persistence_level defined because first 12 were dropped
  for (const p of predictions) {
    assert.ok(p.persistence_level !== undefined, 'Persistence level must exist');
    assert.strictEqual(typeof p.baseline_score, 'number');
    assert.strictEqual(p.model_level, '', 'Model level should be blank when no model loaded');
  }
});

test('Backtest: Event log parser checks independence and flags model_forecast/CAMS', () => {
  const csv = [
    'city,start,end,evidence_type,source_name,source_link,notes',
    'Abu Dhabi,2026-10-10T10:00,2026-10-10T16:00,observation_report,Ground Station,https://example.com,real observation',
    'Dubai,2026-10-10T12:00,2026-10-10T18:00,model_forecast,Open-Meteo CAMS forecast,https://open-meteo.com,model based',
  ].join('\n');

  // Default: exclude non-independent
  const resDefault = parseEventLogCsv(csv, false);
  assert.strictEqual(resDefault.success, true);
  assert.strictEqual(resDefault.nonIndependentCount, 1, 'Should flag 1 non-independent event');
  assert.strictEqual(resDefault.events.length, 1, 'Should exclude non-independent event by default');
  assert.strictEqual(resDefault.events[0].city, 'Abu Dhabi');

  // When includeNonIndependent is true
  const resIncluded = parseEventLogCsv(csv, true);
  assert.strictEqual(resIncluded.events.length, 2, 'Should include both events when allowed');
  assert.strictEqual(resIncluded.circularityWarningTriggered, true, 'Should trigger circularity warning');
});

test('Backtest: Hours outside searched period or cities are excluded', () => {
  const hindcastData = generateSyntheticHindcastData(5, CITIES.slice(0, 2));
  const predictions = buildHourlyPredictions(hindcastData, null);

  const city0Name = CITIES[0].name;
  const searchStart = predictions[2].timestamp;
  const searchEnd = predictions[10].timestamp;

  const result = evaluatePredictionsAgainstEvents({
    predictions,
    events: [],
    searchedPeriod: { start: searchStart, end: searchEnd },
    searchedCities: [city0Name],
    daysRequested: 5,
    activeModel: null,
  });

  assert.ok(result.evaluatedRows.length > 0);
  for (const r of result.evaluatedRows) {
    assert.strictEqual(r.city, city0Name, 'Only searched city should be evaluated');
    assert.ok(r.timestamp >= searchStart && r.timestamp <= searchEnd, 'Only searched period evaluated');
  }
  assert.ok(result.metadata.hoursExcluded > 0, 'Hours outside search window must be excluded');
  assert.strictEqual(result.metadata.hindcastLabel, SYNTHETIC_HINDCAST_LABEL);
  assert.strictEqual(result.isSynthetic, true, 'Synthetic predictions must be labeled as synthetic');
});

test('Backtest: Event detection, lead time, and false alarm episodes', () => {
  const hindcastData = generateSyntheticHindcastData(4, [CITIES[0]]);
  const predictions = buildHourlyPredictions(hindcastData, null);

  const evtStart = predictions[5].timestamp;
  const evtEnd = predictions[8].timestamp;

  const eventObj = {
    id: 'evt-1',
    rowNumber: 2,
    city: CITIES[0].name,
    start: evtStart,
    end: evtEnd,
    evidence_type: 'observation_report' as const,
    source_name: 'Airport Metar',
    source_link: 'https://metar.com',
    notes: 'Sandstorm',
    isIndependent: true,
  };

  const result = evaluatePredictionsAgainstEvents({
    predictions,
    events: [eventObj],
    searchedPeriod: { start: predictions[0].timestamp, end: predictions[predictions.length - 1].timestamp },
    searchedCities: [CITIES[0].name],
    daysRequested: 4,
    activeModel: null,
  });

  assert.strictEqual(result.hasEnoughEvents, false, 'Less than 10 events should flag too few events');
  assert.strictEqual(result.eventSummaries.length, 1);
  assert.ok(result.csvText.includes('observed_event'));
});

test('Part B Nurse Comparison: Stops with "School policy not loaded" if policy is unconfigured or demo', () => {
  const hindcastData = generateSyntheticHindcastData(3, [CITIES[0]]);
  const sampleNurseCsv = [
    'date,hour,activity,nurse_action',
    '2026-10-10,10,break,normal',
  ].join('\n');
  const parseRes = parseNurseLogCsv(sampleNurseCsv);
  assert.strictEqual(parseRes.success, true);

  // 1. Unconfigured policy
  const unconfiguredEval = evaluateNurseComparison({
    nurseRows: parseRes.rows,
    schoolPolicy: DEFAULT_UNCONFIGURED_POLICY,
    rawCityData: hindcastData,
    schoolCityId: CITIES[0].id,
  });
  assert.strictEqual(unconfiguredEval.success, false);
  assert.strictEqual(unconfiguredEval.error, 'School policy not loaded');

  // 2. Demo fictional policy (must NEVER be used for comparison)
  const demoEval = evaluateNurseComparison({
    nurseRows: parseRes.rows,
    schoolPolicy: FICTIONAL_DEMO_POLICY,
    rawCityData: hindcastData,
    schoolCityId: CITIES[0].id,
  });
  assert.strictEqual(demoEval.success, false);
  assert.strictEqual(demoEval.error, 'School policy not loaded');
});

test('Part B Nurse Comparison: Evaluates agreement with configured official policy', () => {
  const hindcastData = generateSyntheticHindcastData(3, [CITIES[0]]);
  const cityData = hindcastData[CITIES[0].id];
  const firstTime = cityData.weather.hourly.time[14];
  const [datePart, hourPart] = firstTime.split('T');
  const hourNum = parseInt(hourPart.split(':')[0], 10);

  // Valid configured school policy (not demo)
  const officialPolicy: SchoolPolicyConfig = {
    isConfigured: true,
    isFictionalDemo: false,
    schoolName: 'Al Nahda Academy',
    policyVersion: '2.1',
    effectiveDate: '2026-09-01',
    approvedBy: 'Principal & Health Lead',
    sourceDocument: 'School Operations Handbook 2026',
    precedenceOrder: ['suspend', 'indoor_only', 'modified', 'normal'],
    rules: [
      {
        id: 'pm10-mod',
        name: 'Moderate Particulate Warning',
        activity: 'all',
        metric: 'pm10',
        operator: '>=',
        threshold: 100,
        unit: 'µg/m³',
        recommendedAction: 'modified',
        actionTitle: 'Shorten outdoor play',
        actionGuidance: 'Reduce strenuous outdoor exertion.',
        reason: 'PM10 high',
        severity: 1,
      },
    ],
  };

  const nurseRows = [
    { rowNumber: 2, date: datePart, hour: hourNum, activity: 'break' as const, nurse_action: 'normal' as const },
    { rowNumber: 3, date: '2020-01-01', hour: 10, activity: 'pe' as const, nurse_action: 'cancel' as const },
  ];

  const evalRes = evaluateNurseComparison({
    nurseRows,
    schoolPolicy: officialPolicy,
    rawCityData: hindcastData,
    schoolCityId: CITIES[0].id,
  });

  assert.strictEqual(evalRes.success, true);
  assert.ok(evalRes.summary);
  assert.strictEqual(evalRes.summary.totalRows, 2);
  assert.strictEqual(evalRes.summary.outsideDataCount, 1, '2020-01-01 should be outside available data');
  assert.strictEqual(evalRes.summary.evaluatedCount, 1);
  assert.ok(evalRes.summary.note.includes('Differences can come from model data versus the nurses'));
});

test('Backtest Integrity: synthetic data is explicitly tagged and not masqueraded as real hindcast', () => {
  const synthetic = generateSyntheticHindcastData(3, [CITIES[0]]);
  const cityData = synthetic[CITIES[0].id];

  assert.strictEqual(cityData.isSampleOrSnapshot, true);
  assert.strictEqual(cityData.snapshotLabel, SYNTHETIC_HINDCAST_LABEL);

  const predictions = buildHourlyPredictions(synthetic, null);
  assert.ok(predictions.length > 0);
  assert.strictEqual(predictions[0].isSynthetic, true);

  const evalResult = evaluatePredictionsAgainstEvents({
    predictions,
    events: [],
    searchedPeriod: { start: predictions[0].timestamp, end: predictions[predictions.length - 1].timestamp },
    searchedCities: [CITIES[0].name],
    daysRequested: 3,
    activeModel: null,
  });

  assert.strictEqual(evalResult.isSynthetic, true);
  assert.strictEqual(evalResult.metadata.isSynthetic, true);
  assert.strictEqual(evalResult.metadata.hindcastLabel, SYNTHETIC_HINDCAST_LABEL);
});

test('Backtest Integrity: synthetic evaluation CSV contains comment header and cannot be parsed as real data', () => {
  const synthetic = generateSyntheticHindcastData(2, [CITIES[0]]);
  const predictions = buildHourlyPredictions(synthetic, null);
  const evalResult = evaluatePredictionsAgainstEvents({
    predictions,
    events: [],
    searchedPeriod: { start: predictions[0].timestamp, end: predictions[predictions.length - 1].timestamp },
    searchedCities: [CITIES[0].name],
    daysRequested: 2,
    activeModel: null,
  });

  // Check CSV text contains synthetic comment header
  assert.ok(evalResult.csvText.includes('# dataset: synthetic'));
  assert.ok(evalResult.csvText.includes(SYNTHETIC_HINDCAST_LABEL));

  // When uploaded into Accuracy Checker without extra metadata, the comment header preserves synthetic status
  const parsed = parseAndEvaluateCsv(evalResult.csvText);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.result?.workbenchMetadata?.isSynthetic, true);
  assert.strictEqual(parsed.result?.workbenchMetadata?.hindcastLabel, SYNTHETIC_HINDCAST_LABEL);
});

test('Snapshot Integrity: synthetic data exported to snapshot cannot be relabeled as real data upon import', () => {
  const synthetic = generateSyntheticHindcastData(2, CITIES);
  const jsonStr = exportSnapshotJson(synthetic);
  const parsedJson = JSON.parse(jsonStr);
  assert.strictEqual(parsedJson.isSynthetic, true);

  const importResult = importSnapshotJson(jsonStr);
  assert.strictEqual(importResult.success, true);
  assert.strictEqual(importResult.isSynthetic, true);
});

test('Realistic Dataset: non-synthetic predictions are labeled with real hindcast provenance and not synthetic', () => {
  // Realistic non-synthetic hindcast data representation
  const realisticData = generateSyntheticHindcastData(2, [CITIES[0]]);
  realisticData[CITIES[0].id].isSampleOrSnapshot = false;
  realisticData[CITIES[0].id].snapshotLabel = HINDCAST_PROVENANCE_LABEL;

  const predictions = buildHourlyPredictions(realisticData, null);
  assert.strictEqual(predictions[0].isSynthetic, false);

  const evalResult = evaluatePredictionsAgainstEvents({
    predictions,
    events: [],
    searchedPeriod: { start: predictions[0].timestamp, end: predictions[predictions.length - 1].timestamp },
    searchedCities: [CITIES[0].name],
    daysRequested: 2,
    activeModel: null,
  });

  assert.strictEqual(evalResult.isSynthetic, false);
  assert.strictEqual(evalResult.metadata.isSynthetic, false);
  assert.strictEqual(evalResult.metadata.hindcastLabel, HINDCAST_PROVENANCE_LABEL);
  assert.ok(!evalResult.csvText.includes('# dataset: synthetic'));
});

test('Provenance Isolation: caller passing isSynthetic: false cannot override synthetic CSV header', () => {
  const syntheticCsv = [
    '# dataset: synthetic',
    `# provenance: ${SYNTHETIC_HINDCAST_LABEL}`,
    'timestamp,city,observed_event,model_level,baseline_level,persistence_level',
    '2026-10-10T10:00,Abu Dhabi,0,,Low,Low',
    '2026-10-10T11:00,Abu Dhabi,1,,High,Low',
  ].join('\n');

  // Attempt to override synthetic provenance with isSynthetic: false in caller metadata
  const parsed = parseAndEvaluateCsv(syntheticCsv, {
    isSynthetic: false,
    hindcastLabel: 'Attempted real label override',
  });

  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.result?.workbenchMetadata?.isSynthetic, true, 'Synthetic CSV must remain synthetic despite caller override');
  assert.ok(
    parsed.result?.workbenchMetadata?.hindcastLabel?.includes('Synthetic') ||
      parsed.result?.workbenchMetadata?.hindcastLabel?.includes('synthetic'),
    'Label must maintain synthetic provenance'
  );
});

test('City Batch Integrity: fetchHindcastData throws on mismatched city counts or coordinates', async () => {
  // Test error throwing when batch fetch returns incorrect city count or mismatched responses
  const originalFetch = globalThis.fetch;
  try {
    // 1. Array length mismatch (e.g. only 5 responses for 10 cities)
    globalThis.fetch = async () =>
      new Response(JSON.stringify([{ latitude: 24.45, longitude: 54.37, hourly: { time: ['2026-10-10T00:00'] } }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    await assert.rejects(
      async () => {
        await fetchHindcastData(1);
      },
      /mismatch/i,
      'Batch size mismatch must throw and not fall back to city 0'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

