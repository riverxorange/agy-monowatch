/**
 * @fileoverview Built-in LLM and image generation pricing catalog plus dynamic
 * `pricing_override.json` registry (`effectiveFrom` schedules & `over200k` tiers).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MAX_WINDOW,
  DEFAULT_SOFT_LIMIT,
  fileSig,
} from './utils.mjs';
import {
  enumToModelCode,
  placeholderToEnum,
  stripCanaryCohortSuffix,
  stripStandardModelTier,
} from './routing.mjs';

/**
 * Built-in GCP / Vertex AI equivalent public API rate card
 * (USD per 1,000,000 tokens). Supports historical `schedule[].effectiveFrom`
 * windows and `pricing_override.json` hot-reloading.
 */
const GEMINI_PRO_OVER_200K = Object.freeze({
  thresholdTokens: 200_000,
  inputRate: 4.0,
  cacheRate: 0.2,
  outputRate: 15.0,
});

const GEMINI_LEGACY_PRO_OVER_200K = Object.freeze({
  thresholdTokens: 200_000,
  inputRate: 4.0,
  cacheRate: 0.4,
  outputRate: 18.0,
});

// Gemini 4 Carbon promotional rate ($2 / $0.10 / $10) ends 2026-11-30;
// standard rate ($4 / $0.20 / $20, flat up to 1M) takes effect 2026-12-01.
const GEMINI_CARBON_DEC_2026_SCHEDULE = Object.freeze([
  Object.freeze({
    effectiveFrom: '2026-12-01T00:00:00Z',
    inputRate: 4.0,
    cacheRate: 0.2,
    outputRate: 20.0,
    over200k: null,
  }),
]);

