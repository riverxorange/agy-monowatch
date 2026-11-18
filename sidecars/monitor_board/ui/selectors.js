/**
 * Telemetry tree, timing, routing, category classification, and CLI batch selectors.
 */

import { initialSearchParams, state } from './state.js';
import {
  formatCanaryReason,
  normalizeUri,
  resolveDefaultSoftLimit,
} from './format.js';
import { tr } from './i18n.js';

export function isNodeRunning(node) {
  return Boolean(node && (node.isGenerating || node.status === 'working'));
}

export function isThreadTreeActive(t) {
  if (!t) return false;
  if (isNodeRunning(t)) return true;
  return Array.isArray(t.children) && t.children.some((c) => isThreadTreeActive(c));
}

export function isThreadTreeGenerating(t) {
  if (!t) return false;
  if (t.isGenerating) return true;
  return Array.isArray(t.children) && t.children.some((c) => isThreadTreeGenerating(c));
}

export function isCurrentHostThread(t) {
  const hId = state.hostConvId;
  if (!hId || !t) return false;
  if (t.id === hId) return true;
  return Array.isArray(t.children) && t.children.some((c) => isCurrentHostThread(c));
}

export function findThreadById(threads, targetId) {
  if (!Array.isArray(threads) || !targetId) return null;
  for (const t of threads) {
    if (t.id === targetId) return t;
    if (Array.isArray(t.children) && t.children.length > 0) {
      const found = findThreadById(t.children, targetId);
      if (found) return found;
    }
  }
  return null;
}

function findParentIdInTree(threads, targetId, currentParentId = null) {
  if (!Array.isArray(threads) || !targetId) return null;
  for (const node of threads) {
    if (node.id === targetId) return currentParentId;
    if (Array.isArray(node.children) && node.children.length > 0) {
      const found = findParentIdInTree(node.children, targetId, node.id);
      if (found) return found;
    }
  }
  return null;
}

export function resolveParentThreadId(t, targetId) {
  const direct = t?.parentId || t?.parentConversationId;
  if (direct) return String(direct).trim();
  return findParentIdInTree(state.snapshot?.threads, targetId || t?.id) || '';
}

export function isZeroMessageThread(t, cachedDetail) {
  if (!t) return true;
  if (t.isNewEmptySession || t.isNewSession || t.isEmpty) return true;
  const hasTurns = Array.isArray(cachedDetail?.turns) && cachedDetail.turns.length > 0;
  if (hasTurns) return false;
  const steps = Number(t.stepCount || 0);
  const tokIn = Number(t.tokens?.input || 0);
  const tokOut = Number(t.tokens?.output || 0);
  const tokCache = Number(t.tokens?.cacheRead || 0);
  const genImgs = Number(t.tokens?.generatedImages || 0);
  const kids = Array.isArray(t.children) ? t.children.length : 0;
  return (
    steps === 0 &&
    tokIn === 0 &&
    tokOut === 0 &&
    tokCache === 0 &&
    genImgs === 0 &&
    kids === 0 &&
    !t.isGenerating
  );
}

export function isPlaceholderTitle(raw, id) {
  const s = String(raw || '').trim();
  if (!s) return true;
  if (id && (s === id || s === id.slice(0, 8))) return true;
  return /^(unknown|untitled|new chat|new conversation|未命名|新对话)$/i.test(s);
}

export function isPlaceholderModel(raw) {
  const s = String(raw || '').trim();
  if (!s) return true;
  return /^(model|unknown|—|-|none|未指定)$/i.test(s);
}

