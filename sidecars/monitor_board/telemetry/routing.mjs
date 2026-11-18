/**
 * @fileoverview Model enum/code mapping, API provider attribution, Orchestrator
 * two-phase (Plan/Execute/Review) classification, and Canary routing forensics.
 */

export function enumToModelCode(enumId) {
  const n = Number(enumId) || 0;
  if (n >= 1000 && n < 10000) {
    const num = n - 1000;
    return {
      enumId: n,
      code: `M${num}`,
      placeholder: `MODEL_PLACEHOLDER_M${num}`,
    };
  }
  if (n === 342) {
    return {
      enumId: 342,
      code: 'E342',
      placeholder: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    };
  }
  if (n > 0) {
    return {
      enumId: n,
      code: `E${n}`,
      placeholder: `MODEL_ENUM_${n}`,
    };
  }
  return { enumId: 0, code: '', placeholder: '' };
}

export function placeholderToEnum(ph) {
  if (!ph || typeof ph !== 'string') return 0;
  if (ph === 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM') return 342;
  const m = ph.match(/^MODEL_PLACEHOLDER_M(\d+)$/);
  if (m) return 1000 + Number(m[1]);
  const e = ph.match(/^MODEL_ENUM_(\d+)$/);
  if (e) return Number(e[1]);
  return 0;
}

export function resolveApiProviderInfo(apiProvider, responseId = '', providerHint = '') {
  const code = Number(apiProvider) || 0;
  const isVrtxClaude = typeof responseId === 'string' && responseId.startsWith('req_vrtx_');
  if (code === 26 || isVrtxClaude) {
    return {
      apiProvider: code || 26,
      apiProviderName: 'anthropic-vertex',
    };
  }
  if (code === 24) {
    return {
      apiProvider: 24,
      apiProviderName: 'google-cloudcode',
    };
  }
  if (code > 0) {
    return {
      apiProvider: code,
      apiProviderName: `provider-${code}`,
    };
  }
  if (providerHint === 'claude') {
    return { apiProvider: 0, apiProviderName: 'anthropic-vertex' };
  }
  if (providerHint === 'openai') {
    return { apiProvider: 0, apiProviderName: 'cloudcode-oss' };
  }
  if (providerHint === 'gemini') {
    return { apiProvider: 0, apiProviderName: 'google-cloudcode' };
  }
  return { apiProvider: 0, apiProviderName: '' };
}

export function stripStandardModelTier(slug) {
  if (!slug || typeof slug !== 'string') return '';
  return slug
    .trim()
    .toLowerCase()
    .replace(/-(?:extra[-_]high|xhigh|high|medium|low|minimal|max|thinking|agent|lite|default)$/i, '');
}

export function stripCanaryCohortSuffix(slug) {
  if (!slug || typeof slug !== 'string') return '';
  return slug
    .trim()
    .toLowerCase()
    .replace(
      /-(?:exp(?:-[a-z0-9]+)?|canary(?:-[a-z0-9]+)?|preview(?:-[a-z0-9-]+)?|rc\d*|tiered|ab-[a-z0-9]+|[abc])$/i,
      ''
    );
}

const ORCHESTRATOR_PLANNER_ENUMS = new Set([1667, 1681]);
const ORCHESTRATOR_ENUMS = new Set([1667, 1669, 1681]);

export function isOrchestratorPlannerSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  const low = slug.trim().toLowerCase();
  if (low.includes('flash-worker')) return false;
  if (low.includes('gemini-pro-orchestrator')) return true;
  return low.includes('orchestrator') && !low.includes('hydrogen');
}

export function isOrchestratorSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  const low = slug.trim().toLowerCase();
  return low.includes('orchestrator') || low.includes('flash-worker');
}

export function isOrchestratorEnum(enumId) {
  return ORCHESTRATOR_ENUMS.has(Number(enumId) || 0);
}

/**
 * Classifies an Orchestrator session step into `plan`, `execute`, or `review`.
 * Returns `''` for non-Orchestrator sessions.
 */