export const BASE_MODELS = [
  {
    enums: [1528],
    placeholders: ['MODEL_PLACEHOLDER_M528'],
    slugs: [
      'gemini-4-hydrogen-xhigh',
      'gemini-4-hydrogen-extra-high',
      'gemini-4-hydrogen-extra_high',
    ],
    slug: 'gemini-4-hydrogen-xhigh',
    shortName: 'Hydrogen',
    fullName: 'Gemini 4 Hydrogen (XHigh)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 1.5,
    cacheRate: 0.075,
    outputRate: 7.5,
  },
  {
    enums: [1525, 1530],
    placeholders: ['MODEL_PLACEHOLDER_M525', 'MODEL_PLACEHOLDER_M530'],
    slugs: ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-tiered-high'],
    slug: 'gemini-4-hydrogen-high',
    shortName: 'Hydrogen',
    fullName: 'Gemini 4 Hydrogen (High)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 1.5,
    cacheRate: 0.075,
    outputRate: 7.5,
  },
  {
    enums: [1526],
    placeholders: ['MODEL_PLACEHOLDER_M526'],
    slugs: ['gemini-4-hydrogen-medium', 'gemini-4-hydrogen'],
    slug: 'gemini-4-hydrogen-medium',
    shortName: 'Hydrogen',
    fullName: 'Gemini 4 Hydrogen (Medium)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 1.5,
    cacheRate: 0.075,
    outputRate: 7.5,
  },
  {
    enums: [1527],
    placeholders: ['MODEL_PLACEHOLDER_M527'],
    slugs: ['gemini-4-hydrogen-low'],
    slug: 'gemini-4-hydrogen-low',
    shortName: 'Hydrogen',
    fullName: 'Gemini 4 Hydrogen (Low)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 1.5,
    cacheRate: 0.075,
    outputRate: 7.5,
  },
  {
    enums: [1535],
    placeholders: ['MODEL_PLACEHOLDER_M535'],
    slugs: [
      'gemini-4-neon-xhigh',
      'gemini-4-neon-extra-high',
      'gemini-4-neon-extra_high',
    ],
    slug: 'gemini-4-neon-xhigh',
    shortName: 'Neon',
    fullName: 'Gemini 4 Neon (XHigh)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 3.0,
    cacheRate: 0.15,
    outputRate: 15.0,
  },
  {
    enums: [1532],
    placeholders: ['MODEL_PLACEHOLDER_M532'],
    slugs: ['gemini-4-neon-high'],
    slug: 'gemini-4-neon-high',
    shortName: 'Neon',
    fullName: 'Gemini 4 Neon (High)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 3.0,
    cacheRate: 0.15,
    outputRate: 15.0,
  },
  {
    enums: [1533],
    placeholders: ['MODEL_PLACEHOLDER_M533'],
    slugs: ['gemini-4-neon-medium', 'gemini-4-neon'],
    slug: 'gemini-4-neon-medium',
    shortName: 'Neon',
    fullName: 'Gemini 4 Neon (Medium)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 3.0,
    cacheRate: 0.15,
    outputRate: 15.0,
  },
  {
    enums: [1534],
    placeholders: ['MODEL_PLACEHOLDER_M534'],
    slugs: ['gemini-4-neon-low'],
    slug: 'gemini-4-neon-low',
    shortName: 'Neon',
    fullName: 'Gemini 4 Neon (Low)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 3.0,
    cacheRate: 0.15,
    outputRate: 15.0,
  },
  {
    enums: [1427],
    placeholders: ['MODEL_PLACEHOLDER_M427'],
    slugs: ['gemini-4-carbon-high'],
    slug: 'gemini-4-carbon-high',
    shortName: 'Carbon',
    fullName: 'Gemini 4 Carbon (High)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 2.0,
    cacheRate: 0.1,
    outputRate: 10.0,
    over200k: GEMINI_PRO_OVER_200K,
    schedule: GEMINI_CARBON_DEC_2026_SCHEDULE,
  },
  {
    enums: [1437],
    placeholders: ['MODEL_PLACEHOLDER_M437'],
    slugs: ['gemini-4-carbon-medium', 'gemini-4-carbon'],
    slug: 'gemini-4-carbon-medium',
    shortName: 'Carbon',
    fullName: 'Gemini 4 Carbon (Medium)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 2.0,
    cacheRate: 0.1,
    outputRate: 10.0,
    over200k: GEMINI_PRO_OVER_200K,
    schedule: GEMINI_CARBON_DEC_2026_SCHEDULE,
  },
  {
    enums: [1438],
    placeholders: ['MODEL_PLACEHOLDER_M438'],
    slugs: ['gemini-4-carbon-low'],
    slug: 'gemini-4-carbon-low',
    shortName: 'Carbon',
    fullName: 'Gemini 4 Carbon (Low)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 2.0,
    cacheRate: 0.1,
    outputRate: 10.0,
    over200k: GEMINI_PRO_OVER_200K,
    schedule: GEMINI_CARBON_DEC_2026_SCHEDULE,
  },
  {
    enums: [1417],
    placeholders: ['MODEL_PLACEHOLDER_M417'],
    slugs: ['gemini-4-argon-high', 'gemini-4-argon', 'gemini-4-argon-b'],
    slug: 'gemini-4-argon-high',
    shortName: 'Argon',
    fullName: 'Gemini 4 Argon (High)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 2.0,
    cacheRate: 0.1,
    outputRate: 10.0,
    over200k: GEMINI_PRO_OVER_200K,
  },
  {
    enums: [1418],
    placeholders: ['MODEL_PLACEHOLDER_M418'],
    slugs: ['gemini-4-argon-medium'],
    slug: 'gemini-4-argon-medium',
    shortName: 'Argon',
    fullName: 'Gemini 4 Argon (Medium)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 2.0,
    cacheRate: 0.1,
    outputRate: 10.0,
    over200k: GEMINI_PRO_OVER_200K,
  },
  {
    enums: [1419],
    placeholders: ['MODEL_PLACEHOLDER_M419'],
    slugs: ['gemini-4-argon-low'],
    slug: 'gemini-4-argon-low',
    shortName: 'Argon',
    fullName: 'Gemini 4 Argon (Low)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 2.0,
    cacheRate: 0.1,
    outputRate: 10.0,
    over200k: GEMINI_PRO_OVER_200K,
  },
  {
    enums: [],
    placeholders: [],
    slugs: ['gemini-pro-orchestrator-neon'],
    slug: 'gemini-pro-orchestrator-neon',
    shortName: 'Neon',
    fullName: 'Gemini 4 Neon (Orchestrator)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 3.0,
    cacheRate: 0.15,
    outputRate: 15.0,
  },
  {
    enums: [1667],
    placeholders: ['MODEL_PLACEHOLDER_M667'],
    slugs: ['gemini-pro-orchestrator'],
    slug: 'gemini-pro-orchestrator',
    shortName: 'Carbon',
    fullName: 'Gemini 4 Carbon (Orchestrator)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 2.0,
    cacheRate: 0.1,
    outputRate: 10.0,
    over200k: GEMINI_PRO_OVER_200K,
    schedule: GEMINI_CARBON_DEC_2026_SCHEDULE,
  },
  {
    enums: [1681],
    placeholders: ['MODEL_PLACEHOLDER_M681'],
    slugs: ['gemini-pro-orchestrator-argon'],
    slug: 'gemini-pro-orchestrator-argon',
    shortName: 'Argon',
    fullName: 'Gemini 4 Argon (Orchestrator)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 2.0,
    cacheRate: 0.1,
    outputRate: 10.0,
    over200k: GEMINI_PRO_OVER_200K,
  },
  {
    enums: [1669],
    placeholders: ['MODEL_PLACEHOLDER_M669'],
    slugs: ['gemini-flash-worker-agy'],
    slug: 'gemini-flash-worker-agy',
    shortName: 'Hydrogen',
    fullName: 'Gemini 4 Hydrogen (Orchestrator)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 1.5,
    cacheRate: 0.075,
    outputRate: 7.5,
  },
  {
    enums: [],
    placeholders: [],
    slugs: ['gemini-pro-orchestrator-hydrogen'],
    slug: 'gemini-pro-orchestrator-hydrogen',
    shortName: 'Hydrogen',
    fullName: 'Gemini 4 Hydrogen (Orchestrator)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 1.5,
    cacheRate: 0.075,
    outputRate: 7.5,
  },
  {
    enums: [1318],
    placeholders: ['MODEL_PLACEHOLDER_M318'],
    slugs: ['gemini-3.8-flash-high', 'gemini-3.8-flash', 'gemini-3.8-flash-exp-a'],
    slug: 'gemini-3.8-flash-high',
    shortName: 'Flash',
    fullName: 'Gemini 3.8 Flash (High)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 0.75,
    cacheRate: 0.075,
    outputRate: 3.75,
  },
  {
    enums: [1322],
    placeholders: ['MODEL_PLACEHOLDER_M322'],
    slugs: ['gemini-3.8-flash-medium', 'gemini-3.8-flash-tiered'],
    slug: 'gemini-3.8-flash-medium',
    shortName: 'Flash',
    fullName: 'Gemini 3.8 Flash (Medium)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 0.75,
    cacheRate: 0.075,
    outputRate: 3.75,
  },
  {
    enums: [1320],
    placeholders: ['MODEL_PLACEHOLDER_M320'],
    slugs: ['gemini-3.8-flash-low'],
    slug: 'gemini-3.8-flash-low',
    shortName: 'Flash',
    fullName: 'Gemini 3.8 Flash (Low)',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 0.75,
    cacheRate: 0.075,
    outputRate: 3.75,
  },
  {
    enums: [1132],
    placeholders: ['MODEL_PLACEHOLDER_M132'],
    slugs: ['gemini-3.5-flash-lite', 'gemini-3-flash-a', 'gemini-3-flash-agent'],
    slug: 'gemini-3.5-flash-lite',
    shortName: '3.5 Flash',
    fullName: 'Gemini 3.5 Flash',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 0.25,
    cacheRate: 0.025,
    outputRate: 1.5,
  },
  {
    enums: [1016],
    placeholders: ['MODEL_PLACEHOLDER_M16'],
    slugs: ['gemini-pro-default'],
    slug: 'gemini-pro-default',
    shortName: 'Gemini Pro',
    fullName: 'Gemini Pro',
    provider: 'gemini',
    softLimit: 512_000,
    maxWindow: 1_048_576,
    inputRate: 2.0,
    cacheRate: 0.2,
    outputRate: 12.0,
    over200k: GEMINI_LEGACY_PRO_OVER_200K,
  },
  {
    enums: [1402],
    placeholders: ['MODEL_PLACEHOLDER_M402'],
    slugs: ['claude-opus-5-5-high'],
    slug: 'claude-opus-5-5-high',
    shortName: 'Opus 5.5',
    fullName: 'Claude Opus 5.5 (High)',
    provider: 'claude',
    softLimit: 512_000,
    maxWindow: 1_000_000,
    inputRate: 4.0,
    cacheRate: 0.2,
    cacheWriteRate: 5.0,
    outputRate: 20.0,
  },
  {
    enums: [1401],
    placeholders: ['MODEL_PLACEHOLDER_M401'],
    slugs: ['claude-opus-5-5-medium', 'claude-opus-5-5'],
    slug: 'claude-opus-5-5-medium',
    shortName: 'Opus 5.5',
    fullName: 'Claude Opus 5.5 (Medium)',
    provider: 'claude',
    softLimit: 512_000,
    maxWindow: 1_000_000,
    inputRate: 4.0,
    cacheRate: 0.2,
    cacheWriteRate: 5.0,
    outputRate: 20.0,
  },
  {
    enums: [1400],
    placeholders: ['MODEL_PLACEHOLDER_M400'],
    slugs: ['claude-opus-5-5-low'],
    slug: 'claude-opus-5-5-low',
    shortName: 'Opus 5.5',
    fullName: 'Claude Opus 5.5 (Low)',
    provider: 'claude',
    softLimit: 512_000,
    maxWindow: 1_000_000,
    inputRate: 4.0,
    cacheRate: 0.2,
    cacheWriteRate: 5.0,
    outputRate: 20.0,
  },
  {
    enums: [1405],
    placeholders: ['MODEL_PLACEHOLDER_M405'],
    slugs: ['claude-sonnet-5-5-high'],
    slug: 'claude-sonnet-5-5-high',
    shortName: 'Sonnet 5.5',
    fullName: 'Claude Sonnet 5.5 (High)',
    provider: 'claude',
    softLimit: 512_000,
    maxWindow: 1_000_000,
    inputRate: 2.0,
    cacheRate: 0.1,
    cacheWriteRate: 2.5,
    outputRate: 10.0,
  },
  {
    enums: [1404],
    placeholders: ['MODEL_PLACEHOLDER_M404'],
    slugs: ['claude-sonnet-5-5-medium', 'claude-sonnet-5-5'],
    slug: 'claude-sonnet-5-5-medium',
    shortName: 'Sonnet 5.5',
    fullName: 'Claude Sonnet 5.5 (Medium)',
    provider: 'claude',
    softLimit: 512_000,
    maxWindow: 1_000_000,
    inputRate: 2.0,
    cacheRate: 0.1,
    cacheWriteRate: 2.5,
    outputRate: 10.0,
  },
  {
    enums: [1403],
    placeholders: ['MODEL_PLACEHOLDER_M403'],
    slugs: ['claude-sonnet-5-5-low'],
    slug: 'claude-sonnet-5-5-low',
    shortName: 'Sonnet 5.5',
    fullName: 'Claude Sonnet 5.5 (Low)',
    provider: 'claude',
    softLimit: 512_000,
    maxWindow: 1_000_000,
    inputRate: 2.0,
    cacheRate: 0.1,
    cacheWriteRate: 2.5,
    outputRate: 10.0,
  },
  {
    enums: [1026],
    placeholders: ['MODEL_PLACEHOLDER_M26'],
    slugs: ['claude-opus-4-6-thinking'],
    slug: 'claude-opus-4-6-thinking',
    shortName: 'Opus 4.6',
    fullName: 'Claude Opus 4.6',
    provider: 'claude',
    softLimit: 180_000,
    maxWindow: 200_000,
    inputRate: 5.0,
    cacheRate: 0.5,
    cacheWriteRate: 6.25,
    outputRate: 25.0,
  },
  {
    enums: [342],
    placeholders: ['MODEL_OPENAI_GPT_OSS_120B_MEDIUM', 'MODEL_ENUM_342'],
    slugs: ['gpt-oss-120b-medium', 'gpt-oss-120b', 'gpt-oss-120b-maas'],
    slug: 'gpt-oss-120b-medium',
    shortName: 'GPT-OSS',
    fullName: 'GPT-OSS 120B (Medium)',
    provider: 'openai',
    softLimit: 120_000,
    maxWindow: 131_072,
    inputRate: 0.09,
    cacheRate: 0.045,
    outputRate: 0.36,
  },
];