export function createEmptyHostThreadStub(id) {
  const defaultSoft = resolveDefaultSoftLimit();
  return {
    id,
    isNewEmptySession: true,
    title: tr('当前新会话', 'New Conversation'),
    status: 'idle',
    isGenerating: false,
    stepCount: 0,
    kind: 'conversation',
    model: {
      fullName: '',
      shortName: '',
      rawSlug: '',
      softLimit: defaultSoft,
      maxWindow: 1_048_576,
    },
    cost: {
      selfUsd: 0,
      childrenUsd: 0,
      treeUsd: 0,
      inputUsd: 0,
      cacheUsd: 0,
      outputUsd: 0,
      imageUsd: 0,
      treeImageUsd: 0,
      savedCacheUsd: 0,
    },
    waterline: {
      currentTokens: 0,
      cachedTokens: 0,
      freshTokens: 0,
      softLimit: defaultSoft,
      maxWindow: 1_048_576,
    },
    tokens: {
      input: 0,
      output: 0,
      thinking: 0,
      response: 0,
      cacheRead: 0,
      generatedImages: 0,
      treeGeneratedImages: 0,
      cacheHitRatio: 0,
    },
    tps: {
      live: 0,
      rolling: 0,
      latestDecode: 0,
    },
    compaction: {
      count: 0,
      latestStepIndex: null,
    },
    children: [],
  };
}

export function resolveThreadCategory(t) {
  if (!t) return 'conversation';
  if (t.category === 'cli' || t.surface === 'cli') return 'cli';
  if (
    t.category === 'project' ||
    (t.project && typeof t.project === 'object' && (t.project.id || t.project.name)) ||
    (typeof t.project === 'string' && t.project.trim() !== '')
  ) {
    return 'project';
  }
  return 'conversation';
}

export function resolveProjectLabel(t) {
  if (!t) return '';
  if (typeof t.project === 'string') return t.project.trim();
  if (t.project && typeof t.project === 'object') {
    return String(t.project.name || t.project.id || '').trim();
  }
  return String(t.projectName || '').trim();
}

export function resolveProjectKey(t) {
  if (!t || resolveThreadCategory(t) !== 'project') return '';
  if (t.projectKey) return String(t.projectKey).trim();
  if (t.project && typeof t.project === 'object' && t.project.id) {
    return String(t.project.id).trim();
  }
  const firstWs = Array.isArray(t.workspaceUris) ? t.workspaceUris[0] : '';
  const normWs = normalizeUri(firstWs);
  if (normWs) return normWs;
  return resolveProjectLabel(t);
}

export function formatWorkspacePathShort(uri) {
  let s = String(uri || '').trim();
  if (!s) return '';
  try {
    s = decodeURIComponent(s);
  } catch {
    // keep raw
  }
  s = s.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length <= 2) return s;
  return parts.slice(-2).join('/');
}

export function formatChildDisplayName(ch) {
  if (!ch) return '';
  if (ch.kind === 'btw') {
    const title = String(ch.title || '').trim();
    if (!title) return `/btw ${ch.id?.slice(0, 8) || ''}`;
    return /^\/btw\b/i.test(title) ? title : `/btw ${title}`;
  }
  return String(ch.roleLabel || ch.title || ch.id?.slice(0, 8) || '');
}

export function getModelsBreakdown(t) {
  const list =
    (Array.isArray(t?.cost?.byModel) && t.cost.byModel) ||
    (Array.isArray(t?.model?.byModel) && t.model.byModel) ||
    (Array.isArray(t?.modelsUsed) && t.modelsUsed) ||
    [];
  return list.filter((m) => m && (m.rawSlug || m.shortName || m.fullName));
}

export function isTurnCanaryRouted(turn) {
  const r = turn?.routing || turn?.model || {};
  if (r.isCanary || r.isCanaryRouted || r.isUnknownModel || turn?.isCanary) {
    return true;
  }
  return (
    Array.isArray(turn?.steps) &&
    turn.steps.some((s) => s && (s.isCanary || s.isCanaryRouted || s.isUnknownModel))
  );
}

