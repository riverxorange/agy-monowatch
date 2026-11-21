/**
 * @fileoverview Core SQLite + JSONL telemetry analyzer (`gen_metadata` slice decoding,
 * active-span duration, image generation pricing, error/quota forensics, dynamic context
 * waterline, compaction summaries, and dual-metric TPS).
 */

import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MAX_WINDOW,
  DEFAULT_SOFT_LIMIT,
  IDLE_WAKEUP_GAP_SEC,
  STALE_GENERATING_SEC,
  addDaily,
  addDailyModel,
  addDailyModelPerf,
  addDailyPerf,
  fileSig,
  finalizeDaily,
  finalizeDailyModels,
  mergeDailyInto,
  mergeDailyModelsInto,
  openReadOnlyDb,
  parseDateMs,
  round,
  safeStat,
} from './utils.mjs';
import {
  detectCanaryRouting,
  enumToModelCode,
  isOrchestratorEnum,
  isOrchestratorSlug,
  resolveApiProviderInfo,
  resolveOrchestratorPhase,
} from './routing.mjs';
import { DEFAULT_MODEL } from './models.mjs';
import {
  cleanCompactedSummary,
  detectSystemInjection101,
  extractSummaryFromStepPayload,
  findContextField9InLargeTail,
  parseChapterTitlesProto,
  parseErrorStepSlice,
  parseGenMetadataSliceRow,
  parseImageGenStepSlice,
  parseParentRefProto,
  parseParentReferencesRows,
  parseStepMetadata,
  parseToolFailureSlice,
} from './proto.mjs';

function createEmptyIssues() {
  return {
    total: 0,
    treeTotal: 0,
    wastedUsd: 0,
    treeWastedUsd: 0,
    latestCategory: '',
    counts: {
      safety_filter: 0,
      quota_429: 0,
      server_injection: 0,
      upstream_retry: 0,
      tool_error: 0,
    },
    treeCounts: {
      safety_filter: 0,
      quota_429: 0,
      server_injection: 0,
      upstream_retry: 0,
      tool_error: 0,
    },
    items: [],
  };
}