/**
 * Built-in image generation pricing catalog (USD per generated image).
 */
export const IMAGE_MODELS = [
  {
    slugs: ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-lite-image-preview'],
    slug: 'gemini-3.1-flash-lite-image',
    shortName: 'Flash-Lite Image',
    fullName: 'Gemini 3.1 Flash-Lite Image',
    provider: 'gemini',
    perImageUsd: 0.034,
  },
  {
    slugs: ['gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview'],
    slug: 'gemini-3.1-flash-image',
    shortName: 'Flash Image',
    fullName: 'Gemini 3.1 Flash Image',
    provider: 'gemini',
    perImageUsd: 0.067,
  },
  {
    slugs: ['gemini-3-pro-image', 'gemini-3-pro-image-preview'],
    slug: 'gemini-3-pro-image',
    shortName: 'Pro Image',
    fullName: 'Gemini 3 Pro Image',
    provider: 'gemini',
    perImageUsd: 0.04,
  },
  {
    slugs: ['imagen-4', 'imagen-3', 'imagen'],
    slug: 'imagen-4',
    shortName: 'Imagen',
    fullName: 'Imagen Generation',
    provider: 'gemini',
    perImageUsd: 0.04,
  },
];

export const DEFAULT_MODEL =
  BASE_MODELS.find((m) => m.slug === 'gemini-4-carbon-high') || BASE_MODELS[0];