export function resolveTurnCanaryBadge(turn) {
  const r = turn?.routing || turn?.model || {};
  if (r.isUnknownModel) return tr('新模型', 'Unlisted');
  if (!isTurnCanaryRouted(turn)) return '';
  let tag = String(r.canaryTag || '').trim();
  if (!tag && Array.isArray(turn?.steps)) {
    const cs = turn.steps.find(
      (s) => s && (s.isCanary || s.isCanaryRouted) && s.canaryTag
    );
    if (cs) tag = String(cs.canaryTag).trim();
  }
  if (tag && tag.length <= 10 && !tag.includes('→')) return `${tr('路由', 'Routing')} ${tag}`;
  return tr('模型路由', 'Routing');
}

export function resolveStepCanaryBadge(step) {
  if (!step) return '';
  if (step.isUnknownModel) return tr('新模型', 'Unlisted');
  if (!(step.isCanary || step.isCanaryRouted)) return '';
  const tag = String(step.canaryTag || '').trim();
  return tag && tag.length <= 10 && !tag.includes('→')
    ? `${tr('路由', 'Routing')} ${tag}`
    : tr('模型路由', 'Routing');
}

export function extractTurnCompactionEvent(turn) {
  if (!turn) return null;
  const raw =
    (turn.compactionEvent && typeof turn.compactionEvent === 'object' && turn.compactionEvent) ||
    (turn.compactedBefore && typeof turn.compactedBefore === 'object' && turn.compactedBefore) ||
    null;
  if (raw) {
    return {
      index: raw.index ?? raw.number ?? null,
      stepIndex: raw.stepIndex ?? null,
      beforeTokens: Number(raw.beforeTokens || 0),
      afterTokens: Number(raw.afterTokens || 0),
    };
  }
  if (turn.compactedBefore === true) {
    return { index: null, stepIndex: null, beforeTokens: 0, afterTokens: 0 };
  }
  return null;
}

export function threadMatchesWorkspace(t, normWsSet) {
  if (normWsSet.size === 0) return true;
  const uris = Array.isArray(t.workspaceUris) ? t.workspaceUris : [];
  for (const u of uris) {
    const nu = normalizeUri(u);
    for (const target of normWsSet) {
      if (nu === target || nu.startsWith(`${target}/`) || target.startsWith(`${nu}/`)) {
        return true;
      }
    }
  }
  if (Array.isArray(t.children)) {
    return t.children.some((c) => threadMatchesWorkspace(c, normWsSet));
  }
  return false;
}

export function computeTreeTokenSums(node) {
  if (!node) return { input: 0, output: 0, cacheRead: 0, savedUsd: 0 };
  let savedUsd = Number(node.cost?.savedCacheUsd || 0);
  if (Array.isArray(node.children)) {
    for (const ch of node.children) {
      savedUsd += computeTreeTokenSums(ch).savedUsd;
    }
  }
  if (node.treeTokens && typeof node.treeTokens === 'object') {
    return {
      input: Number(node.treeTokens.input || 0),
      output: Number(node.treeTokens.output || 0),
      cacheRead: Number(node.treeTokens.cacheRead || 0),
      savedUsd,
    };
  }
  if (node.tokens?.treeInput !== undefined && node.tokens?.treeCacheRead !== undefined) {
    return {
      input: Number(node.tokens.treeInput || 0),
      output: Number(node.tokens.treeOutput || node.tokens.output || 0),
      cacheRead: Number(node.tokens.treeCacheRead || 0),
      savedUsd,
    };
  }
  let input = Number(node.tokens?.input || 0);
  let output = Number(node.tokens?.output || 0);
  let cacheRead = Number(node.tokens?.cacheRead || 0);
  if (Array.isArray(node.children)) {
    for (const ch of node.children) {
      const sub = computeTreeTokenSums(ch);
      input += sub.input;
      output += sub.output;
      cacheRead += sub.cacheRead;
    }
  }
  return { input, output, cacheRead, savedUsd };
}

