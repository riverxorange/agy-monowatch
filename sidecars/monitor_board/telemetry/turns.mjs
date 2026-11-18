/**
 * @fileoverview Per-message (turn) ledger & per-step forensic attribution:
 * reconciles turn costs to `thread.cost.selfUsd`, excludes idle timer/sleep gaps
 * from active turn durations, attributes Orchestrator Plan/Execute/Review phases,
 * image generation steps, and error/quota boundaries.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SOFT_LIMIT,
  IDLE_WAKEUP_GAP_SEC,
  dbWalSig,
  fileSig,
  openReadOnlyDb,
  parseDateMs,
  round,
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
  cleanTurnPrompt,
  detectSystemInjection101,
  extractPromptFromStepPayload,
  parseErrorStepSlice,
  parseImageGenStepSlice,
  parseStepMetadata,
  parseToolFailureSlice,
} from './proto.mjs';

function scoreSystemWakeMessage(txt) {
  if (!txt) return -1;
  if (/^\[board\]\s+the latest message is/i.test(txt)) return 0;
  if (/^\[swarm\]\s+new board message/i.test(txt)) return 1;
  return 2;
}

function pickBetterSystemPrompt(prev, next) {
  const sPrev = scoreSystemWakeMessage(prev.promptText);
  const sNext = scoreSystemWakeMessage(next.promptText);
  if (sNext > sPrev) return next;
  if (sNext === sPrev && next.promptText.length > prev.promptText.length) {
    return next;
  }
  return prev;
}

export function readJsonlPromptMap(tPath) {
  const map = new Map();
  if (!tPath) return map;
  try {
    const content = readFileSync(tPath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !trimmed ||
        (!trimmed.includes('"USER_INPUT"') && !trimmed.includes('"SYSTEM_MESSAGE"'))
      ) {
        continue;
      }
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type !== 'USER_INPUT' && obj.type !== 'SYSTEM_MESSAGE') continue;
        const idx = Number(obj.step_index);
        if (!Number.isFinite(idx)) continue;
        for (const k of Array.from(map.keys())) {
          if (k > idx) map.delete(k);
        }
        map.set(idx, {
          stepType: obj.type === 'USER_INPUT' ? 14 : 101,
          content: typeof obj.content === 'string' ? obj.content : '',
          hasMedia: Array.isArray(obj.media) && obj.media.length > 0,
          createdSec: obj.created_at ? parseDateMs(obj.created_at) / 1000 : 0,
        });
      } catch {
        // ignore partial line
      }
    }
  } catch {
    // ignore
  }
  return map;
}

export function createTurnLedgerBuilder({ pricing, discovery, metrics }) {
  const turnLedgerCache = new Map();
  const lastGoodTurnsCache = new Map();

  function finalizeTurnList(rawTurns, compactionRecords, node, fallbackModel) {
    if (!rawTurns || rawTurns.length === 0) {
      return {
        turns: [],
        turnSummary: { totalTurns: 0, canaryTurnCount: 0 },
      };
    }

    const lastPlannerIdxPerTurn = rawTurns.map((rt) => {
      let maxP = -1;
      for (const s of rt.steps) {
        if (s.kind === 'planner' && s.stepIndex > maxP) maxP = s.stepIndex;
      }
      return maxP;
    });

    const compactionEventsByTurn = rawTurns.map(() => []);
    for (const ck of compactionRecords || []) {
      let ownerIdx = 0;
      for (let i = rawTurns.length - 1; i >= 0; i--) {
        if (ck.stepIndex >= rawTurns[i].stepStartIndex) {
          ownerIdx = i;
          break;
        }
      }
      const ownerLastPlanner = lastPlannerIdxPerTurn[ownerIdx];
      if (
        ownerLastPlanner >= 0 &&
        ck.stepIndex > ownerLastPlanner &&
        ownerIdx + 1 < rawTurns.length
      ) {
        ownerIdx += 1;
      }
      const timing =
        lastPlannerIdxPerTurn[ownerIdx] >= 0 &&
        ck.stepIndex > rawTurns[ownerIdx].stepStartIndex &&
        rawTurns[ownerIdx].steps.some(
          (s) => s.kind === 'planner' && s.stepIndex < ck.stepIndex
        )
          ? 'mid_turn'
          : 'before_turn';
      compactionEventsByTurn[ownerIdx].push({
        index: ck.number,
        number: ck.number,
        stepIndex: ck.stepIndex,
        beforeTokens: ck.beforeTokens,
        afterTokens: ck.afterTokens,
        createdAt: ck.createdAt || null,
        timing,
      });
    }

    const fbSpec = fallbackModel || DEFAULT_MODEL;
    const fbEnum = fbSpec.enums?.[0] || 0;
    const { code: fbCode, placeholder: fbPh } = enumToModelCode(fbEnum);
    const fbProv = resolveApiProviderInfo(0, '', fbSpec.provider);

    const threadLive = Boolean(
      node.timing?.isLiveTicking || node.status === 'working' || node.isGenerating
    );
    const maxDescUpdSec = Number(node._internal?.maxDescendantUpdatedSec) || 0;

    let prevWaterline = 0;
    let prevSoftLimit =
      node.waterline?.softLimit ||
      node.model?.softLimit ||
      fbSpec.softLimit ||
      DEFAULT_SOFT_LIMIT;

    const turns = rawTurns.map((rt, idx) => {
      const isLastTurn = idx === rawTurns.length - 1;
      let inTok = 0;
      let outTok = 0;
      let thinkTok = 0;
      let respTok = 0;
      let crTok = 0;
      let cwTok = 0;
      let genImages = 0;
      let sumOutForTps = 0;
      let sumDtDecode = 0;
      let sumStepDuration = 0;
      const turnStreamTtfts = [];
      const turnFallbackTtfts = [];
      let lastPlannerStep = null;
      let lastAnyStep = null;
      const phaseSet = new Set();

      const modelGroups = new Map();
      let billableStepCount = 0;
      const publicSteps = rt.steps.map((s) => {
        if (s.kind === 'incident') {
          return {
            stepIndex: s.stepIndex,
            kind: 'incident',
            category: s.category,
            summary: s.summary,
            injectedText: s.injectedText,
            retriesRemaining: s.retriesRemaining,
            attempt: s.attempt,
            toolName: s.toolName || '',
            discardedStepIndex: s.discardedStepIndex ?? -1,
            wastedUsd: s.wastedUsd || 0,
            costUsd: 0,
          };
        }

        billableStepCount += 1;
        inTok += s.input || 0;
        outTok += s.output || 0;
        thinkTok += s.thinking || 0;
        respTok += s.response || 0;
        crTok += s.cacheRead || 0;
        cwTok += s.cacheWrite || 0;
        genImages += s.imageCount || 0;
        const sDur = Number(s.durationSec) || 0;
        sumStepDuration += sDur;

        if (s.phase) phaseSet.add(s.phase);

        if (s.kind === 'planner') {
          lastPlannerStep = s;
          if (s.dtDecode > 0 && s.output > 0) {
            sumOutForTps += s.output;
            sumDtDecode += s.dtDecode;
          }
          if (s.ttftSec > 0) {
            if (s.isStreamingTtft) turnStreamTtfts.push(s.ttftSec);
            else turnFallbackTtfts.push(s.ttftSec);
          }
        }
        lastAnyStep = s;

        const mKey = `${s.kind === 'image' ? 'image' : 'llm'}|${s.rawSlug}|${s.code}`;
        let mg = modelGroups.get(mKey);
        if (!mg) {
          mg = {
            kind: s.kind === 'image' ? 'image' : 'llm',
            rawSlug: s.rawSlug,
            code: s.code,
            shortName: s.shortName,
            fullName: s.fullName,
            steps: 0,
            imageCount: 0,
            costUsd: 0,
            isCanary: s.isCanary,
            canaryTag: s.canaryTag,
            canaryReason: s.canaryReason,
          };
          modelGroups.set(mKey, mg);
        } else if (s.isCanary && !mg.isCanary) {
          mg.isCanary = true;
          mg.canaryTag = s.canaryTag;
          mg.canaryReason = s.canaryReason;
        }
        mg.steps += 1;
        mg.imageCount += s.imageCount || 0;
        mg.costUsd += s.exactUsd;

        return {
          stepIndex: s.stepIndex,
          kind: s.kind,
          phase: s.phase || '',
          rawSlug: s.rawSlug,
          code: s.code,
          shortName: s.shortName,
          fullName: s.fullName,
          requestedSlug: s.requestedSlug,
          apiProviderName: s.apiProviderName,
          isCanary: s.isCanary,
          isUnknownModel: s.isUnknownModel,
          wasDiscardedByFilter: Boolean(s.wasDiscardedByFilter),
          canaryTag: s.canaryTag,
          canaryReason: s.canaryReason,
          botId: s.botId,
          responseId: s.responseId,
          traceHash: s.traceHash,
          input: s.input,
          output: s.output,
          thinking: s.thinking,
          response: s.response,
          cacheRead: s.cacheRead,
          imageCount: s.imageCount || 0,
          waterlineTokens: s.waterlineTokens,
          softLimit: s.softLimit || prevSoftLimit,
          decodeTps: s.decodeTps,
          durationSec: sDur,
          ttftSec: s.ttftSec,
          costUsd: s.costUsd,
        };
      });

      const turnCostUsd = round(rt.exactUsd, 6);
      if (billableStepCount > 0) {
        const sumStepRounded = round(
          publicSteps.reduce((acc, s) => acc + (s.kind === 'incident' ? 0 : s.costUsd), 0),
          6
        );
        const stepDiff = round(turnCostUsd - sumStepRounded, 6);
        if (Math.abs(stepDiff) > 0 && Math.abs(stepDiff) <= 0.001) {
          for (let j = publicSteps.length - 1; j >= 0; j--) {
            if (publicSteps[j].kind !== 'incident' && publicSteps[j].costUsd + stepDiff >= 0) {
              publicSteps[j].costUsd = round(publicSteps[j].costUsd + stepDiff, 6);
              break;
            }
          }
        }
      }

      const ckEvents = compactionEventsByTurn[idx];
      const ckEvent = ckEvents.length > 0 ? ckEvents[ckEvents.length - 1] : null;

      let waterlineTokens = prevWaterline;
      if (
        ckEvent &&
        (!lastPlannerStep || ckEvent.stepIndex > lastPlannerStep.stepIndex)
      ) {
        waterlineTokens = ckEvent.afterTokens || 18_000;
      } else if (lastPlannerStep) {
        waterlineTokens = lastPlannerStep.waterlineTokens;
      } else if (lastAnyStep && lastAnyStep.waterlineTokens > 0) {
        waterlineTokens = lastAnyStep.waterlineTokens;
      }
      prevWaterline = waterlineTokens;

      const turnSoftLimit =
        lastPlannerStep?.softLimit ||
        lastAnyStep?.softLimit ||
        prevSoftLimit;
      if (turnSoftLimit > 0) {
        prevSoftLimit = turnSoftLimit;
      }

      const canaryPlannerSteps = rt.steps.filter(
        (s) => s.kind === 'planner' && s.isCanary
      );
      const canaryAnySteps = rt.steps.filter((s) => s.isCanary);
      const turnIsCanary =
        canaryAnySteps.length > 0 || Boolean(rt.liveRouting?.isCanary && rt.steps.length === 0);

      const rep =
        (canaryPlannerSteps.length > 0
          ? canaryPlannerSteps[canaryPlannerSteps.length - 1]
          : canaryAnySteps.length > 0
            ? canaryAnySteps[canaryAnySteps.length - 1]
            : lastPlannerStep || lastAnyStep || rt.liveRouting) || {
          slug: node.model?.slug || fbSpec.slug,
          rawSlug: node.model?.rawSlug || fbSpec.rawSlug || fbSpec.slug,
          code: node.model?.code || fbCode || '',
          placeholder: node.model?.placeholder || fbPh || '',
          shortName: node.model?.shortName || fbSpec.shortName,
          fullName: node.model?.fullName || fbSpec.fullName,
          requestedSlug: node.model?.desiredSlug || '',
          requestedEnum: 0,
          respondedEnum: 0,
          apiProvider: node.model?.apiProvider || fbProv.apiProvider,
          apiProviderName: node.model?.apiProviderName || fbProv.apiProviderName,
          isCanary: false,
          isUnknownModel: Boolean(fbSpec.isUnknownModel),
          canaryTag: '',
          canaryReason: '',
          botId: '',
          responseId: '',
          traceHash: '',
        };

      const distinctModels = Array.from(modelGroups.values()).map((mg) => ({
        ...mg,
        costUsd: round(mg.costUsd, 6),
      }));

      const denom = inTok + crTok;
      const cacheHitRatio = denom > 0 ? round(crTok / denom, 4) : 0;
      const decode = sumDtDecode > 0 ? round(sumOutForTps / sumDtDecode, 1) : 0;
      const turnTtftPool =
        turnStreamTtfts.length > 0 ? turnStreamTtfts : turnFallbackTtfts;
      const ttftSec =
        turnTtftPool.length > 0
          ? round(
              turnTtftPool.reduce((acc, v) => acc + v, 0) / turnTtftPool.length,
              2
            )
          : 0;

      const isLive = Boolean(rt.isGenerating || (isLastTurn && threadLive));
      const llmDurationSec = round(
        sumStepDuration +
          (rt.isGenerating && (node.generatingElapsedSec || 0) > 0
            ? node.generatingElapsedSec
            : 0),
        2
      );
      const tStartSec = rt.createdSec || 0;
      let tEndSec = Math.max(rt.maxTimeSec || 0, tStartSec);
      if (isLastTurn && maxDescUpdSec > tEndSec && tStartSec > 0) {
        tEndSec = maxDescUpdSec;
      }

      // Compute active-span duration excluding long idle sleep gaps across `101` wakeups
      let activeWallSec = 0;
      if (typeof rt.accumulatedSpanSec === 'number') {
        const curSpanStart = rt.curSpanStartSec || 0;
        const curSpanEnd =
          isLastTurn && maxDescUpdSec > (rt.curSpanEndSec || 0)
            ? maxDescUpdSec
            : rt.curSpanEndSec || 0;
        const curSpanSec =
          curSpanStart > 0 && curSpanEnd >= curSpanStart
            ? curSpanEnd - curSpanStart
            : 0;
        const liveExtra =
          isLive && curSpanStart > 0
            ? Math.max(curSpanSec, Math.max(0, Date.now() / 1000 - curSpanStart))
            : curSpanSec;
        activeWallSec = rt.accumulatedSpanSec + liveExtra;
      } else {
        const rawSpan =
          tStartSec > 0 && tEndSec >= tStartSec ? tEndSec - tStartSec : 0;
        activeWallSec =
          isLive && tStartSec > 0
            ? Math.max(rawSpan, Math.max(0, Date.now() / 1000 - tStartSec))
            : rawSpan;
      }

      const baseTurnWallSec = Math.max(
        llmDurationSec,
        activeWallSec,
        isLive ? node.generatingElapsedSec || 0 : 0
      );
      const durationSec = round(baseTurnWallSec, isLive ? 1 : 2);
      const wallSpanSec =
        tStartSec > 0 && tEndSec >= tStartSec ? round(tEndSec - tStartSec, 1) : durationSec;

      const createdAt =
        rt.createdSec > 0 ? new Date(rt.createdSec * 1000).toISOString() : null;
      const updatedAtMs =
        tEndSec > 0 ? Math.round(tEndSec * 1000) : node.updatedAtMs || 0;

      return {
        turnNumber: idx + 1,
        stepStartIndex: rt.stepStartIndex,
        stepEndIndex: rt.stepEndIndex,
        llmStepCount: billableStepCount,
        isGenerating: Boolean(rt.isGenerating),
        isLive,
        durationSec,
        wallSpanSec,
        llmDurationSec,
        createdAt,
        updatedAtMs,
        preview: rt.preview,
        promptText: rt.promptText,
        tokens: {
          input: inTok,
          output: outTok,
          thinking: thinkTok,
          response: respTok,
          cacheRead: crTok,
          cacheWrite: cwTok,
          generatedImages: genImages,
          cacheHitRatio,
        },
        waterlineTokens,
        softLimit: turnSoftLimit,
        tps: {
          decode,
          ttftSec,
        },
        costUsd: turnCostUsd,
        routing: {
          slug: rep.slug || fbSpec.slug,
          rawSlug: rep.rawSlug || rep.slug || fbSpec.slug,
          code: rep.code || '',
          placeholder: rep.placeholder || '',
          shortName: rep.shortName || fbSpec.shortName,
          fullName: rep.fullName || fbSpec.fullName,
          requestedSlug: rep.requestedSlug || '',
          requestedEnum: rep.requestedEnum || 0,
          respondedEnum: rep.respondedEnum || 0,
          apiProvider: rep.apiProvider || 0,
          apiProviderName: rep.apiProviderName || '',
          isCanary: turnIsCanary,
          isUnknownModel: Boolean(rep.isUnknownModel),
          canaryTag: turnIsCanary ? rep.canaryTag || '' : '',
          canaryReason: turnIsCanary ? rep.canaryReason || '' : '',
          phases: Array.from(phaseSet),
          distinctModels,
          botId: rep.botId || '',
          responseId: rep.responseId || '',
          traceHash: rep.traceHash || '',
        },
        error: rt.error || null,
        incidents: Array.isArray(rt.incidents) ? rt.incidents : [],
        compactedBefore: Boolean(ckEvent),
        compactionEvent: ckEvent,
        steps: publicSteps,
      };
    });

    const targetSelfUsd = round(Number(node.cost?.selfUsd) || 0, 6);
    const sumTurnsUsd = round(
      turns.reduce((acc, t) => acc + t.costUsd, 0),
      6
    );
    const totalDiff = round(targetSelfUsd - sumTurnsUsd, 6);
    if (Math.abs(totalDiff) > 0 && Math.abs(totalDiff) <= 0.002 && turns.length > 0) {
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].costUsd + totalDiff >= 0 && turns[i].llmStepCount > 0) {
          turns[i].costUsd = round(turns[i].costUsd + totalDiff, 6);
          for (let k = turns[i].steps.length - 1; k >= 0; k--) {
            const stItem = turns[i].steps[k];
            if (stItem && stItem.kind !== 'incident' && stItem.costUsd + totalDiff >= 0) {
              stItem.costUsd = round(stItem.costUsd + totalDiff, 6);
              break;
            }
          }
          break;
        }
      }
    }

    const canaryTurnCount = turns.reduce(
      (acc, t) => acc + (t.routing.isCanary ? 1 : 0),
      0
    );
    const issueTurnCount = turns.reduce(
      (acc, t) => acc + (t.incidents.length > 0 || t.error ? 1 : 0),
      0
    );

    return {
      turns,
      turnSummary: {
        totalTurns: turns.length,
        canaryTurnCount,
        issueTurnCount,
      },
    };
  }

  function buildThreadTurns(
    convId,
    preferredDir,
    node,
    hintModelSlug = '',
    desiredHintSlug = ''
  ) {
    const dbPath = discovery.findConvFile(convId, preferredDir, join('conversations', `${convId}.db`));
    const tPath = discovery.findConvFile(
      convId,
      preferredDir,
      join('brain', convId, '.system_generated', 'logs', 'transcript.jsonl')
    );
    const dbSig = dbPath ? dbWalSig(dbPath) || '0' : 'none';
    const jsonlSig = tPath ? fileSig(tPath) : 'none';
    const threadIsLive = Boolean(
      node.timing?.isLiveTicking || node.status === 'working' || node.isGenerating
    );
    const minStepIdx = Math.max(0, Number(node._internal?.minStepIdx) || 0);
    const cacheKey = `v9|${minStepIdx}|${dbSig}|${jsonlSig}|${pricing.overrideSig}|${hintModelSlug}|${desiredHintSlug}|${node.cost.selfUsd}|${node.tokens.input}|${node.tokens.output}|${node.tokens.generatedImages || 0}|${node.waterline?.softLimit || 0}`;

    const cached = !threadIsLive ? turnLedgerCache.get(convId) : null;
    if (cached && cached.cacheKey === cacheKey) {
      return { turns: cached.turns, turnSummary: cached.turnSummary };
    }

    const trimmedHint = String(hintModelSlug || '').trim();
    const fallbackModel = trimmedHint
      ? pricing.resolveModelBySlugOrText(trimmedHint, 0) ||
        pricing.synthesizeUnknownModelSpec({
          enumId: 0,
          rawSlug: trimmedHint,
          displayName: '',
          apiProvider: 0,
        })
      : pricing.readGlobalDefaultModel();

    const compactionRecords = node._internal?.compactionRecords || [];

    const buildTurnsFromJsonlFallback = (floorIdx = minStepIdx) => {
      const jsonl = metrics.getJsonlUsageFallbackAndTotal(
        convId,
        preferredDir,
        fallbackModel,
        floorIdx
      );
      if (!jsonl || jsonl.canonicalSteps.length === 0) {
        return null;
      }

      const promptMap = readJsonlPromptMap(tPath);
      const promptEntries = Array.from(promptMap.entries())
        .filter(([pIdx]) => pIdx >= floorIdx)
        .sort((a, b) => a[0] - b[0]);
      const has14 = promptEntries.some(([, v]) => v.stepType === 14);
      const triggers = promptEntries.filter(([, v]) =>
        has14 ? v.stepType === 14 : v.stepType === 101
      );

      const m = fallbackModel || DEFAULT_MODEL;
      const enumId = m.enums?.[0] || 0;
      const { code, placeholder } = enumToModelCode(enumId);
      const rawSlug = trimmedHint || m.rawSlug || m.slug;
      const desiredSlug = desiredHintSlug || '';
      const sessionIsOrch = isOrchestratorSlug(rawSlug) || isOrchestratorSlug(desiredSlug) || isOrchestratorEnum(enumId);
      const baseCanary = detectCanaryRouting({
        rawSlug,
        desiredSlug,
        requestedEnum: 0,
        respondedEnum: 0,
        sessionIsOrchestrator: sessionIsOrch,
      });
      const isUnknown = Boolean(m.isUnknownModel);
      const stepIsCanary = Boolean(baseCanary.isCanaryRouted || isUnknown);
      const stepCanaryTag =
        baseCanary.canaryTag || (isUnknown ? code || 'new' : '');
      const stepCanaryReason =
        baseCanary.canaryReason || (isUnknown ? 'unknown_model' : '');
      const prov = resolveApiProviderInfo(0, '', m.provider);

      const rawTurns = [];
      if (triggers.length === 0) {
        const cl = cleanTurnPrompt(node.title || '', { fallbackLabel: '会话执行' });
        rawTurns.push({
          stepStartIndex: jsonl.canonicalSteps[0].idx,
          stepEndIndex: jsonl.canonicalSteps[jsonl.canonicalSteps.length - 1].idx,
          createdSec: jsonl.canonicalSteps[0].stepTimeSec || 0,
          maxTimeSec: 0,
          preview: cl.preview,
          promptText: cl.promptText,
          steps: [],
          exactUsd: 0,
        });
      } else {
        for (const [pIdx, pVal] of triggers) {
          const cl = cleanTurnPrompt(pVal.content, {
            isSystem: pVal.stepType === 101,
            hasMedia: pVal.hasMedia,
          });
          if (cl.kindHint === 'btw_marker') continue;
          if (
            !has14 &&
            rawTurns.length > 0 &&
            rawTurns[rawTurns.length - 1].steps.length === 0
          ) {
            const prev = rawTurns[rawTurns.length - 1];
            const best = pickBetterSystemPrompt(prev, cl);
            prev.preview = best.preview;
            prev.promptText = best.promptText;
            prev.stepEndIndex = pIdx;
          } else {
            rawTurns.push({
              stepStartIndex: pIdx,
              stepEndIndex: pIdx,
              createdSec: pVal.createdSec || 0,
              maxTimeSec: pVal.createdSec || 0,
              preview: cl.preview,
              promptText: cl.promptText,
              steps: [],
              exactUsd: 0,
            });
          }
        }
      }

      for (const st of jsonl.canonicalSteps) {
        let target = rawTurns[0];
        for (let i = rawTurns.length - 1; i >= 0; i--) {
          if (st.idx >= rawTurns[i].stepStartIndex) {
            target = rawTurns[i];
            break;
          }
        }
        target.stepStartIndex = Math.min(target.stepStartIndex, st.idx);
        target.stepEndIndex = Math.max(target.stepEndIndex, st.idx);
        if (!target.createdSec && st.stepTimeSec) target.createdSec = st.stepTimeSec;
        if (st.stepTimeSec > target.maxTimeSec) target.maxTimeSec = st.stepTimeSec;

        const inp = st.inputTokens || 0;
        const cr = st.cacheReadTokens || 0;
        const out = st.outputTokens || 0;
        const rates = pricing.resolveStepRates(m, st.stepTimeSec || 0, inp + cr);
        const exactUsd =
          (inp * rates.inputRate + cr * rates.cacheRate + out * rates.outputRate) /
          1_000_000;
        target.exactUsd += exactUsd;
        target.steps.push({
          stepIndex: st.idx,
          kind: st.stepType === 23 ? 'checkpoint' : 'planner',
          phase: '',
          slug: m.slug,
          rawSlug,
          code: code || (m.placeholders?.[0]?.replace('MODEL_PLACEHOLDER_', '') || ''),
          placeholder: placeholder || m.placeholders?.[0] || '',
          shortName: m.shortName,
          fullName: m.fullName,
          requestedSlug: desiredSlug,
          requestedEnum: 0,
          respondedEnum: 0,
          apiProvider: prov.apiProvider,
          apiProviderName: prov.apiProviderName,
          isCanary: stepIsCanary,
          isUnknownModel: isUnknown,
          canaryTag: stepCanaryTag,
          canaryReason: stepCanaryReason,
          botId: '',
          responseId: '',
          traceHash: '',
          input: inp,
          output: out,
          thinking: 0,
          response: out,
          cacheRead: cr,
          cacheWrite: 0,
          imageCount: 0,
          waterlineTokens: inp + cr + out,
          softLimit: node.waterline?.softLimit || m.softLimit || DEFAULT_SOFT_LIMIT,
          decodeTps: 0,
          dtDecode: 0,
          durationSec: 0,
          ttftSec: 0,
          isStreamingTtft: false,
          exactUsd,
          costUsd: round(exactUsd, 6),
        });
      }

      return finalizeTurnList(rawTurns, compactionRecords, node, fallbackModel);
    };

    if (!dbPath) {
      const finalized = buildTurnsFromJsonlFallback() || {
        turns: [],
        turnSummary: { totalTurns: 0, canaryTurnCount: 0 },
      };
      turnLedgerCache.set(convId, { cacheKey, ...finalized });
      if (finalized.turns.length > 0) {
        lastGoodTurnsCache.set(convId, {
          ...finalized,
          input: node.tokens?.input || 0,
          output: node.tokens?.output || 0,
          cacheRead: node.tokens?.cacheRead || 0,
          selfUsd: node.cost?.selfUsd || 0,
        });
      }
      return finalized;
    }

    let db = null;
    try {
      db = openReadOnlyDb(dbPath);
      const genIndex = metrics.getCachedGenIndex(convId) || metrics.loadGenMetadataIndex(db);
      const dbBtw = metrics.detectBtwBranchFromDb?.(db);
      const effectiveMinStepIdx = Math.max(minStepIdx, dbBtw?.minStepIdx || 0);

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

      const hasUserInputs = stepRows.some((r) => Number(r.step_type) === 14);
      const triggerType = hasUserInputs ? 14 : 101;
      const payloadRows = db
        .prepare(
          `SELECT idx, step_type, step_payload
           FROM steps
           WHERE idx >= ? AND step_type IN (14, 101)
           ORDER BY idx ASC`
        )
        .all(effectiveMinStepIdx);

      const payloadMap = new Map();
      for (const pr of payloadRows) {
        payloadMap.set(Number(pr.idx), pr.step_payload);
      }

      let jsonlPromptMap = null;
      const getFallbackJsonlPrompt = (idx) => {
        if (!jsonlPromptMap) {
          jsonlPromptMap = readJsonlPromptMap(tPath);
        }
        return jsonlPromptMap.get(idx) || null;
      };

      const effectiveDesiredHint = desiredHintSlug || trimmedHint;
      const hintSpec = effectiveDesiredHint
        ? pricing.resolveModelBySlugOrText(effectiveDesiredHint, 0)
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
          effectiveDesiredHint &&
          (checkEnum === 0 || hintEnums.size === 0 || hintEnums.has(checkEnum))
        ) {
          return effectiveDesiredHint;
        }
        return '';
      };

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

      let runningStepSoftLimit = 0;
      let runningModelSpec =
        genIndex.latestRecord?.modelSpec || fallbackModel || DEFAULT_MODEL;

      const resolveStepModel = (meta, gmRec) => {
        const apiProv = meta.usage?.apiProvider || 0;
        if (gmRec?.modelSpec) {
          if (
            gmRec.modelSpec.isUnknownModel &&
            apiProv === 26 &&
            gmRec.modelSpec.provider === 'unknown'
          ) {
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
          runningModelSpec ||
          genIndex.latestRecord?.modelSpec ||
          fallbackModel ||
          DEFAULT_MODEL
        );
      };

      const maxStepIdx =
        stepRows.length > 0 ? Number(stepRows[stepRows.length - 1].idx) : -1;

      let sessionIsOrchestrator =
        Boolean(node.model?.isOrchestrator) ||
        isOrchestratorSlug(genIndex.sessionDesiredSlug) ||
        isOrchestratorSlug(effectiveDesiredHint);
      const parsedMetas = new Array(stepRows.length);
      for (let i = 0; i < stepRows.length; i++) {
        const m = parseStepMetadata(stepRows[i].metadata);
        parsedMetas[i] = m;
        if (!sessionIsOrchestrator) {
          if (isOrchestratorEnum(m.requestedEnum) || isOrchestratorEnum(m.respondedEnum)) {
            sessionIsOrchestrator = true;
          }
        }
      }

      const rawTurns = [];
      let currentTurn = null;
      let preInputTurn = null;
      let inPlanReview = false;
      let sawExecuteStep = false;
      let lastCompletedPlannerStepRef = null;

      const ISSUE_PRIORITY = {
        safety_filter: 5,
        quota_429: 4,
        server_injection: 3,
        upstream_retry: 2,
        tool_error: 1,
      };

      const makeTurnObj = ({ idx, createdSec, maxTimeSec, preview, promptText }) => ({
        stepStartIndex: idx,
        stepEndIndex: idx,
        createdSec: createdSec || 0,
        maxTimeSec: Math.max(createdSec || 0, maxTimeSec || 0),
        accumulatedSpanSec: 0,
        curSpanStartSec: createdSec || maxTimeSec || 0,
        curSpanEndSec: Math.max(createdSec || 0, maxTimeSec || 0),
        preview,
        promptText,
        steps: [],
        incidents: [],
        exactUsd: 0,
        isGenerating: false,
        liveRouting: null,
        error: null,
      });

      const recordTurnIncident = (target, inc, pushInlineStep = true) => {
        if (!target || !inc) return;
        target.incidents.push(inc);
        const prevCat = target.error?.category || '';
        const prevPri = ISSUE_PRIORITY[prevCat] || 0;
        const nextPri = ISSUE_PRIORITY[inc.category] || 0;
        const pickedCategory = nextPri >= prevPri ? inc.category : prevCat;
        const pickedMsg = nextPri >= prevPri ? inc.summary : target.error?.message || inc.summary;
        target.error = {
          count: target.incidents.length,
          category: pickedCategory,
          hasQuotaError: Boolean(target.error?.hasQuotaError || inc.category === 'quota_429'),
          hasSafetyFilter: Boolean(target.error?.hasSafetyFilter || inc.category === 'safety_filter'),
          wastedUsd: round((target.error?.wastedUsd || 0) + (inc.wastedUsd || 0), 6),
          retriesRemaining:
            inc.retriesRemaining != null ? inc.retriesRemaining : target.error?.retriesRemaining ?? null,
          attempt: inc.attempt != null ? inc.attempt : target.error?.attempt ?? null,
          message: pickedMsg || '执行遇到错误',
        };
        if (pushInlineStep) {
          target.steps.push({
            stepIndex: inc.stepIndex,
            kind: 'incident',
            category: inc.category,
            summary: inc.summary,
            injectedText: inc.injectedText,
            retriesRemaining: inc.retriesRemaining,
            attempt: inc.attempt,
            toolName: inc.toolName || '',
            discardedStepIndex: inc.discardedStepIndex ?? -1,
            wastedUsd: inc.wastedUsd || 0,
            exactUsd: 0,
            costUsd: 0,
          });
        }
      };

      const extendTurnSpan = (turn, tStart, tEnd) => {
        if (!turn) return;
        const s = tStart || tEnd || 0;
        const e = Math.max(s, tEnd || s);
        if (!turn.curSpanStartSec && s > 0) turn.curSpanStartSec = s;
        if (e > turn.curSpanEndSec) turn.curSpanEndSec = e;
        if (e > turn.maxTimeSec) turn.maxTimeSec = e;
      };

      const ensureTargetTurn = (idx, timeSec) => {
        if (currentTurn) return currentTurn;
        if (!preInputTurn) {
          const cl = cleanTurnPrompt(node.title || '', {
            fallbackLabel: '会话执行',
          });
          preInputTurn = makeTurnObj({
            idx,
            createdSec: timeSec || 0,
            maxTimeSec: timeSec || 0,
            preview: cl.preview,
            promptText: cl.promptText,
          });
        }
        return preInputTurn;
      };

      for (let rIdx = 0; rIdx < stepRows.length; rIdx++) {
        const row = stepRows[rIdx];
        const idx = Number(row.idx);
        const stepType = Number(row.step_type);
        const status = Number(row.status);
        const meta = parsedMetas[rIdx];
        const rowMaxTime = Math.max(meta.t7 || 0, meta.t6 || 0, meta.t1 || 0);

        if (stepType === 17) {
          const errInfo = parseErrorStepSlice(row.payload_slice);
          if (errInfo.ignored) continue;

          const target = ensureTargetTurn(idx, meta.t1 || rowMaxTime);
          target.stepEndIndex = Math.max(target.stepEndIndex, idx);
          extendTurnSpan(target, meta.t1, rowMaxTime);

          const incCat = errInfo.category || 'upstream_retry';
          let discardedStepIndex = -1;
          let wastedUsd = 0;
          const canClaimDiscard =
            incCat === 'safety_filter' ||
            incCat === 'server_injection' ||
            (incCat === 'upstream_retry' && /interrupted/i.test(errInfo.fullText || errInfo.message));
          if (
            canClaimDiscard &&
            lastCompletedPlannerStepRef &&
            idx - lastCompletedPlannerStepRef.stepIndex <= 3
          ) {
            lastCompletedPlannerStepRef.wasDiscardedByFilter = true;
            discardedStepIndex = lastCompletedPlannerStepRef.stepIndex;
            wastedUsd = round(lastCompletedPlannerStepRef.exactUsd || 0, 6);
            lastCompletedPlannerStepRef = null;
          }

          recordTurnIncident(target, {
            stepIndex: idx,
            category: incCat,
            timestampSec: rowMaxTime || meta.t1 || 0,
            summary: errInfo.message || '执行遇到错误',
            injectedText: errInfo.fullText || errInfo.message || '执行遇到错误',
            retriesRemaining: errInfo.retriesRemaining,
            attempt: errInfo.attempt,
            toolName: '',
            discardedStepIndex,
            wastedUsd,
          });
          continue;
        }

        if (stepType === triggerType) {
          const ext = extractPromptFromStepPayload(payloadMap.get(idx), stepType);
          let rawText = ext.rawText;
          let hasMedia = ext.hasMedia;
          let createdSec = meta.t1 || ext.createdSec || 0;

          if (!rawText && !hasMedia) {
            const fb = getFallbackJsonlPrompt(idx);
            if (fb) {
              rawText = fb.content;
              hasMedia = fb.hasMedia;
              if (!createdSec && fb.createdSec) createdSec = fb.createdSec;
            }
          }

          const cl = cleanTurnPrompt(rawText, {
            isSystem: stepType === 101,
            hasMedia,
          });
          if (cl.kindHint === 'btw_marker') {
            continue;
          }

          if (stepType === 101) {
            if (cl.kindHint === 'plan_review') inPlanReview = true;
            else if (/^Plan mode is off\b/i.test(rawText.trim())) inPlanReview = false;
          } else {
            inPlanReview = false;
            sawExecuteStep = false;
            lastCompletedPlannerStepRef = null;
          }

          if (
            stepType === 101 &&
            currentTurn &&
            currentTurn.steps.length === 0 &&
            !currentTurn.isGenerating
          ) {
            const best = pickBetterSystemPrompt(currentTurn, cl);
            currentTurn.preview = best.preview;
            currentTurn.promptText = best.promptText;
            currentTurn.stepEndIndex = Math.max(currentTurn.stepEndIndex, idx);
            const tStart = createdSec || rowMaxTime || 0;
            if (
              tStart > 0 &&
              currentTurn.curSpanStartSec > 0 &&
              currentTurn.curSpanEndSec > 0 &&
              tStart - currentTurn.curSpanEndSec > IDLE_WAKEUP_GAP_SEC
            ) {
              currentTurn.curSpanStartSec = tStart;
              currentTurn.curSpanEndSec = Math.max(tStart, rowMaxTime);
            } else {
              extendTurnSpan(currentTurn, tStart, rowMaxTime);
            }
            continue;
          }

          if (rawTurns.length === 0 && preInputTurn) {
            preInputTurn.preview = cl.preview;
            preInputTurn.promptText = cl.promptText;
            preInputTurn.stepStartIndex = Math.min(preInputTurn.stepStartIndex, idx);
            preInputTurn.stepEndIndex = Math.max(preInputTurn.stepEndIndex, idx);
            if (!preInputTurn.createdSec && createdSec) {
              preInputTurn.createdSec = createdSec;
            }
            extendTurnSpan(preInputTurn, createdSec, rowMaxTime);
            currentTurn = preInputTurn;
            preInputTurn = null;
            rawTurns.push(currentTurn);
          } else {
            currentTurn = makeTurnObj({
              idx,
              createdSec,
              maxTimeSec: Math.max(createdSec, rowMaxTime),
              preview: cl.preview,
              promptText: cl.promptText,
            });
            rawTurns.push(currentTurn);
          }
          if (stepType === 101) {
            const sysInj = detectSystemInjection101(payloadMap.get(idx) || row.payload_slice || rawText);
            if (sysInj && currentTurn) {
              recordTurnIncident(currentTurn, {
                stepIndex: idx,
                category: 'server_injection',
                timestampSec: createdSec || rowMaxTime || 0,
                summary: sysInj.message,
                injectedText: sysInj.fullText || sysInj.message,
                retriesRemaining: null,
                attempt: null,
                toolName: '',
                discardedStepIndex: -1,
                wastedUsd: 0,
              });
            }
          }
          continue;
        }

        // Handle hidden `SYSTEM_MESSAGE` (`101`) inside a `USER_INPUT` (`14`) turn:
        // detect `[plan review]` / `Plan mode is off` and exclude long sleep gaps!
        if (stepType === 101 && triggerType === 14) {
          const ext = extractPromptFromStepPayload(payloadMap.get(idx), 101);
          const trimmedRaw = (ext.rawText || '').trim();
          const cl = cleanTurnPrompt(ext.rawText, { isSystem: true });
          if (cl.kindHint === 'btw_marker') {
            continue;
          }
          if (cl.kindHint === 'plan_review') {
            inPlanReview = true;
          } else if (/^Plan mode is off\b/i.test(trimmedRaw)) {
            inPlanReview = false;
          }

          const tStart = meta.t1 || ext.createdSec || rowMaxTime || 0;
          if (currentTurn) {
            currentTurn.stepEndIndex = Math.max(currentTurn.stepEndIndex, idx);
            if (
              tStart > 0 &&
              currentTurn.curSpanStartSec > 0 &&
              currentTurn.curSpanEndSec >= currentTurn.curSpanStartSec &&
              tStart - currentTurn.curSpanEndSec > IDLE_WAKEUP_GAP_SEC
            ) {
              currentTurn.accumulatedSpanSec +=
                currentTurn.curSpanEndSec - currentTurn.curSpanStartSec;
              currentTurn.curSpanStartSec = tStart;
              currentTurn.curSpanEndSec = Math.max(tStart, rowMaxTime);
            } else {
              extendTurnSpan(currentTurn, tStart, rowMaxTime);
            }
            const sysInj = detectSystemInjection101(payloadMap.get(idx) || row.payload_slice || ext.rawText);
            if (sysInj) {
              recordTurnIncident(currentTurn, {
                stepIndex: idx,
                category: 'server_injection',
                timestampSec: tStart || rowMaxTime || 0,
                summary: sysInj.message,
                injectedText: sysInj.fullText || sysInj.message,
                retriesRemaining: null,
                attempt: null,
                toolName: '',
                discardedStepIndex: -1,
                wastedUsd: 0,
              });
            }
          }
          continue;
        }

        // Failed/rejected tool call (`step_type = 132`, `status = 6|7`) or completed `generate_image`
        if (stepType === 132) {
          if (status === 6 || status === 7) {
            const tf = parseToolFailureSlice(row.payload_slice, status);
            const target = ensureTargetTurn(idx, meta.t1 || rowMaxTime);
            target.stepStartIndex = Math.min(target.stepStartIndex, idx);
            target.stepEndIndex = Math.max(target.stepEndIndex, idx);
            if (!target.createdSec && meta.t1) target.createdSec = meta.t1;
            extendTurnSpan(target, meta.t1, rowMaxTime);
            recordTurnIncident(target, {
              stepIndex: idx,
              category: 'tool_error',
              timestampSec: rowMaxTime || meta.t1 || 0,
              summary: tf.message,
              injectedText: tf.message,
              retriesRemaining: null,
              attempt: null,
              toolName: tf.toolName,
              discardedStepIndex: -1,
              wastedUsd: 0,
            });
            continue;
          }
          const isCompleted = status === 3 || status === 5;
          if (!isCompleted) continue;
          const imgInfo = parseImageGenStepSlice(row.payload_slice);
          if (!imgInfo.modelSlug && !imgInfo.hasOutputFile) continue;

          const target = ensureTargetTurn(idx, meta.t1 || rowMaxTime);
          target.stepStartIndex = Math.min(target.stepStartIndex, idx);
          target.stepEndIndex = Math.max(target.stepEndIndex, idx);
          if (!target.createdSec && meta.t1) target.createdSec = meta.t1;
          extendTurnSpan(target, meta.t1, rowMaxTime);

          const stepTimeSec = meta.t1 || meta.t6 || meta.t7 || 0;
          const { spec: imgSpec, perImageUsd } = pricing.resolveImageStepRate(
            imgInfo.modelSlug,
            stepTimeSec
          );
          const stTiming = metrics.computeStepTimingAndTps(meta, 0, 0, 132);
          target.exactUsd += perImageUsd;
          target.steps.push({
            stepIndex: idx,
            kind: 'image',
            phase: '',
            slug: imgSpec.slug,
            rawSlug: imgInfo.modelSlug || imgSpec.slug,
            code: '',
            placeholder: '',
            shortName: imgSpec.shortName,
            fullName: imgSpec.fullName,
            requestedSlug: '',
            requestedEnum: 0,
            respondedEnum: 0,
            apiProvider: 24,
            apiProviderName: 'google-cloudcode',
            isCanary: false,
            isUnknownModel: false,
            canaryTag: '',
            canaryReason: '',
            botId: '',
            responseId: '',
            traceHash: '',
            input: 0,
            output: 0,
            thinking: 0,
            response: 0,
            cacheRead: 0,
            cacheWrite: 0,
            imageCount: 1,
            waterlineTokens: 0,
            softLimit: runningStepSoftLimit || node.waterline?.softLimit || DEFAULT_SOFT_LIMIT,
            decodeTps: 0,
            dtDecode: 0,
            durationSec: stTiming.durationSec,
            ttftSec: 0,
            isStreamingTtft: false,
            exactUsd: perImageUsd,
            costUsd: round(perImageUsd, 6),
          });
          continue;
        }

        // Active live streaming step (`idx === maxStepIdx`)
        if (
          idx === maxStepIdx &&
          (status === 8 || (stepType === 15 && (status === 1 || status === 2)))
        ) {
          const gmRec = lookupGenRecord(meta);
          const target = ensureTargetTurn(idx, meta.t1 || meta.t6 || 0);
          target.stepEndIndex = Math.max(target.stepEndIndex, idx);
          extendTurnSpan(target, meta.t1 || meta.t6, rowMaxTime);
          if (node.isGenerating) {
            target.isGenerating = true;
          }
          if (meta.modelEnum || gmRec) {
            const liveModel = resolveStepModel(meta, gmRec);
            runningModelSpec = liveModel;
            const liveEnum =
              meta.respondedEnum ||
              meta.requestedEnum ||
              gmRec?.enumId ||
              liveModel.enums?.[0] ||
              0;
            const { code: lCode, placeholder: lPh } = enumToModelCode(liveEnum);
            const lRaw = gmRec?.rawSlug || liveModel.rawSlug || liveModel.slug;
            const lDes = resolveScopedDesiredSlug(gmRec, meta.requestedEnum, liveEnum);
            const lIsOrch = Boolean(
              sessionIsOrchestrator ||
                isOrchestratorSlug(lDes) ||
                isOrchestratorEnum(meta.requestedEnum)
            );
            const lCanary = detectCanaryRouting({
              rawSlug: lRaw,
              desiredSlug: lDes,
              requestedEnum: meta.requestedEnum || 0,
              respondedEnum: meta.respondedEnum || 0,
              sessionIsOrchestrator: lIsOrch,
            });
            const lUnknown = Boolean(liveModel.isUnknownModel);
            const lProv = resolveApiProviderInfo(
              meta.usage?.apiProvider || 0,
              meta.usage?.responseId || gmRec?.responseId || '',
              liveModel.provider
            );
            target.liveRouting = {
              slug: liveModel.slug,
              rawSlug: lRaw,
              code:
                lCode ||
                (liveModel.placeholders?.[0]?.replace('MODEL_PLACEHOLDER_', '') || ''),
              placeholder: lPh || liveModel.placeholders?.[0] || '',
              shortName: liveModel.shortName,
              fullName: liveModel.fullName,
              requestedSlug: lDes,
              requestedEnum: meta.requestedEnum || 0,
              respondedEnum: meta.respondedEnum || 0,
              apiProvider: lProv.apiProvider,
              apiProviderName: lProv.apiProviderName,
              isCanary: Boolean(lCanary.isCanaryRouted || lUnknown),
              isUnknownModel: lUnknown,
              canaryTag: lCanary.canaryTag || (lUnknown ? lCode || 'new' : ''),
              canaryReason:
                lCanary.canaryReason || (lUnknown ? 'unknown_model' : ''),
              botId: meta.usage?.botId || gmRec?.botId || '',
              responseId: meta.usage?.responseId || gmRec?.responseId || '',
              traceHash: gmRec?.traceHash || '',
            };
          }
          continue;
        }

        const isCompleted = status === 3 || status === 5;
        if (!isCompleted) continue;
        if (stepType !== 15 && stepType !== 23) continue;

        const gmRec = lookupGenRecord(meta);
        const stepModel = resolveStepModel(meta, gmRec);
        if (stepType === 15) {
          runningModelSpec = stepModel;
        }
        const u = meta.usage;
        if (!u) {
          if (currentTurn) {
            currentTurn.stepEndIndex = Math.max(currentTurn.stepEndIndex, idx);
            extendTurnSpan(currentTurn, meta.t1, rowMaxTime);
          }
          continue;
        }

        const target = ensureTargetTurn(idx, meta.t1 || rowMaxTime);
        target.stepStartIndex = Math.min(target.stepStartIndex, idx);
        target.stepEndIndex = Math.max(target.stepEndIndex, idx);
        if (!target.createdSec && meta.t1) target.createdSec = meta.t1;
        extendTurnSpan(target, meta.t1, rowMaxTime);

        const stepReqEnum = meta.requestedEnum || 0;
        const stepResEnum = meta.respondedEnum || 0;
        const stepEnumId =
          stepResEnum ||
          stepReqEnum ||
          gmRec?.enumId ||
          stepModel.enums?.[0] ||
          0;
        const { code: stepCode, placeholder: stepPh } = enumToModelCode(stepEnumId);
        const stepRawSlug = gmRec?.rawSlug || stepModel.rawSlug || stepModel.slug;
        const stepDesiredSlug = resolveScopedDesiredSlug(gmRec, stepReqEnum, stepEnumId);
        const stepBotId = u.botId || gmRec?.botId || '';
        const stepResponseId = u.responseId || gmRec?.responseId || '';
        const stepTraceHash = gmRec?.traceHash || '';

        const phase = resolveOrchestratorPhase({
          sessionIsOrchestrator,
          stepSlug: stepRawSlug || stepModel.slug,
          stepEnumId,
          afterPlanReview: inPlanReview || sawExecuteStep,
        });
        if (phase === 'execute') sawExecuteStep = true;

        const isOrchHandoff = Boolean(
          sessionIsOrchestrator ||
            isOrchestratorSlug(stepDesiredSlug) ||
            isOrchestratorEnum(stepReqEnum)
        );
        const canary = detectCanaryRouting({
          rawSlug: stepRawSlug,
          desiredSlug: stepDesiredSlug,
          requestedEnum: stepReqEnum,
          respondedEnum: stepResEnum,
          sessionIsOrchestrator: isOrchHandoff,
        });
        const isUnknown = Boolean(stepModel.isUnknownModel);
        const stepIsCanary = Boolean(canary.isCanaryRouted || isUnknown);
        const stepCanaryTag =
          canary.canaryTag || (isUnknown ? stepCode || 'new' : '');
        const stepCanaryReason =
          canary.canaryReason || (isUnknown ? 'unknown_model' : '');

        const provInfo = resolveApiProviderInfo(
          u.apiProvider || 0,
          stepResponseId,
          stepModel.provider
        );

        const inp = u.inputTokens || 0;
        const out = u.outputTokens || 0;
        const think = u.thinkingTokens || 0;
        const resp = u.responseTokens || 0;
        const cr = u.cacheReadTokens || 0;
        const cw = u.cacheWriteTokens || 0;
        const stepTimeSec = meta.t1 || meta.t6 || meta.t7 || 0;
        const rates = pricing.resolveStepRates(stepModel, stepTimeSec, inp + cr);
        const exactUsd =
          (inp * rates.inputRate + cr * rates.cacheRate + out * rates.outputRate) /
          1_000_000;

        const exactGm = lookupExactStepGenRecord(meta);
        if (exactGm?.maxContextTokens > 0) {
          runningStepSoftLimit = exactGm.maxContextTokens;
        }
        const stepSoftLimit =
          exactGm?.maxContextTokens ||
          runningStepSoftLimit ||
          node.waterline?.softLimit ||
          stepModel.softLimit ||
          DEFAULT_SOFT_LIMIT;
        const stepWaterlineTokens =
          stepType === 15 && exactGm?.estimatedTokensUsed > 0
            ? exactGm.estimatedTokensUsed
            : inp + cr + resp;

        const stTiming = metrics.computeStepTimingAndTps(meta, out, think, stepType);

        target.exactUsd += exactUsd;
        const stepObj = {
          stepIndex: idx,
          kind: stepType === 23 ? 'checkpoint' : 'planner',
          phase,
          slug: stepModel.slug,
          rawSlug: stepRawSlug,
          code:
            stepCode ||
            (stepModel.placeholders?.[0]?.replace('MODEL_PLACEHOLDER_', '') || ''),
          placeholder: stepPh || stepModel.placeholders?.[0] || '',
          shortName: stepModel.shortName,
          fullName: stepModel.fullName,
          requestedSlug: stepDesiredSlug,
          requestedEnum: stepReqEnum,
          respondedEnum: stepResEnum,
          apiProvider: provInfo.apiProvider,
          apiProviderName: provInfo.apiProviderName,
          isCanary: stepIsCanary,
          isUnknownModel: isUnknown,
          wasDiscardedByFilter: false,
          canaryTag: stepCanaryTag,
          canaryReason: stepCanaryReason,
          botId: stepBotId,
          responseId: stepResponseId,
          traceHash: stepTraceHash,
          input: inp,
          output: out,
          thinking: think,
          response: resp,
          cacheRead: cr,
          cacheWrite: cw,
          imageCount: 0,
          waterlineTokens: stepWaterlineTokens,
          softLimit: stepSoftLimit,
          decodeTps: stTiming.decodeTps,
          dtDecode: stTiming.dtDecode,
          durationSec: stTiming.durationSec,
          ttftSec: stTiming.ttftSec,
          isStreamingTtft: stTiming.isStreamingTtft,
          exactUsd,
          costUsd: round(exactUsd, 6),
        };
        target.steps.push(stepObj);
        if (stepType === 15) {
          lastCompletedPlannerStepRef = stepObj;
        }
      }

      if (rawTurns.length === 0 && preInputTurn) {
        rawTurns.push(preInputTurn);
      }

      const finalized = finalizeTurnList(
        rawTurns,
        compactionRecords,
        node,
        fallbackModel
      );
      if (!threadIsLive) {
        turnLedgerCache.set(convId, { cacheKey, ...finalized });
      }
      if (finalized.turns.length > 0) {
        lastGoodTurnsCache.set(convId, {
          ...finalized,
          input: node.tokens?.input || 0,
          output: node.tokens?.output || 0,
          cacheRead: node.tokens?.cacheRead || 0,
          selfUsd: node.cost?.selfUsd || 0,
        });
      }
      return finalized;
    } catch {
      const prevGood = lastGoodTurnsCache.get(convId);
      if (
        prevGood &&
        prevGood.input === (node.tokens?.input || 0) &&
        prevGood.output === (node.tokens?.output || 0) &&
        prevGood.cacheRead === (node.tokens?.cacheRead || 0)
      ) {
        return { turns: prevGood.turns, turnSummary: prevGood.turnSummary };
      }
      if (tPath) {
        const jsonlFallback = buildTurnsFromJsonlFallback();
        if (jsonlFallback && jsonlFallback.turns.length > 0) {
          return jsonlFallback;
        }
      }
      if ((node.tokens?.input || 0) + (node.tokens?.output || 0) > 0) {
        const cl = cleanTurnPrompt(node.title || '', { fallbackLabel: '会话执行' });
        const inp = node.tokens?.input || 0;
        const out = node.tokens?.output || 0;
        const cr = node.tokens?.cacheRead || 0;
        const exactUsd = Number(node.cost?.selfUsd) || 0;
        const mObj = node.model || {};
        const stepCanary = Boolean(mObj.activeStepCanary || mObj.isUnknownModel);
        return finalizeTurnList(
          [
            {
              stepStartIndex: 0,
              stepEndIndex: 0,
              createdSec: (node.updatedAtMs || 0) / 1000,
              maxTimeSec: (node.updatedAtMs || 0) / 1000,
              preview: cl.preview,
              promptText: cl.promptText,
              exactUsd,
              steps: [
                {
                  stepIndex: 0,
                  kind: 'planner',
                  phase: '',
                  slug: mObj.slug || fallbackModel.slug,
                  rawSlug: mObj.rawSlug || mObj.slug || fallbackModel.slug,
                  code: mObj.code || '',
                  placeholder: mObj.placeholder || '',
                  shortName: mObj.shortName || fallbackModel.shortName,
                  fullName: mObj.fullName || fallbackModel.fullName,
                  requestedSlug: mObj.desiredSlug || '',
                  requestedEnum: mObj.requestedEnum || 0,
                  respondedEnum: mObj.respondedEnum || 0,
                  apiProvider: mObj.apiProvider || 0,
                  apiProviderName: mObj.apiProviderName || '',
                  isCanary: stepCanary,
                  isUnknownModel: Boolean(mObj.isUnknownModel),
                  canaryTag: stepCanary ? mObj.canaryTag || '' : '',
                  canaryReason: stepCanary ? mObj.canaryReason || '' : '',
                  botId: mObj.botId || '',
                  responseId: mObj.responseId || '',
                  traceHash: mObj.traceHash || '',
                  input: inp,
                  output: out,
                  thinking: node.tokens?.thinking || 0,
                  response: node.tokens?.response || out,
                  cacheRead: cr,
                  cacheWrite: 0,
                  imageCount: node.tokens?.generatedImages || 0,
                  waterlineTokens: node.waterline?.currentTokens || inp + cr + out,
                  softLimit:
                    node.waterline?.softLimit ||
                    node.model?.softLimit ||
                    fallbackModel.softLimit ||
                    DEFAULT_SOFT_LIMIT,
                  decodeTps: node.tps?.latestDecode || node.tps?.rolling || 0,
                  dtDecode: 0,
                  durationSec: node.timing?.llmDurationSec || 0,
                  ttftSec: node.timing?.avgTtftSec || node.tps?.latestTtftSec || 0,
                  isStreamingTtft: false,
                  exactUsd,
                  costUsd: round(exactUsd, 6),
                },
              ],
            },
          ],
          compactionRecords,
          node,
          fallbackModel
        );
      }
      return {
        turns: [],
        turnSummary: { totalTurns: 0, canaryTurnCount: 0 },
      };
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
    buildThreadTurns,
    invalidateConv(cid) {
      turnLedgerCache.delete(cid);
    },
    clearAll() {
      turnLedgerCache.clear();
      lastGoodTurnsCache.clear();
    },
  };
}