export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0];

function parseEffectiveFromSec(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e11 ? raw / 1000 : raw;
  }
  const str = String(raw).trim();
  if (!str) return 0;
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str);
    return n > 1e11 ? n / 1000 : n;
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(str) ? `${str}T00:00:00Z` : str;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

function normalizeOver200kTier(rawOver, fallbackBase) {
  if (!rawOver || typeof rawOver !== 'object') return null;
  const thresholdTokens =
    Number.isFinite(Number(rawOver.thresholdTokens)) && Number(rawOver.thresholdTokens) > 0
      ? Number(rawOver.thresholdTokens)
      : 200_000;
  const inputRate = Number.isFinite(Number(rawOver.inputRate))
    ? Number(rawOver.inputRate)
    : fallbackBase.inputRate;
  const cacheRate = Number.isFinite(Number(rawOver.cacheRate))
    ? Number(rawOver.cacheRate)
    : fallbackBase.cacheRate;
  const outputRate = Number.isFinite(Number(rawOver.outputRate))
    ? Number(rawOver.outputRate)
    : fallbackBase.outputRate;
  const cacheWriteRate = Number.isFinite(Number(rawOver.cacheWriteRate))
    ? Number(rawOver.cacheWriteRate)
    : inputRate * 1.25;
  return {
    thresholdTokens,
    inputRate,
    cacheRate,
    outputRate,
    cacheWriteRate,
  };
}

function normalizeScheduleEntry(rawEntry, baseSpec) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const effectiveFromSec = parseEffectiveFromSec(
    rawEntry.effectiveFrom ?? rawEntry.from ?? rawEntry.date
  );
  const inputRate = Number.isFinite(Number(rawEntry.inputRate))
    ? Number(rawEntry.inputRate)
    : baseSpec.inputRate;
  const cacheRate = Number.isFinite(Number(rawEntry.cacheRate))
    ? Number(rawEntry.cacheRate)
    : baseSpec.cacheRate;
  const outputRate = Number.isFinite(Number(rawEntry.outputRate))
    ? Number(rawEntry.outputRate)
    : baseSpec.outputRate;
  const cacheWriteRate = Number.isFinite(Number(rawEntry.cacheWriteRate))
    ? Number(rawEntry.cacheWriteRate)
    : inputRate * 1.25;
  const over200kRaw =
    rawEntry.over200k ||
    (Number.isFinite(Number(rawEntry.over200kInputRate))
      ? {
          inputRate: rawEntry.over200kInputRate,
          cacheRate: rawEntry.over200kCacheRate,
          outputRate: rawEntry.over200kOutputRate,
          cacheWriteRate: rawEntry.over200kCacheWriteRate,
        }
      : null);
  const over200k =
    rawEntry.over200k === null
      ? null
      : over200kRaw
        ? normalizeOver200kTier(over200kRaw, { inputRate, cacheRate, outputRate })
        : baseSpec.over200k || null;

  return {
    effectiveFrom: rawEntry.effectiveFrom || null,
    effectiveFromSec,
    inputRate,
    cacheRate,
    outputRate,
    cacheWriteRate,
    perImageUsd: Number.isFinite(Number(rawEntry.perImageUsd))
      ? Number(rawEntry.perImageUsd)
      : baseSpec.perImageUsd,
    over200k,
  };
}

function findModelOverrideEntry(modelsObj, spec) {
  if (!modelsObj || typeof modelsObj !== 'object') return null;
  if (modelsObj[spec.slug]) return modelsObj[spec.slug];
  if (modelsObj[spec.shortName]) return modelsObj[spec.shortName];
  if (Array.isArray(spec.enums) && spec.enums[0] && modelsObj[String(spec.enums[0])]) {
    return modelsObj[String(spec.enums[0])];
  }
  for (const alias of spec.slugs || []) {
    if (modelsObj[alias]) return modelsObj[alias];
  }
  return null;
}

