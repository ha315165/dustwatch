/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { APP_CONFIG } from './config.ts';
import { STRINGS } from './strings.ts';
import { AdviceResponse, CityOutlook, SchoolActivityType } from './types.ts';

// Bounded in-memory cache keeping at most 200 entries, dropping the oldest
class BoundedCache<T> {
  private map = new Map<string, T>();
  private readonly max = 200;

  get(key: string): T | undefined {
    return this.map.get(key);
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

const adviceCache = new BoundedCache<AdviceResponse>();
export const schoolCache = new BoundedCache<string>();

export function clearClientSchoolCache(): void {
  schoolCache.clear();
}

export function clearClientAdviceCache(): void {
  adviceCache.clear();
}

export function serializeSchoolAdviceInputs(input: Record<string, unknown>): string {
  const sortedKeys = Object.keys(input).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const val = input[key];
    if (val !== undefined) {
      sortedObj[key] = val;
    }
  }
  return JSON.stringify(sortedObj);
}

export function serializeGeminiAdviceInputs(input: Record<string, unknown>): string {
  const sortedKeys = Object.keys(input).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const val = input[key];
    if (val !== undefined) {
      sortedObj[key] = val;
    }
  }
  return JSON.stringify(sortedObj);
}

export function makeGeminiCacheKey(
  cityOrPayload?: string | Record<string, unknown>,
  levels?: string,
  peakWindow?: string,
  confidence?: string,
  topFactors?: unknown,
  dataSourceType?: string
): string {
  if (cityOrPayload && typeof cityOrPayload === 'object') {
    return serializeGeminiAdviceInputs(cityOrPayload as Record<string, unknown>);
  }
  const obj: Record<string, unknown> = {
    city: cityOrPayload ?? '',
    levels: levels ?? '',
    peakWindow: peakWindow ?? '',
    confidence: confidence ?? '',
    topFactors: topFactors ?? [],
    dataSourceType: dataSourceType ?? '',
  };
  return serializeGeminiAdviceInputs(obj);
}

/**
 * Validates that an advice string conforms to prompt limits:
 * - At most 2 sentences
 * - At most 300 characters
 * - Contains no digits that were not present in the input JSON
 */
function isValidField(text: string, allowedDigits: Set<string>): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return false;

  const sentences = trimmed.split(/[.!?]+(?:\s+|$)/).filter((s) => s.trim().length > 0);
  if (sentences.length > 2) return false;

  const matches = trimmed.match(/\d/g);
  if (matches) {
    for (const d of matches) {
      if (!allowedDigits.has(d)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Collects all digits present in the input JSON for validation.
 */
function extractAllowedDigits(payload: unknown): Set<string> {
  const str = JSON.stringify(payload);
  const digits = new Set<string>();
  const matches = str.match(/\d/g);
  if (matches) {
    for (const d of matches) {
      digits.add(d);
    }
  }
  return digits;
}

/**
 * Retrieves advice for the selected city outlook, using Gemini AI if available
 * or falling back to the standard pre-written advice.
 */
export async function getAdviceForOutlook(outlook: CityOutlook): Promise<AdviceResponse> {
  const peakLevel = outlook.peakLevel;

  // Pre-written fallback advice
  const fallbackAdvice = STRINGS.advice.fixed[peakLevel] || STRINGS.advice.fixed.Low;
  const standardResponse: AdviceResponse = {
    schools: fallbackAdvice.schools,
    workers: fallbackAdvice.workers,
    families: fallbackAdvice.families,
    isAI: false,
    peakLevel,
    worstWindowText: outlook.worstWindow.displayRange,
    cityName: outlook.city.name,
  };

  const peakHour = outlook.hourlyResults[outlook.peakHourIndex] || outlook.hourlyResults[0];
  const topFactors = peakHour
    ? Object.values(peakHour.subScores)
        .filter((s) => s.subScore !== null)
        .slice(0, 4)
        .map((s) => ({
          name: s.displayName,
          value: s.rawValue,
          unit: s.unit,
          status: s.status,
        }))
    : [];

  const inputPayload = {
    city: outlook.city.name,
    levelNow: outlook.levelNow,
    peakLevel,
    peakWindow: outlook.worstWindow.displayRange,
    confidence: outlook.confidence,
    topFactors,
    dataSourceType: outlook.dataSourceType,
  };

  const cacheKey = serializeGeminiAdviceInputs(inputPayload);
  const cached = adviceCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const allowedDigits = extractAllowedDigits(inputPayload);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), APP_CONFIG.geminiTimeoutMs);

    const response = await fetch('/api/gemini/advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inputPayload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      // Do not cache fallback on transport or HTTP failure, enabling subsequent recovery
      return standardResponse;
    }

    const json = await response.json();
    if (!json.ok || !json.data) {
      // Do not cache fallback on server failure
      return standardResponse;
    }

    const { schools, workers, families } = json.data;

    // Strict validation
    if (
      isValidField(schools, allowedDigits) &&
      isValidField(workers, allowedDigits) &&
      isValidField(families, allowedDigits)
    ) {
      const aiResponse: AdviceResponse = {
        schools: schools.trim(),
        workers: workers.trim(),
        families: families.trim(),
        isAI: true,
        modelName: APP_CONFIG.geminiModelName,
        peakLevel,
        worstWindowText: outlook.worstWindow.displayRange,
        cityName: outlook.city.name,
      };
      // Only cache valid verified AI responses
      adviceCache.set(cacheKey, aiResponse);
      return aiResponse;
    }

    return standardResponse;
  } catch {
    return standardResponse;
  }
}