export function computeHitRatio(input, cacheRead, explicitRatio) {
  const inp = Math.max(0, Number(input) || 0);
  const cr = Math.max(0, Number(cacheRead) || 0);
  const denom = inp + cr;
  if (denom <= 0) {
    return explicitRatio != null &&
      Number.isFinite(Number(explicitRatio)) &&
      Number(explicitRatio) > 0
      ? Number(explicitRatio)
      : null;
  }
  return cr / denom;
}

export function getSingleStreamNodeTps(node) {
  if (!node) return 0;
  const explicitStreamAvg =
    node.tps?.avgStream ?? node.tps?.streamAvg ?? node.tps?.avgStreamTps;
  if (explicitStreamAvg !== undefined && Number(explicitStreamAvg) > 0) {
    return Number(explicitStreamAvg);
  }
  const kids = Array.isArray(node.children) ? node.children : [];
  const activeKids = kids.filter((c) => isThreadTreeActive(c));
  if (!node.isGenerating && activeKids.length > 0) {
    const kidRates = activeKids
      .map((c) => getSingleStreamNodeTps(c))
      .filter((v) => v > 0);
    if (kidRates.length > 0) {
      return kidRates.reduce((a, b) => a + b, 0) / kidRates.length;
    }
  }
  if (isNodeRunning(node) && node.tps?.live !== undefined && Number(node.tps.live) > 0) {
    return Number(node.tps.live);
  }
  return Number(node.tps?.rolling || node.tps?.latestDecode || 0);
}

export function getThreadTimingMetrics(t, baseClientMs = state.snapshotClientMs) {
  const tm = t?.timing || {};
  const isLive = Boolean(tm.isLiveTicking || isThreadTreeActive(t));
  const rawTotal = Number(
    tm.totalDurationSec ??
      tm.llmDurationSec ??
      (t?.isGenerating ? t?.generatingElapsedSec : 0) ??
      0
  );
  const llmSec = Number(tm.llmDurationSec ?? 0);
  const treeLlmSec = Number(tm.treeLlmDurationSec ?? llmSec);
  const avgTtftSec = Number(tm.avgTtftSec ?? 0);
  const latestTtftSec = Number(tm.latestTtftSec ?? t?.tps?.latestTtftSec ?? 0);
  const ttftSec = avgTtftSec > 0 ? avgTtftSec : latestTtftSec;
  const deltaSec =
    isLive && (tm.isLiveTicking || rawTotal > 0) && baseClientMs > 0
      ? Math.max(0, (Date.now() - baseClientMs) / 1000)
      : 0;
  return {
    totalSec: rawTotal > 0 || tm.isLiveTicking ? rawTotal + deltaSec : 0,
    llmSec,
    treeLlmSec,
    avgTtftSec,
    latestTtftSec,
    ttftSec,
    isLive,
  };
}

export function getTurnTimingMetrics(turn, threadId) {
  const isLive = Boolean(turn?.isLive || turn?.isGenerating);
  const stepsDur = Array.isArray(turn?.steps)
    ? turn.steps.reduce((acc, s) => acc + (Number(s?.durationSec) || 0), 0)
    : 0;
  const baseDur = Number(
    turn?.durationSec ?? turn?.llmDurationSec ?? (stepsDur > 0 ? stepsDur : 0)
  );
  const llmSec = Number(turn?.llmDurationSec ?? (stepsDur > 0 ? stepsDur : 0));
  const ttftSec = Number(turn?.tps?.ttftSec ?? turn?.ttftSec ?? 0);
  const baseMs = state.detailClientMs.get(threadId) || state.snapshotClientMs;
  const deltaSec =
    isLive && (turn?.isLive || baseDur > 0) && baseMs > 0
      ? Math.max(0, (Date.now() - baseMs) / 1000)
      : 0;
  return {
    durationSec: baseDur > 0 || turn?.isLive ? baseDur + deltaSec : 0,
    llmSec,
    ttftSec,
    isLive,
  };
}

