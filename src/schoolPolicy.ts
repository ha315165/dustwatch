/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  HeatIndexResult,
  HeatStressCategory,
  HourlySchoolAssessment,
  RawHourlyVariables,
  SchoolActivityType,
  SchoolPolicyConfig,
  SchoolPolicyRule,
  SchoolRecommendedAction,
  TriggeredRuleResult,
} from './types.ts';

/**
 * Calculates the Heat Index using the official NOAA / Steadman regression equation.
 * Returns both Celsius and Fahrenheit values and standard heat stress category.
 *
 * Requirements:
 * - If inputs are missing (null/undefined/NaN), explicitly returns unavailable.
 * - Never treats missing temperature or humidity as zero.
 */
export function calculateHeatIndex(
  temperatureCelsius: number | null | undefined,
  relativeHumidity: number | null | undefined
): HeatIndexResult {
  if (
    temperatureCelsius === null ||
    temperatureCelsius === undefined ||
    Number.isNaN(temperatureCelsius) ||
    relativeHumidity === null ||
    relativeHumidity === undefined ||
    Number.isNaN(relativeHumidity)
  ) {
    return {
      heatIndexCelsius: null,
      heatIndexFahrenheit: null,
      category: 'not applicable',
      isAvailable: false,
      notes: 'Assessment unavailable: required temperature or humidity data is missing.',
    };
  }

  // Convert Celsius to Fahrenheit for NOAA formula
  const T = temperatureCelsius * 1.8 + 32;
  const RH = relativeHumidity;

  // For low ambient temperature (< 68°F / 20°C), heat index is not meaningful
  if (T < 68) {
    return {
      heatIndexCelsius: null,
      heatIndexFahrenheit: null,
      category: 'not applicable',
      isAvailable: false,
      notes: 'Heat index is not meaningful when ambient temperature is below 20°C (68°F).',
    };
  }

  // Simple preliminary heat index
  let hi = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + RH * 0.094);

  // If average is 80°F or above, apply the full Rothfusz regression
  if (hi >= 80) {
    hi =
      -42.379 +
      2.04901523 * T +
      10.14333127 * RH -
      0.22475541 * T * RH -
      0.00683783 * T * T -
      0.05481717 * RH * RH +
      0.00122874 * T * T * RH +
      0.00085282 * T * RH * RH -
      0.00000199 * T * T * RH * RH;

    // NOAA low-humidity adjustment
    if (RH < 13 && T >= 80 && T <= 112) {
      const adj = ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(T - 95.0)) / 17);
      hi -= adj;
    }
    // NOAA high-humidity adjustment
    else if (RH > 85 && T >= 80 && T <= 87) {
      const adj = ((RH - 85) / 10) * ((87 - T) / 5);
      hi += adj;
    }
  }

  const hiF = Math.round(hi * 10) / 10;
  const hiC = Math.round(((hi - 32) / 1.8) * 10) / 10;

  // Standard NOAA Heat Stress Categories (NWS general reference, not school policy)
  let category: HeatStressCategory = 'Below Caution range';
  let notes = 'Heat index is below the Caution range (NWS general reference, not school policy).';

  if (hiC >= 54) {
    category = 'Extreme Danger';
    notes = 'Heat stroke highly likely with continued outdoor exposure.';
  } else if (hiC >= 41) {
    category = 'Danger';
    notes = 'Sunstroke and heat exhaustion likely; heat stroke possible with prolonged activity.';
  } else if (hiC >= 32) {
    category = 'Extreme Caution';
    notes = 'Sunstroke, muscle cramps, and heat exhaustion possible with prolonged physical activity.';
  } else if (hiC >= 27) {
    category = 'Caution';
    notes = 'Fatigue possible with prolonged exposure and physical activity.';
  }

  return {
    heatIndexCelsius: hiC,
    heatIndexFahrenheit: hiF,
    category,
    isAvailable: true,
    notes,
  };
}

/**
 * Default Unconfigured Policy State.
 * As required by the sequencing instructions:
 * "Until the verified policy is provided, display a clear 'School policy configuration required' state."
 */
export const DEFAULT_UNCONFIGURED_POLICY: SchoolPolicyConfig = {
  isConfigured: false,
  schoolName: 'Pending Policy Configuration',
  policyVersion: '0.0 (Unconfigured)',
  effectiveDate: 'Pending Teammate 2 Research',
  approvedBy: 'Awaiting Approved School Rules',
  sourceDocument: 'School operational policy documentation pending verification.',
  isFictionalDemo: false,
  rules: [],
  precedenceOrder: ['suspend', 'indoor_only', 'modified', 'normal'],
};