export interface SchoolAdviceResult {
  summary: string;
  isAI: boolean;
}

export async function getSchoolModeAdvice(
  cityName: string,
  activityType: SchoolActivityType,
  hour: string,
  assessment: {
    recommendedAction: string;
    actionTitle: string;
    primaryGuidance: string;
    reason: string;
    triggeredRules: Array<{ rule: { id: string; metric: string } }>;
    dataMissingForAssessment?: boolean;
    isPolicyConfigured?: boolean;
  },
  readings: {
    temperature: number | null;
    relativeHumidity: number | null;
    heatIndex: { heatIndexCelsius: number | null; category: string };
    pm10: number | null;
    dust: number | null;
    windSpeed: number | null;
  },
  outlookContext?: {
    levelNow?: string;
    peakLevel?: string;
    peakWindow?: string;
    confidence?: string;
  }
): Promise<SchoolAdviceResult> {
  const fallbackSummary = assessment.primaryGuidance;

  // If policy is unconfigured or required data is missing for assessment,
  // return deterministic fallback guidance immediately without invoking Gemini
  if (assessment.dataMissingForAssessment) {
    return {
      summary:
        fallbackSummary ||
        'Assessment unavailable: required environmental data is missing. Review applicable school policy before conducting outdoor activities.',
      isAI: false,
    };
  }

  if (assessment.isPolicyConfigured === false) {
    return {
      summary:
        fallbackSummary ||
        'School policy configuration required before evaluating outdoor activity recommendations.',
      isAI: false,
    };
  }

  // Validate activity to fixed list: break or pe, plus lunch only if enabled
  const lunchAllowed = APP_CONFIG.schoolActivities?.showLunch ?? false;
  let normalizedActivity: 'break' | 'pe' | 'lunch' = 'break';
  if (activityType === 'pe') normalizedActivity = 'pe';
  else if (lunchAllowed && (String(activityType) === 'lunch_other' || String(activityType) === 'lunch')) normalizedActivity = 'lunch';

  // Validate action to fixed list: normal, shorten, or cancel
  let normalizedAction: 'normal' | 'shorten' | 'cancel' = 'normal';
  if (assessment.recommendedAction === 'modified') normalizedAction = 'shorten';
  else if (assessment.recommendedAction === 'indoor_only' || assessment.recommendedAction === 'suspend') normalizedAction = 'cancel';

  const levelsStr = `${outlookContext?.levelNow ?? ''}->${outlookContext?.peakLevel ?? normalizedAction}`;
  const peakWin = outlookContext?.peakWindow ?? hour;
  const conf = outlookContext?.confidence ?? 'Medium';

  // Send rule IDs and metric names instead of free text
  const triggeredRules = assessment.triggeredRules.map((tr) => ({
    ruleId: tr.rule.id,
    metric: tr.rule.metric,
  }));

  // Accept numbers as well as strings for readings
  const inputPayload = {
    city: cityName,
    activity: normalizedActivity,
    hour,
    action: normalizedAction,
    reason: assessment.reason,
    heatIndex: readings.heatIndex.heatIndexCelsius,
    temperature: readings.temperature,
    humidity: readings.relativeHumidity,
    pm10: readings.pm10,
    dust: readings.dust,
    windSpeed: readings.windSpeed,
    triggeredRules,
    levelNow: outlookContext?.levelNow,
    peakLevel: outlookContext?.peakLevel,
    peakWindow: peakWin,
    confidence: conf,
    lunchEnabled: lunchAllowed,
  };

  const cacheKey = serializeSchoolAdviceInputs(inputPayload);
  const cachedSummary = schoolCache.get(cacheKey);
  if (cachedSummary) {
    return { summary: cachedSummary, isAI: true };
  }

  try {

    const allowedDigits = extractAllowedDigits(inputPayload);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), APP_CONFIG.geminiTimeoutMs);

    const res = await fetch('/api/gemini/school-advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inputPayload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return { summary: fallbackSummary, isAI: false };
    const json = await res.json();
    if (!json.ok || !json.data?.summary) return { summary: fallbackSummary, isAI: false };

    const rawSummary = String(json.data.summary).trim();
    if (isValidField(rawSummary, allowedDigits)) {
      schoolCache.set(cacheKey, rawSummary);
      return { summary: rawSummary, isAI: true };
    }

    return { summary: fallbackSummary, isAI: false };
  } catch {
    return { summary: fallbackSummary, isAI: false };
  }
}