function chooseDefaultCategory(allRoots) {
  const counts = { conversation: 0, project: 0, cli: 0 };
  for (const r of allRoots) {
    const cat = resolveThreadCategory(r);
    counts[cat] = (counts[cat] || 0) + 1;
  }

  if (state.hostConvId) {
    const hostRoot = allRoots.find((r) => isCurrentHostThread(r));
    if (hostRoot) {
      const hostCat = resolveThreadCategory(hostRoot);
      if (counts[hostCat] > 0) return hostCat;
    }
  }

  if (counts.conversation > 0) return 'conversation';
  if (counts.project > 0) return 'project';
  if (counts.cli > 0) return 'cli';
  return 'all';
}

export function getVisibleThreadsAndTotals() {
  const allRoots = state.snapshot?.threads || [];
  const normWsSet = new Set(state.workspaceUris.map(normalizeUri).filter(Boolean));
  const wsMatches =
    normWsSet.size > 0
      ? allRoots.filter((t) => threadMatchesWorkspace(t, normWsSet))
      : [];
  const canFilterWs =
    normWsSet.size > 0 && wsMatches.length > 0 && wsMatches.length < allRoots.length;

  let effectiveScope = state.scope;
  if (effectiveScope === 'auto') {
    effectiveScope = chooseDefaultCategory(allRoots);
  } else if (effectiveScope === 'workspace' && !canFilterWs) {
    effectiveScope = chooseDefaultCategory(allRoots);
  }

  let roots;
  if (effectiveScope === 'workspace') {
    roots = wsMatches.slice();
  } else if (effectiveScope === 'issues') {
    roots = allRoots.filter(
      (t) => Number(t.issues?.treeTotal ?? t.issues?.total ?? 0) > 0
    );
  } else if (
    effectiveScope === 'conversation' ||
    effectiveScope === 'project' ||
    effectiveScope === 'cli'
  ) {
    roots = allRoots.filter((t) => resolveThreadCategory(t) === effectiveScope);
  } else {
    effectiveScope = 'all';
    roots = allRoots.slice();
  }

  roots.sort((a, b) => {
    const aHost = isCurrentHostThread(a) ? 1 : 0;
    const bHost = isCurrentHostThread(b) ? 1 : 0;
    if (aHost !== bHost) return bHost - aHost;
    const aAct = isThreadTreeActive(a) ? 1 : 0;
    const bAct = isThreadTreeActive(b) ? 1 : 0;
    if (aAct !== bAct) return bAct - aAct;
    return 0;
  });

  let costUsd = 0;
  let activeCount = 0;
  let treeInputSum = 0;
  let treeCacheReadSum = 0;
  let savedCacheUsdSum = 0;

  const activeStreamRates = [];
  let totalBurnTps = 0;

  const collectActiveStreams = (node) => {
    if (!node) return;
    const kids = Array.isArray(node.children) ? node.children : [];
    const anyKidActive = kids.some((c) => isThreadTreeActive(c));
    const selfActive =
      node.isGenerating || (node.status === 'working' && !anyKidActive);
    if (selfActive) {
      const rate = Number(
        (node.tps?.live !== undefined && Number(node.tps.live) > 0
          ? node.tps.live
          : node.tps?.rolling || node.tps?.latestDecode) || 0
      );
      if (rate > 0) {
        activeStreamRates.push(rate);
        totalBurnTps += rate;
      }
    }
    for (const ch of kids) collectActiveStreams(ch);
  };

  for (const r of roots) {
    costUsd += Number(r.cost?.treeUsd ?? r.cost?.selfUsd ?? 0);
    const tSums = computeTreeTokenSums(r);
    treeInputSum += tSums.input;
    treeCacheReadSum += tSums.cacheRead;
    savedCacheUsdSum += tSums.savedUsd;
    if (isThreadTreeActive(r)) {
      activeCount += 1;
      collectActiveStreams(r);
    }
  }

  if (effectiveScope === 'all' && state.snapshot?.totals) {
    const tot = state.snapshot.totals;
    if (tot.costUsd !== undefined) {
      costUsd = Number(tot.costUsd) || costUsd;
    }
    if (tot.inputTokens !== undefined && tot.cacheReadTokens !== undefined) {
      treeInputSum = Number(tot.inputTokens) || treeInputSum;
      treeCacheReadSum = Number(tot.cacheReadTokens) || treeCacheReadSum;
    }
  }

  let avgStreamTps = 0;
  if (activeStreamRates.length > 0) {
    avgStreamTps =
      activeStreamRates.reduce((a, b) => a + b, 0) / activeStreamRates.length;
  } else {
    const baselinePool = roots.length > 0 ? roots : allRoots;
    const recentRates = [];
    for (const r of baselinePool) {
      const rate = getSingleStreamNodeTps(r);
      if (rate > 0) {
        recentRates.push(rate);
        if (recentRates.length >= 5) break;
      }
    }
    if (recentRates.length > 0) {
      avgStreamTps = recentRates.reduce((a, b) => a + b, 0) / recentRates.length;
    }
  }

  if (effectiveScope === 'all' && state.snapshot?.totals) {
    const tot = state.snapshot.totals;
    if (tot.avgStreamTps !== undefined && Number(tot.avgStreamTps) > 0) {
      avgStreamTps = Number(tot.avgStreamTps);
    }
    if (activeCount > 0 && tot.totalBurnTps !== undefined) {
      totalBurnTps = Number(tot.totalBurnTps) || totalBurnTps;
    }
  }

  if (activeCount === 0) {
    totalBurnTps = 0;
  }

  const ttftPool = roots.length > 0 ? roots : allRoots;
  const ttfts = [];
  for (const r of ttftPool) {
    const v = Number(r.tps?.latestTtftSec || 0);
    if (v > 0) {
      ttfts.push(v);
      if (ttfts.length >= 5) break;
    }
  }
  const avgTtftSec =
    ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null;

  const cacheHitRatio = computeHitRatio(
    treeInputSum,
    treeCacheReadSum,
    effectiveScope === 'all' ? state.snapshot?.totals?.cacheHitRatio : null
  );

  return {
    roots,
    canFilterWs,
    effectiveScope,
    costUsd,
    activeCount,
    activeStreamCount: activeStreamRates.length,
    avgStreamTps,
    totalBurnTps,
    avgTtftSec,
    cacheHitRatio,
    treeInputSum,
    treeCacheReadSum,
    savedCacheUsdSum,
  };
}