/**
 * Fictional Demo Policy.
 * Explicitly labelled for testing and presentation only.
 * Never presented as actual school policy.
 */
export const FICTIONAL_DEMO_POLICY: SchoolPolicyConfig = {
  isConfigured: true,
  isFictionalDemo: true,
  schoolName: 'Example UAE Academy (Demonstration Only)',
  policyVersion: '1.0-DEMO (Fictional Test Data)',
  effectiveDate: '2026-10-01',
  approvedBy: 'Health & Safety Committee (Fictional Test Sample)',
  sourceDocument: 'Fictional School Outdoor Break & Physical Activity Guidelines 2026',
  rules: [
    {
      id: 'heat-danger-break',
      name: 'High Heat Stress Outdoor Restriction (Break)',
      activity: 'break',
      metric: 'heat_index',
      operator: '>=',
      threshold: 40,
      unit: '°C',
      recommendedAction: 'indoor_only',
      actionTitle: 'Move break indoors',
      actionGuidance: 'Outdoor break should be moved indoors. Heat index exceeds the configured 40°C threshold.',
      reason: 'Calculated Heat Index is in the high danger zone for free outdoor play.',
      sourceReference: 'Fictional Section 4.2',
      severity: 2,
    },
    {
      id: 'heat-caution-pe',
      name: 'Moderate Heat Stress Modification (PE)',
      activity: 'pe',
      metric: 'heat_index',
      operator: '>=',
      threshold: 35,
      unit: '°C',
      recommendedAction: 'modified',
      actionTitle: 'Modify PE activities (mandatory hydration and shade)',
      actionGuidance: 'Reduce continuous vigorous cardio. Mandate shade rests and water breaks every 15 minutes.',
      reason: 'Heat index >= 35°C requires reduced physical intensity.',
      sourceReference: 'Fictional Section 4.3',
      severity: 1,
    },
    {
      id: 'heat-danger-pe',
      name: 'High Heat Stress Outdoor Prohibition (PE)',
      activity: 'pe',
      metric: 'heat_index',
      operator: '>=',
      threshold: 41,
      unit: '°C',
      recommendedAction: 'indoor_only',
      actionTitle: 'Move PE to indoor gymnasium',
      actionGuidance: 'Outdoor physical education sessions are prohibited. Conduct PE inside air-conditioned sports hall.',
      reason: 'Heat index >= 41°C falls into Danger category for vigorous activity.',
      sourceReference: 'Fictional Section 4.4',
      severity: 2,
    },
    {
      id: 'pm10-advisory-all',
      name: 'Elevated Particulate Air Quality Advisory',
      activity: 'all',
      metric: 'pm10',
      operator: '>=',
      threshold: 150,
      unit: 'µg/m³',
      recommendedAction: 'modified',
      actionTitle: 'Accommodate sensitive students with respiratory conditions',
      actionGuidance: 'Permit students with asthma, allergies, or breathing conditions to remain indoors in air-conditioned areas.',
      reason: 'PM10 concentration >= 150 µg/m³ indicates hazy particulate conditions.',
      sourceReference: 'Fictional Section 5.1',
      severity: 1,
    },
    {
      id: 'pm10-severe-all',
      name: 'Severe Particulate Outdoor Restriction',
      activity: 'all',
      metric: 'pm10',
      operator: '>=',
      threshold: 250,
      unit: 'µg/m³',
      recommendedAction: 'indoor_only',
      actionTitle: 'Keep all students indoors; close perimeter doors',
      actionGuidance: 'Suspend all student outdoor activities. Keep classroom windows and building perimeter doors closed.',
      reason: 'PM10 concentration >= 250 µg/m³ indicates severe particulate pollution or blowing dust.',
      sourceReference: 'Fictional Section 5.2',
      severity: 2,
    },
    {
      id: 'dust-severe-all',
      name: 'Mineral Dust Concentration Alert',
      activity: 'all',
      metric: 'dust',
      operator: '>=',
      threshold: 200,
      unit: 'µg/m³',
      recommendedAction: 'indoor_only',
      actionTitle: 'Move all student activities indoors due to dust',
      actionGuidance: 'Model-estimated mineral dust concentration exceeds 200 µg/m³. Restrict outdoor exposure.',
      reason: 'Dust forecast exceeds configured threshold.',
      sourceReference: 'Fictional Section 5.3',
      severity: 2,
    },
    {
      id: 'wind-gusts-break',
      name: 'High Wind Gust Hazard',
      activity: 'break',
      metric: 'wind_gusts',
      operator: '>=',
      threshold: 50,
      unit: 'km/h',
      recommendedAction: 'indoor_only',
      actionTitle: 'Restrict outdoor playground use (wind gusts)',
      actionGuidance: 'High wind gusts can cause flying debris and eye irritation. Move playground activities indoors.',
      reason: 'Wind gusts >= 50 km/h exceed safe playground thresholds.',
      sourceReference: 'Fictional Section 6.1',
      severity: 2,
    },
  ],
  precedenceOrder: ['suspend', 'indoor_only', 'modified', 'normal'],
};

