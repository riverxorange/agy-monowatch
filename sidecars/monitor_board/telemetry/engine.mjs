/**
 * @fileoverview Main Telemetry Engine factory combining pricing, directory discovery,
 * trajectory metrics, turn ledger reconciliation, and tree rollups.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CLI_ROOT_LIMIT,
  DEFAULT_INTERACTIVE_ROOT_LIMIT,
  DEFAULT_MAX_WINDOW,
  DEFAULT_ROOT_LIMIT,
  DEFAULT_SOFT_LIMIT,
  STALE_RUNNING_SEC,
  STALE_WAITING_SEC,
  VALID_CONV_UUID_RE,
  dbWalSig,
  fileSig,
  mergeDailyInto,
  mergeDailyModelsInto,
  openReadOnlyDb,
  parseWorkspaceUris,
  round,
  scrubInterpuncts,
} from './utils.mjs';
import { createPricingRegistry } from './models.mjs';
import { createDiscoveryStore, discoverAppDataDirs } from './discovery.mjs';
import { cleanTurnPrompt, extractPromptFromStepPayload } from './proto.mjs';
import { createMetricsAnalyzer } from './metrics.mjs';
import { createTurnLedgerBuilder, readJsonlPromptMap } from './turns.mjs';

function statusRank(status) {
  if (status === 'working') return 0;
  if (status === 'waiting') return 1;
  if (status === 'idle') return 2;
  return 3; // killed
}

function mergeByModelLists(baseList, extraList) {
  const map = new Map();
  const pushItem = (it) => {
    if (!it || !it.slug) return;
    const effRaw = it.rawSlug || it.slug;
    const kind = it.kind === 'image' ? 'image' : 'llm';
    const key = `${kind}|${it.slug}|${effRaw}|${it.enumId || 0}`;
    let cur = map.get(key);
    if (!cur) {
      cur = {
        kind,
        slug: it.slug,
        rawSlug: effRaw,
        desiredSlug: it.desiredSlug || '',
        shortName: it.shortName,
        fullName: it.fullName,
        provider: it.provider,
        enumId: it.enumId || 0,
        code: it.code || '',
        placeholder: it.placeholder || '',
        requestedEnum: it.requestedEnum || 0,
        respondedEnum: it.respondedEnum || 0,
        isCanaryRouted: Boolean(it.isCanaryRouted),
        canaryTag: it.canaryTag || '',
        canaryReason: it.canaryReason || '',
        isUnknownModel: Boolean(it.isUnknownModel),
        apiProvider: it.apiProvider || 0,
        apiProviderName: it.apiProviderName || '',
        botId: it.botId || '',
        responseId: it.responseId || '',
        traceHash: it.traceHash || '',
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
      map.set(key, cur);
    } else {
      if (it.isCanaryRouted && !cur.isCanaryRouted) {
        cur.isCanaryRouted = true;
        cur.canaryTag = it.canaryTag || '';
        cur.canaryReason = it.canaryReason || '';
      }
      if (it.botId && !cur.botId) cur.botId = it.botId;
      if (it.responseId && !cur.responseId) cur.responseId = it.responseId;
      if (it.traceHash && !cur.traceHash) cur.traceHash = it.traceHash;
    }
    cur.costUsd += Number(it.costUsd) || 0;
    cur.inputTokens += Number(it.inputTokens) || 0;
    cur.cacheReadTokens += Number(it.cacheReadTokens) || 0;
    cur.outputTokens += Number(it.outputTokens) || 0;
    cur.imageCount += Number(it.imageCount) || 0;
    cur.steps += Number(it.steps) || 0;
    cur.decodeOutTokens += Number(it.decodeOutTokens) || 0;
    cur.decodeSec += Number(it.decodeSec) || 0;
    cur.ttftSum += Number(it.ttftSum) || 0;
    cur.ttftCount += Number(it.ttftCount) || 0;
    cur.latestSec = Math.max(cur.latestSec || 0, Number(it.latestSec) || 0);
  };
  for (const a of baseList || []) pushItem(a);
  for (const b of extraList || []) pushItem(b);
  return Array.from(map.values())
    .map((x) => ({ ...x, costUsd: round(x.costUsd, 6) }))
    .sort((a, b) => b.costUsd - a.costUsd || b.steps - a.steps);
}

function cleanPreviewTitle(preview) {
  if (!preview) return '';
  const cleaned = scrubInterpuncts(String(preview))
    .replace(/<\/?[A-Z_]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > 48 ? `${cleaned.slice(0, 48)}…` : cleaned;
}

function isBareHeaderPreview(s) {
  if (!s) return true;
  const t = String(s).trim();
  if (!t) return true;
  if (t.length <= 24 && /[:：]$/.test(t)) return true;
  return /^(?:#+\s*)?(?:background|context|task|role|system|prompt|goal|instructions?|objective|overview|problem)\s*[:：]?$/i.test(
    t
  );
}

function stripLeadingPromptHeader(raw) {
  if (!raw) return '';
  const text = String(raw)
    .replace(/<\/?[A-Z_]+>/g, ' ')
    .trim();
  if (!text) return '';
  const stripped = text
    .replace(
      /^(?:#+\s*)?(?:background|context|task|role|system|prompt|goal|instructions?|objective|overview|problem)\s*[:：]?\s*\r?\n+/i,
      ''
    )
    .replace(
      /^(?:#+\s*)?(?:background|context|task|role|system|prompt|goal|instructions?|objective|overview|problem)\s*[:：]\s+/i,
      ''
    )
    .trim();
  return stripped || text;
}

export function createTelemetryEngine(options = {}) {
  const appDataDirs = discoverAppDataDirs(options);
  const primaryAppDataDir = appDataDirs[0] || join(homedir(), '.gemini', 'antigravity');
  const sidecarDataDir =
    options.sidecarDataDir || process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || '';

  const idleNodeCache = new Map();
  const firstPromptTitleCache = new Map();
  const hostObservedLimitsBySurfaceSlug = new Map();
  const hostObservedLimitsBySurface = new Map();

  let lastPinnedHostConvId = '';
  let lastPinnedWorkspaceUris = [];
  let rootSelectionCacheSig = '';
  let rootSelectionCacheObj = null;

  let currentRev = 0;
  let lastSnapshotKey = '';
  let lastSnapshotObj = null;

  const discovery = createDiscoveryStore({ appDataDirs, primaryAppDataDir });

  let metrics = null;
  let turnsBuilder = null;

  const pricing = createPricingRegistry({
    primaryAppDataDir,
    sidecarDataDir,
    pricingOverridePath: options.pricingOverridePath || '',
    onReload: () => {
      metrics?.clearPricingCaches();
      idleNodeCache.clear();
    },
  });

  metrics = createMetricsAnalyzer({ pricing, discovery });
  turnsBuilder = createTurnLedgerBuilder({ pricing, discovery, metrics });

  function getFirstPromptDerivedTitle(convId, preferredDir, minStepIdx = 0) {
    const floorIdx = Math.max(0, Number(minStepIdx) || 0);
    const dbPath = discovery.findConvFile(
      convId,
      preferredDir,
      join('conversations', `${convId}.db`)
    );
    const tPath = discovery.findConvFile(
      convId,
      preferredDir,
      join('brain', convId, '.system_generated', 'logs', 'transcript.jsonl')
    );
    const cacheKey = `${convId}|${floorIdx}`;
    const sig = `${dbPath ? dbWalSig(dbPath) || '0' : 'none'}|${tPath ? fileSig(tPath) : 'none'}`;
    const cached = firstPromptTitleCache.get(cacheKey);
    if (cached && cached.sig === sig) {
      return cached.title;
    }

    let derived = '';
    if (dbPath) {
      let db = null;
      try {
        db = openReadOnlyDb(dbPath);
        const pRows = db
          .prepare(
            `SELECT step_type, step_payload
             FROM steps
             WHERE idx >= ? AND step_type IN (14, 101)
             ORDER BY CASE WHEN step_type = 14 THEN 0 ELSE 1 END, idx ASC
             LIMIT 4`
          )
          .all(floorIdx);
        for (const pRow of pRows) {
          if (!pRow || !pRow.step_payload) continue;
          const stType = Number(pRow.step_type);
          const ext = extractPromptFromStepPayload(pRow.step_payload, stType);
          if (!ext.rawText) continue;
          let baseText = ext.rawText;
          if (stType === 101) {
            const cl = cleanTurnPrompt(ext.rawText, { isSystem: true });
            if (cl.kindHint === 'btw_marker') continue;
            baseText = cl.promptText;
          }
          const candidate = cleanPreviewTitle(stripLeadingPromptHeader(baseText));
          if (candidate && !isBareHeaderPreview(candidate)) {
            derived = candidate;
            break;
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

    if (!derived && tPath) {
      const pMap = readJsonlPromptMap(tPath);
      const entries = Array.from(pMap.entries())
        .filter(([pIdx]) => pIdx >= floorIdx)
        .sort((a, b) => a[0] - b[0]);
      const has14 = entries.some(([, v]) => v.stepType === 14);
      for (const [, val] of entries) {
        if (has14 && val.stepType !== 14) continue;
        if (!val.content) continue;
        let baseText = val.content;
        if (val.stepType === 101) {
          const cl = cleanTurnPrompt(val.content, { isSystem: true });
          if (cl.kindHint === 'btw_marker') continue;
          baseText = cl.promptText;
        }
        const candidate = cleanPreviewTitle(stripLeadingPromptHeader(baseText));
        if (candidate && !isBareHeaderPreview(candidate)) {
          derived = candidate;
          break;
        }
      }
    }

    firstPromptTitleCache.set(cacheKey, { sig, title: derived });
    return derived;
  }

  function cloneCachedNode(tpl) {
    const selfByModel = Array.isArray(tpl.cost.byModel)
      ? tpl.cost.byModel.map((m) => ({ ...m }))
      : [];
    const selfStream = round(tpl.tps.rolling || tpl.tps.latestDecode || 0, 1);
    return {
      ...tpl,
      project: tpl.project ? { ...tpl.project } : null,
      automation: tpl.automation ? { ...tpl.automation } : null,
      battle: tpl.battle ? { ...tpl.battle } : null,
      alert: tpl.alert ? { ...tpl.alert } : null,
      issues: tpl.issues
        ? {
            ...tpl.issues,
            total: tpl.issues.total || 0,
            treeTotal: tpl.issues.total || 0,
            wastedUsd: tpl.issues.wastedUsd || 0,
            treeWastedUsd: tpl.issues.wastedUsd || 0,
            counts: { ...tpl.issues.counts },
            treeCounts: { ...tpl.issues.counts },
            items: Array.isArray(tpl.issues.items)
              ? tpl.issues.items.map((it) => ({ ...it }))
              : [],
          }
        : null,
      channels: Array.isArray(tpl.channels) ? [...tpl.channels] : [],
      referencedConversationIds: Array.isArray(tpl.referencedConversationIds)
        ? [...tpl.referencedConversationIds]
        : [],
      model: {
        ...tpl.model,
        orchestratorPhases: tpl.model?.orchestratorPhases
          ? { ...tpl.model.orchestratorPhases }
          : { planSteps: 0, executeSteps: 0, reviewSteps: 0 },
        byModel: selfByModel,
      },
      tokens: {
        ...tpl.tokens,
        treeInput: tpl.tokens.input,
        treeOutput: tpl.tokens.output,
        treeCacheRead: tpl.tokens.cacheRead,
        treeGeneratedImages: tpl.tokens.generatedImages || 0,
        treeCacheHitRatio: tpl.tokens.cacheHitRatio,
      },
      cost: {
        ...tpl.cost,
        childrenUsd: 0,
        treeUsd: tpl.cost.selfUsd,
        treeImageUsd: tpl.cost.imageUsd || 0,
        byModel: selfByModel,
        treeByModel: selfByModel,
      },
      waterline: {
        ...tpl.waterline,
        breakdown: Array.isArray(tpl.waterline?.breakdown)
          ? tpl.waterline.breakdown.map((b) => ({ ...b }))
          : [],
      },
      tps: {
        ...tpl.tps,
        live: 0,
        stream: selfStream,
        avgStream: selfStream,
        activeChildAvg: 0,
        treeBurn: 0,
      },
      timing: {
        ...(tpl.timing || {
          totalDurationSec: 0,
          llmDurationSec: 0,
          treeLlmDurationSec: 0,
          avgTtftSec: 0,
          latestTtftSec: 0,
          isLiveTicking: false,
        }),
        treeLlmDurationSec: tpl.timing?.llmDurationSec || 0,
        isLiveTicking: false,
      },
      children: [],
      _internal: {
        preferredDir: tpl._internal.preferredDir,
        hintModelSlug: tpl._internal.hintModelSlug || '',
        desiredHintSlug: tpl._internal.desiredHintSlug || '',
        minStepIdx: tpl._internal.minStepIdx || 0,
        compactionRecords: tpl._internal.compactionRecords,
        ageSinceActivitySec: tpl._internal.ageSinceActivitySec ?? Infinity,
        priorTurnsDurationSec: tpl._internal.priorTurnsDurationSec || 0,
        latestTurnStartSec: tpl._internal.latestTurnStartSec || 0,
        latestTurnBaseDurationSec: tpl._internal.latestTurnBaseDurationSec || 0,
        selfLlmDurationSec: tpl._internal.selfLlmDurationSec || 0,
        treeSavedCacheUsd: tpl.cost.savedCacheUsd,
        treeInputTokens: tpl.tokens.input,
        treeOutputTokens: tpl.tokens.output,
        treeCacheReadTokens: tpl.tokens.cacheRead,
        treeGeneratedImages: tpl.tokens.generatedImages || 0,
        treeImageUsd: tpl.cost.imageUsd || 0,
        hasWorkingDescendant: false,
        activeDescBurnSum: 0,
        activeDescWithTpsSum: 0,
        activeDescWithTpsCount: 0,
      },
    };
  }

  function buildThreadNode(row, allRowsMap, opts = {}) {
    const id = row.conversation_id;
    const forceLive = Boolean(opts.forceLive);
    const eagerJsonlDelta = Boolean(opts.eagerJsonlDelta);
    discovery.loadProjectsCatalog();

    if (row._isZeroHostStub) {
      const { model: defModel } = pricing.readGlobalDefaultModelInfo();
      const emptyMetrics = metrics.createEmptyMetrics(defModel, '', '');
      emptyMetrics.model = {
        ...emptyMetrics.model,
        slug: '',
        rawSlug: '',
        shortName: '',
        fullName: '',
        code: '',
        placeholder: '',
        enumId: 0,
      };
      const stubWorkspaces = parseWorkspaceUris(row.workspace_uris);
      const { surface, category, project, automation } = discovery.resolveThreadClassification(
        row,
        row,
        row.preferredDir || primaryAppDataDir,
        stubWorkspaces
      );
      discovery.dirtyConvIds.delete(id);
      idleNodeCache.delete(id);
      return {
        id,
        isNewEmptySession: true,
        stepCount: 0,
        title: '当前新会话',
        parentConversationId: '',
        nestingDepth: 0,
        kind: 'conversation',
        surface,
        category,
        project,
        automation: automation || null,
        battle: null,
        swarmRole: '',
        isSystemRoleWorker: false,
        workspaceMode: 'inherit',
        channels: [],
        roleLabel: '',
        btwBranchStepIndex: -1,
        workspaceUris: stubWorkspaces,
        status: 'idle',
        isGenerating: false,
        generatingElapsedSec: 0,
        updatedAtMs: 0,
        model: { ...emptyMetrics.model },
        tokens: { ...emptyMetrics.tokens },
        cost: { ...emptyMetrics.cost },
        waterline: emptyMetrics.waterline,
        compaction: emptyMetrics.compaction,
        tps: {
          ...emptyMetrics.tps,
          live: 0,
          stream: 0,
          avgStream: 0,
          activeChildAvg: 0,
          treeBurn: 0,
        },
        timing: { ...emptyMetrics.timing },
        alert: null,
        issues: {
          ...emptyMetrics.issues,
          counts: { ...emptyMetrics.issues.counts },
          treeCounts: { ...emptyMetrics.issues.treeCounts },
          items: [],
        },
        referencedConversationIds: [],
        children: [],
        _internal: {
          preferredDir: row.preferredDir || primaryAppDataDir,
          hintModelSlug: '',
          desiredHintSlug: '',
          minStepIdx: 0,
          compactionRecords: [],
          ageSinceActivitySec: Infinity,
          priorTurnsDurationSec: 0,
          latestTurnStartSec: 0,
          latestTurnBaseDurationSec: 0,
          selfLlmDurationSec: 0,
          treeSavedCacheUsd: 0,
          treeInputTokens: 0,
          treeOutputTokens: 0,
          treeCacheReadTokens: 0,
          treeGeneratedImages: 0,
          treeImageUsd: 0,
          hasWorkingDescendant: false,
          activeDescBurnSum: 0,
          activeDescWithTpsSum: 0,
          activeDescWithTpsCount: 0,
        },
      };
    }

    const nowMs = Date.now();
    const isRowIdle =
      row.status !== 'CASCADE_RUN_STATUS_RUNNING' &&
      Number(row.not_fully_idle) !== 1;
    const isHostPinned = id === lastPinnedHostConvId;

    const rowSig = `v9|${pricing.overrideSig}|${discovery.projectsCatalogSig}|${isHostPinned ? 1 : 0}|${row.last_modified_time || ''}|${row.step_count || 0}|${row.status || ''}|${row.source || ''}|${row.project_id || ''}|${row.not_fully_idle || 0}|${row.killed || 0}|${row.title || ''}|${row.battle_id || ''}|${row._unindexedSig || ''}|${row._isBtw ? 1 : 0}|${row._btwMinStepIdx || 0}`;
    if (
      !forceLive &&
      !eagerJsonlDelta &&
      (!row._unindexedDiskRow || Boolean(row._unindexedSig)) &&
      !discovery.dirtyConvIds.has(id)
    ) {
      const hit = idleNodeCache.get(id);
      if (hit && hit.rowSig === rowSig && !hit.template.isGenerating) {
        if (isRowIdle && nowMs - (row.updatedAtMs || 0) > 60_000) {
          return cloneCachedNode(hit.template);
        }
        if (nowMs - (hit.cachedAtMs || 0) < 2500) {
          return cloneCachedNode(hit.template);
        }
      }
    }

    const parentId = row.parent_conversation_id || '';
    const nestingDepth = Number(row.nesting_depth) || (parentId ? 1 : 0);
    const preferredDir = row.preferredDir || primaryAppDataDir;

    let rootId = id;
    let hop = row;
    let guard = 0;
    while (hop && hop.parent_conversation_id && guard++ < 8) {
      rootId = hop.parent_conversation_id;
      hop = allRowsMap.get(hop.parent_conversation_id);
    }
    const rootPreferredDir = hop?.preferredDir || preferredDir;
    const swarmInfo = discovery.getSwarmInfo(rootId, rootPreferredDir);
    const swarmMember = swarmInfo?.membersByConvId.get(id) || null;
    const subDesc = parentId
      ? discovery.getSubagentDescriptor(parentId, id, rootPreferredDir)
      : null;

    let kind = 'conversation';
    let roleLabel = '';
    const swarmRole = swarmMember
      ? swarmMember.systemRole ||
        (swarmMember.role === 'coordinator' ? 'coordinator' : 'worker')
      : '';
    const isSystemRoleWorker = Boolean(swarmMember?.isSystemRoleWorker);
    const workspaceMode = swarmMember?.workspaceMode || 'inherit';
    const channels = Array.isArray(swarmMember?.channels) ? [...swarmMember.channels] : [];

    if (parentId) {
      const isSwarmWorker =
        Boolean(swarmMember && swarmMember.role !== 'coordinator') ||
        subDesc?.typeName === 'worker' ||
        (subDesc?.role || '').startsWith('Swarm Worker');
      if (isSwarmWorker) {
        kind = 'swarm';
        const wName =
          swarmMember?.rosterName || row.agent_name || 'worker';
        roleLabel = wName.startsWith('@') ? wName : `@${wName}`;
      } else {
        kind = 'subagent';
        roleLabel = subDesc?.typeName || row.agent_name || 'subagent';
      }
    }

    const rowMinStepIdx = Math.max(0, Number(row._btwMinStepIdx) || 0);
    const hintModelSlug = swarmMember?.modelSlug || '';
    const desiredHintSlug = swarmMember?.desiredModelSlug || '';
    const convMetrics = metrics.analyzeConversationDb(
      id,
      preferredDir,
      hintModelSlug,
      eagerJsonlDelta,
      desiredHintSlug,
      rowMinStepIdx
    );

    const isBtw = Boolean(row._isBtw || convMetrics.btw?.isBtw);
    const effectiveMinStepIdx = Math.max(
      rowMinStepIdx,
      Number(convMetrics.btw?.minStepIdx) || 0
    );
    const btwBranchStepIndex = isBtw
      ? row._btwBranchStepIdx ?? convMetrics.btw?.branchStepIndex ?? -1
      : -1;
    if (isBtw) {
      kind = 'btw';
      roleLabel = '/btw';
    }

    if (swarmMember?.modelSwitched) {
      convMetrics.model = {
        ...convMetrics.model,
        desiredSlug: convMetrics.model.desiredSlug || swarmMember.desiredModelSlug,
        modelSwitched: true,
        switchedFromSlug: swarmMember.desiredModelSlug,
        switchedToSlug: swarmMember.appliedModelSlug,
      };
    }

    if (convMetrics.waterline.isPostCompactionEstimate) {
      const ckSummary = metrics.readLatestCompactionSummary(
        id,
        preferredDir,
        effectiveMinStepIdx
      );
      if (ckSummary.rawByteLength > 0) {
        const estFresh = 12_000 + Math.ceil(ckSummary.rawByteLength / 3.5);
        convMetrics.waterline = {
          ...convMetrics.waterline,
          cachedTokens: 0,
          freshTokens: estFresh,
          currentTokens: estFresh,
          apiCachedTokens: 0,
          apiFreshTokens: estFresh,
          apiContextTokens: estFresh,
          softRatio: Math.min(
            1,
            round(estFresh / convMetrics.waterline.softLimit, 4)
          ),
          maxRatio: Math.min(
            1,
            round(estFresh / convMetrics.waterline.maxWindow, 6)
          ),
        };
      }
    }

    const stepCount = isBtw
      ? Math.max(Number(convMetrics.stepCount) || 0, Number(row.step_count) || 0)
      : Math.max(Number(row.step_count) || 0, Number(convMetrics.stepCount) || 0);

    let title = (row.title || '').trim();
    if (!title) {
      title = discovery.getAnnotationTitle(id, preferredDir);
    }
    if (!title && kind === 'swarm') {
      title = roleLabel;
    }
    if (!title && kind === 'subagent') {
      title =
        (subDesc?.role && !subDesc.role.startsWith('Swarm Worker')
          ? subDesc.role.trim()
          : '') ||
        (row.agent_name ? `${row.agent_name}` : '子代理');
    }
    if (!title && swarmInfo?.title && !parentId) {
      title = swarmInfo.title;
    }
    if (!title) {
      const previewTitle = cleanPreviewTitle(row.preview);
      if (previewTitle && !isBareHeaderPreview(previewTitle)) {
        title = previewTitle;
      } else {
        const promptTitle =
          stepCount > 0 || convMetrics.tokens.input > 0
            ? getFirstPromptDerivedTitle(id, preferredDir, effectiveMinStepIdx)
            : '';
        if (promptTitle) {
          title = promptTitle;
        } else if (previewTitle) {
          title = previewTitle;
        } else if (
          isHostPinned &&
          stepCount === 0 &&
          convMetrics.tokens.input === 0 &&
          convMetrics.tokens.output === 0 &&
          !convMetrics.isGenerating
        ) {
          title = '当前新会话';
        } else if (isBtw) {
          title = `/btw 侧问 ${id.slice(0, 8)}`;
        } else {
          title = `会话 ${id.slice(0, 8)}`;
        }
      }
    }
    title = scrubInterpuncts(title);

    const isKilled =
      Number(row.killed) === 1 ||
      subDesc?.state === 'SUBAGENT_STATE_KILLED' ||
      Boolean(swarmMember?.killed);
    const isParkedSwarmMember = Boolean(
      swarmMember &&
        swarmMember.wakeMode &&
        swarmMember.wakeMode !== 'working' &&
        !convMetrics.isGenerating
    );

    let status = 'idle';
    if (isKilled) {
      status = 'killed';
    } else if (convMetrics.isGenerating) {
      status = 'working';
    } else if (
      row.status === 'CASCADE_RUN_STATUS_RUNNING' &&
      !isParkedSwarmMember &&
      convMetrics.ageSinceActivitySec <= STALE_RUNNING_SEC
    ) {
      status = 'working';
    } else if (
      Number(row.not_fully_idle) === 1 &&
      !isParkedSwarmMember &&
      convMetrics.ageSinceActivitySec <= STALE_WAITING_SEC
    ) {
      status = 'waiting';
    }

    const workspaceUris = parseWorkspaceUris(row.workspace_uris);
    const effectiveWorkspaces =
      workspaceUris.length > 0
        ? workspaceUris
        : subDesc?.workspaceUris?.length
          ? subDesc.workspaceUris
          : hop
            ? parseWorkspaceUris(hop.workspace_uris)
            : [];

    const { surface, category, project, automation } = discovery.resolveThreadClassification(
      row,
      hop,
      preferredDir,
      effectiveWorkspaces
    );

    const selfStreamTps = round(
      convMetrics.tps.rolling || convMetrics.tps.latestDecode || 0,
      1
    );
    const liveSelfTps =
      status === 'working' || convMetrics.isGenerating ? selfStreamTps : 0;

    const selfIsLive = status === 'working' || convMetrics.isGenerating;
    const selfLlmSec = round(convMetrics.selfLlmDurationSec || 0, 2);
    const priorTurnsSec = convMetrics.priorTurnsDurationSec || 0;
    const latestStartSec = convMetrics.latestTurnStartSec || 0;
    const latestBaseSec = convMetrics.latestTurnBaseDurationSec || 0;
    const selfLatestTurnSec =
      selfIsLive && latestStartSec > 0
        ? Math.max(latestBaseSec, Math.max(0, Date.now() / 1000 - latestStartSec))
        : selfIsLive
          ? Math.max(latestBaseSec, convMetrics.generatingElapsedSec || 0)
          : latestBaseSec;
    const selfTotalDurationSec = round(
      Math.max(selfLlmSec, priorTurnsSec + selfLatestTurnSec),
      selfIsLive ? 1 : 2
    );

    const battle = row.battle_id
      ? {
          id: String(row.battle_id),
          isWinner: row.winning_conversation_id === id,
        }
      : null;

    const built = {
      id,
      stepCount,
      title,
      parentConversationId: parentId,
      nestingDepth,
      kind,
      surface,
      category,
      project,
      automation: automation || null,
      battle,
      swarmRole,
      isSystemRoleWorker,
      workspaceMode,
      channels,
      roleLabel,
      btwBranchStepIndex,
      workspaceUris: effectiveWorkspaces,
      status,
      isGenerating: convMetrics.isGenerating,
      generatingElapsedSec: convMetrics.generatingElapsedSec,
      updatedAtMs: row.updatedAtMs || 0,
      model: { ...convMetrics.model },
      tokens: { ...convMetrics.tokens },
      cost: { ...convMetrics.cost },
      waterline: convMetrics.waterline,
      compaction: convMetrics.compaction,
      tps: {
        ...convMetrics.tps,
        live: liveSelfTps,
        stream: selfStreamTps,
        avgStream: selfStreamTps,
        activeChildAvg: 0,
        treeBurn: liveSelfTps,
      },
      timing: {
        totalDurationSec: selfTotalDurationSec,
        llmDurationSec: selfLlmSec,
        treeLlmDurationSec: selfLlmSec,
        avgTtftSec: convMetrics.avgTtftSec || convMetrics.tps?.latestTtftSec || 0,
        latestTtftSec: convMetrics.tps?.latestTtftSec || 0,
        isLiveTicking: selfIsLive,
      },
      alert: convMetrics.alert || null,
      issues: convMetrics.issues
        ? {
            ...convMetrics.issues,
            counts: { ...convMetrics.issues.counts },
            treeCounts: { ...convMetrics.issues.treeCounts },
            items: Array.isArray(convMetrics.issues.items)
              ? convMetrics.issues.items.map((it) => ({ ...it }))
              : [],
          }
        : null,
      referencedConversationIds: convMetrics.referencedConversationIds || [],
      children: [],
      _internal: {
        preferredDir,
        hintModelSlug,
        desiredHintSlug,
        minStepIdx: effectiveMinStepIdx,
        compactionRecords: convMetrics.compactionRecords,
        ageSinceActivitySec: convMetrics.ageSinceActivitySec,
        priorTurnsDurationSec: priorTurnsSec,
        latestTurnStartSec: latestStartSec,
        latestTurnBaseDurationSec: latestBaseSec,
        selfLlmDurationSec: selfLlmSec,
        treeSavedCacheUsd: convMetrics.cost.savedCacheUsd,
        treeInputTokens: convMetrics.tokens.input,
        treeOutputTokens: convMetrics.tokens.output,
        treeCacheReadTokens: convMetrics.tokens.cacheRead,
        treeGeneratedImages: convMetrics.tokens.generatedImages || 0,
        treeImageUsd: convMetrics.cost.imageUsd || 0,
        hasWorkingDescendant: false,
        activeDescBurnSum: 0,
        activeDescWithTpsSum: 0,
        activeDescWithTpsCount: 0,
      },
    };

    discovery.dirtyConvIds.delete(id);
    if (!built.isGenerating && (status === 'idle' || status === 'killed')) {
      idleNodeCache.set(id, {
        rowSig,
        template: cloneCachedNode(built),
        cachedAtMs: nowMs,
        isZombieRow: !isRowIdle,
      });
    } else {
      idleNodeCache.delete(id);
    }

    return built;
  }

  function rollupTreeNode(node) {
    if (node.children.length > 0) {
      let childrenUsd = 0;
      let childSaved = 0;
      let childIn = 0;
      let childOut = 0;
      let childCache = 0;
      let childImages = 0;
      let childImageUsd = 0;
      let childTreeLlmSec = 0;
      let maxChildUpdatedSec = 0;
      let hasWorkingDescendant = false;
      let activeDescBurnSum = 0;
      let activeDescWithTpsSum = 0;
      let activeDescWithTpsCount = 0;
      let mergedModels = node.cost.byModel || [];

      for (const child of node.children) {
        rollupTreeNode(child);
        childrenUsd += child.cost.treeUsd;
        childSaved += child._internal.treeSavedCacheUsd;
        childIn += child._internal.treeInputTokens;
        childOut += child._internal.treeOutputTokens;
        childCache += child._internal.treeCacheReadTokens;
        childImages += child._internal.treeGeneratedImages || 0;
        childImageUsd += child._internal.treeImageUsd || 0;
        childTreeLlmSec += Number(child.timing?.treeLlmDurationSec) || 0;
        if (child.kind !== 'btw') {
          const cUpdSec = Math.max(
            (child.updatedAtMs || 0) / 1000,
            child._internal.maxDescendantUpdatedSec || 0
          );
          if (cUpdSec > maxChildUpdatedSec) {
            maxChildUpdatedSec = cUpdSec;
          }
        }
        mergedModels = mergeByModelLists(mergedModels, child.cost.treeByModel);

        const childRunningSelf = child.status === 'working' || child.isGenerating;
        if (childRunningSelf || child._internal.hasWorkingDescendant) {
          hasWorkingDescendant = true;
        }
        if (childRunningSelf) {
          const cLive = Number(child.tps.live) || 0;
          activeDescBurnSum += cLive;
          if (cLive > 0) {
            activeDescWithTpsSum += cLive;
            activeDescWithTpsCount += 1;
          }
        }
        activeDescBurnSum += child._internal.activeDescBurnSum || 0;
        activeDescWithTpsSum += child._internal.activeDescWithTpsSum || 0;
        activeDescWithTpsCount += child._internal.activeDescWithTpsCount || 0;
      }

      node.children.sort((a, b) => {
        const sr = statusRank(a.status) - statusRank(b.status);
        if (sr !== 0) return sr;
        return b.updatedAtMs - a.updatedAtMs;
      });

      const treeInput = node.tokens.input + childIn;
      const treeOutput = node.tokens.output + childOut;
      const treeCacheRead = node.tokens.cacheRead + childCache;
      const treeGeneratedImages = (node.tokens.generatedImages || 0) + childImages;
      const treeImageUsd = round((node.cost.imageUsd || 0) + childImageUsd, 6);
      const treePromptDenom = treeInput + treeCacheRead;

      node.tokens.treeInput = treeInput;
      node.tokens.treeOutput = treeOutput;
      node.tokens.treeCacheRead = treeCacheRead;
      node.tokens.treeGeneratedImages = treeGeneratedImages;
      node.tokens.treeCacheHitRatio =
        treePromptDenom > 0 ? round(treeCacheRead / treePromptDenom, 4) : 0;

      node.cost.childrenUsd = round(childrenUsd, 6);
      node.cost.treeUsd = round(node.cost.selfUsd + childrenUsd, 6);
      node.cost.treeImageUsd = treeImageUsd;
      node.cost.treeByModel = mergedModels;
      {
        const treeDaily = mergeDailyInto({}, node.cost.daily);
        const treeDailyModels = mergeDailyModelsInto({}, node.cost.dailyModels);
        for (const child of node.children) {
          mergeDailyInto(treeDaily, child.cost.treeDaily || child.cost.daily);
          mergeDailyModelsInto(treeDailyModels, child.cost.treeDailyModels || child.cost.dailyModels);
        }
        node.cost.treeDaily = treeDaily;
        node.cost.treeDailyModels = treeDailyModels;
      }
      node.model.treeHasCanary = Boolean(
        node.model.isCanaryRouted || mergedModels.some((m) => m.isCanaryRouted)
      );

      if (node.issues) {
        const cats = [
          'safety_filter',
          'quota_429',
          'server_injection',
          'upstream_retry',
          'tool_error',
        ];
        const treeCounts = {};
        let treeTotal = Number(node.issues.total) || 0;
        let treeWastedUsd = Number(node.issues.wastedUsd) || 0;
        for (const cat of cats) {
          treeCounts[cat] = Number(node.issues.counts?.[cat]) || 0;
        }
        for (const child of node.children) {
          if (!child.issues) continue;
          treeTotal += Number(child.issues.treeTotal ?? child.issues.total) || 0;
          treeWastedUsd += Number(child.issues.treeWastedUsd ?? child.issues.wastedUsd) || 0;
          const cc = child.issues.treeCounts || child.issues.counts || {};
          for (const cat of cats) {
            treeCounts[cat] += Number(cc[cat]) || 0;
          }
        }
        node.issues = {
          ...node.issues,
          treeTotal,
          treeWastedUsd: round(treeWastedUsd, 6),
          treeCounts,
        };
      }

      node._internal.treeSavedCacheUsd = round(
        node.cost.savedCacheUsd + childSaved,
        6
      );
      node._internal.treeInputTokens = treeInput;
      node._internal.treeOutputTokens = treeOutput;
      node._internal.treeCacheReadTokens = treeCacheRead;
      node._internal.treeGeneratedImages = treeGeneratedImages;
      node._internal.treeImageUsd = treeImageUsd;
      node._internal.hasWorkingDescendant = hasWorkingDescendant;
      node._internal.maxDescendantUpdatedSec = maxChildUpdatedSec;
      node._internal.activeDescBurnSum = activeDescBurnSum;
      node._internal.activeDescWithTpsSum = activeDescWithTpsSum;
      node._internal.activeDescWithTpsCount = activeDescWithTpsCount;

      if (node.status === 'idle' && hasWorkingDescendant) {
        node.status = 'waiting';
      } else if (
        node.status === 'waiting' &&
        !hasWorkingDescendant &&
        (node._internal.ageSinceActivitySec ?? Infinity) > STALE_WAITING_SEC
      ) {
        node.status = 'idle';
      }

      const selfLlmSec = Number(node._internal.selfLlmDurationSec ?? node.timing?.llmDurationSec) || 0;
      const treeLlmDurationSec = round(selfLlmSec + childTreeLlmSec, 2);
      const isLiveTicking = Boolean(
        node.status === 'working' || node.isGenerating || hasWorkingDescendant
      );
      const priorSec = Number(node._internal.priorTurnsDurationSec) || 0;
      const latestStartSec = Number(node._internal.latestTurnStartSec) || 0;
      const baseLatestSec = Number(node._internal.latestTurnBaseDurationSec) || 0;
      const descExtendedSec =
        latestStartSec > 0 && maxChildUpdatedSec > latestStartSec
          ? Math.max(baseLatestSec, maxChildUpdatedSec - latestStartSec)
          : baseLatestSec;
      const effLatestSec =
        isLiveTicking && latestStartSec > 0
          ? Math.max(descExtendedSec, Math.max(0, Date.now() / 1000 - latestStartSec))
          : isLiveTicking
            ? Math.max(descExtendedSec, node.generatingElapsedSec || 0)
            : descExtendedSec;
      const totalDurationSec = round(
        Math.max(selfLlmSec, priorSec + effLatestSec),
        isLiveTicking ? 1 : 2
      );

      node.timing = {
        ...node.timing,
        totalDurationSec,
        llmDurationSec: round(selfLlmSec, 2),
        treeLlmDurationSec,
        isLiveTicking,
      };

      const selfStream = round(node.tps.rolling || node.tps.latestDecode || 0, 1);
      const liveSelf =
        node.status === 'working' || node.isGenerating ? selfStream : 0;
      const activeChildAvg =
        activeDescWithTpsCount > 0
          ? round(activeDescWithTpsSum / activeDescWithTpsCount, 1)
          : 0;
      const treeBurn = round(liveSelf + activeDescBurnSum, 1);
      const stream =
        liveSelf > 0
          ? liveSelf
          : node.status === 'waiting' && hasWorkingDescendant && activeChildAvg > 0
            ? activeChildAvg
            : selfStream;

      node.tps = {
        ...node.tps,
        live: liveSelf,
        stream,
        avgStream: stream,
        activeChildAvg,
        treeBurn,
      };
    }
  }

  function recordObservedHostLimits(node) {
    if (!node) return;
    const wl = node.waterline;
    if (wl && wl.limitSource === 'official' && wl.softLimit > 0) {
      const sGroup = node.surface === 'cli' ? 'cli' : 'desktop';
      const upd = node.updatedAtMs || 0;
      const prevSurf = hostObservedLimitsBySurface.get(sGroup);
      if (!prevSurf || upd >= prevSurf.updatedAtMs) {
        hostObservedLimitsBySurface.set(sGroup, {
          softLimit: wl.softLimit,
          updatedAtMs: upd,
        });
      }
      const slug = node.model?.slug || '';
      if (slug) {
        const sKey = `${sGroup}|${slug}`;
        const prevSlug = hostObservedLimitsBySurfaceSlug.get(sKey);
        if (!prevSlug || upd >= prevSlug.updatedAtMs) {
          hostObservedLimitsBySurfaceSlug.set(sKey, {
            softLimit: wl.softLimit,
            updatedAtMs: upd,
          });
        }
      }
    }
    for (const c of node.children || []) {
      recordObservedHostLimits(c);
    }
  }

  function applyHostInferredSoftLimit(node) {
    if (!node) return;
    const wl = node.waterline;
    if (wl && wl.limitSource !== 'official') {
      const sGroup = node.surface === 'cli' ? 'cli' : 'desktop';
      const slug = node.model?.slug || '';
      const bySlug = slug
        ? hostObservedLimitsBySurfaceSlug.get(`${sGroup}|${slug}`)
        : null;
      const bySurf = hostObservedLimitsBySurface.get(sGroup);
      const inferred = bySlug?.softLimit || bySurf?.softLimit || 0;
      if (inferred > 0) {
        const mw = wl.maxWindow || node.model?.maxWindow || DEFAULT_MAX_WINDOW;
        const clamped =
          mw > 0 && inferred > mw ? Math.floor(mw * 0.9) : inferred;
        const curTok = wl.currentTokens || 0;
        node.waterline = {
          ...wl,
          softLimit: clamped,
          softRatio:
            clamped > 0 ? Math.min(1, round(curTok / clamped, 4)) : 0,
          limitSource: 'host_inferred',
        };
        if (node.model) {
          node.model = {
            ...node.model,
            softLimit: clamped,
          };
        }
      }
    }
    for (const c of node.children || []) {
      applyHostInferredSoftLimit(c);
    }
  }

  function resolveCurrentDefaultSoftLimit() {
    return (
      hostObservedLimitsBySurface.get('desktop')?.softLimit ||
      hostObservedLimitsBySurface.get('cli')?.softLimit ||
      DEFAULT_SOFT_LIMIT
    );
  }

  function stripInternalFields(node) {
    const { _internal, ...publicNode } = node;
    publicNode.children = node.children.map(stripInternalFields);
    return publicNode;
  }

  function buildFullTreeSelection(allRowsMap, opts = {}) {
    discovery.loadProjectsCatalog();
    const hasCustomLimit =
      opts.limitRoots !== undefined && opts.limitRoots !== null && opts.limitRoots !== '';
    const pinnedConvId =
      typeof opts.conversationId === 'string' ? opts.conversationId.trim() : '';
    const filterWs = parseWorkspaceUris(opts.workspaceUris);

    let pinnedDiskSig = 'indexed';
    if (VALID_CONV_UUID_RE.test(pinnedConvId)) {
      lastPinnedHostConvId = pinnedConvId;
      if (filterWs.length > 0) {
        lastPinnedWorkspaceUris = filterWs;
      }
      if (!allRowsMap.has(pinnedConvId)) {
        const probed = discovery.probeConvOnDiskDirect(pinnedConvId);
        const effWs =
          filterWs.length > 0 ? filterWs : lastPinnedWorkspaceUris;
        if (probed.dbFound || probed.brainFound) {
          pinnedDiskSig = probed.diskSig;
          allRowsMap.set(
            pinnedConvId,
            discovery.createSyntheticSummaryRow(pinnedConvId, {
              ...probed,
              workspaceUris: effWs,
              isZeroHostStub: false,
            })
          );
        } else {
          const defInfo = pricing.readGlobalDefaultModelInfo();
          pinnedDiskSig = `empty:${defInfo.model.slug}:${defInfo.explicit ? 1 : 0}`;
          allRowsMap.set(
            pinnedConvId,
            discovery.createSyntheticSummaryRow(pinnedConvId, {
              workspaceUris: effWs,
              isZeroHostStub: true,
            })
          );
        }
      }
    }

    const selSig = `${discovery.mergedSummarySig}|${discovery.projectsCatalogSig}|${opts.limitRoots ?? ''}|${opts.limitCliRoots ?? ''}|${pinnedConvId}|${pinnedDiskSig}|${filterWs.join(',')}`;

    let effectiveRoots = null;
    let childrenByParent = null;

    if (rootSelectionCacheObj && rootSelectionCacheSig === selSig) {
      effectiveRoots = rootSelectionCacheObj.effectiveRoots;
      childrenByParent = rootSelectionCacheObj.childrenByParent;
    } else {
      const rootRows = [];
      childrenByParent = new Map();

      for (const row of allRowsMap.values()) {
        const pid = row.parent_conversation_id || '';
        if (!pid || !allRowsMap.has(pid)) {
          rootRows.push(row);
        } else {
          if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
          childrenByParent.get(pid).push(row);
        }
      }

      const activeRootIds = new Set();
      for (const row of allRowsMap.values()) {
        if (
          row.status === 'CASCADE_RUN_STATUS_RUNNING' ||
          Number(row.not_fully_idle) === 1
        ) {
          let cur = row;
          let guard = 0;
          while (
            cur &&
            cur.parent_conversation_id &&
            allRowsMap.has(cur.parent_conversation_id) &&
            guard++ < 8
          ) {
            cur = allRowsMap.get(cur.parent_conversation_id);
          }
          if (cur) activeRootIds.add(cur.conversation_id);
        }
      }
      if (pinnedConvId) {
        let cur = allRowsMap.get(pinnedConvId);
        let guard = 0;
        while (
          cur &&
          cur.parent_conversation_id &&
          allRowsMap.has(cur.parent_conversation_id) &&
          guard++ < 8
        ) {
          cur = allRowsMap.get(cur.parent_conversation_id);
        }
        if (cur) activeRootIds.add(cur.conversation_id);
      }

      const sortBucket = (arr) => {
        arr.sort((a, b) => {
          const aAct = activeRootIds.has(a.conversation_id) ? 0 : 1;
          const bAct = activeRootIds.has(b.conversation_id) ? 0 : 1;
          if (aAct !== bAct) return aAct - bAct;
          return b.updatedAtMs - a.updatedAtMs;
        });
      };

      const convRoots = [];
      const projRoots = [];
      const cliRoots = [];

      for (const r of rootRows) {
        const ws = r.parsedWorkspaces || parseWorkspaceUris(r.workspace_uris);
        const { category } = discovery.resolveThreadClassification(r, r, r.preferredDir, ws);
        if (category === 'cli') cliRoots.push(r);
        else if (category === 'project') projRoots.push(r);
        else convRoots.push(r);
      }

      sortBucket(convRoots);
      sortBucket(projRoots);
      sortBucket(cliRoots);

      let selectedRoots = [];
      if (hasCustomLimit && opts.limitCliRoots === undefined) {
        const customCap = Math.max(1, Number(opts.limitRoots) || DEFAULT_ROOT_LIMIT);
        const convQuota = Math.min(convRoots.length, Math.max(1, Math.ceil(customCap * 0.35)));
        const projQuota = Math.min(projRoots.length, Math.max(1, Math.ceil(customCap * 0.45)));
        const cliQuota = Math.max(0, customCap - convQuota - projQuota);
        const picked = new Map();
        for (const r of convRoots.slice(0, convQuota)) picked.set(r.conversation_id, r);
        for (const r of projRoots.slice(0, projQuota)) picked.set(r.conversation_id, r);
        for (const r of cliRoots.slice(0, cliQuota)) picked.set(r.conversation_id, r);
        if (picked.size < customCap) {
          for (const r of [...convRoots, ...projRoots, ...cliRoots]) {
            if (picked.size >= customCap) break;
            picked.set(r.conversation_id, r);
          }
        }
        for (const r of rootRows) {
          if (activeRootIds.has(r.conversation_id)) picked.set(r.conversation_id, r);
        }
        selectedRoots = Array.from(picked.values());
      } else {
        const interactiveCap = Number(opts.limitRoots) || DEFAULT_INTERACTIVE_ROOT_LIMIT;
        const cliCap = Number(opts.limitCliRoots) || DEFAULT_CLI_ROOT_LIMIT;

        const activeConvCount = convRoots.filter((r) => activeRootIds.has(r.conversation_id)).length;
        const activeProjCount = projRoots.filter((r) => activeRootIds.has(r.conversation_id)).length;
        const activeCliCount = cliRoots.filter((r) => activeRootIds.has(r.conversation_id)).length;

        const reservedConv = Math.min(convRoots.length, Math.max(40, activeConvCount));
        const remainingForProj = Math.max(activeProjCount, interactiveCap - reservedConv);
        const selectedConv = convRoots.slice(0, reservedConv);
        const selectedProj = projRoots.slice(0, remainingForProj);

        const leftoverInteractive =
          interactiveCap - (selectedConv.length + selectedProj.length);
        const extraConv =
          leftoverInteractive > 0 && convRoots.length > selectedConv.length
            ? convRoots.slice(selectedConv.length, selectedConv.length + leftoverInteractive)
            : [];

        const selectedCli = cliRoots.slice(0, Math.max(cliCap, activeCliCount));
        selectedRoots = [...selectedConv, ...extraConv, ...selectedProj, ...selectedCli];
      }

      const filteredRoots =
        filterWs.length > 0
          ? selectedRoots.filter((r) => {
              if (pinnedConvId && r.conversation_id === pinnedConvId) {
                return true;
              }
              const ws = r.parsedWorkspaces || parseWorkspaceUris(r.workspace_uris);
              return ws.some((u) =>
                filterWs.some((f) => u.toLowerCase() === f.toLowerCase())
              );
            })
          : selectedRoots;

      effectiveRoots = filteredRoots.length > 0 ? filteredRoots : selectedRoots;
      const effectiveIds = new Set(effectiveRoots.map((r) => r.conversation_id));
      const archiveRows = rootRows
        .filter((r) => !effectiveIds.has(r.conversation_id))
        .sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
      rootSelectionCacheSig = selSig;
      rootSelectionCacheObj = { effectiveRoots, childrenByParent, archiveRows };
    }

    const nodeMap = new Map();
    const visit = (row, depthGuard = 0) => {
      if (!row || depthGuard > 8 || nodeMap.has(row.conversation_id)) return null;
      const node = buildThreadNode(row, allRowsMap);
      nodeMap.set(node.id, node);
      const kids = childrenByParent.get(node.id) || [];
      for (const kRow of kids) {
        const childNode = visit(kRow, depthGuard + 1);
        if (childNode) node.children.push(childNode);
      }
      return node;
    };

    const roots = [];
    for (const rRow of effectiveRoots) {
      const rootNode = visit(rRow, 0);
      if (rootNode) {
        rollupTreeNode(rootNode);
        roots.push(rootNode);
      }
    }

    for (const rootNode of roots) {
      recordObservedHostLimits(rootNode);
    }
    for (const rootNode of roots) {
      applyHostInferredSoftLimit(rootNode);
    }

    roots.sort((a, b) => {
      const sr = statusRank(a.status) - statusRank(b.status);
      if (sr !== 0) return sr;
      return b.updatedAtMs - a.updatedAtMs;
    });

    return { roots, nodeMap, archiveRows: rootSelectionCacheObj?.archiveRows || [], childrenByParent };
  }

  function computeSnapshotSignature(roots) {
    const parts = [];
    const walk = (n) => {
      const durSig = n.timing?.isLiveTicking
        ? Math.floor(n.timing.totalDurationSec || 0)
        : n.timing?.totalDurationSec || 0;
      const alertSig = n.alert ? `${n.alert.kind}:${n.alert.count}:${n.alert.stepIndex}` : '';
      parts.push(
        `${n.id}:${n.isNewEmptySession ? 1 : 0}:${n.stepCount || 0}:${n.title}:${n.surface}:${n.category}:${n.project?.id || ''}:${n.project?.name || ''}:${n.swarmRole || ''}:${n.status}:${n.isGenerating ? n.generatingElapsedSec : 0}:${durSig}:${n.timing?.treeLlmDurationSec || 0}:${n.waterline?.currentTokens || 0}:${n.waterline?.softLimit || 0}:${n.updatedAtMs}:${n.model.rawSlug || n.model.slug}:${n.model.isCanaryRouted ? 1 : 0}:${n.tokens.input}:${n.tokens.output}:${n.tokens.cacheRead}:${n.tokens.treeGeneratedImages || 0}:${n.compaction.count}:${n.cost.treeUsd}:${n.cost.treeImageUsd || 0}:${alertSig}:${n.issues?.treeTotal || 0}:${n.issues?.treeWastedUsd || 0}:${n.tps.live}:${n.tps.stream}`
      );
      for (const c of n.children) walk(c);
    };
    for (const r of roots) walk(r);
    return parts.join('|');
  }

  // -------------------------------------------------------------------------
  // Archive: every root session beyond the live snapshot window is analysed in
  // the background (chunked via setImmediate) and folded into compact daily
  // aggregates, so period totals cover the full local history without shipping
  // thousands of nodes on every poll.
  // -------------------------------------------------------------------------

  const ARCHIVE_CHUNK = 120;
  const ARCHIVE_EVENT_CAP = 300;
  const CLOUD_CATS = ['safety_filter', 'quota_429', 'server_injection', 'upstream_retry'];
  const archiveListeners = new Set();
  let archiveVersion = 0;
  const archiveState = { key: '', token: null, building: false, data: null, list: [] };

  function normalizeWsKey(uri) {
    let s = String(uri || '');
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep raw
    }
    return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function archiveKeyOf(rows) {
    let sum = 0;
    for (const r of rows) sum += Number(r.updatedAtMs) || 0;
    return `${rows.length}:${sum}`;
  }

  function resolveProjectKey(node) {
    if (!node || node.category !== 'project') return '';
    return String(
      node.project?.id ||
        normalizeWsKey((node.workspaceUris || [])[0] || '') ||
        node.project?.name ||
        ''
    ).trim();
  }

  function createArchiveAcc() {
    return {
      count: 0,
      catCounts: { conversation: 0, project: 0, cli: 0 },
      catDayCounts: { conversation: {}, project: {}, cli: {} },
      byCategory: { conversation: {}, project: {}, cli: {} },
      byProject: {},
      byWorkspace: {},
      models: {},
      issueCounts: Object.fromEntries(CLOUD_CATS.map((c) => [c, 0])),
      wastedUsd: 0,
      events: [],
      canaryHits: [],
      list: [],
    };
  }

  function extractNodeCanaryHits(n, rootNode, outArr) {
    if (!n) return;
    const childLabel =
      n.id !== rootNode.id
        ? n.kind === 'btw'
          ? `/btw ${n.title || ''}`.trim()
          : n.roleLabel || n.title || ''
        : '';
    const fallbackSec = Math.floor((Number(n.updatedAtMs || rootNode.updatedAtMs) || 0) / 1000);
    for (const bm of n.cost?.byModel || []) {
      if (!(bm.isCanaryRouted || bm.isUnknownModel)) continue;
      outArr.push({
        threadId: n.id,
        rootThreadId: rootNode.id,
        threadTitle: rootNode.title || rootNode.id.slice(0, 8),
        childLabel,
        threadKind: n.kind || 'conversation',
        rawSlug: bm.rawSlug || bm.slug || '',
        desiredSlug: bm.desiredSlug || '',
        shortName: bm.shortName || '',
        fullName: bm.fullName || '',
        provider: bm.provider || 'gemini',
        code: bm.code || '',
        requestedEnum: bm.requestedEnum || 0,
        respondedEnum: bm.respondedEnum || 0,
        canaryTag: bm.canaryTag || '',
        canaryReason: bm.canaryReason || (bm.isUnknownModel ? 'unknown_model' : ''),
        isUnknownModel: Boolean(bm.isUnknownModel),
        steps: Number(bm.steps) || 0,
        costUsd: round(Number(bm.costUsd) || 0, 6),
        inputTokens: Number(bm.inputTokens) || 0,
        cacheReadTokens: Number(bm.cacheReadTokens) || 0,
        outputTokens: Number(bm.outputTokens) || 0,
        decodeOutTokens: Number(bm.decodeOutTokens) || 0,
        decodeSec: Number(bm.decodeSec) || 0,
        ttftSum: Number(bm.ttftSum) || 0,
        ttftCount: Number(bm.ttftCount) || 0,
        timestampSec: Number(bm.latestSec) || fallbackSec,
      });
    }
  }

  function slimArchiveNode(node) {
    return {
      id: node.id,
      title: node.title,
      kind: node.kind,
      category: node.category,
      surface: node.surface,
      project: node.project ? { id: node.project.id, name: node.project.name } : null,
      projectKey: resolveProjectKey(node),
      updatedAtMs: node.updatedAtMs,
      status: 'idle',
      isArchived: true,
      childCount: node.children.length,
      workspaceUris: node.workspaceUris || [],
      model: {
        shortName: node.model?.shortName || '',
        fullName: node.model?.fullName || '',
        rawSlug: node.model?.rawSlug || '',
        softLimit: node.model?.softLimit || 0,
      },
      cost: {
        selfUsd: node.cost.selfUsd,
        treeUsd: node.cost.treeUsd,
        treeDaily: node.cost.treeDaily || node.cost.daily || {},
      },
      tokens: {
        input: node.tokens.treeInput ?? node.tokens.input,
        output: node.tokens.treeOutput ?? node.tokens.output,
        cacheRead: node.tokens.treeCacheRead ?? node.tokens.cacheRead,
      },
      waterline: {
        currentTokens: node.waterline?.currentTokens || 0,
        cachedTokens: node.waterline?.cachedTokens || 0,
        freshTokens: node.waterline?.freshTokens || 0,
        softLimit: node.waterline?.softLimit || 0,
      },
      issues: { treeCounts: { ...(node.issues?.treeCounts || node.issues?.counts || {}) } },
      children: [],
    };
  }

  function accumulateArchiveRoot(acc, row, allRowsMap, childrenByParent) {
    const seen = new Set();
    const visit = (r, depth = 0) => {
      if (!r || depth > 8 || seen.has(r.conversation_id)) return null;
      seen.add(r.conversation_id);
      const n = buildThreadNode(r, allRowsMap);
      for (const k of childrenByParent.get(n.id) || []) {
        const c = visit(k, depth + 1);
        if (c) n.children.push(c);
      }
      return n;
    };
    const node = visit(row);
    if (!node) return;
    rollupTreeNode(node);

    const daily = node.cost.treeDaily || node.cost.daily || {};
    const cat = node.category === 'cli' || node.category === 'project' ? node.category : 'conversation';
    acc.count += 1;
    acc.catCounts[cat] += 1;
    const latestActiveDay = Object.keys(daily)
      .filter((dk) => (Number(daily[dk]?.[0]) || 0) > 0)
      .sort()
      .pop();
    if (latestActiveDay) {
      acc.catDayCounts[cat][latestActiveDay] = (acc.catDayCounts[cat][latestActiveDay] || 0) + 1;
    }
    mergeDailyInto(acc.byCategory[cat], daily);
    mergeDailyModelsInto(acc.models, node.cost.treeDailyModels || node.cost.dailyModels || {});
    if (cat === 'project') {
      const pKey = resolveProjectKey(node);
      if (pKey) {
        let pEntry = acc.byProject[pKey];
        if (!pEntry) {
          pEntry = {
            id: node.project?.id || pKey,
            name: node.project?.name || pKey,
            workspaceUris: (node.workspaceUris || []).slice(0, 2),
            count: 0,
            latestMs: 0,
            spans: [],
            daily: {},
          };
          acc.byProject[pKey] = pEntry;
        }
        pEntry.count += 1;
        pEntry.latestMs = Math.max(pEntry.latestMs, Number(node.updatedAtMs) || 0);
        const activeDays = Object.keys(daily)
          .filter((dk) => (Number(daily[dk]?.[0]) || 0) > 0)
          .sort();
        if (activeDays.length > 0 && pEntry.spans.length < 500) {
          pEntry.spans.push(
            activeDays.length === 1
              ? activeDays[0]
              : [activeDays[0], activeDays[activeDays.length - 1]]
          );
        }
        mergeDailyInto(pEntry.daily, daily);
      }
    }
    const wsKeys = new Set((node.workspaceUris || []).map(normalizeWsKey).filter(Boolean));
    for (const k of wsKeys) {
      acc.byWorkspace[k] = mergeDailyInto(acc.byWorkspace[k] || {}, daily);
    }

    const tc = node.issues?.treeCounts || node.issues?.counts || {};
    for (const c of CLOUD_CATS) acc.issueCounts[c] += Number(tc[c]) || 0;
    acc.wastedUsd += Number(node.issues?.treeWastedUsd ?? node.issues?.wastedUsd) || 0;

    const walk = (n) => {
      extractNodeCanaryHits(n, node, acc.canaryHits);
      for (const it of n.issues?.items || []) {
        if (!CLOUD_CATS.includes(it.category)) continue;
        const clip = (s) => {
          const t = String(s || '');
          return t.length > 400 ? `${t.slice(0, 399)}…` : t;
        };
        acc.events.push({
          ...it,
          injectedText: clip(it.injectedText),
          summary: clip(it.summary),
          threadId: n.id,
          rootThreadId: node.id,
          threadTitle: node.title || node.id.slice(0, 8),
          childLabel: n.id !== node.id ? n.roleLabel || n.title || '' : '',
          threadKind: n.kind || 'conversation',
        });
      }
      for (const c of n.children) walk(c);
    };
    walk(node);
    if (acc.events.length > ARCHIVE_EVENT_CAP * 2) {
      acc.events.sort((a, b) => (Number(b.timestampSec) || 0) - (Number(a.timestampSec) || 0));
      acc.events.length = ARCHIVE_EVENT_CAP;
    }
    if (acc.canaryHits.length > ARCHIVE_EVENT_CAP * 2) {
      acc.canaryHits.sort((a, b) => (Number(b.timestampSec) || 0) - (Number(a.timestampSec) || 0));
      acc.canaryHits.length = ARCHIVE_EVENT_CAP;
    }

    acc.list.push(slimArchiveNode(node));
  }

  function scheduleArchiveBuild(allRowsMap, archiveRows, childrenByParent) {
    const key = archiveKeyOf(archiveRows);
    if (key === archiveState.key) return;
    archiveState.key = key;
    const token = {};
    archiveState.token = token;
    archiveState.building = true;
    const rows = archiveRows.slice();
    const acc = createArchiveAcc();
    let i = 0;

    const step = () => {
      if (archiveState.token !== token) return;
      const end = Math.min(rows.length, i + ARCHIVE_CHUNK);
      for (; i < end; i++) {
        try {
          accumulateArchiveRoot(acc, rows[i], allRowsMap, childrenByParent);
        } catch {
          // Skip unreadable archived session.
        }
      }
      if (i < rows.length) {
        setImmediate(step);
        return;
      }
      acc.events.sort((a, b) => (Number(b.timestampSec) || 0) - (Number(a.timestampSec) || 0));
      acc.events.length = Math.min(acc.events.length, ARCHIVE_EVENT_CAP);
      acc.canaryHits.sort((a, b) => (Number(b.timestampSec) || 0) - (Number(a.timestampSec) || 0));
      acc.canaryHits.length = Math.min(acc.canaryHits.length, ARCHIVE_EVENT_CAP);
      acc.list.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
      archiveState.list = acc.list;
      archiveState.data = {
        count: acc.count,
        catCounts: acc.catCounts,
        catDayCounts: acc.catDayCounts,
        byCategory: acc.byCategory,
        byProject: acc.byProject,
        byWorkspace: acc.byWorkspace,
        models: acc.models,
        issueCounts: acc.issueCounts,
        wastedUsd: round(acc.wastedUsd, 6),
        events: acc.events,
        canaryHits: acc.canaryHits,
      };
      archiveState.building = false;
      archiveVersion += 1;
      for (const fn of archiveListeners) {
        try {
          fn();
        } catch {
          // ignore listener failure
        }
      }
    };
    setImmediate(step);
  }

  function getArchivePublic() {
    if (!archiveState.data) {
      return { pending: true, count: 0 };
    }
    return { pending: archiveState.building, ...archiveState.data };
  }

  /**
   * Paged archived-session rows for the session list.
   * Filters: category scope, workspace URIs (normalized prefix match), day-key window.
   */
  function listArchive({
    scope = 'all',
    projectKey = '',
    workspaceUris = [],
    startKey = '',
    endKey = '',
    offset = 0,
    limit = 40,
  } = {}) {
    const ws = (Array.isArray(workspaceUris) ? workspaceUris : []).map(normalizeWsKey).filter(Boolean);
    const pKey = String(projectKey || '').trim();
    const inWindow = (row) => {
      if (!startKey && !endKey) return true;
      for (const k of Object.keys(row.cost.treeDaily || {})) {
        if (k >= startKey && k < endKey && (Number(row.cost.treeDaily[k]?.[0]) || 0) > 0) return true;
      }
      return false;
    };
    const matches = archiveState.list.filter((row) => {
      if (scope === 'conversation' || scope === 'project' || scope === 'cli') {
        const cat = row.category === 'cli' || row.category === 'project' ? row.category : 'conversation';
        if (cat !== scope) return false;
      }
      if (pKey) {
        if (
          row.projectKey !== pKey &&
          row.project?.id !== pKey &&
          row.project?.name !== pKey
        ) {
          return false;
        }
      }
      if (scope === 'workspace') {
        const own = (row.workspaceUris || []).map(normalizeWsKey);
        if (!own.some((u) => ws.some((t) => u === t || u.startsWith(`${t}/`) || t.startsWith(`${u}/`)))) {
          return false;
        }
      }
      return inWindow(row);
    });
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.max(1, Math.min(200, Number(limit) || 40));
    return {
      pending: archiveState.building && !archiveState.data,
      total: matches.length,
      rows: matches.slice(off, off + lim),
    };
  }

  function onArchiveReady(fn) {
    archiveListeners.add(fn);
    return () => archiveListeners.delete(fn);
  }

  function getSnapshot(opts = {}) {
    pricing.refreshIfNeeded();
    const allRowsMap = discovery.loadAllSummaryRows();
    const { roots, archiveRows, childrenByParent } = buildFullTreeSelection(allRowsMap, opts);
    scheduleArchiveBuild(allRowsMap, archiveRows, childrenByParent);

    let costUsd = 0;
    let savedCacheUsd = 0;
    let imageUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let generatedImages = 0;
    let activeCount = 0;
    let activeRootCount = 0;
    let waitingCount = 0;
    let canaryCount = 0;
    let totalBurnTps = 0;

    const categoryCounts = {
      conversation: 0,
      project: 0,
      cli: 0,
      all: roots.length,
    };

    const allNodes = [];
    const activeNodesWithTps = [];

    const walkMetrics = (node) => {
      allNodes.push(node);
      if (node.model?.isCanaryRouted) {
        canaryCount += 1;
      }
      if (node.status === 'working' || node.isGenerating) {
        activeCount += 1;
        const liveVal = Number(node.tps.live) || 0;
        totalBurnTps += liveVal;
        if (liveVal > 0) {
          activeNodesWithTps.push(node);
        }
      } else if (node.status === 'waiting') {
        waitingCount += 1;
      }
      for (const c of node.children) walkMetrics(c);
    };

    for (const root of roots) {
      costUsd += root.cost.treeUsd;
      savedCacheUsd += root._internal.treeSavedCacheUsd;
      imageUsd += root._internal.treeImageUsd || 0;
      inputTokens += root._internal.treeInputTokens;
      outputTokens += root._internal.treeOutputTokens;
      cacheReadTokens += root._internal.treeCacheReadTokens;
      generatedImages += root._internal.treeGeneratedImages || 0;
      if (
        root.status === 'working' ||
        root.isGenerating ||
        root._internal.hasWorkingDescendant
      ) {
        activeRootCount += 1;
      }
      if (root.category === 'cli') categoryCounts.cli += 1;
      else if (root.category === 'project') categoryCounts.project += 1;
      else categoryCounts.conversation += 1;

      walkMetrics(root);
    }

    if (activeCount === 0) {
      totalBurnTps = 0;
    }

    let avgStreamTps = 0;
    let avgStreamIsLive = false;
    let avgStreamSampleCount = 0;
    let avgTtftSec = 0;

    const recentWithTps = allNodes
      .filter(
        (n) =>
          (n.tokens?.output || 0) > 0 &&
          (n.tps?.rolling || n.tps?.latestDecode || 0) > 0
      )
      .sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0))
      .slice(0, 5);

    if (activeNodesWithTps.length > 0) {
      const sumActiveStream = activeNodesWithTps.reduce(
        (acc, n) => acc + (Number(n.tps.live) || 0),
        0
      );
      avgStreamTps = round(sumActiveStream / activeNodesWithTps.length, 1);
      avgStreamIsLive = true;
      avgStreamSampleCount = activeNodesWithTps.length;

      const activeTtftNodes = activeNodesWithTps.filter(
        (n) => (n.timing?.avgTtftSec || n.tps?.latestTtftSec || 0) > 0
      );
      if (activeTtftNodes.length > 0) {
        avgTtftSec = round(
          activeTtftNodes.reduce(
            (acc, n) => acc + (n.timing?.avgTtftSec || n.tps?.latestTtftSec || 0),
            0
          ) / activeTtftNodes.length,
          2
        );
      }
    } else if (recentWithTps.length > 0) {
      const sumRecentStream = recentWithTps.reduce(
        (acc, n) => acc + (Number(n.tps.rolling || n.tps.latestDecode) || 0),
        0
      );
      avgStreamTps = round(sumRecentStream / recentWithTps.length, 1);
      avgStreamIsLive = false;
      avgStreamSampleCount = recentWithTps.length;
    }

    if (avgTtftSec === 0 && recentWithTps.length > 0) {
      const ttftNodes = recentWithTps.filter(
        (n) => (n.timing?.avgTtftSec || n.tps?.latestTtftSec || 0) > 0
      );
      if (ttftNodes.length > 0) {
        avgTtftSec = round(
          ttftNodes.reduce(
            (acc, n) => acc + (n.timing?.avgTtftSec || n.tps?.latestTtftSec || 0),
            0
          ) / ttftNodes.length,
          2
        );
      }
    }

    const totalPromptDenom = inputTokens + cacheReadTokens;
    const cacheHitRatio =
      totalPromptDenom > 0 ? round(cacheReadTokens / totalPromptDenom, 4) : 0;
    const roundedBurnTps = round(totalBurnTps, 1);

    const defaultSoftLimit = resolveCurrentDefaultSoftLimit();
    const publicRoots = roots.map(stripInternalFields);

    const issueCats = [
      'safety_filter',
      'quota_429',
      'server_injection',
      'upstream_retry',
      'tool_error',
    ];
    const globalIssueCounts = {
      safety_filter: 0,
      quota_429: 0,
      server_injection: 0,
      upstream_retry: 0,
      tool_error: 0,
    };
    let issuesTotalCount = 0;
    let issuesAffectedThreads = 0;
    let issuesWastedUsd = 0;
    const collectedIssueEvents = [];
    const collectedCanaryHits = [];

    for (const root of publicRoots) {
      const rTreeTotal = Number(root.issues?.treeTotal ?? root.issues?.total) || 0;
      if (rTreeTotal > 0) {
        issuesTotalCount += rTreeTotal;
        issuesAffectedThreads += 1;
        issuesWastedUsd += Number(root.issues?.treeWastedUsd ?? root.issues?.wastedUsd) || 0;
        const tc = root.issues?.treeCounts || root.issues?.counts || {};
        for (const cat of issueCats) {
          globalIssueCounts[cat] += Number(tc[cat]) || 0;
        }
      }
      const walkIssueNodes = (node) => {
        if (!node) return;
        extractNodeCanaryHits(node, root, collectedCanaryHits);
        const items = Array.isArray(node.issues?.items) ? node.issues.items : [];
        for (const it of items) {
          collectedIssueEvents.push({
            ...it,
            threadId: node.id,
            rootThreadId: root.id,
            threadTitle: root.title || root.id.slice(0, 8),
            childLabel:
              node.id !== root.id
                ? node.kind === 'btw'
                  ? `/btw ${node.title || ''}`.trim()
                  : node.roleLabel || node.title || ''
                : '',
            threadKind: node.kind || 'conversation',
          });
        }
        for (const ch of node.children || []) walkIssueNodes(ch);
      };
      walkIssueNodes(root);
    }

    collectedIssueEvents.sort(
      (a, b) =>
        (Number(b.timestampSec) || 0) - (Number(a.timestampSec) || 0) ||
        (Number(b.stepIndex) || 0) - (Number(a.stepIndex) || 0)
    );
    collectedCanaryHits.sort(
      (a, b) => (Number(b.timestampSec) || 0) - (Number(a.timestampSec) || 0)
    );

    const sigKey = `${defaultSoftLimit}|a${archiveVersion}|${computeSnapshotSignature(publicRoots)}`;

    if (sigKey !== lastSnapshotKey || !lastSnapshotObj) {
      currentRev += 1;
      lastSnapshotKey = sigKey;
      lastSnapshotObj = {
        rev: currentRev,
        generatedAt: new Date().toISOString(),
        defaultSoftLimit,
        totals: {
          defaultSoftLimit,
          costUsd: round(costUsd, 6),
          imageUsd: round(imageUsd, 6),
          savedCacheUsd: round(savedCacheUsd, 6),
          inputTokens,
          outputTokens,
          cacheReadTokens,
          generatedImages,
          cacheHitRatio,
          activeCount: activeRootCount,
          activeRootCount,
          activeStreamCount: activeCount,
          waitingCount,
          canaryCount,
          totalThreads: publicRoots.length,
          categoryCounts,
          avgStreamTps,
          avgStreamIsLive,
          avgStreamSampleCount,
          avgTtftSec,
          totalBurnTps: roundedBurnTps,
          liveTps: roundedBurnTps,
        },
        issuesSummary: {
          totalCount: issuesTotalCount,
          affectedThreads: issuesAffectedThreads,
          wastedUsd: round(issuesWastedUsd, 6),
          counts: globalIssueCounts,
          events: [
            ...collectedIssueEvents.filter((e) => e.category !== 'tool_error').slice(0, 200),
            ...collectedIssueEvents.filter((e) => e.category === 'tool_error').slice(0, 40),
          ].sort(
            (a, b) =>
              (Number(b.timestampSec) || 0) - (Number(a.timestampSec) || 0) ||
              (Number(b.stepIndex) || 0) - (Number(a.stepIndex) || 0)
          ),
        },
        canaryHits: collectedCanaryHits.slice(0, 300),
        threads: publicRoots,
        archive: getArchivePublic(),
      };
    }

    if (
      opts &&
      opts.etag !== undefined &&
      opts.etag !== null &&
      String(opts.etag).trim() !== '' &&
      Number(opts.etag) === lastSnapshotObj.rev
    ) {
      return { unchanged: true, rev: lastSnapshotObj.rev };
    }

    return lastSnapshotObj;
  }

  function getThreadDetail(conversationId, detailOpts = {}) {
    if (!conversationId || typeof conversationId !== 'string') return null;
    const targetId = conversationId.trim();
    if (!targetId) return null;

    if (
      VALID_CONV_UUID_RE.test(targetId) &&
      (Boolean(detailOpts?.isHostSession) ||
        (typeof detailOpts?.conversationId === 'string' &&
          detailOpts.conversationId.trim() === targetId))
    ) {
      lastPinnedHostConvId = targetId;
    }

    pricing.refreshIfNeeded();
    const allRowsMap = discovery.loadAllSummaryRows({
      includeUnindexedBtw: !detailOpts?.fastCold,
    });
    let targetRow = allRowsMap.get(targetId);

    if (!targetRow) {
      const probed = discovery.probeConvOnDiskDirect(targetId);
      const effWs = detailOpts?.workspaceUris || lastPinnedWorkspaceUris;
      if (probed.dbFound || probed.brainFound) {
        targetRow = discovery.createSyntheticSummaryRow(targetId, {
          ...probed,
          workspaceUris: effWs,
          isZeroHostStub: false,
        });
        allRowsMap.set(targetId, targetRow);
      } else if (
        VALID_CONV_UUID_RE.test(targetId) &&
        (targetId === lastPinnedHostConvId ||
          Boolean(detailOpts?.isHostSession) ||
          Boolean(detailOpts?.allowEmptyStub))
      ) {
        const stubRow = discovery.createSyntheticSummaryRow(targetId, {
          workspaceUris: effWs,
          isZeroHostStub: true,
        });
        const stubNode = buildThreadNode(stubRow, allRowsMap, {
          forceLive: true,
        });
        applyHostInferredSoftLimit(stubNode);
        return {
          isNewEmptySession: true,
          thread: stripInternalFields(stubNode),
          compaction: {
            count: 0,
            latestStepIndex: -1,
            latestCreatedAt: null,
            summaryMarkdown: '',
            chapters: [],
            history: [],
          },
          turnSummary: {
            totalTurns: 0,
            canaryTurnCount: 0,
          },
          turns: [],
        };
      } else {
        return null;
      }
    }

    let rootRow = targetRow;
    let guard = 0;
    while (rootRow && rootRow.parent_conversation_id && guard++ < 8) {
      const parent = allRowsMap.get(rootRow.parent_conversation_id);
      if (!parent) break;
      rootRow = parent;
    }

    const childrenByParent = new Map();
    for (const row of allRowsMap.values()) {
      const pid = row.parent_conversation_id || '';
      if (pid && allRowsMap.has(pid)) {
        if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
        childrenByParent.get(pid).push(row);
      }
    }

    const nodeMap = new Map();
    const visitSingleRoot = (row, depthGuard = 0) => {
      if (!row || depthGuard > 8 || nodeMap.has(row.conversation_id)) return null;
      const isTarget = row.conversation_id === targetId;
      const built = buildThreadNode(row, allRowsMap, {
        forceLive: isTarget,
        eagerJsonlDelta: isTarget,
      });
      nodeMap.set(built.id, built);
      const kids = childrenByParent.get(built.id) || [];
      for (const kRow of kids) {
        const childNode = visitSingleRoot(kRow, depthGuard + 1);
        if (childNode) built.children.push(childNode);
      }
      return built;
    };

    const rootNode = visitSingleRoot(rootRow, 0);
    if (rootNode) {
      rollupTreeNode(rootNode);
      recordObservedHostLimits(rootNode);
      applyHostInferredSoftLimit(rootNode);
    }

    let node = nodeMap.get(targetId);
    if (!node) {
      node = buildThreadNode(targetRow, allRowsMap, {
        forceLive: true,
        eagerJsonlDelta: true,
      });
      rollupTreeNode(node);
      recordObservedHostLimits(node);
      applyHostInferredSoftLimit(node);
    }

    const preferredDir = node._internal.preferredDir;
    const minStepIdx = Number(node._internal.minStepIdx) || 0;
    const records = node._internal.compactionRecords || [];
    const count = node.compaction.count;

    let summaryMarkdown = '';
    let latestStepIndex = node.compaction.latestStepIndex;
    let latestCreatedAt =
      records.length > 0 ? records[records.length - 1].createdAt : null;

    if (count > 0) {
      const ckSummary = metrics.readLatestCompactionSummary(
        targetId,
        preferredDir,
        minStepIdx
      );
      summaryMarkdown = ckSummary.summaryMarkdown || '';
      if (ckSummary.latestStepIndex >= 0) {
        latestStepIndex = ckSummary.latestStepIndex;
      }
      if (ckSummary.latestCreatedAt) {
        latestCreatedAt = ckSummary.latestCreatedAt;
      }
    }

    const chapters = metrics.readChapterTitles(targetId, preferredDir);
    const history = [...records];
    const { turns, turnSummary } = turnsBuilder.buildThreadTurns(
      targetId,
      preferredDir,
      node,
      node._internal.hintModelSlug || '',
      node._internal.desiredHintSlug || ''
    );

    return {
      thread: stripInternalFields(node),
      compaction: {
        count,
        latestStepIndex,
        latestCreatedAt,
        summaryMarkdown,
        chapters,
        history,
      },
      turnSummary,
      turns,
    };
  }

  function invalidate(conversationId) {
    if (conversationId && typeof conversationId === 'string') {
      const cid = conversationId.trim();
      discovery.invalidateConv(cid);
      if (cid === lastPinnedHostConvId) {
        rootSelectionCacheSig = '';
        rootSelectionCacheObj = null;
      }
      idleNodeCache.delete(cid);
      firstPromptTitleCache.delete(cid);
      metrics.invalidateConv(cid);
      turnsBuilder.invalidateConv(cid);
    } else {
      discovery.invalidateAll();
      rootSelectionCacheSig = '';
      rootSelectionCacheObj = null;
      idleNodeCache.clear();
      firstPromptTitleCache.clear();
      turnsBuilder.clearAll();
    }
  }

  function close() {
    discovery.clearAll();
    metrics.clearAll();
    turnsBuilder.clearAll();
    rootSelectionCacheSig = '';
    rootSelectionCacheObj = null;
    lastPinnedHostConvId = '';
    lastPinnedWorkspaceUris = [];
    idleNodeCache.clear();
    firstPromptTitleCache.clear();
    hostObservedLimitsBySurfaceSlug.clear();
    hostObservedLimitsBySurface.clear();
  }

  function getConversationMetadataLite(conversationId) {
    return discovery.getConversationMetadataLite(conversationId);
  }

  return {
    appDataDirs,
    getSnapshot,
    getThreadDetail,
    getConversationMetadataLite,
    listArchive,
    onArchiveReady,
    invalidate,
    close,
  };
}