function getCliBatchPrefix(t) {
  if (resolveThreadCategory(t) !== 'cli') return '';
  if (isThreadTreeActive(t) || isCurrentHostThread(t)) return '';
  if (Array.isArray(t.children) && t.children.length > 0) return '';
  const clean = String(t.title || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 8) return '';
  return clean.slice(0, 16);
}

export function buildDisplayItems(roots) {
  const items = [];
  let i = 0;
  while (i < roots.length) {
    const lead = roots[i];
    const prefix = getCliBatchPrefix(lead);
    if (!prefix) {
      items.push({ lead, batchSiblings: [] });
      i += 1;
      continue;
    }
    const siblings = [];
    let j = i + 1;
    while (j < roots.length && getCliBatchPrefix(roots[j]) === prefix) {
      siblings.push(roots[j]);
      j += 1;
    }
    items.push({ lead, batchSiblings: siblings });
    i = j;
  }
  return items;
}

export function isDetailChildrenExpanded(threadId, childrenCount) {
  if (state.expandedDetailChildren.has(threadId)) return true;
  if (state.collapsedDetailChildren.has(threadId)) return false;
  const param = initialSearchParams.get('expandChildren');
  if (param === '0') return false;
  if (param === '1') return true;
  return childrenCount > 0 && childrenCount <= 10;
}

export function isDetailIssuesExpanded(threadId, issueCount) {
  if (state.expandedDetailIssues.has(threadId)) return true;
  if (state.collapsedDetailIssues.has(threadId)) return false;
  return issueCount > 0 && issueCount <= 5;
}