/**
 * Extracts the metric value corresponding to a rule from the raw environmental variables.
 */
function getMetricValue(
  metric: SchoolPolicyRule['metric'],
  raw: RawHourlyVariables,
  heatIndex: HeatIndexResult
): number | null {
  switch (metric) {
    case 'heat_index':
      return heatIndex.heatIndexCelsius;
    case 'temperature':
      return raw.temperature_2m;
    case 'relative_humidity':
      return raw.relative_humidity_2m;
    case 'pm10':
      return raw.pm10;
    case 'pm2_5':
      return raw.pm2_5;
    case 'dust':
      return raw.dust;
    case 'wind_speed':
      return raw.wind_speed_10m;
    case 'wind_gusts':
      return raw.wind_gusts_10m;
    case 'visibility':
      return raw.visibility;
    default:
      return null;
  }
}

/**
 * Evaluates whether an observed value triggers a rule threshold.
 */
function isRuleTriggered(operator: SchoolPolicyRule['operator'], value: number, threshold: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    default:
      return false;
  }
}

/**
 * Evaluates a single hour of environmental readings against a configured school policy
 * for a specific activity type (Break, PE, Lunch/Other).
 */
export function evaluateActivityPolicy(
  raw: RawHourlyVariables,
  heatIndex: HeatIndexResult,
  policy: SchoolPolicyConfig,
  activity: SchoolActivityType
): {
  recommendedAction: SchoolRecommendedAction;
  actionTitle: string;
  primaryGuidance: string;
  reason: string;
  triggeredRules: TriggeredRuleResult[];
  conflictingRules: boolean;
  dataMissingForAssessment: boolean;
} {
  // If policy is not configured, explicitly indicate configuration required
  if (!policy.isConfigured || policy.rules.length === 0) {
    return {
      recommendedAction: 'normal',
      actionTitle: 'School policy configuration required',
      primaryGuidance: 'Review the applicable school policy. Authorized school thresholds have not been configured yet.',
      reason: 'No approved school rules configured for this activity.',
      triggeredRules: [],
      conflictingRules: false,
      dataMissingForAssessment: false,
    };
  }

  // Filter rules that apply to this activity or all activities
  const relevantRules = policy.rules.filter(
    (r) => r.activity === activity || r.activity === 'all'
  );

  const triggeredResults: TriggeredRuleResult[] = [];
  let criticalDataMissing = false;

  for (const rule of relevantRules) {
    const val = getMetricValue(rule.metric, raw, heatIndex);

    if (val === null || val === undefined || Number.isNaN(val)) {
      // Missing reading
      criticalDataMissing = true;
      triggeredResults.push({
        rule,
        observedValue: null,
        unit: rule.unit,
        thresholdValue: rule.threshold,
        isTriggered: false,
        isDataMissing: true,
      });
      continue;
    }

    const triggered = isRuleTriggered(rule.operator, val, rule.threshold);
    if (triggered) {
      triggeredResults.push({
        rule,
        observedValue: val,
        unit: rule.unit,
        thresholdValue: rule.threshold,
        isTriggered: true,
        isDataMissing: false,
      });
    }
  }

  const actuallyTriggered = triggeredResults.filter((r) => r.isTriggered);

  // If no rules triggered
  if (actuallyTriggered.length === 0) {
    if (criticalDataMissing) {
      return {
        recommendedAction: 'normal',
        actionTitle: 'Assessment unavailable: required data is missing',
        primaryGuidance: 'Review the applicable school policy. Some environmental readings are unavailable and cannot be verified against school thresholds.',
        reason: 'One or more required inputs are missing.',
        triggeredRules: triggeredResults,
        conflictingRules: false,
        dataMissingForAssessment: true,
      };
    }

    // Required language: never state "definitively safe"
    return {
      recommendedAction: 'normal',
      actionTitle: 'Conditions meet the configured criteria for this activity',
      primaryGuidance: 'Conditions meet the configured criteria for this activity under current school thresholds. Continue monitoring for changing conditions.',
      reason: 'No configured school policy thresholds were exceeded for this hour.',
      triggeredRules: [],
      conflictingRules: false,
      dataMissingForAssessment: false,
    };
  }

  // Apply precedence order
  // Precedence order: e.g. ['suspend', 'indoor_only', 'modified', 'normal']
  let winningAction: SchoolRecommendedAction = 'normal';
  let winningRuleResult: TriggeredRuleResult | null = null;
  let conflicting = false;

  for (const actionCandidate of policy.precedenceOrder) {
    const matches = actuallyTriggered.filter((tr) => tr.rule.recommendedAction === actionCandidate);
    if (matches.length > 0) {
      winningAction = actionCandidate;
      // Pick highest severity or first rule
      matches.sort((a, b) => b.rule.severity - a.rule.severity);
      winningRuleResult = matches[0];
      break;
    }
  }

  // If different actions triggered with identical severity and unknown precedence
  const uniqueActions = new Set(actuallyTriggered.map((tr) => tr.rule.recommendedAction));
  if (uniqueActions.size > 1 && !winningRuleResult) {
    conflicting = true;
  }

  const rule = winningRuleResult?.rule;
  const reasonText = rule
    ? `A configured threshold has been exceeded: ${rule.name} (${rule.metric} ${rule.operator} ${rule.threshold} ${rule.unit}).`
    : 'A configured school threshold has been exceeded.';

  const guidanceText = rule?.actionGuidance || 'Review the applicable school policy for recommended activity adjustments.';
  const titleText = rule?.actionTitle || 'A configured threshold has been exceeded';

  return {
    recommendedAction: winningAction,
    actionTitle: titleText,
    primaryGuidance: guidanceText,
    reason: reasonText,
    triggeredRules: triggeredResults,
    conflictingRules: conflicting,
    dataMissingForAssessment: criticalDataMissing,
  };
}