export function resolveOrchestratorPhase({
  sessionIsOrchestrator = false,
  stepSlug = '',
  stepEnumId = 0,
  afterPlanReview = false,
}) {
  if (!sessionIsOrchestrator) return '';
  if (
    isOrchestratorPlannerSlug(stepSlug) ||
    ORCHESTRATOR_PLANNER_ENUMS.has(Number(stepEnumId) || 0)
  ) {
    return afterPlanReview ? 'review' : 'plan';
  }
  return 'execute';
}

/**
 * Detects server-side gray-box / A-B canary / bucket / cross-enum routing:
 * 1) Explicit experiment/canary/preview/rc or `-a`/`-b` cohort suffixes on `rawSlug`
 * 2) `-tiered` ONLY when `desiredSlug` requested a non-tiered model (never when `-tiered` was requested directly, e.g. subagents)
 * 3) `requestedEnum !== respondedEnum` or cross-family `slug_override` (excluding intentional Orchestrator Plan->Execute handoffs)
 */
export function detectCanaryRouting({
  rawSlug = '',
  desiredSlug = '',
  requestedEnum = 0,
  respondedEnum = 0,
  sessionIsOrchestrator = false,
}) {
  const rSlug = String(rawSlug || '').trim();
  const dSlug = String(desiredSlug || '').trim();
  const orchHandoff = Boolean(
    sessionIsOrchestrator ||
      isOrchestratorSlug(dSlug) ||
      isOrchestratorSlug(rSlug) ||
      isOrchestratorEnum(requestedEnum) ||
      isOrchestratorEnum(respondedEnum)
  );

  if (rSlug) {
    const expMatch = rSlug.match(/-(exp(?:-[a-z0-9]+)?)$/i);
    if (expMatch) {
      return {
        isCanaryRouted: true,
        canaryTag: expMatch[1].toLowerCase(),
        canaryReason: 'exp_cohort',
      };
    }
    const canaryMatch = rSlug.match(
      /-(canary(?:-[a-z0-9]+)?|preview(?:-[a-z0-9-]+)?|rc\d*)$/i
    );
    if (canaryMatch) {
      return {
        isCanaryRouted: true,
        canaryTag: canaryMatch[1].toLowerCase(),
        canaryReason: 'exp_cohort',
      };
    }
    if (/-tiered$/i.test(rSlug)) {
      const requestedTieredAlready =
        !dSlug || dSlug.toLowerCase() === rSlug.toLowerCase();
      const enumChanged =
        requestedEnum > 0 && respondedEnum > 0 && requestedEnum !== respondedEnum;
      if (!requestedTieredAlready || (enumChanged && !orchHandoff)) {
        return {
          isCanaryRouted: true,
          canaryTag: 'tiered',
          canaryReason: 'tiered_pool',
        };
      }
      return {
        isCanaryRouted: false,
        canaryTag: '',
        canaryReason: '',
      };
    }
    const abMatch = rSlug.match(/-(ab-[a-z0-9]+|[abc])$/i);
    if (abMatch && (!dSlug || dSlug.toLowerCase() !== rSlug.toLowerCase())) {
      return {
        isCanaryRouted: true,
        canaryTag: abMatch[1].toLowerCase().replace(/^ab-/, ''),
        canaryReason: 'ab_cohort',
      };
    }
  }

  if (
    !orchHandoff &&
    requestedEnum > 0 &&
    respondedEnum > 0 &&
    requestedEnum !== respondedEnum
  ) {
    const reqC = enumToModelCode(requestedEnum).code || String(requestedEnum);
    const resC = enumToModelCode(respondedEnum).code || String(respondedEnum);
    return {
      isCanaryRouted: true,
      canaryTag: `${reqC}→${resC}`,
      canaryReason: 'enum_override',
    };
  }

  if (!orchHandoff && dSlug && rSlug) {
    const dBase = stripStandardModelTier(dSlug);
    const rBase = stripStandardModelTier(rSlug);
    if (
      dBase &&
      rBase &&
      dBase !== rBase &&
      !rBase.startsWith(dBase) &&
      !dBase.startsWith(rBase)
    ) {
      return {
        isCanaryRouted: true,
        canaryTag: rSlug,
        canaryReason: 'slug_override',
      };
    }
  }

  return {
    isCanaryRouted: false,
    canaryTag: '',
    canaryReason: '',
  };
}