export function createMetricsAnalyzer({ pricing, discovery }) {
  const convDbCache = new Map();
  const jsonlUsageCache = new Map();
  const checkpointSummaryCache = new Map();
  const chapterTitlesCache = new Map();

  function parseGenMetadataRows(rows, latestLargeRow = null) {
    const byBotId = new Map();
    const byResponseId = new Map();
    const byEnum = new Map();
    let sessionDesiredSlug = '';
    let sessionDesiredEnums = new Set();
    let latestRecord = null;
    let latestContextRecord = null;
    let latestBreakdownRecord = null;
    let dynamicMaxWindow = 0;

    const latestLargeIdx =
      latestLargeRow && Number.isFinite(Number(latestLargeRow.idx))
        ? Number(latestLargeRow.idx)
        : -1;
    const latestLargeCtx =
      latestLargeRow && latestLargeRow.tail_large
        ? findContextField9InLargeTail(latestLargeRow.tail_large)
        : null;

    let runningMaxContextTokens = 0;
    const parsedList = [];

    for (const r of rows) {
      const rIdx = Number(r.idx) || 0;
      const rec = parseGenMetadataSliceRow(
        rIdx,
        r.head ?? null,
        r.tail ?? null,
        r.full_data ?? null
      );
      if (!rec) continue;

      if (rIdx === latestLargeIdx && latestLargeCtx) {
        rec.checkpointStepIndex = latestLargeCtx.checkpointStepIndex;
        rec.hasCheckpointField = latestLargeCtx.hasCheckpointField;
        if (latestLargeCtx.estimatedTokensUsed > 0) {
          rec.estimatedTokensUsed = latestLargeCtx.estimatedTokensUsed;
        }
        if (latestLargeCtx.maxContextTokens > 0) {
          rec.maxContextTokens = latestLargeCtx.maxContextTokens;
        }
        if (latestLargeCtx.breakdown.length > 0) {
          rec.breakdown = latestLargeCtx.breakdown;
        }
      }

      if (rec.dynamicMaxWindow > 0) {
        dynamicMaxWindow = rec.dynamicMaxWindow;
      }

      if (rec.maxContextTokens > 0) {
        runningMaxContextTokens = rec.maxContextTokens;
      } else if (runningMaxContextTokens > 0) {
        rec.maxContextTokens = runningMaxContextTokens;
      }

      if (rec.desiredSlug) {
        sessionDesiredSlug = rec.desiredSlug;
        const desSpec = pricing.resolveModelBySlugOrText(rec.desiredSlug, 0);
        sessionDesiredEnums = new Set(desSpec?.enums || []);
        if (rec.enumId > 0) sessionDesiredEnums.add(rec.enumId);
      }
      const canInheritDesired =
        Boolean(sessionDesiredSlug) &&
        (rec.enumId === 0 ||
          sessionDesiredEnums.size === 0 ||
          sessionDesiredEnums.has(rec.enumId));
      const effectiveDesired =
        rec.desiredSlug || (canInheritDesired ? sessionDesiredSlug : '');

      let modelSpec = null;
      const textHint = rec.displayName || rec.rawSlug || effectiveDesired;
      if (textHint) {
        const known = pricing.resolveModelBySlugOrText(textHint, rec.enumId);
        if (known) {
          const enumMatchesKnown =
            rec.enumId > 0 &&
            Array.isArray(known.enums) &&
            known.enums.includes(rec.enumId);
          const tierHint = enumMatchesKnown
            ? rec.displayName || rec.rawSlug
            : rec.displayName || effectiveDesired || rec.rawSlug;
          modelSpec = rec.displayName
            ? { ...pricing.refineTierName(known, tierHint), fullName: rec.displayName }
            : pricing.refineTierName(known, tierHint);
        } else if (rec.rawSlug || rec.displayName) {
          modelSpec = pricing.synthesizeUnknownModelSpec({
            enumId: rec.enumId,
            rawSlug: rec.rawSlug,
            displayName: rec.displayName,
            apiProvider: 0,
          });
        }
      }

      if (!modelSpec && rec.enumId > 0) {
        modelSpec =
          pricing.enumCatalog.get(rec.enumId) ||
          pricing.synthesizeUnknownModelSpec({
            enumId: rec.enumId,
            rawSlug: '',
            displayName: '',
            apiProvider: 0,
          });
      }

      parsedList.push({
        ...rec,
        desiredSlug: effectiveDesired,
        modelSpec,
      });
    }

    let firstKnownMaxCtx = 0;
    for (const item of parsedList) {
      if (item.maxContextTokens > 0) {
        firstKnownMaxCtx = item.maxContextTokens;
        break;
      }
    }
    if (firstKnownMaxCtx > 0) {
      for (const item of parsedList) {
        if (!item.maxContextTokens) {
          item.maxContextTokens = firstKnownMaxCtx;
        }
      }
    }

    for (const enrichedRec of parsedList) {
      if (enrichedRec.botId) byBotId.set(enrichedRec.botId, enrichedRec);
      if (enrichedRec.responseId) byResponseId.set(enrichedRec.responseId, enrichedRec);
      if (enrichedRec.enumId > 0) {
        const prev = byEnum.get(enrichedRec.enumId);
        byEnum.set(enrichedRec.enumId, {
          ...enrichedRec,
          rawSlug: enrichedRec.rawSlug || prev?.rawSlug || '',
          displayName: enrichedRec.displayName || prev?.displayName || '',
          modelSpec: enrichedRec.modelSpec || prev?.modelSpec || null,
        });
      }
      if (enrichedRec.modelSpec || enrichedRec.rawSlug || enrichedRec.enumId > 0) {
        latestRecord = enrichedRec;
      }
      if (enrichedRec.estimatedTokensUsed > 0 || enrichedRec.maxContextTokens > 0) {
        latestContextRecord = enrichedRec;
      }
      if (enrichedRec.breakdown && enrichedRec.breakdown.length > 0) {
        latestBreakdownRecord = enrichedRec;
      }
    }

    if (!latestBreakdownRecord && latestLargeCtx && latestLargeCtx.breakdown.length > 0) {
      latestBreakdownRecord = { idx: latestLargeIdx, ...latestLargeCtx };
    }
    if (
      !latestContextRecord &&
      latestLargeCtx &&
      (latestLargeCtx.estimatedTokensUsed > 0 || latestLargeCtx.maxContextTokens > 0)
    ) {
      latestContextRecord = { idx: latestLargeIdx, ...latestLargeCtx };
    }

    return {
      byBotId,
      byResponseId,
      byEnum,
      sessionDesiredSlug,
      sessionDesiredEnums,
      latestRecord,
      latestContextRecord,
      latestBreakdownRecord,
      dynamicMaxWindow,
    };
  }

  function loadGenMetadataIndex(db) {
    let genRows = [];
    let latestLargeRow = null;
    try {
      genRows = db
        .prepare(
          `SELECT
             idx,
             CASE WHEN LENGTH(data) <= 8192 THEN data ELSE NULL END AS full_data,
             CASE WHEN LENGTH(data) > 8192 THEN SUBSTR(data, 1, 6144) ELSE NULL END AS head,
             CASE WHEN LENGTH(data) > 8192 THEN SUBSTR(data, MAX(1, LENGTH(data) - 1536)) ELSE NULL END AS tail
           FROM gen_metadata
           ORDER BY idx ASC`
        )
        .all();
    } catch {
      genRows = [];
    }
    if (genRows.length > 0) {
      try {
        latestLargeRow =
          db
            .prepare(
              `SELECT
                 idx,
                 SUBSTR(data, MAX(1, LENGTH(data) - 98304)) AS tail_large
               FROM gen_metadata
               WHERE LENGTH(data) > 8192
               ORDER BY idx DESC
               LIMIT 1`
            )
            .get() || null;
      } catch {
        latestLargeRow = null;
      }
    }
    return parseGenMetadataRows(genRows, latestLargeRow);
  }

  function detectBtwBranchFromDb(db) {
    const none = {
      isBtw: false,
      parentConversationId: '',
      branchStepIndex: -1,
      minStepIdx: 0,
    };
    if (!db) return none;
    let trajectoryType = 0;
    try {
      const tm = db.prepare('SELECT trajectory_type FROM trajectory_meta LIMIT 1').get();
      if (tm) trajectoryType = Number(tm.trajectory_type) || 0;
    } catch {
      // ignore
    }
    if (trajectoryType !== 22) return none;

    let markerIdx = -1;
    try {
      const mRow = db
        .prepare(
          `SELECT idx
           FROM steps
           WHERE step_type = 101
             AND instr(CAST(step_payload AS BLOB), CAST('what follows is a side question (/btw)' AS BLOB)) > 0
           ORDER BY idx ASC
           LIMIT 1`
        )
        .get();
      if (mRow && Number.isFinite(Number(mRow.idx))) {
        markerIdx = Number(mRow.idx);
      }
    } catch {
      markerIdx = -1;
    }

    let parentRef = {
      parentTrajectoryId: '',
      parentStepIndex: -1,
      refType: 0,
      parentConversationId: '',
    };
    try {
      const prRow = db
        .prepare('SELECT idx, data FROM parent_references ORDER BY idx DESC LIMIT 1')
        .get();
      if (prRow?.data) {
        parentRef = parseParentRefProto(prRow.data);
      }
    } catch {
      // ignore
    }

    const branchStepIndex =
      parentRef.parentStepIndex >= 0
        ? parentRef.parentStepIndex
        : markerIdx >= 0
          ? markerIdx - 1
          : -1;
    const minStepIdx =
      markerIdx >= 0
        ? markerIdx
        : branchStepIndex >= 0
          ? branchStepIndex + 1
          : 0;
    return {
      isBtw: true,
      parentConversationId: parentRef.parentConversationId || '',
      branchStepIndex,
      minStepIdx,
    };
  }

  function getJsonlUsageFallbackAndTotal(
    convId,
    preferredDir,
    defaultModel,
    minStepIdx = 0
  ) {
    const tPath = discovery.findConvFile(
      convId,
      preferredDir,
      join('brain', convId, '.system_generated', 'logs', 'transcript.jsonl')
    );
    if (!tPath) return null;
    const sig = fileSig(tPath);
    const floorIdx = Math.max(0, Number(minStepIdx) || 0);
    const cacheKey = `${convId}|${floorIdx}`;
    const cached = jsonlUsageCache.get(cacheKey);
    if (cached && cached.sig === sig) return cached.parsed;

    let parsed = null;
    try {
      const tSt = safeStat(tPath);
      const content = readFileSync(tPath, 'utf-8');
      const lines = content.split('\n');
      const m = defaultModel || DEFAULT_MODEL;
      let allInput = 0;
      let allCache = 0;
      let allOutput = 0;
      let allJsonlUsd = 0;
      const lineStepRecords = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (
          !trimmed.includes('"PLANNER_RESPONSE"') &&
          !trimmed.includes('"CHECKPOINT"')
        ) {
          continue;
        }
        try {
          const obj = JSON.parse(trimmed);
          const type = obj.type;
          if (type !== 'PLANNER_RESPONSE' && type !== 'CHECKPOINT') continue;
          if (obj.status && obj.status !== 'DONE') continue;
          const stepIdx = Number(obj.step_index) ?? 0;
          if (floorIdx > 0 && stepIdx < floorIdx) continue;
          const inp = Number(obj.input_tokens) || 0;
          const cr = Number(obj.cache_read_tokens) || 0;
          const out = Number(obj.output_tokens) || 0;
          const stepTimeSec = obj.created_at ? parseDateMs(obj.created_at) / 1000 : 0;
          const rates = pricing.resolveStepRates(m, stepTimeSec, inp + cr);
          allInput += inp;
          allCache += cr;
          allOutput += out;
          allJsonlUsd +=
            (inp * rates.inputRate + cr * rates.cacheRate + out * rates.outputRate) /
            1_000_000;
          lineStepRecords.push({
            idx: stepIdx,
            stepType: type === 'CHECKPOINT' ? 23 : 15,
            inputTokens: inp,
            cacheReadTokens: cr,
            outputTokens: out,
            createdAt: obj.created_at || null,
            stepTimeSec,
          });
        } catch {
          // ignore torn line
        }
      }

      const byIdx = new Map();
      const liveIdx = [];
      const revertedSteps = [];
      for (const rec of lineStepRecords) {
        const prev = byIdx.get(rec.idx);
        const isDuplicateFlush =
          prev &&
          prev.createdAt === rec.createdAt &&
          prev.inputTokens === rec.inputTokens &&
          prev.cacheReadTokens === rec.cacheReadTokens &&
          prev.outputTokens === rec.outputTokens;
        if (isDuplicateFlush) continue;
        while (liveIdx.length > 0 && liveIdx[liveIdx.length - 1] >= rec.idx) {
          const k = liveIdx.pop();
          revertedSteps.push(byIdx.get(k));
          byIdx.delete(k);
        }
        if (!Number.isNaN(rec.idx)) liveIdx.push(rec.idx);
        byIdx.set(rec.idx, rec);
      }

      let revertedInput = 0;
      let revertedCache = 0;
      let revertedOutput = 0;
      let revertedInputUsd = 0;
      let revertedCacheUsd = 0;
      let revertedOutputUsd = 0;
      let revertedUsd = 0;
      let revertedSavedCacheUsd = 0;
      let latestRevertedTimeSec = 0;
      const revertedDailyMap = new Map();
      const revertedDailyModelMap = new Map();
      const modelLabel = m.fullName || m.shortName || m.slug;

      for (const r of revertedSteps) {
        const inp = r.inputTokens || 0;
        const cr = r.cacheReadTokens || 0;
        const out = r.outputTokens || 0;
        const ts = r.stepTimeSec || 0;
        if (ts > latestRevertedTimeSec) latestRevertedTimeSec = ts;
        const rates = pricing.resolveStepRates(m, ts, inp + cr);
        const sInUsd = (inp * rates.inputRate) / 1_000_000;
        const sCrUsd = (cr * rates.cacheRate) / 1_000_000;
        const sOutUsd = (out * rates.outputRate) / 1_000_000;
        const sUsd = sInUsd + sCrUsd + sOutUsd;
        const sSaved = (cr * Math.max(0, rates.inputRate - rates.cacheRate)) / 1_000_000;

        revertedInput += inp;
        revertedCache += cr;
        revertedOutput += out;
        revertedInputUsd += sInUsd;
        revertedCacheUsd += sCrUsd;
        revertedOutputUsd += sOutUsd;
        revertedUsd += sUsd;
        revertedSavedCacheUsd += sSaved;

        addDaily(revertedDailyMap, ts, sUsd, inp, cr, out, sSaved, 0, sInUsd, sCrUsd, sOutUsd);
        addDailyModel(revertedDailyModelMap, ts, modelLabel, sUsd, inp, cr, out);
      }

      parsed = {
        allInput,
        allCache,
        allOutput,
        allJsonlUsd,
        revertedStepCount: revertedSteps.length,
        revertedInput,
        revertedCache,
        revertedOutput,
        revertedInputUsd,
        revertedCacheUsd,
        revertedOutputUsd,
        revertedUsd,
        revertedSavedCacheUsd,
        revertedDaily: finalizeDaily(revertedDailyMap, latestRevertedTimeSec),
        revertedDailyModels: finalizeDailyModels(revertedDailyModelMap, latestRevertedTimeSec),
        mtimeMs: tSt ? tSt.mtimeMs : 0,
        canonicalSteps: Array.from(byIdx.values()).sort((a, b) => a.idx - b.idx),
      };
    } catch {
      parsed = null;
    }

    jsonlUsageCache.set(cacheKey, { sig, parsed });
    return parsed;
  }

  function createEmptyMetrics(modelSpec, desiredHintSlug = '', rawHintSlug = '') {
    const m = modelSpec || DEFAULT_MODEL;
    const enumId = m.enums?.[0] || 0;
    const { code, placeholder } = enumToModelCode(enumId);
    const rawSlug = rawHintSlug || m.rawSlug || m.slug;
    const desiredSlug = desiredHintSlug || '';
    const isOrch = isOrchestratorSlug(rawSlug) || isOrchestratorEnum(enumId);
    const canary = detectCanaryRouting({
      rawSlug,
      desiredSlug,
      requestedEnum: 0,
      respondedEnum: 0,
      sessionIsOrchestrator: isOrch,
    });
    const prov = resolveApiProviderInfo(0, '', m.provider);

    return {
      modelSpec: m,
      model: {
        slug: m.slug,
        rawSlug,
        desiredSlug,
        shortName: m.shortName,
        fullName: m.fullName,
        provider: m.provider,
        enumId,
        code: code || (m.placeholders?.[0]?.replace('MODEL_PLACEHOLDER_', '') || ''),
        placeholder: placeholder || m.placeholders?.[0] || '',
        requestedEnum: 0,
        respondedEnum: 0,
        enumMismatchCount: 0,
        isCanaryRouted: canary.isCanaryRouted,
        activeStepCanary: canary.isCanaryRouted,
        canaryTag: canary.canaryTag,
        canaryReason: canary.canaryReason,
        isUnknownModel: Boolean(m.isUnknownModel),
        isOrchestrator: isOrch,
        orchestratorPhases: { planSteps: 0, executeSteps: 0, reviewSteps: 0 },
        modelSwitched: false,
        switchedFromSlug: '',
        switchedToSlug: '',
        apiProvider: prov.apiProvider,
        apiProviderName: prov.apiProviderName,
        botId: '',
        distinctBotCount: 0,
        responseId: '',
        traceHash: '',
        sessionId: '',
        softLimit: m.softLimit,
        maxWindow: m.maxWindow,
        modelCount: 0,
        distinctModelCount: 0,
        treeHasCanary: canary.isCanaryRouted,
        byModel: [],
      },
      tokens: {
        input: 0,
        output: 0,
        thinking: 0,
        response: 0,
        cacheRead: 0,
        generatedImages: 0,
        cacheHitRatio: 0,
        treeInput: 0,
        treeOutput: 0,
        treeCacheRead: 0,
        treeGeneratedImages: 0,
        treeCacheHitRatio: 0,
      },
      cost: {
        selfUsd: 0,
        treeUsd: 0,
        childrenUsd: 0,
        inputUsd: 0,
        cacheUsd: 0,
        outputUsd: 0,
        imageUsd: 0,
        treeImageUsd: 0,
        savedCacheUsd: 0,
        claudeCacheWriteEstUsd: 0,
        retryBranchDeltaUsd: 0,
        retryBranchStepCount: 0,
        retryBranchInput: 0,
        retryBranchCacheRead: 0,
        retryBranchOutput: 0,
        daily: {},
        dailyModels: {},
        byModel: [],
        treeByModel: [],
      },
      waterline: {
        currentTokens: 0,
        cachedTokens: 0,
        freshTokens: 0,
        apiContextTokens: 0,
        apiCachedTokens: 0,
        apiFreshTokens: 0,
        softLimit: m.softLimit,
        softRatio: 0,
        maxWindow: m.maxWindow,
        maxRatio: 0,
        source: 'api_usage',
        limitSource: 'model_default',
        breakdown: [],
        isPostCompactionEstimate: false,
      },
      compaction: {
        count: 0,
        hasSummary: false,
        latestStepIndex: -1,
      },
      tps: {
        live: 0,
        stream: 0,
        activeChildAvg: 0,
        treeBurn: 0,
        rolling: 0,
        latestDecode: 0,
        latestTtftSec: 0,
        latestE2e: 0,
      },
      timing: {
        totalDurationSec: 0,
        llmDurationSec: 0,
        treeLlmDurationSec: 0,
        avgTtftSec: 0,
        latestTtftSec: 0,
        isLiveTicking: false,
      },
      alert: null,
      issues: createEmptyIssues(),
      referencedConversationIds: [],
      priorTurnsDurationSec: 0,
      latestTurnStartSec: 0,
      latestTurnBaseDurationSec: 0,
      baseLlmDurationSec: 0,
      selfLlmDurationSec: 0,
      avgTtftSec: 0,
      rawIsGenerating: false,
      isGenerating: false,
      generatingStartSec: 0,
      generatingElapsedSec: 0,
      latestStepTimeSec: 0,
      lastActivityMs: 0,
      ageSinceActivitySec: Infinity,
      stepCount: 0,
      compactionRecords: [],
    };
  }

  function computeStepTimingAndTps(meta, out, think, stepType) {
    const rawDecodeDt =
      meta.t6 > 0 && meta.t7 >= meta.t6 ? meta.t7 - meta.t6 : 0;
    const dt61 =
      meta.t6 > 0 && meta.t1 > 0 && meta.t6 >= meta.t1 ? meta.t6 - meta.t1 : 0;
    const dtE2e =
      meta.t1 > 0 && meta.t7 >= meta.t1 ? meta.t7 - meta.t1 : rawDecodeDt;
    const durationSec = dtE2e > 0 ? round(dtE2e, 2) : 0;

    if (
      stepType !== 15 ||
      out <= 0 ||
      meta.t7 <= 0 ||
      (meta.t6 <= 0 && meta.t1 <= 0)
    ) {
      const fallbackTtft =
        dt61 > 0 ? round(dt61, 2) : dtE2e > 0 ? round(dtE2e, 2) : 0;
      return {
        durationSec,
        dtE2e,
        dtDecode: 0,
        decodeTps: 0,
        e2eTps: 0,
        ttftSec: fallbackTtft,
        isStreamingTtft: false,
        isValidTpsSample: false,
      };
    }

    const isBuffered =
      rawDecodeDt < 0.5 ||
      (dtE2e > 0 && rawDecodeDt < 0.15 * dtE2e && out / rawDecodeDt > 450) ||
      (meta.t1 > 0 && out / rawDecodeDt > 550 && dtE2e > rawDecodeDt * 1.5) ||
      (think > 0 && dt61 > rawDecodeDt * 2 && out / rawDecodeDt > 250);
    const candDt = isBuffered ? dtE2e : rawDecodeDt;
    const isUnmeasuredReplay = candDt < 0.05 || out / candDt > 650;

    if (isUnmeasuredReplay) {
      return {
        durationSec,
        dtE2e,
        dtDecode: 0,
        decodeTps: 0,
        e2eTps: 0,
        ttftSec: 0,
        isStreamingTtft: false,
        isValidTpsSample: false,
      };
    }

    const dtDecode = candDt;
    const decodeTps = round(out / dtDecode, 1);
    const e2eTps = round(out / Math.max(0.05, dtE2e), 1);
    const isStreamingTtft = !isBuffered && dt61 > 0;
    const ttftRaw = dt61 > 0 ? dt61 : dtE2e > 0 ? dtE2e : 0;
    const ttftSec = ttftRaw > 0 ? round(ttftRaw, 2) : 0;

    return {
      durationSec,
      dtE2e,
      dtDecode,
      decodeTps,
      e2eTps,
      ttftSec,
      isStreamingTtft,
      isValidTpsSample: true,
    };
  }

  function computeCoreDbMetrics(
    stepRows,
    genIndex,
    fallbackModel,
    desiredHintSlug = '',
    { isBtw = false, minStepIdx = 0 } = {}
  ) {
    let totalInput = 0;
    let totalOutput = 0;
    let totalThinking = 0;
    let totalResponse = 0;
    let totalCacheRead = 0;
    let generatedImages = 0;

    let inputUsd = 0;
    let cacheUsd = 0;
    let outputUsd = 0;
    let imageUsd = 0;
    let savedCacheUsd = 0;
    let claudeCacheWriteEstUsd = 0;
    const dailyMap = new Map();
    const dailyModelMap = new Map();

    let lastPlannerStep = null;
    let lastOfficialPlannerStep = null;
    let latestOfficialMaxContextTokens =
      genIndex.latestContextRecord?.maxContextTokens || 0;
    let latestStepModelSpec =
      genIndex.latestRecord?.modelSpec || fallbackModel || DEFAULT_MODEL;
    let rawIsGenerating = false;
    let generatingStartSec = 0;
    let latestStepTimeSec = 0;
    let enumMismatchCount = 0;

    const hintSpec = desiredHintSlug
      ? pricing.resolveModelBySlugOrText(desiredHintSlug, 0)
      : null;
    const hintEnums = new Set(hintSpec?.enums || []);

    const resolveScopedDesiredSlug = (gmRec, reqEnum, stepEnumId) => {
      if (gmRec?.desiredSlug) return gmRec.desiredSlug;
      const checkEnum = reqEnum || stepEnumId || 0;
      if (
        genIndex.sessionDesiredSlug &&
        (checkEnum === 0 ||
          genIndex.sessionDesiredEnums.size === 0 ||
          genIndex.sessionDesiredEnums.has(checkEnum))
      ) {
        return genIndex.sessionDesiredSlug;
      }
      if (
        desiredHintSlug &&
        (checkEnum === 0 || hintEnums.size === 0 || hintEnums.has(checkEnum))
      ) {
        return desiredHintSlug;
      }
      return '';
    };

    const botIdsSet = new Set();
    const initialEnumId =
      genIndex.latestRecord?.enumId || latestStepModelSpec.enums?.[0] || 0;
    let latestRouting = {
      hasStep: false,
      rawSlug: genIndex.latestRecord?.rawSlug || latestStepModelSpec.rawSlug || '',
      desiredSlug: resolveScopedDesiredSlug(genIndex.latestRecord, 0, initialEnumId),
      enumId: initialEnumId,
      requestedEnum: 0,
      respondedEnum: 0,
      apiProvider: 0,
      botId: genIndex.latestRecord?.botId || '',
      responseId: genIndex.latestRecord?.responseId || '',
      traceHash: genIndex.latestRecord?.traceHash || '',
      sessionId: '',
    };

    const maxStepIdx =
      stepRows.length > 0 ? Number(stepRows[stepRows.length - 1].idx) : -1;
    const hasUserInputs = stepRows.some((r) => Number(r.step_type) === 14);
    const triggerType = hasUserInputs ? 14 : 101;

    let priorTurnsDurationSec = 0;
    let curTurnStartSec = 0;
    let curTurnEndSec = 0;
    let curTurnHasLlm = false;
    let baseLlmDurationSec = 0;

    const completedPlannerForTps = [];
    const streamingTtftSamples = [];
    const fallbackTtftSamples = [];
    const completedUsageSteps = [];
    const checkpoints = [];
    const byModelMap = new Map();

    let errorCount = 0;
    let lastError = null;
    const issueCounts = {
      safety_filter: 0,
      quota_429: 0,
      server_injection: 0,
      upstream_retry: 0,
      tool_error: 0,
    };
    const incidents = [];
    let selfWastedUsd = 0;
    let lastCompletedPlannerForDiscard = null;

    const lookupExactStepGenRecord = (meta) => {
      const u = meta.usage;
      if (u?.botId && genIndex.byBotId.has(u.botId)) {
        return genIndex.byBotId.get(u.botId);
      }
      if (u?.responseId && genIndex.byResponseId.has(u.responseId)) {
        return genIndex.byResponseId.get(u.responseId);
      }
      return null;
    };

    const lookupGenRecord = (meta) => {
      const exact = lookupExactStepGenRecord(meta);
      if (exact) return exact;
      if (meta.modelEnum && genIndex.byEnum.has(meta.modelEnum)) {
        return genIndex.byEnum.get(meta.modelEnum);
      }
      return null;
    };

    const resolveStepModel = (meta, gmRec) => {
      const apiProv = meta.usage?.apiProvider || 0;
      if (gmRec?.modelSpec) {
        if (gmRec.modelSpec.isUnknownModel && apiProv === 26 && gmRec.modelSpec.provider === 'unknown') {
          return {
            ...gmRec.modelSpec,
            provider: 'claude',
            maxWindow: 1_000_000,
            inputRate: 4.0,
            cacheRate: 0.2,
            cacheWriteRate: 5.0,
            outputRate: 20.0,
          };
        }
        return gmRec.modelSpec;
      }
      if (meta.modelEnum > 0) {
        if (pricing.enumCatalog.has(meta.modelEnum)) {
          return pricing.enumCatalog.get(meta.modelEnum);
        }
        return pricing.synthesizeUnknownModelSpec({
          enumId: meta.modelEnum,
          rawSlug: '',
          displayName: '',
          apiProvider: apiProv,
        });
      }
      if (apiProv === 26) {
        return pricing.slugCatalog.get('claude-opus-5-5-high') || DEFAULT_MODEL;
      }
      return (
        latestStepModelSpec ||
        genIndex.latestRecord?.modelSpec ||
        fallbackModel ||
        DEFAULT_MODEL
      );
    };

    // Pre-scan for Orchestrator session status (Plan -> Execute -> Review)
    let sessionIsOrchestrator =
      isOrchestratorSlug(genIndex.sessionDesiredSlug) ||
      isOrchestratorSlug(desiredHintSlug) ||
      isOrchestratorSlug(genIndex.latestRecord?.rawSlug) ||
      isOrchestratorEnum(genIndex.latestRecord?.enumId);
    const parsedMetas = new Array(stepRows.length);
    for (let i = 0; i < stepRows.length; i++) {
      const r = stepRows[i];
      const m = parseStepMetadata(r.metadata);
      parsedMetas[i] = m;
      if (!sessionIsOrchestrator) {
        if (isOrchestratorEnum(m.requestedEnum) || isOrchestratorEnum(m.respondedEnum)) {
          sessionIsOrchestrator = true;
        }
      }
    }

    const orchestratorPhases = { planSteps: 0, executeSteps: 0, reviewSteps: 0 };
    let sawExecuteStep = false;

    for (let rowIdx = 0; rowIdx < stepRows.length; rowIdx++) {
      const row = stepRows[rowIdx];
      const idx = Number(row.idx);
      const stepType = Number(row.step_type);
      const status = Number(row.status);
      const meta = parsedMetas[rowIdx];
      const gmRec = lookupGenRecord(meta);

      const rowMaxTime = Math.max(meta.t7 || 0, meta.t6 || 0, meta.t1 || 0);
      if (rowMaxTime > latestStepTimeSec) {
        latestStepTimeSec = rowMaxTime;
      }

      const resolveCurrentIssueModel = () => {
        const spec =
          gmRec?.modelSpec ||
          (meta.modelEnum > 0 ? pricing.enumCatalog.get(meta.modelEnum) : null) ||
          latestStepModelSpec;
        const enumId =
          meta.respondedEnum ||
          meta.requestedEnum ||
          gmRec?.enumId ||
          latestRouting.enumId ||
          spec?.enums?.[0] ||
          0;
        const rawSlug =
          gmRec?.rawSlug ||
          spec?.rawSlug ||
          spec?.slug ||
          latestRouting.rawSlug ||
          '';
        const code =
          enumToModelCode(enumId).code ||
          spec?.placeholders?.[0]?.replace('MODEL_PLACEHOLDER_', '') ||
          '';
        return { rawSlug, code };
      };

      // System restart / server interruption notice (`step_type = 101`)
      if (stepType === 101) {
        const sysInj = detectSystemInjection101(row.payload_slice);
        if (sysInj) {
          const { rawSlug, code } = resolveCurrentIssueModel();
          issueCounts.server_injection += 1;
          incidents.push({
            stepIndex: idx,
            category: 'server_injection',
            timestampSec: rowMaxTime || latestStepTimeSec || 0,
            modelSlug: rawSlug,
            modelCode: code,
            summary: sysInj.message,
            injectedText: sysInj.fullText || sysInj.message,
            retriesRemaining: null,
            attempt: null,
            toolName: '',
            status,
            discardedStepIndex: -1,
            wastedUsd: 0,
          });
        }
      }

      // Error message & server moderation injection steps (`step_type = 17`)
      if (stepType === 17) {
        const errInfo = parseErrorStepSlice(row.payload_slice);
        if (errInfo.ignored) continue;

        const incCat = errInfo.category || 'upstream_retry';
        let discardedStepIndex = -1;
        let wastedUsd = 0;
        const canClaimDiscard =
          incCat === 'safety_filter' ||
          incCat === 'server_injection' ||
          (incCat === 'upstream_retry' && /interrupted/i.test(errInfo.fullText || errInfo.message));
        if (
          canClaimDiscard &&
          lastCompletedPlannerForDiscard &&
          idx - lastCompletedPlannerForDiscard.idx <= 3
        ) {
          discardedStepIndex = lastCompletedPlannerForDiscard.idx;
          wastedUsd = round(lastCompletedPlannerForDiscard.stepTotalUsd, 6);
          selfWastedUsd += wastedUsd;
          lastCompletedPlannerForDiscard = null;
        }

        const curM = resolveCurrentIssueModel();
        if (incCat in issueCounts) issueCounts[incCat] += 1;
        incidents.push({
          stepIndex: idx,
          category: incCat,
          timestampSec: rowMaxTime || latestStepTimeSec || 0,
          modelSlug: lastCompletedPlannerForDiscard?.modelSlug || curM.rawSlug,
          modelCode: lastCompletedPlannerForDiscard?.modelCode || curM.code,
          summary: errInfo.message || '执行遇到错误',
          injectedText: errInfo.fullText || errInfo.message || '执行遇到错误',
          retriesRemaining: errInfo.retriesRemaining,
          attempt: errInfo.attempt,
          toolName: '',
          status,
          discardedStepIndex,
          wastedUsd,
        });

        errorCount += 1;
        lastError = {
          stepIndex: idx,
          category: incCat,
          message: errInfo.message || '执行遇到错误',
          isQuotaError: errInfo.isQuotaError,
        };
        continue;
      }

      // Prompt / system wakeup boundary (skip synthetic `/btw` branch preamble step)
      if (isBtw && stepType === 101 && idx === minStepIdx) {
        continue;
      }
      if (stepType === triggerType) {
        if (stepType === 14) {
          sawExecuteStep = false;
          lastCompletedPlannerForDiscard = null;
        }
        const tStart = meta.t1 || rowMaxTime || 0;
        if (stepType === 101 && curTurnStartSec > 0 && !curTurnHasLlm) {
          if (tStart > 0 && curTurnEndSec > 0 && tStart - curTurnEndSec > IDLE_WAKEUP_GAP_SEC) {
            curTurnStartSec = tStart;
            curTurnEndSec = Math.max(tStart, rowMaxTime);
          } else if (rowMaxTime > curTurnEndSec) {
            curTurnEndSec = rowMaxTime;
          }
        } else {
          if (curTurnStartSec > 0 && curTurnEndSec > curTurnStartSec) {
            priorTurnsDurationSec += curTurnEndSec - curTurnStartSec;
          }
          curTurnStartSec = tStart;
          curTurnEndSec = Math.max(tStart, rowMaxTime);
          curTurnHasLlm = false;
        }
        continue;
      }

      // System wakeups (`101`) inside a user-initiated (`14`) session: exclude long idle sleep gaps
      if (stepType === 101 && triggerType === 14) {
        const tStart = meta.t1 || rowMaxTime || 0;
        if (
          tStart > 0 &&
          curTurnStartSec > 0 &&
          curTurnEndSec >= curTurnStartSec &&
          tStart - curTurnEndSec > IDLE_WAKEUP_GAP_SEC
        ) {
          priorTurnsDurationSec += curTurnEndSec - curTurnStartSec;
          curTurnStartSec = tStart;
          curTurnEndSec = Math.max(tStart, rowMaxTime);
        } else if (rowMaxTime > curTurnEndSec) {
          curTurnEndSec = rowMaxTime;
        }
        continue;
      }

      // Failed/rejected tool call (`step_type = 132`, `status = 6|7`) or completed `generate_image`
      if (stepType === 132) {
        if (status === 6 || status === 7) {
          const tf = parseToolFailureSlice(row.payload_slice, status);
          const curM = resolveCurrentIssueModel();
          issueCounts.tool_error += 1;
          incidents.push({
            stepIndex: idx,
            category: 'tool_error',
            timestampSec: rowMaxTime || latestStepTimeSec || 0,
            modelSlug: curM.rawSlug,
            modelCode: curM.code,
            summary: tf.message,
            injectedText: tf.message,
            retriesRemaining: null,
            attempt: null,
            toolName: tf.toolName,
            status,
            discardedStepIndex: -1,
            wastedUsd: 0,
          });
          continue;
        }
        const isCompleted = status === 3 || status === 5;
        if (!isCompleted) continue;
        const imgInfo = parseImageGenStepSlice(row.payload_slice);
        if (!imgInfo.modelSlug && !imgInfo.hasOutputFile) continue;

        const stepTimeSec = meta.t1 || meta.t6 || meta.t7 || 0;
        const { spec: imgSpec, perImageUsd } = pricing.resolveImageStepRate(
          imgInfo.modelSlug,
          stepTimeSec
        );
        generatedImages += 1;
        imageUsd += perImageUsd;
        addDaily(dailyMap, stepTimeSec || rowMaxTime, perImageUsd, 0, 0, 0, 0, 1);
        addDailyModel(dailyModelMap, stepTimeSec || rowMaxTime, imgSpec.fullName || imgSpec.shortName, perImageUsd);
        if (rowMaxTime > curTurnEndSec) curTurnEndSec = rowMaxTime;

        const key = `image|${imgSpec.slug}`;
        let bm = byModelMap.get(key);
        if (!bm) {
          bm = {
            kind: 'image',
            slug: imgSpec.slug,
            rawSlug: imgInfo.modelSlug || imgSpec.slug,
            desiredSlug: '',
            shortName: imgSpec.shortName,
            fullName: imgSpec.fullName,
            provider: imgSpec.provider || 'gemini',
            enumId: 0,
            code: '',
            placeholder: '',
            requestedEnum: 0,
            respondedEnum: 0,
            isCanaryRouted: false,
            canaryTag: '',
            canaryReason: '',
            isUnknownModel: false,
            apiProvider: 24,
            apiProviderName: 'google-cloudcode',
            botId: '',
            responseId: '',
            traceHash: '',
            costUsd: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            imageCount: 0,
            steps: 0,
            decodeOutTokens: 0,
            decodeSec: 0,
            ttftSum: 0,
            ttftCount: 0,
          };
          byModelMap.set(key, bm);
        }
        bm.costUsd += perImageUsd;
        bm.imageCount += 1;
        bm.steps += 1;
        continue;
      }

      // Active live streaming step (`idx === maxStepIdx`)
      if (
        idx === maxStepIdx &&
        (status === 8 || (stepType === 15 && (status === 1 || status === 2)))
      ) {
        rawIsGenerating = true;
        generatingStartSec = meta.t1 || meta.t6 || 0;
        const gStart = generatingStartSec || rowMaxTime || 0;
        if (!curTurnStartSec && gStart > 0) curTurnStartSec = gStart;
        if (rowMaxTime > curTurnEndSec) curTurnEndSec = rowMaxTime;
        curTurnHasLlm = true;
        if (meta.modelEnum || gmRec) {
          latestStepModelSpec = resolveStepModel(meta, gmRec);
          const genStepEnumId =
            meta.respondedEnum ||
            meta.requestedEnum ||
            gmRec?.enumId ||
            latestStepModelSpec.enums?.[0] ||
            0;
          const sameGenEnum = latestRouting.enumId === genStepEnumId;
          latestRouting = {
            hasStep: true,
            rawSlug:
              gmRec?.rawSlug ||
              (sameGenEnum ? latestRouting.rawSlug : '') ||
              latestStepModelSpec.rawSlug ||
              '',
            desiredSlug: resolveScopedDesiredSlug(gmRec, meta.requestedEnum, genStepEnumId),
            enumId: genStepEnumId,
            requestedEnum: meta.requestedEnum || (sameGenEnum ? latestRouting.requestedEnum : 0),
            respondedEnum: meta.respondedEnum || (sameGenEnum ? latestRouting.respondedEnum : 0),
            apiProvider: meta.usage?.apiProvider || latestRouting.apiProvider || 0,
            botId: meta.usage?.botId || gmRec?.botId || latestRouting.botId || '',
            responseId:
              meta.usage?.responseId || gmRec?.responseId || latestRouting.responseId || '',
            traceHash: gmRec?.traceHash || latestRouting.traceHash || '',
            sessionId: meta.usage?.sessionId || latestRouting.sessionId || '',
          };
        }
        continue;
      }

      const isCompleted = status === 3 || status === 5;
      if (!isCompleted) continue;
      if (stepType !== 15 && stepType !== 23) continue;

      const sStart = meta.t1 || rowMaxTime || 0;
      if (!curTurnStartSec && sStart > 0) curTurnStartSec = sStart;
      if (rowMaxTime > curTurnEndSec) curTurnEndSec = rowMaxTime;
      curTurnHasLlm = true;
      const stepRawDur =
        meta.t1 > 0 && meta.t7 >= meta.t1
          ? meta.t7 - meta.t1
          : meta.t6 > 0 && meta.t7 >= meta.t6
            ? meta.t7 - meta.t6
            : 0;
      if (stepRawDur > 0) {
        baseLlmDurationSec += stepRawDur;
      }

      const stepModel = resolveStepModel(meta, gmRec);
      const u = meta.usage;

      const stepReqEnum = meta.requestedEnum || 0;
      const stepResEnum = meta.respondedEnum || 0;
      const stepEnumId =
        stepResEnum ||
        stepReqEnum ||
        gmRec?.enumId ||
        stepModel.enums?.[0] ||
        0;
      const { code: stepCode, placeholder: stepPlaceholder } = enumToModelCode(stepEnumId);
      const stepRawSlug = gmRec?.rawSlug || stepModel.rawSlug || '';
      const stepDesiredSlug = resolveScopedDesiredSlug(gmRec, stepReqEnum, stepEnumId);
      const stepBotId = u?.botId || gmRec?.botId || '';
      const stepResponseId = u?.responseId || gmRec?.responseId || '';
      const stepTraceHash = gmRec?.traceHash || '';
      const stepSessionId = u?.sessionId || '';
      if (stepBotId) botIdsSet.add(stepBotId);

      const phase = resolveOrchestratorPhase({
        sessionIsOrchestrator,
        stepSlug: stepRawSlug || stepModel.slug,
        stepEnumId,
        afterPlanReview: sawExecuteStep,
      });
      if (phase === 'plan') orchestratorPhases.planSteps += 1;
      else if (phase === 'execute') {
        orchestratorPhases.executeSteps += 1;
        sawExecuteStep = true;
      } else if (phase === 'review') {
        orchestratorPhases.reviewSteps += 1;
      }

      const isOrchStepHandoff = Boolean(
        sessionIsOrchestrator ||
          isOrchestratorSlug(stepDesiredSlug) ||
          isOrchestratorEnum(stepReqEnum)
      );
      if (stepReqEnum > 0 && stepResEnum > 0 && stepReqEnum !== stepResEnum && !isOrchStepHandoff) {
        enumMismatchCount += 1;
      }

      const canary = detectCanaryRouting({
        rawSlug: stepRawSlug,
        desiredSlug: stepDesiredSlug,
        requestedEnum: stepReqEnum,
        respondedEnum: stepResEnum,
        sessionIsOrchestrator: isOrchStepHandoff,
      });
      const provInfo = resolveApiProviderInfo(
        u?.apiProvider || 0,
        stepResponseId,
        stepModel.provider
      );

      if (stepType === 15 || !latestRouting.hasStep) {
        const samePrevEnum = latestRouting.enumId === stepEnumId;
        latestStepModelSpec = stepModel;
        latestRouting = {
          hasStep: true,
          rawSlug: stepRawSlug || (samePrevEnum ? latestRouting.rawSlug : ''),
          desiredSlug: stepDesiredSlug,
          enumId: stepEnumId || latestRouting.enumId,
          requestedEnum: stepReqEnum,
          respondedEnum: stepResEnum,
          apiProvider: provInfo.apiProvider,
          botId: stepBotId || latestRouting.botId,
          responseId: stepResponseId || latestRouting.responseId,
          traceHash: stepTraceHash || latestRouting.traceHash,
          sessionId: stepSessionId || latestRouting.sessionId,
        };
      }

      if (u) {
        const inp = u.inputTokens || 0;
        const out = u.outputTokens || 0;
        const think = u.thinkingTokens || 0;
        const resp = u.responseTokens || 0;
        const cr = u.cacheReadTokens || 0;
        const stepTimeSec = meta.t1 || meta.t6 || meta.t7 || 0;
        const rates = pricing.resolveStepRates(stepModel, stepTimeSec, inp + cr);

        totalInput += inp;
        totalOutput += out;
        totalThinking += think;
        totalResponse += resp;
        totalCacheRead += cr;

        const stepInUsd = (inp * rates.inputRate) / 1_000_000;
        const stepCacheUsd = (cr * rates.cacheRate) / 1_000_000;
        const stepOutUsd = (out * rates.outputRate) / 1_000_000;
        const stepTotalUsd = stepInUsd + stepCacheUsd + stepOutUsd;

        inputUsd += stepInUsd;
        cacheUsd += stepCacheUsd;
        outputUsd += stepOutUsd;
        const stepSavedUsd =
          (cr * Math.max(0, rates.inputRate - rates.cacheRate)) / 1_000_000;
        savedCacheUsd += stepSavedUsd;
        addDaily(
          dailyMap,
          stepTimeSec || rowMaxTime,
          stepTotalUsd,
          inp,
          cr,
          out,
          stepSavedUsd,
          0,
          stepInUsd,
          stepCacheUsd,
          stepOutUsd
        );
        addDailyModel(
          dailyModelMap,
          stepTimeSec || rowMaxTime,
          stepModel.fullName || stepModel.shortName,
          stepTotalUsd,
          inp,
          cr,
          out
        );

        const effectiveRaw = stepRawSlug || stepModel.slug;
        const variantKey = `${stepModel.slug}|${effectiveRaw}|${stepEnumId}`;
        let bm = byModelMap.get(variantKey);
        if (!bm) {
          bm = {
            kind: 'llm',
            slug: stepModel.slug,
            rawSlug: effectiveRaw,
            desiredSlug: stepDesiredSlug,
            shortName: stepModel.shortName,
            fullName: stepModel.fullName,
            provider: stepModel.provider,
            enumId: stepEnumId,
            code:
              stepCode ||
              stepModel.placeholders?.[0]?.replace('MODEL_PLACEHOLDER_', '') ||
              '',
            placeholder: stepPlaceholder || stepModel.placeholders?.[0] || '',
            requestedEnum: stepReqEnum,
            respondedEnum: stepResEnum,
            isCanaryRouted: canary.isCanaryRouted,
            canaryTag: canary.canaryTag,
            canaryReason: canary.canaryReason,
            isUnknownModel: Boolean(stepModel.isUnknownModel),
            apiProvider: provInfo.apiProvider,
            apiProviderName: provInfo.apiProviderName,
            botId: stepBotId,
            responseId: stepResponseId,
            traceHash: stepTraceHash,
            costUsd: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            imageCount: 0,
            steps: 0,
            decodeOutTokens: 0,
            decodeSec: 0,
            ttftSum: 0,
            ttftCount: 0,
            latestSec: 0,
          };
          byModelMap.set(variantKey, bm);
        } else {
          if (stepBotId) bm.botId = stepBotId;
          if (stepResponseId) bm.responseId = stepResponseId;
          if (stepTraceHash) bm.traceHash = stepTraceHash;
          if (stepDesiredSlug && !bm.desiredSlug) bm.desiredSlug = stepDesiredSlug;
          if (stepReqEnum) bm.requestedEnum = stepReqEnum;
          if (stepResEnum) bm.respondedEnum = stepResEnum;
          if (canary.isCanaryRouted && !bm.isCanaryRouted) {
            bm.isCanaryRouted = true;
            bm.canaryTag = canary.canaryTag;
            bm.canaryReason = canary.canaryReason;
          }
        }
        bm.costUsd += stepTotalUsd;
        bm.inputTokens += inp;
        bm.cacheReadTokens += cr;
        bm.outputTokens += out;
        bm.steps += 1;
        bm.latestSec = Math.max(bm.latestSec || 0, stepTimeSec || rowMaxTime || 0);

        completedUsageSteps.push({
          idx,
          stepType,
          t1: meta.t1,
          inputTokens: inp,
          cacheReadTokens: cr,
          responseTokens: resp,
          outputTokens: out,
          isClaude: provInfo.apiProvider === 26 || stepModel.provider === 'claude',
          inputRate: rates.inputRate,
          cacheWriteRate: rates.cacheWriteRate,
        });
        if (stepType === 15) {
          lastCompletedPlannerForDiscard = {
            idx,
            stepTotalUsd,
            modelSlug: stepRawSlug || stepModel.slug,
            modelCode: stepCode || '',
          };
        }
      }

      if (stepType === 15 && u) {
        const exactGm = lookupExactStepGenRecord(meta);
        const stepApiCached = u.cacheReadTokens || 0;
        const stepApiFresh = (u.inputTokens || 0) + (u.responseTokens || 0);
        const stepApiContext = stepApiCached + stepApiFresh;
        if (exactGm?.maxContextTokens > 0) {
          latestOfficialMaxContextTokens = exactGm.maxContextTokens;
        }
        lastPlannerStep = {
          idx,
          t1: meta.t1,
          t6: meta.t6,
          t7: meta.t7,
          inputTokens: u.inputTokens || 0,
          cacheReadTokens: stepApiCached,
          responseTokens: u.responseTokens || 0,
          outputTokens: u.outputTokens || 0,
          apiContextTokens: stepApiContext,
          officialEstimatedTokens: exactGm?.estimatedTokensUsed || 0,
          officialMaxContextTokens: exactGm?.maxContextTokens || 0,
        };
        if (exactGm?.estimatedTokensUsed > 0) {
          lastOfficialPlannerStep = lastPlannerStep;
        }

        const stTiming = computeStepTimingAndTps(
          meta,
          u.outputTokens || 0,
          u.thinkingTokens || 0,
          stepType
        );
        if (stTiming.isValidTpsSample) {
          const perfSec = meta.t1 || meta.t6 || meta.t7 || rowMaxTime;
          const streamTtft = stTiming.isStreamingTtft ? stTiming.ttftSec : 0;
          addDailyPerf(dailyMap, perfSec, u.outputTokens || 0, stTiming.dtDecode, streamTtft);
          addDailyModelPerf(
            dailyModelMap,
            perfSec,
            stepModel.fullName || stepModel.shortName,
            u.outputTokens || 0,
            stTiming.dtDecode,
            streamTtft
          );
          const curBm = byModelMap.get(`${stepModel.slug}|${stepRawSlug || stepModel.slug}|${stepEnumId}`);
          if (curBm) {
            if ((u.outputTokens || 0) > 0 && stTiming.dtDecode > 0) {
              curBm.decodeOutTokens += u.outputTokens || 0;
              curBm.decodeSec += stTiming.dtDecode;
            }
            if (streamTtft > 0) {
              curBm.ttftSum += streamTtft;
              curBm.ttftCount += 1;
            }
          }
          completedPlannerForTps.push({
            outputTokens: u.outputTokens,
            dtDecode: stTiming.dtDecode,
            dtE2e: Math.max(0.05, stTiming.dtE2e || stTiming.dtDecode),
            decodeTps: stTiming.decodeTps,
            e2eTps: stTiming.e2eTps,
            ttftSec: stTiming.ttftSec,
            isStreamingTtft: stTiming.isStreamingTtft,
          });
        }
        if (stTiming.isStreamingTtft && stTiming.ttftSec > 0) {
          streamingTtftSamples.push(stTiming.ttftSec);
        } else if (stTiming.ttftSec > 0) {
          fallbackTtftSamples.push(stTiming.ttftSec);
        }
      } else if (stepType === 23) {
        checkpoints.push({
          idx,
          t1: meta.t1,
          usagePromptTokens: u ? (u.inputTokens || 0) + (u.cacheReadTokens || 0) : 0,
        });
      }
    }

    for (let i = 0; i < completedUsageSteps.length - 1; i++) {
      const cur = completedUsageSteps[i];
      if (!cur.isClaude || cur.inputTokens <= 0) continue;
      const nxt = completedUsageSteps[i + 1];
      const dt = nxt.t1 > 0 && cur.t1 > 0 ? nxt.t1 - cur.t1 : 0;
      if (dt >= 0 && dt <= 300 && nxt.cacheReadTokens > cur.cacheReadTokens) {
        const estWritten = Math.min(
          cur.inputTokens,
          nxt.cacheReadTokens - cur.cacheReadTokens
        );
        const writePremium = Math.max(0, cur.cacheWriteRate - cur.inputRate);
        claudeCacheWriteEstUsd += (estWritten * writePremium) / 1_000_000;
      }
    }

    const compactionRecords = checkpoints.map((ck, i) => {
      let beforeTokens = ck.usagePromptTokens;
      if (!beforeTokens) {
        for (let j = completedUsageSteps.length - 1; j >= 0; j--) {
          const s = completedUsageSteps[j];
          if (s.stepType === 15 && s.idx < ck.idx) {
            beforeTokens = s.inputTokens + s.cacheReadTokens + s.responseTokens;
            break;
          }
        }
      }
      let afterTokens = 0;
      for (let j = 0; j < completedUsageSteps.length; j++) {
        const s = completedUsageSteps[j];
        if (s.stepType === 15 && s.idx > ck.idx) {
          afterTokens = s.inputTokens + s.cacheReadTokens + s.responseTokens;
          break;
        }
      }
      if (!afterTokens) {
        afterTokens = 18_000;
      }
      return {
        number: i + 1,
        stepIndex: ck.idx,
        createdAt: ck.t1 > 0 ? new Date(ck.t1 * 1000).toISOString() : null,
        beforeTokens,
        afterTokens,
      };
    });

    const latestCkptIdx =
      checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].idx : -1;
    const latestPlannerIdx = lastPlannerStep ? lastPlannerStep.idx : -1;

    const maxWindow =
      genIndex.dynamicMaxWindow ||
      latestStepModelSpec.maxWindow ||
      DEFAULT_MAX_WINDOW;
    const hasOfficialLimit = latestOfficialMaxContextTokens > 0;
    const softLimit = hasOfficialLimit
      ? latestOfficialMaxContextTokens
      : latestStepModelSpec.softLimit || DEFAULT_SOFT_LIMIT;
    const limitSource = hasOfficialLimit ? 'official' : 'model_default';

    let currentTokens = 0;
    let cachedTokens = 0;
    let freshTokens = 0;
    let apiContextTokens = 0;
    let apiCachedTokens = 0;
    let apiFreshTokens = 0;
    let waterlineSource = hasOfficialLimit ? 'official' : 'api_usage';
    let isPostCompactionEstimate = false;

    const latestCtxRec = genIndex.latestContextRecord || null;
    const latestCtxIsCurrentEpoch = Boolean(
      latestCtxRec &&
        latestCtxRec.estimatedTokensUsed > 0 &&
        (!isBtw || Boolean(lastPlannerStep)) &&
        (latestCkptIdx < 0 ||
          (latestCtxRec.hasCheckpointField &&
            latestCtxRec.checkpointStepIndex >= latestCkptIdx))
    );

    if (latestPlannerIdx > latestCkptIdx && lastPlannerStep) {
      apiCachedTokens = lastPlannerStep.cacheReadTokens;
      apiFreshTokens =
        lastPlannerStep.inputTokens + lastPlannerStep.responseTokens;
      apiContextTokens = apiCachedTokens + apiFreshTokens;

      if (
        lastOfficialPlannerStep &&
        lastOfficialPlannerStep.idx > latestCkptIdx &&
        lastOfficialPlannerStep.officialEstimatedTokens > 0
      ) {
        const trailingDelta =
          lastPlannerStep.idx > lastOfficialPlannerStep.idx
            ? Math.max(
                0,
                lastPlannerStep.apiContextTokens -
                  lastOfficialPlannerStep.apiContextTokens
              )
            : 0;
        currentTokens =
          lastOfficialPlannerStep.officialEstimatedTokens + trailingDelta;
        waterlineSource = 'official';
      } else if (latestCtxIsCurrentEpoch) {
        currentTokens = latestCtxRec.estimatedTokensUsed;
        waterlineSource = 'official';
      } else {
        currentTokens = apiContextTokens;
        waterlineSource = 'api_usage';
      }

      if (currentTokens > 0 && apiContextTokens > 0) {
        cachedTokens = Math.min(
          currentTokens,
          Math.round(
            currentTokens * (apiCachedTokens / Math.max(1, apiContextTokens))
          )
        );
        freshTokens = Math.max(0, currentTokens - cachedTokens);
      } else {
        cachedTokens = 0;
        freshTokens = Math.max(0, currentTokens);
      }
    } else if (latestCkptIdx >= 0 && latestCkptIdx > latestPlannerIdx) {
      if (latestCtxIsCurrentEpoch) {
        currentTokens = latestCtxRec.estimatedTokensUsed;
        cachedTokens = 0;
        freshTokens = currentTokens;
        apiCachedTokens = 0;
        apiFreshTokens = currentTokens;
        apiContextTokens = currentTokens;
        waterlineSource = 'official';
      } else {
        cachedTokens = 0;
        freshTokens = 18_000;
        currentTokens = 18_000;
        apiCachedTokens = 0;
        apiFreshTokens = 18_000;
        apiContextTokens = 18_000;
        waterlineSource = 'api_usage';
        isPostCompactionEstimate = true;
      }
    } else if (latestCtxIsCurrentEpoch) {
      currentTokens = latestCtxRec.estimatedTokensUsed;
      cachedTokens = 0;
      freshTokens = currentTokens;
      apiCachedTokens = 0;
      apiFreshTokens = currentTokens;
      apiContextTokens = currentTokens;
      waterlineSource = 'official';
    }

    const latestBdRec = genIndex.latestBreakdownRecord || null;
    const breakdown =
      latestBdRec &&
      Array.isArray(latestBdRec.breakdown) &&
      latestBdRec.breakdown.length > 0 &&
      !isPostCompactionEstimate &&
      (!isBtw || Boolean(lastPlannerStep)) &&
      (latestCkptIdx < 0 ||
        !latestBdRec.hasCheckpointField ||
        latestBdRec.checkpointStepIndex >= latestCkptIdx)
        ? latestBdRec.breakdown
        : [];

    let rolling = 0;
    let latestDecode = 0;
    let latestTtftSec = 0;
    let avgTtftSec = 0;
    let latestE2e = 0;

    const ttftPool =
      streamingTtftSamples.length > 0 ? streamingTtftSamples : fallbackTtftSamples;
    if (ttftPool.length > 0) {
      latestTtftSec = round(ttftPool[ttftPool.length - 1], 2);
      avgTtftSec = round(
        ttftPool.reduce((acc, v) => acc + v, 0) / ttftPool.length,
        2
      );
    }

    if (completedPlannerForTps.length > 0) {
      const last = completedPlannerForTps[completedPlannerForTps.length - 1];
      latestDecode = last.decodeTps;
      latestE2e = last.e2eTps;
      if (!latestTtftSec && last.ttftSec > 0) {
        latestTtftSec = last.ttftSec;
      }
      const window5 = completedPlannerForTps.slice(-5);
      let sumOut = 0;
      let sumDt = 0;
      for (const item of window5) {
        sumOut += item.outputTokens;
        sumDt += item.dtDecode;
      }
      rolling = sumDt > 0 ? round(sumOut / sumDt, 1) : latestDecode;
    }

    const latestTurnStartSec = curTurnStartSec;
    const latestTurnBaseDurationSec =
      curTurnStartSec > 0 && curTurnEndSec > curTurnStartSec
        ? curTurnEndSec - curTurnStartSec
        : 0;

    const selfUsd = inputUsd + cacheUsd + outputUsd + imageUsd;
    const promptDenom = totalInput + totalCacheRead;
    const cacheHitRatio = promptDenom > 0 ? round(totalCacheRead / promptDenom, 4) : 0;
    const streamTps = round(rolling || latestDecode || 0, 1);

    const byModel = Array.from(byModelMap.values())
      .map((item) => ({
        ...item,
        costUsd: round(item.costUsd, 6),
      }))
      .sort((a, b) => b.costUsd - a.costUsd || b.steps - a.steps);

    const activeEnumId =
      latestRouting.enumId || latestStepModelSpec.enums?.[0] || 0;
    const { code: activeCode, placeholder: activePlaceholder } =
      enumToModelCode(activeEnumId);
    const activeRawSlug =
      latestRouting.rawSlug ||
      latestStepModelSpec.rawSlug ||
      latestStepModelSpec.slug;
    const activeDesiredSlug =
      latestRouting.desiredSlug ||
      resolveScopedDesiredSlug(null, latestRouting.requestedEnum, activeEnumId);
    const activeCanary = detectCanaryRouting({
      rawSlug: activeRawSlug,
      desiredSlug: activeDesiredSlug,
      requestedEnum: latestRouting.requestedEnum,
      respondedEnum: latestRouting.respondedEnum,
      sessionIsOrchestrator,
    });
    const historicalCanaryItem = byModel.find((x) => x.isCanaryRouted) || null;
    const isCanaryRouted = Boolean(
      activeCanary.isCanaryRouted || historicalCanaryItem || enumMismatchCount > 0
    );
    const canaryTag =
      activeCanary.canaryTag || historicalCanaryItem?.canaryTag || '';
    const canaryReason =
      activeCanary.canaryReason || historicalCanaryItem?.canaryReason || '';
    const activeProv = resolveApiProviderInfo(
      latestRouting.apiProvider,
      latestRouting.responseId,
      latestStepModelSpec.provider
    );
    const distinctModelCount = new Set(byModel.map((x) => x.slug)).size;

    const isTerminalError =
      lastError &&
      !rawIsGenerating &&
      (lastError.stepIndex >= maxStepIdx - 2 || lastError.stepIndex > latestPlannerIdx);
    const alert = isTerminalError
      ? {
          kind:
            lastError.category === 'safety_filter'
              ? 'safety'
              : lastError.isQuotaError
                ? 'quota'
                : 'error',
          category:
            lastError.category || (lastError.isQuotaError ? 'quota_429' : 'upstream_retry'),
          count: errorCount,
          message: lastError.message,
          stepIndex: lastError.stepIndex,
        }
      : null;

    return {
      modelSpec: latestStepModelSpec,
      model: {
        slug: latestStepModelSpec.slug,
        rawSlug: activeRawSlug,
        desiredSlug: activeDesiredSlug,
        shortName: latestStepModelSpec.shortName,
        fullName: latestStepModelSpec.fullName,
        provider: latestStepModelSpec.provider,
        enumId: activeEnumId,
        code:
          activeCode ||
          latestStepModelSpec.placeholders?.[0]?.replace('MODEL_PLACEHOLDER_', '') ||
          '',
        placeholder:
          activePlaceholder || latestStepModelSpec.placeholders?.[0] || '',
        requestedEnum: latestRouting.requestedEnum,
        respondedEnum: latestRouting.respondedEnum,
        enumMismatchCount,
        isCanaryRouted,
        activeStepCanary: activeCanary.isCanaryRouted,
        canaryTag,
        canaryReason,
        isUnknownModel: Boolean(latestStepModelSpec.isUnknownModel),
        isOrchestrator: sessionIsOrchestrator,
        orchestratorPhases,
        modelSwitched: false,
        switchedFromSlug: '',
        switchedToSlug: '',
        apiProvider: activeProv.apiProvider,
        apiProviderName: activeProv.apiProviderName,
        botId: latestRouting.botId,
        distinctBotCount: botIdsSet.size,
        responseId: latestRouting.responseId,
        traceHash: latestRouting.traceHash,
        sessionId: latestRouting.sessionId,
        softLimit,
        maxWindow,
        modelCount: byModel.length,
        distinctModelCount,
        treeHasCanary: isCanaryRouted,
        byModel,
      },
      tokens: {
        input: totalInput,
        output: totalOutput,
        thinking: totalThinking,
        response: totalResponse,
        cacheRead: totalCacheRead,
        generatedImages,
        cacheHitRatio,
        treeInput: totalInput,
        treeOutput: totalOutput,
        treeCacheRead: totalCacheRead,
        treeGeneratedImages: generatedImages,
        treeCacheHitRatio: cacheHitRatio,
      },
      cost: {
        selfUsd: round(selfUsd, 6),
        treeUsd: round(selfUsd, 6),
        childrenUsd: 0,
        inputUsd: round(inputUsd, 6),
        cacheUsd: round(cacheUsd, 6),
        outputUsd: round(outputUsd, 6),
        imageUsd: round(imageUsd, 6),
        treeImageUsd: round(imageUsd, 6),
        savedCacheUsd: round(savedCacheUsd, 6),
        claudeCacheWriteEstUsd: round(claudeCacheWriteEstUsd, 6),
        retryBranchDeltaUsd: 0,
        retryBranchStepCount: 0,
        retryBranchInput: 0,
        retryBranchCacheRead: 0,
        retryBranchOutput: 0,
        daily: finalizeDaily(dailyMap, latestStepTimeSec),
        dailyModels: finalizeDailyModels(dailyModelMap, latestStepTimeSec),
        byModel,
        treeByModel: byModel,
      },
      waterline: {
        currentTokens,
        cachedTokens,
        freshTokens,
        apiContextTokens,
        apiCachedTokens,
        apiFreshTokens,
        softLimit,
        softRatio: softLimit > 0 ? Math.min(1, round(currentTokens / softLimit, 4)) : 0,
        maxWindow,
        maxRatio: maxWindow > 0 ? Math.min(1, round(currentTokens / maxWindow, 6)) : 0,
        source: waterlineSource,
        limitSource,
        breakdown,
        isPostCompactionEstimate,
      },
      compaction: {
        count: checkpoints.length,
        hasSummary: checkpoints.length > 0,
        latestStepIndex: latestCkptIdx,
      },
      tps: {
        live: 0,
        stream: streamTps,
        activeChildAvg: 0,
        treeBurn: 0,
        rolling,
        latestDecode,
        latestTtftSec,
        latestE2e,
      },
      alert,
      issues: {
        total: incidents.length,
        treeTotal: incidents.length,
        wastedUsd: round(selfWastedUsd, 6),
        treeWastedUsd: round(selfWastedUsd, 6),
        latestCategory:
          incidents.length > 0 ? incidents[incidents.length - 1].category : '',
        counts: { ...issueCounts },
        treeCounts: { ...issueCounts },
        // Keep cloud-side signals preferentially; tool errors are high-volume agent noise.
        items: [
          ...incidents.filter((it) => it.category !== 'tool_error').slice(-40),
          ...incidents.filter((it) => it.category === 'tool_error').slice(-8),
        ].sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0)),
      },
      referencedConversationIds: [],
      priorTurnsDurationSec,
      latestTurnStartSec,
      latestTurnBaseDurationSec,
      baseLlmDurationSec,
      avgTtftSec,
      rawIsGenerating,
      isGenerating: false,
      generatingStartSec,
      latestStepTimeSec,
      stepCount: stepRows.length,
      compactionRecords,
    };
  }

  function buildMetricsFromJsonlOnly(
    jsonl,
    modelSpec,
    desiredHintSlug = '',
    rawHintSlug = ''
  ) {
    const base = createEmptyMetrics(modelSpec, desiredHintSlug, rawHintSlug);
    const m = modelSpec || DEFAULT_MODEL;
    let inTok = 0;
    let crTok = 0;
    let outTok = 0;
    let inputUsd = 0;
    let cacheUsd = 0;
    let outputUsd = 0;
    let savedCacheUsd = 0;
    let latestStepTimeSec = 0;
    let earliestStepTimeSec = 0;
    let lastPlanner = null;
    const ckpts = [];
    const jsonlDaily = new Map();
    const jsonlModelDaily = new Map();

    for (const st of jsonl.canonicalSteps) {
      const inp = st.inputTokens || 0;
      const cr = st.cacheReadTokens || 0;
      const out = st.outputTokens || 0;
      const tSec = st.stepTimeSec || 0;
      if (tSec > 0 && (!earliestStepTimeSec || tSec < earliestStepTimeSec)) {
        earliestStepTimeSec = tSec;
      }
      if (tSec > latestStepTimeSec) latestStepTimeSec = tSec;
      const rates = pricing.resolveStepRates(m, tSec, inp + cr);

      inTok += inp;
      crTok += cr;
      outTok += out;

      inputUsd += (inp * rates.inputRate) / 1_000_000;
      cacheUsd += (cr * rates.cacheRate) / 1_000_000;
      outputUsd += (out * rates.outputRate) / 1_000_000;
      const stSaved = (cr * Math.max(0, rates.inputRate - rates.cacheRate)) / 1_000_000;
      savedCacheUsd += stSaved;
      const stInUsd = (inp * rates.inputRate) / 1_000_000;
      const stCrUsd = (cr * rates.cacheRate) / 1_000_000;
      const stOutUsd = (out * rates.outputRate) / 1_000_000;
      const stUsd = stInUsd + stCrUsd + stOutUsd;
      addDaily(jsonlDaily, tSec, stUsd, inp, cr, out, stSaved, 0, stInUsd, stCrUsd, stOutUsd);
      addDailyModel(jsonlModelDaily, tSec, m.fullName || m.shortName, stUsd, inp, cr, out);

      if (st.stepType === 15) lastPlanner = st;
      else if (st.stepType === 23) ckpts.push(st);
    }

    const selfUsd = inputUsd + cacheUsd + outputUsd;
    const latestCkptIdx = ckpts.length > 0 ? ckpts[ckpts.length - 1].idx : -1;
    const latestPlannerIdx = lastPlanner ? lastPlanner.idx : -1;
    let cachedTokens = 0;
    let freshTokens = 0;
    let isPostCompactionEstimate = false;

    if (latestPlannerIdx > latestCkptIdx && lastPlanner) {
      cachedTokens = lastPlanner.cacheReadTokens;
      freshTokens = lastPlanner.inputTokens + lastPlanner.outputTokens;
    } else if (latestCkptIdx >= 0) {
      freshTokens = 18_000;
      isPostCompactionEstimate = true;
    }
    const currentTokens = cachedTokens + freshTokens;
    const revIn = jsonl.revertedInput || 0;
    const revCr = jsonl.revertedCache || 0;
    const revOut = jsonl.revertedOutput || 0;
    const revSteps = jsonl.revertedStepCount || 0;
    const revInUsd = jsonl.revertedInputUsd || 0;
    const revCrUsd = jsonl.revertedCacheUsd || 0;
    const revOutUsd = jsonl.revertedOutputUsd || 0;
    const revUsd = jsonl.revertedUsd || 0;
    const revSavedUsd = jsonl.revertedSavedCacheUsd || 0;

    const totalInTok = inTok + revIn;
    const totalCrTok = crTok + revCr;
    const totalOutTok = outTok + revOut;
    const totalSelfUsd = selfUsd + revUsd;
    const totalInUsd = inputUsd + revInUsd;
    const totalCrUsd = cacheUsd + revCrUsd;
    const totalOutUsd = outputUsd + revOutUsd;
    const totalSavedUsd = savedCacheUsd + revSavedUsd;
    const mergedDaily = finalizeDaily(jsonlDaily, latestStepTimeSec);
    if (revSteps > 0) mergeDailyInto(mergedDaily, jsonl.revertedDaily);
    const mergedDailyModels = finalizeDailyModels(jsonlModelDaily, latestStepTimeSec);
    if (revSteps > 0) mergeDailyModelsInto(mergedDailyModels, jsonl.revertedDailyModels);

    const denom = totalInTok + totalCrTok;
    const cacheHitRatio = denom > 0 ? round(totalCrTok / denom, 4) : 0;

    const byModel =
      jsonl.canonicalSteps.length + revSteps > 0
        ? [
            {
              kind: 'llm',
              slug: m.slug,
              rawSlug: base.model.rawSlug,
              desiredSlug: base.model.desiredSlug,
              shortName: m.shortName,
              fullName: m.fullName,
              provider: m.provider,
              enumId: base.model.enumId,
              code: base.model.code,
              placeholder: base.model.placeholder,
              requestedEnum: 0,
              respondedEnum: 0,
              isCanaryRouted: base.model.isCanaryRouted,
              canaryTag: base.model.canaryTag,
              canaryReason: base.model.canaryReason,
              isUnknownModel: Boolean(m.isUnknownModel),
              apiProvider: base.model.apiProvider,
              apiProviderName: base.model.apiProviderName,
              botId: '',
              responseId: '',
              traceHash: '',
              costUsd: round(totalSelfUsd, 6),
              inputTokens: totalInTok,
              cacheReadTokens: totalCrTok,
              outputTokens: totalOutTok,
              imageCount: 0,
              steps: jsonl.canonicalSteps.length + revSteps,
            },
          ]
        : [];

    const lastActivityMs = Math.max(
      latestStepTimeSec * 1000,
      jsonl.mtimeMs || 0
    );
    const ageSinceActivitySec =
      lastActivityMs > 0
        ? Math.max(0, (Date.now() - lastActivityMs) / 1000)
        : Infinity;

    return {
      ...base,
      model: {
        ...base.model,
        modelCount: byModel.length,
        distinctModelCount: byModel.length,
        byModel,
      },
      tokens: {
        ...base.tokens,
        input: totalInTok,
        output: totalOutTok,
        thinking: 0,
        response: totalOutTok,
        cacheRead: totalCrTok,
        cacheHitRatio,
        treeInput: totalInTok,
        treeOutput: totalOutTok,
        treeCacheRead: totalCrTok,
        treeCacheHitRatio: cacheHitRatio,
      },
      cost: {
        ...base.cost,
        selfUsd: round(totalSelfUsd, 6),
        treeUsd: round(totalSelfUsd, 6),
        inputUsd: round(totalInUsd, 6),
        cacheUsd: round(totalCrUsd, 6),
        outputUsd: round(totalOutUsd, 6),
        savedCacheUsd: round(totalSavedUsd, 6),
        retryBranchDeltaUsd: round(revUsd, 6),
        retryBranchStepCount: revSteps,
        retryBranchInput: revIn,
        retryBranchCacheRead: revCr,
        retryBranchOutput: revOut,
        daily: mergedDaily,
        dailyModels: mergedDailyModels,
        byModel,
        treeByModel: byModel,
      },
      waterline: {
        ...base.waterline,
        currentTokens,
        cachedTokens,
        freshTokens,
        apiContextTokens: currentTokens,
        apiCachedTokens: cachedTokens,
        apiFreshTokens: freshTokens,
        softRatio:
          base.model.softLimit > 0
            ? Math.min(1, round(currentTokens / base.model.softLimit, 4))
            : 0,
        maxRatio:
          base.model.maxWindow > 0
            ? Math.min(1, round(currentTokens / base.model.maxWindow, 6))
            : 0,
        source: 'api_usage',
        limitSource: 'model_default',
        breakdown: [],
        isPostCompactionEstimate,
      },
      compaction: {
        count: ckpts.length,
        hasSummary: ckpts.length > 0,
        latestStepIndex: latestCkptIdx,
      },
      timing: {
        totalDurationSec:
          earliestStepTimeSec > 0 && latestStepTimeSec >= earliestStepTimeSec
            ? round(latestStepTimeSec - earliestStepTimeSec, 2)
            : 0,
        llmDurationSec: 0,
        treeLlmDurationSec: 0,
        avgTtftSec: 0,
        latestTtftSec: 0,
        isLiveTicking: false,
      },
      priorTurnsDurationSec: 0,
      latestTurnStartSec: earliestStepTimeSec,
      latestTurnBaseDurationSec:
        earliestStepTimeSec > 0 && latestStepTimeSec >= earliestStepTimeSec
          ? latestStepTimeSec - earliestStepTimeSec
          : 0,
      baseLlmDurationSec: 0,
      selfLlmDurationSec: 0,
      avgTtftSec: 0,
      latestStepTimeSec,
      lastActivityMs,
      ageSinceActivitySec,
      stepCount: jsonl.canonicalSteps.length,
    };
  }

  function analyzeConversationDb(
    convId,
    preferredDir,
    hintModelSlug = '',
    eagerJsonlDelta = false,
    desiredHintSlug = '',
    minStepIdx = 0
  ) {
    const dbPath = discovery.findConvFile(convId, preferredDir, join('conversations', `${convId}.db`));
    const trimmedHint = String(hintModelSlug || '').trim();
    const floorIdxParam = Math.max(0, Number(minStepIdx) || 0);
    const hintModel = trimmedHint
      ? pricing.resolveModelBySlugOrText(trimmedHint, 0) ||
        pricing.synthesizeUnknownModelSpec({
          enumId: 0,
          rawSlug: trimmedHint,
          displayName: '',
          apiProvider: 0,
        })
      : pricing.readGlobalDefaultModel();

    if (!dbPath) {
      const jsonl = getJsonlUsageFallbackAndTotal(
        convId,
        preferredDir,
        hintModel,
        floorIdxParam
      );
      if (!jsonl) {
        return createEmptyMetrics(hintModel, desiredHintSlug, trimmedHint);
      }
      return buildMetricsFromJsonlOnly(jsonl, hintModel, desiredHintSlug, trimmedHint);
    }

    const dbSt = safeStat(dbPath);
    const walSt = safeStat(`${dbPath}-wal`);
    const sig = dbSt
      ? `${dbSt.mtimeMs}:${dbSt.size}:${walSt ? `${walSt.mtimeMs}:${walSt.size}` : '0'}`
      : null;
    const hintKey = `${trimmedHint}|${desiredHintSlug || ''}|${floorIdxParam}`;
    const cached = convDbCache.get(convId);
    let core = null;
    let effectiveMinStepIdx = floorIdxParam;

    if (sig && cached && cached.sig === sig && cached.hintKey === hintKey) {
      core = cached.parsed;
      effectiveMinStepIdx = cached.effectiveMinStepIdx || floorIdxParam;
    } else {
      let db = null;
      try {
        db = openReadOnlyDb(dbPath);
        const genIndex = loadGenMetadataIndex(db);
        const btwInfo = detectBtwBranchFromDb(db);
        effectiveMinStepIdx = Math.max(floorIdxParam, btwInfo.minStepIdx || 0);
        const isBtw = Boolean(btwInfo.isBtw || effectiveMinStepIdx > 0);

        const stepRows = db
          .prepare(
            `SELECT idx, step_type, status, metadata,
               CASE
                 WHEN step_type = 17 THEN substr(step_payload, 1, 1600)
                 WHEN step_type = 101 THEN substr(step_payload, 1, 600)
                 WHEN step_type = 132 AND status IN (6, 7) THEN substr(step_payload, 1, 360)
                 WHEN step_type = 132 THEN substr(step_payload, max(1, length(step_payload) - 512), 512)
                 ELSE NULL
               END AS payload_slice
             FROM steps
             WHERE idx >= ?
               AND (
                 step_type IN (14, 15, 17, 23, 101)
                 OR (step_type = 132 AND ((status IN (3, 5) AND instr(metadata, CAST('generate_image' AS BLOB)) > 0) OR status IN (6, 7)))
                 OR idx = (SELECT MAX(idx) FROM steps)
               )
             ORDER BY idx ASC`
          )
          .all(effectiveMinStepIdx);

        let refRows = [];
        try {
          refRows = db.prepare('SELECT idx, data FROM parent_references LIMIT 32').all();
        } catch {
          refRows = [];
        }
        const referencedConversationIds = parseParentReferencesRows(refRows, convId);

        core = computeCoreDbMetrics(
          stepRows,
          genIndex,
          hintModel,
          desiredHintSlug || trimmedHint,
          { isBtw, minStepIdx: effectiveMinStepIdx }
        );
        core.referencedConversationIds = referencedConversationIds;
        core.btw = isBtw
          ? {
              isBtw: true,
              parentConversationId: btwInfo.parentConversationId,
              branchStepIndex: btwInfo.branchStepIndex,
              minStepIdx: effectiveMinStepIdx,
            }
          : null;
        if (sig) {
          convDbCache.set(convId, {
            sig,
            hintKey,
            dbPath,
            genIndex,
            effectiveMinStepIdx,
            parsed: core,
          });
        }
      } catch {
        core = cached
          ? cached.parsed
          : createEmptyMetrics(hintModel, desiredHintSlug, trimmedHint);
      } finally {
        if (db) {
          try {
            db.close();
          } catch {
            // ignore
          }
        }
      }
    }

    const tPath = discovery.findConvFile(
      convId,
      preferredDir,
      join('brain', convId, '.system_generated', 'logs', 'transcript.jsonl')
    );
    const tSt = tPath ? safeStat(tPath) : null;

    let jsonl = null;
    if (
      eagerJsonlDelta ||
      jsonlUsageCache.has(`${convId}|${effectiveMinStepIdx}`) ||
      jsonlUsageCache.has(convId)
    ) {
      jsonl = getJsonlUsageFallbackAndTotal(
        convId,
        preferredDir,
        core.modelSpec,
        effectiveMinStepIdx
      );
    } else if (tSt && tSt.size <= 16 * 1024 * 1024) {
      jsonl = getJsonlUsageFallbackAndTotal(
        convId,
        preferredDir,
        core.modelSpec,
        effectiveMinStepIdx
      );
    }

    const revSteps = jsonl?.revertedStepCount || 0;
    const revIn = revSteps > 0 ? jsonl.revertedInput || 0 : 0;
    const revCr = revSteps > 0 ? jsonl.revertedCache || 0 : 0;
    const revOut = revSteps > 0 ? jsonl.revertedOutput || 0 : 0;
    const revInUsd = revSteps > 0 ? jsonl.revertedInputUsd || 0 : 0;
    const revCrUsd = revSteps > 0 ? jsonl.revertedCacheUsd || 0 : 0;
    const revOutUsd = revSteps > 0 ? jsonl.revertedOutputUsd || 0 : 0;
    const revUsd = revSteps > 0 ? jsonl.revertedUsd || 0 : 0;
    const revSavedUsd = revSteps > 0 ? jsonl.revertedSavedCacheUsd || 0 : 0;
    const retryBranchDeltaUsd = round(revUsd, 6);

    let mergedTokens = core.tokens;
    let mergedCost = core.cost;
    let mergedModel = core.model;

    if (revSteps > 0 && (revUsd > 0 || revIn + revOut + revCr > 0)) {
      const nextIn = (core.tokens.input || 0) + revIn;
      const nextCr = (core.tokens.cacheRead || 0) + revCr;
      const nextOut = (core.tokens.output || 0) + revOut;
      const nextDenom = nextIn + nextCr;
      const nextHit = nextDenom > 0 ? round(nextCr / nextDenom, 4) : 0;

      mergedTokens = {
        ...core.tokens,
        input: nextIn,
        output: nextOut,
        response: (core.tokens.response || 0) + revOut,
        cacheRead: nextCr,
        cacheHitRatio: nextHit,
        treeInput: nextIn,
        treeOutput: nextOut,
        treeCacheRead: nextCr,
        treeCacheHitRatio: nextHit,
      };

      const clonedDaily = {};
      mergeDailyInto(clonedDaily, core.cost.daily);
      mergeDailyInto(clonedDaily, jsonl.revertedDaily);

      const clonedDailyModels = {};
      mergeDailyModelsInto(clonedDailyModels, core.cost.dailyModels);
      mergeDailyModelsInto(clonedDailyModels, jsonl.revertedDailyModels);

      const clonedByModel = (core.cost.byModel || []).map((bm) => ({ ...bm }));
      const targetBm = clonedByModel.find(
        (bm) => bm.kind !== 'image' && bm.slug === core.model?.slug
      ) || clonedByModel.find((bm) => bm.kind !== 'image');
      if (targetBm) {
        targetBm.costUsd = round((Number(targetBm.costUsd) || 0) + revUsd, 6);
        targetBm.inputTokens = (Number(targetBm.inputTokens) || 0) + revIn;
        targetBm.cacheReadTokens = (Number(targetBm.cacheReadTokens) || 0) + revCr;
        targetBm.outputTokens = (Number(targetBm.outputTokens) || 0) + revOut;
        targetBm.steps = (Number(targetBm.steps) || 0) + revSteps;
      }

      const nextSelfUsd = round((Number(core.cost.selfUsd) || 0) + revUsd, 6);
      mergedCost = {
        ...core.cost,
        selfUsd: nextSelfUsd,
        treeUsd: nextSelfUsd,
        inputUsd: round((Number(core.cost.inputUsd) || 0) + revInUsd, 6),
        cacheUsd: round((Number(core.cost.cacheUsd) || 0) + revCrUsd, 6),
        outputUsd: round((Number(core.cost.outputUsd) || 0) + revOutUsd, 6),
        savedCacheUsd: round((Number(core.cost.savedCacheUsd) || 0) + revSavedUsd, 6),
        retryBranchDeltaUsd,
        retryBranchStepCount: revSteps,
        retryBranchInput: revIn,
        retryBranchCacheRead: revCr,
        retryBranchOutput: revOut,
        daily: clonedDaily,
        dailyModels: clonedDailyModels,
        byModel: clonedByModel,
        treeByModel: clonedByModel,
      };
      mergedModel = {
        ...core.model,
        byModel: clonedByModel,
      };
    } else {
      mergedCost = {
        ...core.cost,
        retryBranchDeltaUsd: 0,
        retryBranchStepCount: 0,
        retryBranchInput: 0,
        retryBranchCacheRead: 0,
        retryBranchOutput: 0,
      };
    }

    const latestFileMtimeMs = Math.max(
      dbSt ? dbSt.mtimeMs : 0,
      walSt ? walSt.mtimeMs : 0,
      tSt ? tSt.mtimeMs : 0
    );
    const lastActivityMs = Math.max(
      (core.latestStepTimeSec || 0) * 1000,
      latestFileMtimeMs
    );
    const ageSinceActivitySec =
      lastActivityMs > 0
        ? Math.max(0, (Date.now() - lastActivityMs) / 1000)
        : Infinity;

    const isGenerating = Boolean(
      core.rawIsGenerating && ageSinceActivitySec <= STALE_GENERATING_SEC
    );
    let generatingElapsedSec = 0;
    if (isGenerating) {
      const startSec =
        core.generatingStartSec > 0
          ? core.generatingStartSec
          : lastActivityMs > 0
            ? lastActivityMs / 1000
            : Date.now() / 1000;
      generatingElapsedSec = round(
        Math.max(0, Date.now() / 1000 - startSec),
        1
      );
    }

    const selfLlmDurationSec = round(
      (core.baseLlmDurationSec || 0) + (isGenerating ? generatingElapsedSec : 0),
      2
    );
    const liveSelfLatestTurnSec =
      isGenerating && (core.latestTurnStartSec || 0) > 0
        ? Math.max(
            core.latestTurnBaseDurationSec || 0,
            Math.max(0, Date.now() / 1000 - core.latestTurnStartSec)
          )
        : isGenerating
          ? Math.max(core.latestTurnBaseDurationSec || 0, generatingElapsedSec)
          : core.latestTurnBaseDurationSec || 0;
    const baseTotalDurationSec = round(
      Math.max(
        selfLlmDurationSec,
        (core.priorTurnsDurationSec || 0) + liveSelfLatestTurnSec
      ),
      2
    );

    return {
      ...core,
      model: mergedModel,
      tokens: mergedTokens,
      isGenerating,
      generatingElapsedSec,
      selfLlmDurationSec,
      timing: {
        totalDurationSec: baseTotalDurationSec,
        llmDurationSec: selfLlmDurationSec,
        treeLlmDurationSec: selfLlmDurationSec,
        avgTtftSec: core.avgTtftSec || 0,
        latestTtftSec: core.tps?.latestTtftSec || 0,
        isLiveTicking: isGenerating,
      },
      lastActivityMs,
      ageSinceActivitySec,
      cost: mergedCost,
    };
  }

  function readLatestCompactionSummary(convId, preferredDir, minStepIdx = 0) {
    const floorIdx = Math.max(0, Number(minStepIdx) || 0);
    const fullPath = discovery.findConvFile(
      convId,
      preferredDir,
      join('brain', convId, '.system_generated', 'logs', 'transcript_full.jsonl')
    );

    if (fullPath) {
      const st = safeStat(fullPath);
      if (st && st.size > 0) {
        let state = checkpointSummaryCache.get(convId);
        if (
          !state ||
          state.filePath !== fullPath ||
          st.size < state.offset ||
          state.floorIdx !== floorIdx
        ) {
          state = {
            filePath: fullPath,
            floorIdx,
            mtimeMs: 0,
            size: 0,
            offset: 0,
            latestStepIndex: -1,
            latestCreatedAt: null,
            rawContent: '',
          };
        }

        if (st.size > state.offset || st.mtimeMs !== state.mtimeMs) {
          const bytesToRead = st.size - state.offset;
          if (bytesToRead > 0) {
            let fd = -1;
            try {
              fd = openSync(fullPath, 'r');
              const buf = Buffer.allocUnsafe(bytesToRead);
              const bytesRead = readSync(fd, buf, 0, bytesToRead, state.offset);
              const sliceStr = buf.subarray(0, bytesRead).toString('utf-8');
              const lastNewline = sliceStr.lastIndexOf('\n');
              const completeChunk =
                lastNewline >= 0
                  ? sliceStr.slice(0, lastNewline + 1)
                  : sliceStr.endsWith('}')
                    ? sliceStr
                    : '';

              if (completeChunk) {
                state.offset += Buffer.byteLength(completeChunk, 'utf-8');
                const lines = completeChunk.split('\n');
                for (const line of lines) {
                  if (!line.includes('"CHECKPOINT"')) continue;
                  try {
                    const obj = JSON.parse(line);
                    const sIdx = Number(obj.step_index) ?? -1;
                    if (
                      obj.type === 'CHECKPOINT' &&
                      typeof obj.content === 'string' &&
                      (floorIdx === 0 || sIdx >= floorIdx)
                    ) {
                      state.latestStepIndex = sIdx >= 0 ? sIdx : state.latestStepIndex;
                      state.latestCreatedAt = obj.created_at || state.latestCreatedAt;
                      state.rawContent = obj.content;
                    }
                  } catch {
                    // ignore partial line
                  }
                }
              }
              state.mtimeMs = st.mtimeMs;
              state.size = st.size;
              checkpointSummaryCache.set(convId, state);
            } catch {
              // ignore transient read error
            } finally {
              if (fd >= 0) {
                try {
                  closeSync(fd);
                } catch {
                  // ignore
                }
              }
            }
          } else {
            state.mtimeMs = st.mtimeMs;
            checkpointSummaryCache.set(convId, state);
          }
        }

        if (state.rawContent) {
          return {
            latestStepIndex: state.latestStepIndex,
            latestCreatedAt: state.latestCreatedAt,
            summaryMarkdown: cleanCompactedSummary(state.rawContent),
            rawByteLength: Buffer.byteLength(state.rawContent, 'utf-8'),
          };
        }
      }
    }

    const dbPath = discovery.findConvFile(convId, preferredDir, join('conversations', `${convId}.db`));
    if (dbPath) {
      let db = null;
      try {
        db = openReadOnlyDb(dbPath);
        const row = db
          .prepare(
            `SELECT idx, metadata, step_payload
             FROM steps
             WHERE idx >= ? AND step_type = 23 AND status IN (3, 5)
             ORDER BY idx DESC
             LIMIT 1`
          )
          .get(floorIdx);
        if (row && row.step_payload) {
          const raw = extractSummaryFromStepPayload(row.step_payload);
          const meta = parseStepMetadata(row.metadata);
          if (raw) {
            return {
              latestStepIndex: Number(row.idx),
              latestCreatedAt: meta.t1 > 0 ? new Date(meta.t1 * 1000).toISOString() : null,
              summaryMarkdown: cleanCompactedSummary(raw),
              rawByteLength: Buffer.byteLength(raw, 'utf-8'),
            };
          }
        }
      } catch {
        // ignore
      } finally {
        if (db) {
          try {
            db.close();
          } catch {
            // ignore
          }
        }
      }
    }

    return {
      latestStepIndex: -1,
      latestCreatedAt: null,
      summaryMarkdown: '',
      rawByteLength: 0,
    };
  }

  function readChapterTitles(convId, preferredDir) {
    const pbPath = discovery.findConvFile(
      convId,
      preferredDir,
      join('chapter_titles', `${convId}.pb`)
    );
    if (!pbPath) return [];
    const sig = fileSig(pbPath);
    const cached = chapterTitlesCache.get(convId);
    if (cached && cached.sig === sig) return cached.chapters;

    let chapters = [];
    try {
      const buf = readFileSync(pbPath);
      chapters = parseChapterTitlesProto(buf);
    } catch {
      chapters = [];
    }
    chapterTitlesCache.set(convId, { sig, chapters });
    return chapters;
  }

  return {
    getCachedGenIndex(convId) {
      return convDbCache.get(convId)?.genIndex || null;
    },
    detectBtwBranchFromDb,
    loadGenMetadataIndex,
    getJsonlUsageFallbackAndTotal,
    computeStepTimingAndTps,
    createEmptyMetrics,
    analyzeConversationDb,
    readLatestCompactionSummary,
    readChapterTitles,
    clearPricingCaches() {
      convDbCache.clear();
      jsonlUsageCache.clear();
    },
    invalidateConv(cid) {
      convDbCache.delete(cid);
      for (const k of Array.from(jsonlUsageCache.keys())) {
        if (k === cid || k.startsWith(`${cid}|`)) {
          jsonlUsageCache.delete(k);
        }
      }
      chapterTitlesCache.delete(cid);
    },
    clearAll() {
      convDbCache.clear();
      jsonlUsageCache.clear();
      checkpointSummaryCache.clear();
      chapterTitlesCache.clear();
    },
  };
}