/**
 * Builds the complete 12-hour school assessment for a city.
 */
export function buildHourlySchoolAssessments(
  hourlyVariables: RawHourlyVariables[],
  policy: SchoolPolicyConfig
): HourlySchoolAssessment[] {
  return hourlyVariables.map((raw, idx) => {
    const heatIndex = calculateHeatIndex(raw.temperature_2m, raw.relative_humidity_2m);

    const missingReadings: string[] = [];
    if (raw.temperature_2m === null) missingReadings.push('Temperature');
    if (raw.relative_humidity_2m === null) missingReadings.push('Relative humidity');
    if (raw.pm10 === null) missingReadings.push('PM10');
    if (raw.pm2_5 === null) missingReadings.push('PM2.5');
    if (raw.dust === null) missingReadings.push('Dust');
    if (raw.wind_speed_10m === null) missingReadings.push('Wind speed');
    if (raw.wind_gusts_10m === null) missingReadings.push('Wind gusts');

    const breakAssessment = evaluateActivityPolicy(raw, heatIndex, policy, 'break');
    const peAssessment = evaluateActivityPolicy(raw, heatIndex, policy, 'pe');
    const lunchAssessment = evaluateActivityPolicy(raw, heatIndex, policy, 'lunch_other');

    const displayHour = raw.time.includes('T')
      ? raw.time.split('T')[1].substring(0, 5)
      : raw.time;

    return {
      hourIndex: idx,
      time: raw.time,
      displayHour,
      environmentalReadings: {
        temperature: raw.temperature_2m,
        relativeHumidity: raw.relative_humidity_2m,
        heatIndex,
        pm10: raw.pm10,
        pm2_5: raw.pm2_5,
        dust: raw.dust,
        windSpeed: raw.wind_speed_10m,
        windGusts: raw.wind_gusts_10m,
        windDirection: raw.wind_direction_10m,
        visibility: raw.visibility,
      },
      missingReadings,
      activityAssessments: {
        break: breakAssessment,
        pe: peAssessment,
        lunch_other: lunchAssessment,
      },
      officialAlertDetected: false, // Default false unless official alert feed or simulation is triggered
    };
  });
}