export function createPricingRegistry({
  primaryAppDataDir,
  sidecarDataDir = '',
  pricingOverridePath = '',
  onReload = null,
}) {
  let overrideSig = '';
  let enumCatalog = new Map();
  let placeholderCatalog = new Map();
  let slugCatalog = new Map();
  let imageSlugCatalog = new Map();

  let globalDefaultModelSig = '';
  let globalDefaultModelCached = DEFAULT_MODEL;
  let globalDefaultModelExplicit = false;

  function rebuildPricingMaps(rawOverrideDoc = null) {
    enumCatalog = new Map();
    placeholderCatalog = new Map();
    slugCatalog = new Map();
    imageSlugCatalog = new Map();

    const modelsMap =
      rawOverrideDoc && typeof rawOverrideDoc === 'object'
        ? rawOverrideDoc.models && typeof rawOverrideDoc.models === 'object'
          ? rawOverrideDoc.models
          : rawOverrideDoc
        : null;
    const topHistory =
      rawOverrideDoc && Array.isArray(rawOverrideDoc.history)
        ? rawOverrideDoc.history
        : rawOverrideDoc && Array.isArray(rawOverrideDoc.schedules)
          ? rawOverrideDoc.schedules
          : [];

    for (const m of BASE_MODELS) {
      const spec = {
        ...m,
        over200k: m.over200k ? normalizeOver200kTier(m.over200k, m) : null,
        schedule: [],
      };

      const rawScheduleItems = Array.isArray(m.schedule) ? [...m.schedule] : [];
      const ov = findModelOverrideEntry(modelsMap, spec);

      if (Array.isArray(ov)) {
        rawScheduleItems.push(...ov);
      } else if (ov && typeof ov === 'object') {
        if (ov.effectiveFrom && !Array.isArray(ov.schedule)) {
          rawScheduleItems.push(ov);
        } else {
          if (Number.isFinite(Number(ov.inputRate))) spec.inputRate = Number(ov.inputRate);
          if (Number.isFinite(Number(ov.cacheRate))) spec.cacheRate = Number(ov.cacheRate);
          if (Number.isFinite(Number(ov.outputRate))) spec.outputRate = Number(ov.outputRate);
          if (Number.isFinite(Number(ov.cacheWriteRate))) {
            spec.cacheWriteRate = Number(ov.cacheWriteRate);
          }
          if (Number.isFinite(Number(ov.softLimit))) spec.softLimit = Number(ov.softLimit);
          if (Number.isFinite(Number(ov.maxWindow))) spec.maxWindow = Number(ov.maxWindow);
          if (typeof ov.shortName === 'string' && ov.shortName) spec.shortName = ov.shortName;
          if (typeof ov.fullName === 'string' && ov.fullName) spec.fullName = ov.fullName;
          const ovOver200k =
            ov.over200k ||
            (Number.isFinite(Number(ov.over200kInputRate))
              ? {
                  inputRate: ov.over200kInputRate,
                  cacheRate: ov.over200kCacheRate,
                  outputRate: ov.over200kOutputRate,
                  cacheWriteRate: ov.over200kCacheWriteRate,
                }
              : null);
          if (ovOver200k) {
            spec.over200k = normalizeOver200kTier(ovOver200k, spec);
          }
          if (Array.isArray(ov.schedule)) {
            rawScheduleItems.push(...ov.schedule);
          }
        }
      }

      for (const histBlock of topHistory) {
        if (!histBlock || typeof histBlock !== 'object') continue;
        const hModels = histBlock.models || histBlock;
        const hOv = findModelOverrideEntry(hModels, spec);
        if (hOv && typeof hOv === 'object') {
          rawScheduleItems.push({
            ...hOv,
            effectiveFrom: hOv.effectiveFrom ?? histBlock.effectiveFrom ?? histBlock.date,
          });
        }
      }

      if (rawScheduleItems.length > 0) {
        spec.schedule = rawScheduleItems
          .map((item) => normalizeScheduleEntry(item, spec))
          .filter(Boolean)
          .sort((a, b) => a.effectiveFromSec - b.effectiveFromSec);
      }

      for (const e of spec.enums) enumCatalog.set(e, spec);
      for (const ph of spec.placeholders) placeholderCatalog.set(ph, spec);
      for (const s of spec.slugs) slugCatalog.set(s.toLowerCase(), spec);
    }

    for (const im of IMAGE_MODELS) {
      const spec = { ...im, schedule: [] };
      const rawScheduleItems = [];
      const ov = findModelOverrideEntry(modelsMap, spec);
      if (Array.isArray(ov)) {
        rawScheduleItems.push(...ov);
      } else if (ov && typeof ov === 'object') {
        if (ov.effectiveFrom && !Array.isArray(ov.schedule)) {
          rawScheduleItems.push(ov);
        } else {
          if (Number.isFinite(Number(ov.perImageUsd))) {
            spec.perImageUsd = Number(ov.perImageUsd);
          }
          if (typeof ov.shortName === 'string' && ov.shortName) spec.shortName = ov.shortName;
          if (typeof ov.fullName === 'string' && ov.fullName) spec.fullName = ov.fullName;
          if (Array.isArray(ov.schedule)) {
            rawScheduleItems.push(...ov.schedule);
          }
        }
      }
      if (rawScheduleItems.length > 0) {
        spec.schedule = rawScheduleItems
          .map((item) => normalizeScheduleEntry(item, { inputRate: 0, cacheRate: 0, outputRate: 0, perImageUsd: spec.perImageUsd }))
          .filter(Boolean)
          .sort((a, b) => a.effectiveFromSec - b.effectiveFromSec);
      }
      for (const s of spec.slugs) {
        imageSlugCatalog.set(s.toLowerCase(), spec);
      }
    }

    if (modelsMap && typeof modelsMap === 'object') {
      for (const [key, rawVal] of Object.entries(modelsMap)) {
        if (!rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) continue;
        if (key === 'history' || key === 'schedules') continue;
        const kLow = key.trim().toLowerCase();
        if (slugCatalog.has(kLow) || imageSlugCatalog.has(kLow)) continue;
        if (Number.isFinite(Number(rawVal.perImageUsd))) {
          const imSpec = {
            slugs: [kLow, ...(Array.isArray(rawVal.slugs) ? rawVal.slugs : [])],
            slug: kLow,
            shortName: String(rawVal.shortName || kLow),
            fullName: String(rawVal.fullName || rawVal.shortName || kLow),
            provider: String(rawVal.provider || 'gemini'),
            perImageUsd: Number(rawVal.perImageUsd),
            schedule: Array.isArray(rawVal.schedule)
              ? rawVal.schedule
                  .map((it) => normalizeScheduleEntry(it, { inputRate: 0, cacheRate: 0, outputRate: 0, perImageUsd: Number(rawVal.perImageUsd) }))
                  .filter(Boolean)
                  .sort((a, b) => a.effectiveFromSec - b.effectiveFromSec)
              : [],
          };
          for (const s of imSpec.slugs) imageSlugCatalog.set(String(s).toLowerCase(), imSpec);
          continue;
        }
        const mCode = key.match(/^MODEL_PLACEHOLDER_M(\d+)$/i);
        const numKey = /^\d+$/.test(key) ? Number(key) : mCode ? 1000 + Number(mCode[1]) : 0;
        if (numKey && enumCatalog.has(numKey)) continue;

        const enums = Array.isArray(rawVal.enums)
          ? rawVal.enums.map(Number).filter((x) => x > 0)
          : numKey
            ? [numKey]
            : [];
        const placeholders = enums
          .map((e) => enumToModelCode(e).placeholder)
          .filter(Boolean);
        const slug = String(rawVal.slug || (numKey ? `model-${key.toLowerCase()}` : kLow));
        const customSpec = {
          enums,
          placeholders,
          slugs: [slug, ...(Array.isArray(rawVal.slugs) ? rawVal.slugs : [])],
          slug,
          shortName: String(rawVal.shortName || slug),
          fullName: String(rawVal.fullName || rawVal.shortName || slug),
          provider: String(
            rawVal.provider ||
              (/claude|anthropic/i.test(slug) ? 'claude' : /gpt|openai/i.test(slug) ? 'openai' : 'gemini')
          ),
          softLimit: Number(rawVal.softLimit) || DEFAULT_SOFT_LIMIT,
          maxWindow: Number(rawVal.maxWindow) || DEFAULT_MAX_WINDOW,
          inputRate: Number.isFinite(Number(rawVal.inputRate)) ? Number(rawVal.inputRate) : 2.0,
          cacheRate: Number.isFinite(Number(rawVal.cacheRate)) ? Number(rawVal.cacheRate) : 0.1,
          outputRate: Number.isFinite(Number(rawVal.outputRate)) ? Number(rawVal.outputRate) : 10.0,
          over200k: rawVal.over200k ? normalizeOver200kTier(rawVal.over200k, rawVal) : null,
          schedule: Array.isArray(rawVal.schedule)
            ? rawVal.schedule
                .map((it) => normalizeScheduleEntry(it, rawVal))
                .filter(Boolean)
                .sort((a, b) => a.effectiveFromSec - b.effectiveFromSec)
            : [],
        };
        for (const e of customSpec.enums) enumCatalog.set(e, customSpec);
        for (const ph of customSpec.placeholders) placeholderCatalog.set(ph, customSpec);
        for (const s of customSpec.slugs) slugCatalog.set(String(s).toLowerCase(), customSpec);
      }
    }
  }

  rebuildPricingMaps(null);

  function refreshIfNeeded() {
    const legacySidecarDataDir = primaryAppDataDir
      ? join(primaryAppDataDir, 'sidecar_data', 'thread-monitor', 'monitor_board', 'data')
      : '';
    const monowatchSidecarDataDir = primaryAppDataDir
      ? join(primaryAppDataDir, 'sidecar_data', 'monowatch', 'monitor_board', 'data')
      : '';
    const candidates = [
      pricingOverridePath || '',
      sidecarDataDir ? join(sidecarDataDir, 'pricing_override.json') : '',
      monowatchSidecarDataDir ? join(monowatchSidecarDataDir, 'pricing_override.json') : '',
      legacySidecarDataDir ? join(legacySidecarDataDir, 'pricing_override.json') : '',
      primaryAppDataDir ? join(primaryAppDataDir, 'pricing_override.json') : '',
    ].filter(Boolean);

    let activePath = '';
    let sig = 'none';
    for (const p of candidates) {
      const s = fileSig(p);
      if (s !== '0') {
        activePath = p;
        sig = `${p}:${s}`;
        break;
      }
    }
    if (sig === overrideSig) return false;
    overrideSig = sig;
    if (!activePath) {
      rebuildPricingMaps(null);
    } else {
      try {
        const parsed = JSON.parse(readFileSync(activePath, 'utf-8'));
        rebuildPricingMaps(parsed);
      } catch {
        rebuildPricingMaps(null);
      }
    }
    globalDefaultModelSig = '';
    if (typeof onReload === 'function') onReload();
    return true;
  }

  function resolveStepRates(modelSpec, stepTimeSec = 0, promptTokens = 0) {
    const spec = modelSpec || DEFAULT_MODEL;
    let activeTier = spec;

    if (Array.isArray(spec.schedule) && spec.schedule.length > 0) {
      const refSec = stepTimeSec > 0 ? stepTimeSec : Date.now() / 1000;
      for (let i = spec.schedule.length - 1; i >= 0; i--) {
        const entry = spec.schedule[i];
        if (refSec >= entry.effectiveFromSec) {
          activeTier = entry;
          break;
        }
      }
    }

    let inputRate = activeTier.inputRate;
    let cacheRate = activeTier.cacheRate;
    let outputRate = activeTier.outputRate;
    let cacheWriteRate = activeTier.cacheWriteRate || inputRate * 1.25;

    if (activeTier.over200k && promptTokens > activeTier.over200k.thresholdTokens) {
      inputRate = activeTier.over200k.inputRate;
      cacheRate = activeTier.over200k.cacheRate;
      outputRate = activeTier.over200k.outputRate;
      cacheWriteRate = activeTier.over200k.cacheWriteRate || inputRate * 1.25;
    }

    return { inputRate, cacheRate, outputRate, cacheWriteRate };
  }

  function resolveImageModelSpec(rawImageSlug = '') {
    const lower = String(rawImageSlug || '').trim().toLowerCase();
    if (lower) {
      if (imageSlugCatalog.has(lower)) {
        return imageSlugCatalog.get(lower);
      }
      for (const [k, spec] of imageSlugCatalog.entries()) {
        if (lower.startsWith(k) || k.startsWith(lower)) {
          return spec;
        }
      }
      if (lower.includes('3.1') && lower.includes('flash') && lower.includes('lite')) {
        return imageSlugCatalog.get('gemini-3.1-flash-lite-image') || DEFAULT_IMAGE_MODEL;
      }
      if (lower.includes('3.1') && lower.includes('flash')) {
        return imageSlugCatalog.get('gemini-3.1-flash-image') || DEFAULT_IMAGE_MODEL;
      }
      if (lower.includes('pro') && lower.includes('image')) {
        return imageSlugCatalog.get('gemini-3-pro-image') || DEFAULT_IMAGE_MODEL;
      }
      if (lower.includes('imagen')) {
        return imageSlugCatalog.get('imagen-4') || DEFAULT_IMAGE_MODEL;
      }
      return {
        slug: lower,
        shortName: lower.replace(/^gemini-/, '').slice(0, 18) || 'Image',
        fullName: rawImageSlug,
        provider: 'gemini',
        perImageUsd: DEFAULT_IMAGE_MODEL.perImageUsd,
        schedule: [],
      };
    }
    return DEFAULT_IMAGE_MODEL;
  }

  function resolveImageStepRate(rawImageSlug = '', stepTimeSec = 0) {
    const spec = resolveImageModelSpec(rawImageSlug);
    let perImageUsd = spec.perImageUsd ?? DEFAULT_IMAGE_MODEL.perImageUsd;
    if (Array.isArray(spec.schedule) && spec.schedule.length > 0) {
      const refSec = stepTimeSec > 0 ? stepTimeSec : Date.now() / 1000;
      for (let i = spec.schedule.length - 1; i >= 0; i--) {
        const entry = spec.schedule[i];
        if (refSec >= entry.effectiveFromSec && Number.isFinite(entry.perImageUsd)) {
          perImageUsd = entry.perImageUsd;
          break;
        }
      }
    }
    return { spec, perImageUsd };
  }

  function refineTierName(baseSpec, hint) {
    if (!baseSpec || !hint) return baseSpec;
    if (
      baseSpec.slug &&
      (baseSpec.slug.startsWith('gemini-pro-orchestrator') ||
        baseSpec.slug === 'gemini-flash-worker-agy')
    ) {
      return baseSpec;
    }
    const h = String(hint);
    const low = h.toLowerCase();
    let tier = '';
    if (low.includes('(xhigh)') || low.endsWith('-xhigh')) tier = 'XHigh';
    else if (low.includes('(high)') || low.endsWith('-high')) tier = 'High';
    else if (low.includes('(medium)') || low.endsWith('-medium')) tier = 'Medium';
    else if (low.includes('(low)') || low.endsWith('-low')) tier = 'Low';
    if (!tier) return baseSpec;

    const baseFull = baseSpec.fullName.replace(
      /\s*\((XHigh|High|Medium|Low)\)\s*$/i,
      ''
    );
    const baseSlug = baseSpec.slug.replace(/-(xhigh|high|medium|low|lite)$/i, '');
    return {
      ...baseSpec,
      slug: `${baseSlug}-${tier.toLowerCase()}`,
      fullName: `${baseFull} (${tier})`,
    };
  }

  function resolveModelBySlugOrText(slugOrName = '', fallbackEnum = 0) {
    const rawStr = String(slugOrName || '').trim();
    const lower = rawStr.toLowerCase();
    if (fallbackEnum && enumCatalog.has(fallbackEnum)) {
      const byEnum = enumCatalog.get(fallbackEnum);
      if (!lower) return byEnum;
      if (
        byEnum.slug === 'gemini-flash-worker-agy' ||
        lower === byEnum.fullName.toLowerCase()
      ) {
        return byEnum;
      }
      const hasExplicitTier = /(?:^|[- (])(xhigh|high|medium|low)(?:[ )]|$)/i.test(
        lower
      );
      if (!hasExplicitTier && !lower.includes('orchestrator')) {
        const enumBase = stripStandardModelTier(byEnum.slug);
        const hintBase = stripStandardModelTier(stripCanaryCohortSuffix(lower));
        if (enumBase && hintBase && enumBase === hintBase) {
          return byEnum;
        }
      }
    }
    if (lower) {
      if (slugCatalog.has(lower)) {
        return refineTierName(slugCatalog.get(lower), rawStr);
      }
      if (placeholderCatalog.has(rawStr.toUpperCase())) {
        return placeholderCatalog.get(rawStr.toUpperCase());
      }
      if (
        lower.includes('flash-worker') ||
        (lower.includes('hydrogen') && lower.includes('(orchestrator)'))
      ) {
        return slugCatalog.get('gemini-flash-worker-agy');
      }
      if (lower.includes('orchestrator')) {
        if (lower.includes('neon')) {
          return slugCatalog.get('gemini-pro-orchestrator-neon');
        }
        if (lower.includes('argon')) {
          return slugCatalog.get('gemini-pro-orchestrator-argon');
        }
        if (lower.includes('hydrogen')) {
          return slugCatalog.get('gemini-pro-orchestrator-hydrogen');
        }
        return slugCatalog.get('gemini-pro-orchestrator');
      }
      if (lower.includes('claude-sonnet-5-5') || lower.includes('sonnet 5.5')) {
        return refineTierName(slugCatalog.get('claude-sonnet-5-5-medium'), rawStr);
      }
      if (lower.includes('claude-opus-5-5') || lower.includes('opus 5.5')) {
        return refineTierName(slugCatalog.get('claude-opus-5-5-high'), rawStr);
      }
      if (lower.includes('claude-opus-4-6') || lower.includes('opus 4.6')) {
        return slugCatalog.get('claude-opus-4-6-thinking');
      }
      if (lower.includes('gpt-oss')) {
        return slugCatalog.get('gpt-oss-120b-medium');
      }
      if (lower.includes('neon')) {
        if (lower.includes('xhigh')) return slugCatalog.get('gemini-4-neon-xhigh');
        if (lower.includes('high')) return slugCatalog.get('gemini-4-neon-high');
        if (lower.includes('low')) return slugCatalog.get('gemini-4-neon-low');
        return slugCatalog.get('gemini-4-neon-medium');
      }
      if (lower.includes('hydrogen')) {
        if (lower.includes('xhigh')) return slugCatalog.get('gemini-4-hydrogen-xhigh');
        if (lower.includes('high')) return slugCatalog.get('gemini-4-hydrogen-high');
        if (lower.includes('low')) return slugCatalog.get('gemini-4-hydrogen-low');
        return slugCatalog.get('gemini-4-hydrogen-medium');
      }
      if (lower.includes('carbon')) {
        if (lower.includes('low')) return slugCatalog.get('gemini-4-carbon-low');
        if (lower.includes('medium')) return slugCatalog.get('gemini-4-carbon-medium');
        return slugCatalog.get('gemini-4-carbon-high');
      }
      if (lower.includes('argon')) {
        if (lower.includes('low')) return slugCatalog.get('gemini-4-argon-low');
        if (lower.includes('medium')) return slugCatalog.get('gemini-4-argon-medium');
        return slugCatalog.get('gemini-4-argon-high');
      }
      if (lower.includes('3.8-flash') || lower.includes('3.8 flash')) {
        if (lower.includes('low')) return slugCatalog.get('gemini-3.8-flash-low');
        if (lower.includes('medium')) return slugCatalog.get('gemini-3.8-flash-medium');
        return refineTierName(slugCatalog.get('gemini-3.8-flash'), rawStr);
      }
      if (lower.includes('3.5-flash') || lower.includes('3-flash') || lower.includes('3.5 flash')) {
        return slugCatalog.get('gemini-3.5-flash-lite');
      }
      if (lower === 'gemini-pro-default' || lower === 'gemini pro') {
        return slugCatalog.get('gemini-pro-default');
      }
    }
    if (!lower && fallbackEnum && enumCatalog.has(fallbackEnum)) {
      return enumCatalog.get(fallbackEnum);
    }
    return null;
  }

  /**
   * Preserves brand-new gray-box / uncataloged models verbatim instead of
   * swallowing them into `DEFAULT_MODEL` (`Gemini 4 Carbon`).
   */
  function synthesizeUnknownModelSpec({
    enumId = 0,
    rawSlug = '',
    displayName = '',
    apiProvider = 0,
  }) {
    const { code, placeholder } = enumToModelCode(enumId);
    const cleanSlug = String(rawSlug || '').trim();
    const cleanDisp = String(displayName || '').trim();
    const combinedHint = `${cleanSlug} ${cleanDisp}`.toLowerCase();

    let provider = 'unknown';
    if (
      apiProvider === 26 ||
      /claude|anthropic|opus|sonnet|haiku/.test(combinedHint)
    ) {
      provider = 'claude';
    } else if (/gpt|openai|o\d-/.test(combinedHint)) {
      provider = 'openai';
    } else if (
      apiProvider === 24 ||
      /gemini|flash|pro|argon|carbon|hydrogen|neon|orchestrator/.test(combinedHint)
    ) {
      provider = 'gemini';
    }

    const isFlashLike = /flash|haiku|lite|mini/.test(combinedHint);
    const isSonnetLike = /sonnet/.test(combinedHint);
    const isHydrogenLike = /hydrogen/.test(combinedHint);
    const inputRate =
      provider === 'claude'
        ? isSonnetLike
          ? 2.0
          : 4.0
        : provider === 'openai'
          ? 0.09
          : isFlashLike
            ? 0.75
            : isHydrogenLike
              ? 1.5
              : 2.0;
    const cacheRate =
      provider === 'claude'
        ? isSonnetLike
          ? 0.1
          : 0.2
        : provider === 'openai'
          ? 0.045
          : isFlashLike || isHydrogenLike
            ? 0.075
            : 0.1;
    const outputRate =
      provider === 'claude'
        ? isSonnetLike
          ? 10.0
          : 20.0
        : provider === 'openai'
          ? 0.36
          : isFlashLike
            ? 3.75
            : isHydrogenLike
              ? 7.5
              : 10.0;

    const slug = cleanSlug
      ? cleanSlug.toLowerCase()
      : code
        ? `model-placeholder-${code.toLowerCase()}`
        : 'unknown-model';

    const shortName = cleanDisp
      ? cleanDisp.replace(/\s*\([^)]*\)\s*$/, '').trim().slice(0, 20)
      : cleanSlug || code || 'Unknown';

    const fullName = cleanDisp
      ? cleanDisp
      : cleanSlug && code
        ? `${cleanSlug} (${code})`
        : cleanSlug || placeholder || 'Uncataloged Model';

    return {
      enums: enumId > 0 ? [enumId] : [],
      placeholders: placeholder ? [placeholder] : [],
      slugs: [slug],
      slug,
      rawSlug: cleanSlug || placeholder || slug,
      shortName,
      fullName,
      provider,
      softLimit: DEFAULT_SOFT_LIMIT,
      maxWindow: provider === 'claude' ? 1_000_000 : DEFAULT_MAX_WINDOW,
      inputRate,
      cacheRate,
      cacheWriteRate: provider === 'claude' ? inputRate * 1.25 : undefined,
      outputRate,
      isUnknownModel: true,
      over200k: null,
      schedule: [],
    };
  }

  function readGlobalDefaultModelInfo() {
    const statePath = join(primaryAppDataDir, 'antigravity_state.pbtxt');
    const sig = fileSig(statePath);
    if (sig === '0') {
      return { model: DEFAULT_MODEL, explicit: false };
    }
    if (sig === globalDefaultModelSig && globalDefaultModelCached) {
      return {
        model: globalDefaultModelCached,
        explicit: globalDefaultModelExplicit,
      };
    }
    globalDefaultModelSig = sig;
    globalDefaultModelExplicit = false;
    try {
      const txt = readFileSync(statePath, 'utf-8');
      const m = txt.match(/last_selected_agent_model:\s*([A-Z0-9_]+)/);
      if (m) {
        if (placeholderCatalog.has(m[1])) {
          globalDefaultModelCached = placeholderCatalog.get(m[1]);
          globalDefaultModelExplicit = true;
          return { model: globalDefaultModelCached, explicit: true };
        }
        const unkEnum = placeholderToEnum(m[1]);
        if (unkEnum > 0) {
          globalDefaultModelCached =
            enumCatalog.get(unkEnum) ||
            synthesizeUnknownModelSpec({
              enumId: unkEnum,
              rawSlug: '',
              displayName: '',
              apiProvider: 0,
            });
          globalDefaultModelExplicit = true;
          return { model: globalDefaultModelCached, explicit: true };
        }
      }
    } catch {
      // ignore
    }
    globalDefaultModelCached = DEFAULT_MODEL;
    return { model: DEFAULT_MODEL, explicit: false };
  }

  return {
    get overrideSig() {
      return overrideSig;
    },
    get enumCatalog() {
      return enumCatalog;
    },
    get placeholderCatalog() {
      return placeholderCatalog;
    },
    get slugCatalog() {
      return slugCatalog;
    },
    refreshIfNeeded,
    resolveStepRates,
    resolveImageModelSpec,
    resolveImageStepRate,
    resolveModelBySlugOrText,
    synthesizeUnknownModelSpec,
    refineTierName,
    readGlobalDefaultModelInfo,
    readGlobalDefaultModel: () => readGlobalDefaultModelInfo().model,
  };
}
