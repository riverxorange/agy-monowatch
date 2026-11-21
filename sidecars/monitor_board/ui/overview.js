/**
 * Top-level peer views:
 *   总览  macro subscription ROI, per-model performance, cloud review
 *   对话  standalone conversations
 *   项目  concrete project ranking -> single-project sessions
 *   CLI   headless CLI calls & auto-grouped batch runs
 *
 * All four peer tabs share the global time window selector in the header.
 */

import { appEl, sidecarFetch, state } from './state.js';
import {
  encodeTip,
  escapeHtml,
  setClass,
  setDisplay,
  setHtmlCached,
  setText,
  setTip,
} from './dom.js';
import {
  BACK_CHEVRON_SVG,
  CANARY_SIGNAL_CATEGORIES,
  CLOUD_SIGNAL_CATEGORIES,
  buildRowDotsCompactSvg,
  classifyCanaryCategory,
  cleanCloudEventBody,
  computeDotAllocation,
  describeCanaryCategory,
  describeIssueCategory,
  formatCanaryCategoryLabel,
  formatDuration,
  formatIssueCategoryLabel,
  formatTimestampShort,
  formatTokensCompact,
  formatTtft,
  formatUsd,
  getCanaryBadgeClass,
  getIssueBadgeClass,
  normalizeUri,
  renderModelFamilyGlyph,
  resolveThreadSoftLimit,
} from './format.js';
import { getDotPalette } from './theme.js';
import {
  buildDisplayItems,
  computeHitRatio,
  computeTreeTokenSums,
  formatChildDisplayName,
  formatWorkspacePathShort,
  getModelsBreakdown,
  getSingleStreamNodeTps,
  getThreadTimingMetrics,
  isCurrentHostThread,
  isPlaceholderModel,
  isPlaceholderTitle,
  isThreadTreeActive,
  isThreadTreeGenerating,
  isZeroMessageThread,
  resolveProjectKey,
  resolveProjectLabel,
  resolveThreadCategory,
  threadMatchesWorkspace,
} from './selectors.js';
import { buildChildRowTip, buildCostTip, buildWaterlineTip } from './tooltips.js';
import {
  PLAN_OPTIONS,
  computeRoiDots,
  formatMonthDay,
  resolvePlanLabel,
  resolveWindow,
} from './period.js';
import { LANG_OPTIONS, isEn, tr } from './i18n.js';

let ovShell = null;

export function invalidateOverviewShell() {
  ovShell = null;
}

function getMainTabs() {
  return [
    ['overview', tr('总览', 'Overview')],
    ['conversation', tr('对话', 'Conversations')],
    ['project', tr('项目', 'Projects')],
    ['cli', 'CLI'],
    ['cloud', tr('事件', 'Events')],
    ['canary', tr('路由', 'Routing')],
  ];
}

// ---------------------------------------------------------------------------
// Aggregation helpers over daily buckets
// ---------------------------------------------------------------------------

function emptyAgg() {
  return {
    usd: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    images: 0,
    decOut: 0,
    decSec: 0,
    ttftSum: 0,
    ttftCnt: 0,
    inUsd: 0,
    crUsd: 0,
    outUsd: 0,
  };
}

function addBucket(agg, b) {
  agg.usd += Number(b[0]) || 0;
  agg.input += Number(b[1]) || 0;
  agg.cacheRead += Number(b[2]) || 0;
  agg.output += Number(b[3]) || 0;
  agg.images += Number(b[5]) || 0;
  agg.decOut += Number(b[6]) || 0;
  agg.decSec += Number(b[7]) || 0;
  agg.ttftSum += Number(b[8]) || 0;
  agg.ttftCnt += Number(b[9]) || 0;
  agg.inUsd += Number(b[10]) || 0;
  agg.crUsd += Number(b[11]) || 0;
  agg.outUsd += Number(b[12]) || 0;
}

function addModelBucket(agg, b) {
  if (Array.isArray(b)) {
    agg.usd += Number(b[0]) || 0;
    agg.input += Number(b[1]) || 0;
    agg.cacheRead += Number(b[2]) || 0;
    agg.output += Number(b[3]) || 0;
    agg.decOut += Number(b[4]) || 0;
    agg.decSec += Number(b[5]) || 0;
    agg.ttftSum += Number(b[6]) || 0;
    agg.ttftCnt += Number(b[7]) || 0;
  } else {
    agg.usd += Number(b) || 0;
  }
}

function foldDaily(daily, win, ...aggs) {
  if (!daily) return;
  for (const key of Object.keys(daily)) {
    if (key < win.startKey || key >= win.endKey) continue;
    const b = daily[key];
    if (!Array.isArray(b)) continue;
    for (const a of aggs) addBucket(a, b);
  }
}

function sumWindowUsd(daily, win) {
  if (!daily) return 0;
  let usd = 0;
  for (const key of Object.keys(daily)) {
    if (key < win.startKey || key >= win.endKey) continue;
    usd += Number(daily[key]?.[0]) || 0;
  }
  return usd;
}

function aggCacheHit(a) {
  const d = a.input + a.cacheRead;
  return d > 0 ? a.cacheRead / d : null;
}

function aggTps(a) {
  return a.decSec > 0 ? a.decOut / a.decSec : 0;
}

function aggTtft(a) {
  return a.ttftCnt > 0 ? a.ttftSum / a.ttftCnt : 0;
}

function nodeDaily(n) {
  return n?.cost?.treeDaily || n?.cost?.daily || null;
}

function nodeDailyModels(n) {
  return n?.cost?.treeDailyModels || n?.cost?.dailyModels || null;
}

function modelFamilyName(name) {
  const s = String(name || '').trim();
  const orchMatch = s.match(/^Orchestrator\s*\((Carbon|Argon|Hydrogen|Neon)\)$/i);
  if (orchMatch) {
    const fam = orchMatch[1].charAt(0).toUpperCase() + orchMatch[1].slice(1).toLowerCase();
    return `Gemini 4 ${fam}`;
  }
  const stripped = s
    .replace(
      /\s*\((extra[\s_-]?high|x?high|medium|low|minimal|thinking|default|lite|orchestrator)\)\s*$/i,
      ''
    )
    .trim();
  return stripped || s || tr('其他', 'Other');
}

function wsMatches(key, normWsSet) {
  for (const t of normWsSet) {
    if (key === t || key.startsWith(`${t}/`) || t.startsWith(`${key}/`)) return true;
  }
  return false;
}

function spanIntersectsWindow(span, win) {
  if (win.kind === 'all') return true;
  if (typeof span === 'string') {
    return span >= win.startKey && span < win.endKey;
  }
  if (Array.isArray(span) && span.length >= 2) {
    return span[1] >= win.startKey && span[0] < win.endKey;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function computeOverviewModel() {
  const snap = state.snapshot || {};
  const recent = Array.isArray(snap.threads) ? snap.threads : [];
  const archive = snap.archive || {};
  const settings = state.settings || {};
  const win = resolveWindow(state.timeWindow, settings.billingDay);

  const normWsSet = new Set((state.workspaceUris || []).map(normalizeUri).filter(Boolean));
  const wsRootIds = new Set();
  if (normWsSet.size > 0) {
    for (const r of recent) if (threadMatchesWorkspace(r, normWsSet)) wsRootIds.add(r.id);
  }

  const total = emptyAgg();
  const byCat = { conversation: emptyAgg(), project: emptyAgg(), cli: emptyAgg() };
  const catCounts = { conversation: 0, project: 0, cli: 0 };
  const byModel = new Map();
  const projectsMap = new Map();
  const rootUsd = new Map();

  const ensureProject = (key, name, firstWs) => {
    let p = projectsMap.get(key);
    if (!p) {
      p = {
        key,
        name: name || key,
        workspaceUri: firstWs || '',
        pathShort: formatWorkspacePathShort(firstWs || ''),
        isCurrentWs: false,
        isActive: false,
        sessionCount: 0,
        latestMs: 0,
        agg: emptyAgg(),
      };
      projectsMap.set(key, p);
    } else {
      if (!p.workspaceUri && firstWs) {
        p.workspaceUri = firstWs;
        p.pathShort = formatWorkspacePathShort(firstWs);
      }
      if ((!p.name || p.name === p.key) && name) {
        p.name = name;
      }
    }
    return p;
  };

  const foldModels = (dm) => {
    if (!dm) return;
    for (const key of Object.keys(dm)) {
      if (key < win.startKey || key >= win.endKey) continue;
      for (const [name, v] of Object.entries(dm[key] || {})) {
        const fam = modelFamilyName(name);
        let entry = byModel.get(fam);
        if (!entry) {
          entry = emptyAgg();
          byModel.set(fam, entry);
        }
        addModelBucket(entry, v);
      }
    }
  };

  for (const r of recent) {
    const own = emptyAgg();
    const cat = resolveThreadCategory(r);
    const active = isThreadTreeActive(r);
    const currentHost = isCurrentHostThread(r);

    foldDaily(nodeDaily(r), win, own, total, byCat[cat]);
    const ownWinUsd = win.kind === 'all' ? Number(r.cost?.treeUsd ?? r.cost?.selfUsd ?? own.usd) : own.usd;
    rootUsd.set(r.id, ownWinUsd);
    foldModels(nodeDailyModels(r));

    const inWin = win.kind === 'all' || ownWinUsd > 0 || active || currentHost;
    if (inWin) catCounts[cat] = (catCounts[cat] || 0) + 1;

    if (cat === 'project') {
      const pKey = resolveProjectKey(r);
      if (pKey) {
        const firstWs = Array.isArray(r.workspaceUris) ? r.workspaceUris[0] || '' : '';
        const p = ensureProject(pKey, resolveProjectLabel(r), firstWs);
        foldDaily(nodeDaily(r), win, p.agg);
        if (wsRootIds.has(r.id)) p.isCurrentWs = true;
        if (active) p.isActive = true;
        if (inWin) p.sessionCount += 1;
        p.latestMs = Math.max(p.latestMs, Number(r.updatedAtMs) || 0);
      }
    }
  }

  for (const cat of Object.keys(byCat)) {
    foldDaily(archive.byCategory?.[cat], win, total, byCat[cat]);
    if (win.kind === 'all') {
      catCounts[cat] += Number(archive.catCounts?.[cat]) || 0;
    } else {
      const dayMap = archive.catDayCounts?.[cat] || {};
      for (const dk of Object.keys(dayMap)) {
        if (dk >= win.startKey && dk < win.endKey) {
          catCounts[cat] += Number(dayMap[dk]) || 0;
        }
      }
    }
  }

  for (const [pKey, pArc] of Object.entries(archive.byProject || {})) {
    const firstWs = Array.isArray(pArc.workspaceUris) ? pArc.workspaceUris[0] || '' : '';
    const p = ensureProject(pKey, pArc.name, firstWs);
    foldDaily(pArc.daily, win, p.agg);
    if (normWsSet.size > 0) {
      for (const u of pArc.workspaceUris || []) {
        const nu = normalizeUri(u);
        if (nu && wsMatches(nu, normWsSet)) p.isCurrentWs = true;
      }
    }
    if (win.kind === 'all') {
      p.sessionCount += Number(pArc.count) || 0;
    } else if (Array.isArray(pArc.spans)) {
      for (const sp of pArc.spans) {
        if (spanIntersectsWindow(sp, win)) p.sessionCount += 1;
      }
    }
    p.latestMs = Math.max(p.latestMs, Number(pArc.latestMs) || 0);
  }

  foldModels(archive.models);

  const projects = Array.from(projectsMap.values())
    .filter((p) => p.sessionCount > 0 || p.agg.usd > 0 || p.isCurrentWs || p.isActive)
    .sort((a, b) => {
      const aw = a.isCurrentWs ? 1 : 0;
      const bw = b.isCurrentWs ? 1 : 0;
      if (aw !== bw) return bw - aw;
      const aa = a.isActive ? 1 : 0;
      const ba = b.isActive ? 1 : 0;
      if (aa !== ba) return ba - aa;
      if (Math.abs(b.agg.usd - a.agg.usd) > 1e-6) return b.agg.usd - a.agg.usd;
      return b.latestMs - a.latestMs;
    });

  if (state.selectedProjectKey) {
    const sel = projectsMap.get(state.selectedProjectKey);
    state.selectedProjectName = sel?.name || '';
  } else {
    state.selectedProjectName = '';
  }

  // Cloud signals
  const cats = CLOUD_SIGNAL_CATEGORIES;
  const summary = snap.issuesSummary || {};
  const allEvents = [
    ...(Array.isArray(summary.events) ? summary.events : []),
    ...(Array.isArray(archive.events) ? archive.events : []),
  ].filter((ev) => ev && cats.includes(ev.category));
  const windowEvents = allEvents
    .filter((ev) => {
      if (win.kind === 'all') return true;
      const ms = (Number(ev.timestampSec) || 0) * 1000;
      return ms >= win.startMs && ms < win.endMs;
    })
    .sort((a, b) => (Number(b.timestampSec) || 0) - (Number(a.timestampSec) || 0));
  const signalCounts = Object.fromEntries(cats.map((c) => [c, 0]));
  if (win.kind === 'all') {
    for (const c of cats) {
      signalCounts[c] = (Number(summary.counts?.[c]) || 0) + (Number(archive.issueCounts?.[c]) || 0);
    }
  } else {
    for (const ev of windowEvents) {
      signalCounts[ev.category] += 1;
    }
  }

  // Model routing hits
  const canaryCats = CANARY_SIGNAL_CATEGORIES;
  const seenCanaryKeys = new Set();
  const rawCanaryHits = [
    ...(Array.isArray(snap.canaryHits) ? snap.canaryHits : []),
    ...(Array.isArray(archive.canaryHits) ? archive.canaryHits : []),
  ];
  const windowCanaryHits = [];
  for (const h of rawCanaryHits) {
    if (!h || !h.rawSlug) continue;
    const dedupKey = `${h.threadId || ''}|${h.rawSlug}`;
    if (seenCanaryKeys.has(dedupKey)) continue;
    seenCanaryKeys.add(dedupKey);
    if (win.kind !== 'all') {
      const ms = (Number(h.timestampSec) || 0) * 1000;
      if (!(ms >= win.startMs && ms < win.endMs)) continue;
    }
    windowCanaryHits.push({
      ...h,
      category: classifyCanaryCategory(h),
    });
  }
  windowCanaryHits.sort((a, b) => (Number(b.timestampSec) || 0) - (Number(a.timestampSec) || 0));
  const canaryCounts = Object.fromEntries(canaryCats.map((c) => [c, 0]));
  for (const h of windowCanaryHits) {
    canaryCounts[h.category] = (canaryCounts[h.category] || 0) + 1;
  }

  let activeCount = 0;
  for (const r of recent) {
    if (isThreadTreeActive(r)) activeCount += 1;
  }

  let earliestKey = '';
  for (const r of recent) {
    for (const k of Object.keys(nodeDaily(r) || {})) if (!earliestKey || k < earliestKey) earliestKey = k;
  }
  for (const d of Object.values(archive.byCategory || {})) {
    for (const k of Object.keys(d || {})) if (!earliestKey || k < earliestKey) earliestKey = k;
  }

  return {
    settings,
    win,
    recent,
    archive,
    rootUsd,
    wsRootIds,
    normWsSet,
    total,
    byCat,
    catCounts,
    projects,
    projectsMap,
    byModel,
    signalCounts,
    signalCats: cats,
    windowEvents,
    canaryCounts,
    canaryCats,
    windowCanaryHits,
    activeCount,
    earliestKey,
    sessionCount: recent.length + (Number(archive.count) || 0),
  };
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const BRAND_LOGO_SVG = `<svg class="ov-brand-logo" width="28" height="28" viewBox="0 0 256 256" fill="none" aria-hidden="true"><rect x="233" y="109" width="13" height="38" rx="5" fill="var(--ink-primary)"/><circle cx="124" cy="128" r="106" fill="var(--bg-canvas)" stroke="var(--ink-primary)" stroke-width="13"/><circle cx="124" cy="52" r="8.8" fill="var(--ink-primary)"/><circle cx="162" cy="62.2" r="8.8" fill="var(--ink-primary)"/><circle cx="189.8" cy="90" r="8.8" fill="var(--ink-primary)"/><circle cx="200" cy="128" r="8.8" fill="var(--ink-primary)"/><circle cx="189.8" cy="166" r="8.8" fill="var(--ink-primary)"/><circle cx="162" cy="193.8" r="8.8" fill="var(--ink-primary)"/><circle cx="124" cy="204" r="8.8" fill="var(--ink-primary)"/><circle cx="86" cy="193.8" r="8.8" fill="var(--ink-primary)"/><circle cx="58.2" cy="166" r="11.5" fill="var(--accent-mint)"/><circle cx="48" cy="128" r="6.8" fill="var(--dot-free)"/><circle cx="58.2" cy="90" r="6.8" fill="var(--dot-free)"/><circle cx="86" cy="62.2" r="6.8" fill="var(--dot-free)"/><line x1="124" y1="128" x2="91.2" y2="109.1" stroke="var(--ink-primary)" stroke-width="10.8" stroke-linecap="round"/><line x1="124" y1="128" x2="171.2" y2="100.7" stroke="var(--ink-primary)" stroke-width="8.8" stroke-linecap="round"/><circle cx="124" cy="128" r="10.2" fill="var(--ink-primary)"/><circle cx="124" cy="128" r="4.6" fill="var(--accent-mint)"/></svg>`;

function ensureOverviewShell() {
  if (ovShell && ovShell.root.parentNode === appEl) return ovShell;
  appEl.innerHTML = `
    <div class="view-overview" data-shell="overview-v2">
      <header class="ov2-top sec-pad tnum">
        <span class="ov-brand-group">
          <button type="button" class="ov-brand" data-main-tab="overview">
            ${BRAND_LOGO_SVG}
            <span class="ov-brand-word">monowatch</span>
          </button>
          <button type="button" class="nav-link ov2-current" data-open-thread="" style="display:none">${tr('当前会话', 'Current')}</button>
        </span>
        <nav class="ov2-wins" aria-label="${tr('时间范围', 'Time window')}"></nav>
      </header>
      <div class="ov2-nav-bar sec-pad tnum">
        <nav class="ov2-tabs" aria-label="${tr('主导航', 'Navigation')}"></nav>
        <span class="ov2-nav-right">
          <button type="button" class="nav-link ov2-update" data-action="apply-update" style="display:none"></button>
          <span class="ov2-live" style="display:none"><span class="hdr-dot-live is-pulsing"></span><span class="ov2-live-text"></span></span>
        </span>
      </div>
      <div class="ov2-pane-overview">
        <section class="ov2-hero sec-pad"></section>
        <section class="ov2-setup sec-pad" style="display:none"></section>
        <section class="ov2-block ov2-models-sec ov2-block-last sec-pad"></section>
      </div>
      <section class="ov2-issues sec-pad" style="display:none"></section>
      <section class="ov2-canary sec-pad" style="display:none"></section>
      <section class="ov2-projects sec-pad" style="display:none"></section>
      <section class="ov2-sessions sec-pad" style="display:none">
        <div class="ov2-list-head tnum"></div>
        <div class="thread-list"></div>
        <div class="empty-state" style="display:none"></div>
        <button type="button" class="more-btn tnum" data-action="load-more" style="display:none"></button>
      </section>
    </div>
  `;
  const root = appEl.firstElementChild;
  ovShell = {
    root,
    currentLink: root.querySelector('.ov2-current'),
    updateBtn: root.querySelector('.ov2-update'),
    wins: root.querySelector('.ov2-wins'),
    tabs: root.querySelector('.ov2-tabs'),
    live: root.querySelector('.ov2-live'),
    liveText: root.querySelector('.ov2-live-text'),
    overviewPane: root.querySelector('.ov2-pane-overview'),
    hero: root.querySelector('.ov2-hero'),
    setup: root.querySelector('.ov2-setup'),
    modelsSec: root.querySelector('.ov2-models-sec'),
    issues: root.querySelector('.ov2-issues'),
    canary: root.querySelector('.ov2-canary'),
    projects: root.querySelector('.ov2-projects'),
    sessions: root.querySelector('.ov2-sessions'),
    listHead: root.querySelector('.ov2-sessions .ov2-list-head'),
    list: root.querySelector('.ov2-sessions .thread-list'),
    empty: root.querySelector('.ov2-sessions .empty-state'),
    moreBtn: root.querySelector('.ov2-sessions .more-btn'),
    rowMap: new Map(),
  };
  return ovShell;
}

// ---------------------------------------------------------------------------
// Controls & Tabs
// ---------------------------------------------------------------------------

function windowShortLabel(win) {
  if (win.kind === 'today') return tr('今日', 'Today');
  if (win.kind === '7d') return tr('近 7 天', '7d');
  if (win.kind === 'all') return tr('累计', 'Total');
  return win.isBilling ? tr('本期', 'Cycle') : tr('近 30 天', '30d');
}

function windowRangeLabel(win) {
  if (win.kind === 'today') return tr('今日', 'Today');
  if (win.kind === 'all') return tr('全部', 'All');
  return `${formatMonthDay(win.start)}–${formatMonthDay(win.lastDay)}`;
}

function buildWindowTabs(win, settings) {
  const opts = [
    ['today', tr('今日', 'Today')],
    ['7d', tr('近 7 天', '7d')],
    ['period', settings.billingDay ? tr('本期', 'Cycle') : tr('近 30 天', '30d')],
    ['all', tr('全部', 'All')],
  ];
  return opts
    .map(
      ([k, label]) =>
        `<button type="button" class="ov2-win${win.kind === k ? ' is-active' : ''}" data-window="${k}">${label}</button>`
    )
    .join('');
}

function buildMainTabs(activeTab) {
  return getMainTabs()
    .map(
      ([k, label]) =>
        `<button type="button" class="ov2-tab${activeTab === k ? ' is-active' : ''}" data-main-tab="${k}">${label}</button>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Hero (回报)
// ---------------------------------------------------------------------------

function buildRoiDotsSvg(current, projected) {
  const { ink, mint, free } = getDotPalette();
  const { unit, total, full, partial } = computeRoiDots(current, projected);
  const gap = 14;
  const r = 4;
  const width = Math.max(1, total) * gap;
  let circles = '';
  for (let i = 0; i < total; i++) {
    const cx = (i * gap + r + 1).toFixed(1);
    if (i < full) {
      circles += `<circle cx="${cx}" cy="6" r="${r}" fill="${ink}"/>`;
    } else if (i === full && partial) {
      circles += `<circle cx="${cx}" cy="6" r="${r}" fill="${mint}"/>`;
    } else {
      circles += `<circle cx="${cx}" cy="6" r="${r - 0.6}" fill="none" stroke="${free}" stroke-width="1.2"/>`;
    }
  }
  return {
    unit,
    svg: `<svg width="${width}" height="12" viewBox="0 0 ${width} 12" style="display:block;overflow:visible">${circles}</svg>`,
  };
}

function fact(label, value, extraCls = '') {
  return `<div class="ov2-fact${extraCls}"><span class="ov2-k">${label}</span><span class="ov2-v tnum">${value}</span></div>`;
}

function shouldShowSetup(settings) {
  if (!state.settingsLoaded) return false;
  if (state.settingsOpen) return true;
  if (!settings.plan) return true;
  return Number(settings.plan.monthlyUsd) > 0 && !settings.billingDay && !settings.billingDaySkipped;
}

function buildHeroTip(total) {
  const usd = total.usd;
  if (usd <= 0) return '';
  const items = [
    [tr('未缓存输入', 'Uncached input'), total.inUsd, ''],
    [tr('模型输出', 'Output'), total.outUsd, ''],
    [tr('缓存读取', 'Cache read'), total.crUsd, ''],
  ];
  const imgUsd = Math.max(0, usd - total.inUsd - total.crUsd - total.outUsd);
  if (total.images > 0 && imgUsd >= 0.005) {
    items.push([
      tr('图片生成', 'Images'),
      imgUsd,
      isEn() ? `${total.images} ${total.images === 1 ? 'img' : 'imgs'}` : `${total.images} 张`,
    ]);
  }
  const rows = items
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, v, sub]) => [label, formatUsd(v, true), sub]);
  const sections = [];
  const tokAll = total.input + total.cacheRead + total.output;
  if (tokAll > 0) {
    sections.push({
      label: tr('Token 用量', 'Tokens'),
      rows: [
        [tr('缓存读取', 'Cache read'), formatTokensCompact(total.cacheRead)],
        [tr('未命中输入', 'Uncached input'), formatTokensCompact(total.input)],
        [tr('模型输出', 'Output'), formatTokensCompact(total.output)],
      ],
    });
  }
  return encodeTip({
    title: tr('价值构成', 'API Value Breakdown'),
    right: formatUsd(usd, true),
    rows,
    sections,
    note: tr(
      '按各模型公开 API 单价折算，非实际扣费',
      'Estimated at public API list rates, not billed'
    ),
  });
}

function buildHeroHtml(m) {
  const { win, total, settings } = m;
  const plan = settings.plan;
  const monthly = Number(plan?.monthlyUsd || 0);
  const usd = total.usd;
  const pending = m.archive?.pending;
  const setupVisible = shouldShowSetup(settings);
  const tokensAll = total.input + total.cacheRead + total.output;

  let side = '';
  let dots = '';
  const facts = [];
  const planFact = plan
    ? `<button type="button" class="ov2-link" data-action="open-settings">${escapeHtml(resolvePlanLabel(plan))}${monthly > 0 ? ` $${monthly.toFixed(2)}` : ''}</button>`
    : '';

  if (win.kind === 'period') {
    facts.push(fact(win.isBilling ? tr('账期', 'Cycle') : tr('范围', 'Range'), windowRangeLabel(win)));
    if (win.isBilling) {
      facts.push(
        fact(tr('剩余', 'Left'), isEn() ? `${win.remainingDays}d` : `${win.remainingDays} 天`)
      );
    }
    if (plan && monthly > 0) {
      const mult = usd / monthly;
      let projected = 0;
      if (win.isBilling && win.elapsedDays >= 2 && win.remainingDays > 3 && win.elapsedFraction > 0) {
        projected = usd / win.elapsedFraction;
        facts.push(fact(tr('本期预计', 'Projected'), formatUsd(projected, true)));
      } else if (tokensAll > 0) {
        facts.push(fact('Token', formatTokensCompact(tokensAll)));
      }
      const multStr = mult >= 10 ? mult.toFixed(0) : mult.toFixed(1);
      side = `<div class="ov2-roi${mult >= 1 ? ' is-reached' : ''}"><span class="ov2-k">${tr('价值倍数', 'Payback')}</span><span class="ov2-roi-num tnum">${multStr}×</span></div>`;
      const roi = buildRoiDotsSvg(mult, projected / monthly);
      const roiRows = [
        [
          tr('每颗圆点', 'Per dot'),
          `$${(monthly * roi.unit).toFixed(2)}`,
          isEn()
            ? `${roi.unit} mo plan`
            : roi.unit === 1
              ? '1 个月订阅'
              : `${roi.unit} 个月订阅`,
        ],
      ];
      if (projected > 0) {
        roiRows.push([tr('期末预计', 'Projected'), `${(projected / monthly).toFixed(1)}×`]);
      }
      const roiTip = encodeTip({
        title: tr('价值进度', 'Payback Progress'),
        right: `${multStr}×`,
        rows: roiRows,
      });
      dots = `<div class="ov2-roi-dots" data-tip="${escapeHtml(roiTip)}">${roi.svg}</div>`;
    } else {
      if (plan && monthly === 0) {
        side = `<div class="ov2-roi is-reached"><span class="ov2-k">${tr('订阅成本', 'Plan Cost')}</span><span class="ov2-roi-num tnum">$0</span></div>`;
      }
      if (tokensAll > 0) facts.push(fact('Token', formatTokensCompact(tokensAll)));
      if (setupVisible) {
        dots = `<div class="ov2-roi-dots is-empty" aria-hidden="true"></div>`;
      }
    }
  } else if (win.kind === 'today' || win.kind === '7d') {
    if (plan && monthly > 0) {
      const days = usd / (monthly / 30);
      const targetDays = win.kind === '7d' ? 7 : 1;
      const daysStr = days >= 10 ? days.toFixed(0) : days.toFixed(1);
      side = `<div class="ov2-roi${days >= targetDays ? ' is-reached' : ''}"><span class="ov2-k">${tr('折合订阅', 'Covered')}</span><span class="ov2-roi-num tnum">${isEn() ? `${daysStr}d` : `${daysStr} 天`}</span></div>`;
    } else if (plan && monthly === 0) {
      side = `<div class="ov2-roi is-reached"><span class="ov2-k">${tr('订阅成本', 'Plan Cost')}</span><span class="ov2-roi-num tnum">$0</span></div>`;
    }
    facts.push(
      win.kind === '7d'
        ? fact(tr('范围', 'Range'), windowRangeLabel(win))
        : fact(tr('日期', 'Date'), `${win.start.getMonth() + 1}/${win.start.getDate()}`)
    );
    if (tokensAll > 0) facts.push(fact('Token', formatTokensCompact(tokensAll)));
  } else {
    if (m.earliestKey) {
      const [y, mo, d] = m.earliestKey.split('-');
      facts.push(fact(tr('起始', 'Since'), `${y}/${Number(mo)}/${Number(d)}`));
    }
    facts.push(fact(tr('会话', 'Conversations'), `${m.sessionCount.toLocaleString('en-US')}`));
    if (tokensAll > 0) facts.push(fact('Token', formatTokensCompact(tokensAll)));
  }
  if (planFact) facts.push(fact(tr('订阅', 'Plan'), planFact, ' is-end'));

  const heroTip = buildHeroTip(total);
  const heroTipAttr = heroTip ? ` data-tip="${escapeHtml(heroTip)}"` : '';
  const heroLabel = isEn()
    ? `${windowShortLabel(win)} API Value`
    : `${windowShortLabel(win)}等效 API 价值`;

  return `
    <div class="ov2-hero-row">
      <div class="ov2-hero-main">
        <span class="ov2-k">${heroLabel}${pending ? `<span class="ov2-pending">${tr('统计中', 'Indexing')}</span>` : ''}</span>
        <span class="ov-hero-cost tnum"${heroTipAttr}>${formatUsd(usd, true)}</span>
      </div>
      ${side}
    </div>
    ${dots}
    ${facts.length ? `<div class="ov2-facts">${facts.join('')}</div>` : ''}
  `;
}

// ---------------------------------------------------------------------------
// Setup (订阅 + 续费日 + 语言)
// ---------------------------------------------------------------------------

function buildSetupHtml(settings) {
  const plan = settings.plan;
  const opts = PLAN_OPTIONS.map((p) => {
    const active = plan?.id === p.id && !state.customPlanDraft;
    return `<button type="button" class="ov2-opt${active ? ' is-active' : ''}" data-plan="${p.id}"><span class="ov2-opt-name">${p.label}</span><span class="ov2-opt-price tnum">$${p.monthlyUsd}</span></button>`;
  });
  const customActive = plan?.id === 'custom' || state.customPlanDraft;
  opts.push(
    `<button type="button" class="ov2-opt${customActive ? ' is-active' : ''}" data-plan="custom"><span class="ov2-opt-name">${tr('自定义', 'Custom')}</span><span class="ov2-opt-price tnum">${plan?.id === 'custom' ? `$${Number(plan.monthlyUsd).toFixed(2)}` : tr('月均价', '$/mo')}</span></button>`
  );

  const customRow = state.customPlanDraft
    ? `<div class="ov2-inline tnum">
         <span class="ov2-input-unit">$</span>
         <input type="number" class="ov2-input ov2-custom-usd" min="0" step="0.01" value="${plan?.id === 'custom' ? escapeHtml(String(plan.monthlyUsd)) : ''}" />
         <span class="ov2-input-unit">${tr('每月', '/ mo')}</span>
         <button type="button" class="ov2-btn" data-action="save-custom-plan">${tr('保存', 'Save')}</button>
       </div>`
    : '';

  const dayRow =
    plan && Number(plan.monthlyUsd) > 0
      ? `<div class="ov2-field">
           <span class="ov2-k">${tr('续费日', 'Billing Day')}</span>
           <div class="ov2-inline tnum">
             <span class="ov2-input-unit">${tr('每月', 'Day')}</span>
             <input type="number" class="ov2-input ov2-billing-day" min="1" max="31" step="1" value="${settings.billingDay ? escapeHtml(String(settings.billingDay)) : ''}" />
             <span class="ov2-input-unit">${tr('号', 'of month')}</span>
             <button type="button" class="ov2-btn" data-action="save-billing-day">${tr('保存', 'Save')}</button>
             ${settings.billingDay ? `<button type="button" class="ov2-link" data-action="clear-billing-day">${tr('改用近 30 天', 'Use rolling 30d')}</button>` : `<button type="button" class="ov2-link" data-action="skip-billing-day">${tr('暂不设置', 'Skip')}</button>`}
           </div>
         </div>`
      : '';

  const prefLang = ['auto', 'zh', 'en'].includes(settings.lang) ? settings.lang : 'auto';
  const langOpts = LANG_OPTIONS.map((opt) => {
    const active = prefLang === opt.id && !state.urlLang;
    const label = isEn() ? opt.en : opt.zh;
    return `<button type="button" class="ov2-opt${active ? ' is-active' : ''}" data-lang="${opt.id}"><span class="ov2-opt-name">${label}</span></button>`;
  }).join('');

  const langRow = state.settingsOpen
    ? `<div class="ov2-field">
         <span class="ov2-k">${tr('界面语言', 'Language')}</span>
         <div class="ov2-opts ov2-opts-3">${langOpts}</div>
       </div>`
    : '';

  const verStr = state.updateInfo?.currentVersion || '2.0.0';
  let verStatusHtml = '';
  if (state.updateApplying) {
    verStatusHtml = `<span class="ov2-ver-note is-mint">${tr('正在热更新…', 'Updating…')}</span>`;
  } else if (state.updateChecking) {
    verStatusHtml = `<span class="ov2-ver-note">${tr('正在检查…', 'Checking…')}</span>`;
  } else if (state.updateInfo?.hasUpdate) {
    const nextV = escapeHtml(state.updateInfo.latestVersion);
    verStatusHtml = `<button type="button" class="ov2-link is-mint" data-action="apply-update">${isEn() ? `Update to v${nextV}` : `立即更新 v${nextV}`}</button>`;
  } else {
    const fb = state.updateFeedback
      ? escapeHtml(state.updateFeedback)
      : tr('检查更新', 'Check updates');
    verStatusHtml = `<button type="button" class="ov2-link ov2-muted-link" data-action="check-update">${fb}</button>`;
  }

  const autoCheckBtn = `<button type="button" class="ov2-link ov2-muted-link" data-action="toggle-update-check">${settings.updateCheck === false ? tr('自动检测已关', 'Auto-check off') : tr('自动检测已开', 'Auto-check on')}</button>`;

  const done = state.settingsOpen
    ? `<div class="ov2-setup-actions tnum">
         <span class="ov2-ver-bar">
           <span class="ov2-ver-num">v${escapeHtml(verStr)}</span>
           ${verStatusHtml}
           ${autoCheckBtn}
         </span>
         <button type="button" class="ov2-link" data-action="close-settings">${tr('完成', 'Done')}</button>
       </div>`
    : '';

  return `
    <div class="ov2-field">
      <span class="ov2-k">${tr('订阅方案', 'Subscription')}</span>
      <div class="ov2-opts">${opts.join('')}</div>
      ${customRow}
    </div>
    ${dayRow}
    ${langRow}
    ${done}
  `;
}

// ---------------------------------------------------------------------------
// Models (模型表现: 价值 + 缓存命中 + 首字延迟 + 生成速度)
// ---------------------------------------------------------------------------

function buildModelsHtml(m) {
  const entries = Array.from(m.byModel.entries())
    .filter(([, a]) => a.usd > 0)
    .sort((a, b) => b[1].usd - a[1].usd);

  if (entries.length === 0) {
    return `<div class="ov2-sec-head"><span class="ov2-sec-title">${tr('模型', 'Models')}</span></div><div class="ov2-empty-line">${tr('这段时间没有用量', 'No usage in this window')}</div>`;
  }

  const totalUsd = entries.reduce((acc, [, a]) => acc + a.usd, 0) || 1;
  const top = entries.slice(0, 6);
  if (entries.length > 6) {
    const rest = emptyAgg();
    for (const [, a] of entries.slice(6)) addModelBucket(rest, [a.usd, a.input, a.cacheRead, a.output, a.decOut, a.decSec, a.ttftSum, a.ttftCnt]);
    if (rest.usd > 0) top.push([tr('其他', 'Other'), rest]);
  }

  const rows = top
    .map(([name, a]) => {
      const hit = aggCacheHit(a);
      const ttft = aggTtft(a);
      const tps = aggTps(a);
      const sharePct = (a.usd / totalUsd) * 100;
      const shareStr = sharePct > 0 && sharePct < 1 ? '<1%' : `${Math.round(sharePct)}%`;
      const tokSum = a.input + a.cacheRead + a.output;
      const tipSpec =
        tokSum > 0
          ? encodeTip({
              title: name,
              right: isEn() ? `${shareStr} share` : `占比 ${shareStr}`,
              rows: [
                [tr('缓存读取', 'Cache read'), formatTokensCompact(a.cacheRead)],
                [tr('未命中输入', 'Uncached input'), formatTokensCompact(a.input)],
                [tr('模型输出', 'Output'), formatTokensCompact(a.output)],
              ],
            })
          : '';
      return `
        <div class="ov2-tr ov2-tr-perf"${tipSpec ? ` data-tip="${escapeHtml(tipSpec)}"` : ''}>
          <span class="ov2-td-label ov2-model-cell">${renderModelFamilyGlyph(name)}<span class="ov2-model-name">${escapeHtml(name)}</span></span>
          <span class="ov2-td tnum">${formatUsd(a.usd, true)}</span>
          <span class="ov2-td tnum">${hit != null ? `${Math.round(hit * 100)}%` : '—'}</span>
          <span class="ov2-td tnum">${ttft > 0 ? formatTtft(ttft) : '—'}</span>
          <span class="ov2-td tnum">${tps > 0 ? Math.round(tps) : '—'}</span>
        </div>`;
    })
    .join('');

  return `
    <div class="ov2-sec-head"><span class="ov2-sec-title">${tr('模型', 'Models')}</span></div>
    <div class="ov2-table">
      <div class="ov2-tr ov2-tr-perf ov2-th">
        <span class="ov2-td-label">${tr('名称', 'Model')}</span>
        <span class="ov2-td">${tr('价值', 'Value')}</span>
        <span class="ov2-td">${tr('缓存', 'Cache')}</span>
        <span class="ov2-td">${tr('首字', 'TTFT')}</span>
        <span class="ov2-td">tok/s</span>
      </div>
      ${rows}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Projects Ranking (项目一级视图)
// ---------------------------------------------------------------------------

function buildProjectsRankingHtml(m) {
  const { projects, byCat } = m;
  const totalUsd = byCat.project.usd;

  if (projects.length === 0) {
    return `
      <div class="ov2-list-head tnum">
        <span class="ov2-list-count">${tr('0 个项目', '0 projects')}</span>
        <span class="ov2-list-total">$0.00</span>
      </div>
      <div class="empty-state">${tr('这段时间没有项目会话', 'No project conversations in this window')}</div>
    `;
  }

  const denomUsd = Math.max(
    totalUsd,
    projects.reduce((acc, p) => acc + p.agg.usd, 0),
    0.0001
  );
  const maxUsd = Math.max(...projects.map((p) => p.agg.usd), 0.0001);

  const rows = projects
    .map((p) => {
      const pct = denomUsd > 0 ? (p.agg.usd / denomUsd) * 100 : 0;
      const pctStr = p.agg.usd <= 0 ? '0%' : pct < 1 ? '<1%' : `${Math.round(pct)}%`;
      const barW = p.agg.usd > 0 ? Math.max(2, (p.agg.usd / maxUsd) * 100).toFixed(1) : '0';
      const dotCls = p.isActive
        ? 'dot-live is-pulsing'
        : p.isCurrentWs
          ? 'dot-current'
          : 'dot-idle';
      const hit = aggCacheHit(p.agg);
      const tokSum = p.agg.input + p.agg.cacheRead + p.agg.output;
      const tipRows = [];
      if (hit != null) tipRows.push([tr('缓存命中', 'Cache hit'), `${Math.round(hit * 100)}%`]);
      if (tokSum > 0) {
        tipRows.push([tr('缓存读取', 'Cache read'), formatTokensCompact(p.agg.cacheRead)]);
        tipRows.push([tr('未命中输入', 'Uncached input'), formatTokensCompact(p.agg.input)]);
        tipRows.push([tr('模型输出', 'Output'), formatTokensCompact(p.agg.output)]);
      }
      const tipSpec =
        tipRows.length > 0 || p.pathShort
          ? encodeTip({
              title: p.name,
              right:
                p.pathShort ||
                (isEn()
                  ? `${p.sessionCount} ${p.sessionCount === 1 ? 'conversation' : 'conversations'}`
                  : `${p.sessionCount} 个会话`),
              rows: tipRows,
            })
          : '';
      return `
        <button type="button" class="ov2-tr ov2-tr-proj" data-open-project="${escapeHtml(p.key)}"${tipSpec ? ` data-tip="${escapeHtml(tipSpec)}"` : ''}>
          <span class="ov2-td-label ov2-proj-cell">
            <span class="${dotCls}"></span>
            <span class="ov2-proj-name">${escapeHtml(p.name)}</span>
            ${p.isCurrentWs ? `<span class="ov2-proj-tag">${tr('当前', 'Active')}</span>` : ''}
          </span>
          <span class="ov2-td tnum is-muted">${p.sessionCount}</span>
          <span class="ov2-td tnum">${formatUsd(p.agg.usd, true)}</span>
          <span class="ov2-td tnum is-muted">${pctStr}</span>
          <span class="ov2-td ov2-td-bar"><i style="width:${barW}%"></i></span>
        </button>`;
    })
    .join('');

  const projCountLabel = isEn()
    ? `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`
    : `${projects.length} 个项目`;

  return `
    <div class="ov2-list-head tnum">
      <span class="ov2-list-count">${projCountLabel}</span>
      <span class="ov2-list-total">${formatUsd(totalUsd, true)}</span>
    </div>
    <div class="ov2-table">
      <div class="ov2-tr ov2-tr-proj ov2-th">
        <span class="ov2-td-label">${tr('名称', 'Project')}</span>
        <span class="ov2-td">${tr('会话', 'Convs')}</span>
        <span class="ov2-td">${tr('价值', 'Value')}</span>
        <span class="ov2-td">${tr('占比', 'Share')}</span>
        <span class="ov2-td"></span>
      </div>
      ${rows}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Session rows (对话 / 单项目下钻 / CLI)
// ---------------------------------------------------------------------------

function formatRelativeTime(ms) {
  const t = Number(ms) || 0;
  if (t <= 0) return '';
  const diff = Math.max(0, Date.now() - t) / 1000;
  if (diff < 60) return tr('刚刚', 'just now');
  if (diff < 3600) {
    const mins = Math.floor(diff / 60);
    return isEn() ? `${mins}m ago` : `${mins} 分钟前`;
  }
  if (diff < 86400) {
    const hrs = Math.floor(diff / 3600);
    return isEn() ? `${hrs}h ago` : `${hrs} 小时前`;
  }
  if (diff < 86400 * 7) {
    const days = Math.floor(diff / 86400);
    return isEn() ? `${days}d ago` : `${days} 天前`;
  }
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function resolveRowBadge(t) {
  if (t.isDeleted) {
    return { text: tr('已删除', 'Deleted'), cls: 'ov2-badge is-muted' };
  }
  const tc = t.issues?.treeCounts || t.issues?.counts || {};
  if (t.alert?.kind === 'safety' || (tc.safety_filter || 0) > 0) {
    return { text: tr('安全过滤', 'Filtered'), cls: 'ov2-badge is-alert' };
  }
  if (t.alert?.kind === 'quota' || (tc.quota_429 || 0) > 0) {
    return { text: tr('限流', '429 Quota'), cls: 'ov2-badge is-warn' };
  }
  return null;
}

function createRowElement(threadId) {
  const sec = document.createElement('section');
  sec.className = 'thread-item ov2-row';
  sec.setAttribute('data-open-thread', threadId);
  sec.innerHTML = `
    <div class="ti-row1">
      <div class="ti-title-wrap">
        <span class="dot-idle"></span>
        <span class="ti-title"></span>
      </div>
      <span class="ti-cost tnum"></span>
    </div>
    <div class="ov2-row2 tnum">
      <span class="ov2-row-meta">
        <span class="ov2-row-model"></span>
        <span class="ov2-row-hit" style="display:none"></span>
        <span class="ov2-row-tps" style="display:none"></span>
        <span class="ov2-badge" style="display:none"></span>
        <span class="ov2-row-time"></span>
      </span>
      <span class="ov2-row-ctx">
        <span class="ov2-ctx-dots"></span>
        <span class="ov2-ctx-pct"></span>
      </span>
    </div>
    <div class="ti-extra-wrap"></div>
  `;
  sec._refs = {
    dot: sec.querySelector('.ti-title-wrap > span:first-child'),
    title: sec.querySelector('.ti-title'),
    cost: sec.querySelector('.ti-cost'),
    model: sec.querySelector('.ov2-row-model'),
    hit: sec.querySelector('.ov2-row-hit'),
    tps: sec.querySelector('.ov2-row-tps'),
    badge: sec.querySelector('.ov2-badge'),
    time: sec.querySelector('.ov2-row-time'),
    ctx: sec.querySelector('.ov2-row-ctx'),
    dots: sec.querySelector('.ov2-ctx-dots'),
    pct: sec.querySelector('.ov2-ctx-pct'),
    extra: sec.querySelector('.ti-extra-wrap'),
  };
  return sec;
}

function nodeWindowUsd(node, m) {
  if (!node) return 0;
  if (m.win.kind === 'all') {
    return Number(node.cost?.treeUsd ?? node.cost?.selfUsd ?? 0);
  }
  if (m.rootUsd.has(node.id)) {
    return m.rootUsd.get(node.id) || 0;
  }
  return sumWindowUsd(nodeDaily(node), m.win);
}

function buildExtraDrawerHtml(t, batchSiblings, m) {
  const parts = [];
  const children = Array.isArray(t.children) ? t.children : [];

  if (children.length > 0) {
    const isExp = state.expandedParents.has(t.id);
    const runningKids = children.filter((c) => isThreadTreeActive(c)).length;
    const btwKids = children.filter((c) => c.kind === 'btw').length;
    const kidsCost =
      t.cost?.childrenUsd ?? children.reduce((acc, c) => acc + Number(c.cost?.treeUsd ?? c.cost?.selfUsd ?? 0), 0);
    let label = isEn()
      ? `${children.length} ${children.length === 1 ? 'subtask' : 'subtasks'}`
      : `${children.length} 个子任务`;
    if (btwKids === children.length) {
      label = isEn()
        ? `${children.length} /btw ${children.length === 1 ? 'branch' : 'branches'}`
        : `${children.length} 个 /btw 侧问`;
    }
    const run =
      runningKids > 0
        ? `<span class="sub-gap is-live">${isEn() ? `${runningKids} live` : `${runningKids} 个运行中`}</span>`
        : '';
    parts.push(`
      <button type="button" class="ti-children-toggle tnum" data-toggle-children="${escapeHtml(t.id)}">
        <span><span>${isExp ? tr('收起子任务', 'Hide subtasks') : label}</span>${isExp ? '' : run}</span>
        <span>${isExp ? '' : formatUsd(kidsCost)}</span>
      </button>`);
    if (isExp) {
      const kidRows = children
        .map((ch) => {
          const chActive = isThreadTreeActive(ch);
          const chDot = chActive ? `child-dot-live${isThreadTreeGenerating(ch) ? ' is-pulsing' : ''}` : 'child-dot-idle';
          const chDur = getThreadTimingMetrics(ch, state.snapshotClientMs);
          const chTip = buildChildRowTip(ch);
          return `
            <div class="child-row tnum" data-open-thread="${escapeHtml(ch.id)}"${chTip ? ` data-tip="${escapeHtml(chTip)}"` : ''}>
              <div class="child-left">
                <span class="${chDot}"></span>
                <span class="child-name">${escapeHtml(formatChildDisplayName(ch))}</span>
                ${ch.model?.shortName ? `<span class="child-meta">${escapeHtml(ch.model.shortName)}</span>` : ''}
              </div>
              <div class="child-right">
                ${chDur.totalSec > 0 ? `<span class="child-meta">${formatDuration(chDur.totalSec, true)}</span>` : ''}
                <span>${formatUsd(ch.cost?.treeUsd ?? ch.cost?.selfUsd ?? 0)}</span>
              </div>
            </div>`;
        })
        .join('');
      parts.push(`<div class="ti-children-list">${kidRows}</div>`);
    }
  }

  if (batchSiblings.length > 0) {
    const key = t.id;
    const isExp = state.expandedBatches.has(key);
    const sibCost = batchSiblings.reduce((acc, s) => acc + nodeWindowUsd(s, m), 0);
    const batchLabel = isEn()
      ? `${batchSiblings.length} more in batch`
      : `同批次还有 ${batchSiblings.length} 次调用`;
    parts.push(`
      <button type="button" class="ti-children-toggle tnum" data-toggle-batch="${escapeHtml(key)}">
        <span>${isExp ? tr('收起', 'Hide') : batchLabel}</span>
        <span>${isExp ? '' : formatUsd(sibCost)}</span>
      </button>`);
    if (isExp) {
      const sibRows = batchSiblings
        .map(
          (sib) => `
            <div class="child-row tnum" data-open-thread="${escapeHtml(sib.id)}">
              <div class="child-left">
                <span class="child-dot-idle"></span>
                <span class="child-name">${escapeHtml(sib.title || sib.id.slice(0, 8))}</span>
              </div>
              <div class="child-right"><span>${formatUsd(nodeWindowUsd(sib, m))}</span></div>
            </div>`
        )
        .join('');
      parts.push(`<div class="ti-children-list">${sibRows}</div>`);
    }
  }
  return parts.join('');
}

function resolveNodePerf(t) {
  const tok = computeTreeTokenSums(t);
  const hit = computeHitRatio(tok.input, tok.cacheRead, null);
  let tps = getSingleStreamNodeTps(t);
  if (!(tps > 0) && t.cost?.treeDaily) {
    let decOut = 0;
    let decSec = 0;
    for (const b of Object.values(t.cost.treeDaily)) {
      if (Array.isArray(b)) {
        decOut += Number(b[6]) || 0;
        decSec += Number(b[7]) || 0;
      }
    }
    if (decSec > 0) tps = decOut / decSec;
  }
  return { hit, tps };
}

function patchRowElement(sec, item, m) {
  const t = item.lead;
  const refs = sec._refs;
  const palette = getDotPalette();

  const active = isThreadTreeActive(t);
  const currentHost = isCurrentHostThread(t);
  setClass(refs.dot, active ? 'dot-live is-pulsing' : currentHost ? 'dot-current' : 'dot-idle');

  const isZeroHost = Boolean(t.id === state.hostConvId && isZeroMessageThread(t, null));
  setText(
    refs.title,
    isZeroHost && isPlaceholderTitle(t.title, t.id)
      ? tr('当前新会话', 'New Conversation')
      : t.title || t.roleLabel || t.id.slice(0, 8)
  );

  let winUsd = nodeWindowUsd(t, m);
  let lifetimeUsd = Number(t.cost?.treeUsd ?? t.cost?.selfUsd ?? 0);
  for (const sib of item.batchSiblings) {
    winUsd += nodeWindowUsd(sib, m);
    lifetimeUsd += Number(sib.cost?.treeUsd ?? sib.cost?.selfUsd ?? 0);
  }
  setText(refs.cost, formatUsd(winUsd));
  if (t.isArchived || item.batchSiblings.length > 0) {
    setTip(refs.cost, '');
  } else if (m.win.kind !== 'all' && lifetimeUsd > winUsd + 0.005) {
    setTip(
      refs.cost,
      encodeTip({
        title: isEn() ? `${windowShortLabel(m.win)} Value` : `${windowShortLabel(m.win)}价值`,
        right: formatUsd(winUsd, true),
        rows: [[tr('会话累计价值', 'Lifetime value'), formatUsd(lifetimeUsd, true)]],
      })
    );
  } else {
    setTip(refs.cost, buildCostTip(t));
  }

  const modelsUsed = getModelsBreakdown(t);
  const rawShort = t.model?.shortName || t.model?.rawSlug || '';
  const baseShort =
    isZeroHost && isPlaceholderModel(rawShort)
      ? tr('等待首条消息', 'Waiting for first message')
      : rawShort || '—';
  setText(refs.model, modelsUsed.length >= 2 ? `${baseShort} +${modelsUsed.length - 1}` : baseShort);

  const { hit, tps } = resolveNodePerf(t);
  if (hit != null) {
    const pct = Math.round(hit * 100);
    setText(refs.hit, isEn() ? `Cache ${pct}%` : `缓存 ${pct}%`);
    setDisplay(refs.hit, true, 'inline');
  } else {
    setDisplay(refs.hit, false);
  }

  if (!active && tps > 0) {
    setText(refs.tps, `${Math.round(tps)} tok/s`);
    setDisplay(refs.tps, true, 'inline');
  } else {
    setDisplay(refs.tps, false);
  }

  const badge = resolveRowBadge(t);
  if (badge) {
    setText(refs.badge, badge.text);
    setClass(refs.badge, badge.cls);
    setDisplay(refs.badge, true, 'inline');
  } else {
    setDisplay(refs.badge, false);
  }

  if (active) {
    setText(
      refs.time,
      tps > 0
        ? isEn()
          ? `Live ${Math.round(tps)} tok/s`
          : `运行中 ${Math.round(tps)} tok/s`
        : tr('运行中', 'Live')
    );
    setClass(refs.time, 'ov2-row-time is-live');
  } else {
    setText(refs.time, currentHost ? tr('当前会话', 'Current') : formatRelativeTime(t.updatedAtMs));
    setClass(refs.time, 'ov2-row-time');
  }

  const { inkDots, mintDots } = computeDotAllocation(t.waterline, t.model, 20);
  const sig = `${palette.theme}:${inkDots}:${mintDots}`;
  if (refs.dots._sig !== sig) {
    refs.dots.innerHTML = buildRowDotsCompactSvg(inkDots, mintDots);
    refs.dots._sig = sig;
  }
  const soft = resolveThreadSoftLimit(t.waterline, t.model);
  const cur = Number(t.waterline?.currentTokens || 0);
  setText(refs.pct, `${soft > 0 ? Math.round((cur / soft) * 100) : 0}%`);
  setTip(refs.ctx, t.isArchived ? '' : buildWaterlineTip(t, null));

  setHtmlCached(refs.extra, t.isArchived ? '' : buildExtraDrawerHtml(t, item.batchSiblings, m));
}

function filterRecentRoots(m, scope, projectKey = '') {
  let roots = m.recent.filter((r) => {
    const cat = resolveThreadCategory(r);
    if (cat !== scope) return false;
    if (projectKey && resolveProjectKey(r) !== projectKey) return false;
    return true;
  });
  if (m.win.kind !== 'all') {
    roots = roots.filter(
      (r) => (m.rootUsd.get(r.id) || 0) > 0 || isThreadTreeActive(r) || isCurrentHostThread(r)
    );
  }
  roots.sort((a, b) => {
    const ah = isCurrentHostThread(a) ? 1 : 0;
    const bh = isCurrentHostThread(b) ? 1 : 0;
    if (ah !== bh) return bh - ah;
    const aa = isThreadTreeActive(a) ? 1 : 0;
    const ba = isThreadTreeActive(b) ? 1 : 0;
    if (aa !== ba) return ba - aa;
    return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
  });
  return roots;
}

// Archived sessions are paged from the server on demand.
const archivePager = { key: '', rows: [], total: 0, loading: false, done: false };

function archiveKey(m, scope, projectKey) {
  return `${scope}|${projectKey}|${m.win.kind === 'all' ? '' : m.win.startKey}|${m.win.kind === 'all' ? '' : m.win.endKey}|${m.archive?.count || 0}`;
}

async function fetchArchivePage(m, scope, projectKey, key) {
  if (archivePager.loading || archivePager.done) return;
  archivePager.loading = true;
  const params = new URLSearchParams({
    scope,
    offset: String(archivePager.rows.length),
    limit: '40',
  });
  if (projectKey) params.set('projectKey', projectKey);
  if (m.win.kind !== 'all') {
    params.set('startKey', m.win.startKey);
    params.set('endKey', m.win.endKey);
  }
  try {
    const res = await sidecarFetch(`/api/archive?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (res.ok && archivePager.key === key) {
      const data = await res.json();
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      archivePager.rows.push(...rows);
      archivePager.total = Number(data?.total) || archivePager.rows.length;
      archivePager.done = archivePager.rows.length >= archivePager.total || rows.length === 0;
    }
  } catch {
    archivePager.done = true;
  } finally {
    archivePager.loading = false;
    if (archivePager.key === key && !state.selectedThreadId) renderOverview();
  }
}

function buildListHeaderHtml(m, scope, projectKey) {
  if (scope === 'project' && projectKey) {
    const p = m.projectsMap.get(projectKey);
    const name = p?.name || projectKey;
    const count = p?.sessionCount || 0;
    const usd = p?.agg.usd || 0;
    const countLabel = isEn()
      ? `${count} ${count === 1 ? 'conversation' : 'conversations'}`
      : `${count} 个会话`;
    return `
      <div class="ov2-proj-bar">
        <button type="button" class="back-btn" data-action="close-project">${BACK_CHEVRON_SVG}<span>${tr('返回全部项目', 'All Projects')}</span></button>
        <span class="ov2-proj-bar-right">
          <span class="ov2-list-count">${countLabel}</span>
          <span class="ov2-list-total">${formatUsd(usd, true)}</span>
        </span>
      </div>
      <div class="ov2-proj-banner">
        <div class="ov2-proj-title-wrap">
          <h2 class="ov2-proj-title">${escapeHtml(name)}</h2>
          ${p?.isCurrentWs ? `<span class="ov2-proj-tag">${tr('当前', 'Active')}</span>` : ''}
        </div>
        ${p?.pathShort ? `<span class="ov2-proj-path">${escapeHtml(p.pathShort)}</span>` : ''}
      </div>
    `;
  }

  const count = m.catCounts[scope] || 0;
  const usd = m.byCat[scope]?.usd || 0;
  const countStr = count.toLocaleString('en-US');
  const countLabel = isEn()
    ? scope === 'cli'
      ? `${countStr} ${count === 1 ? 'call' : 'calls'}`
      : `${countStr} ${count === 1 ? 'conversation' : 'conversations'}`
    : `${countStr} ${scope === 'cli' ? '次调用' : '个会话'}`;
  return `
    <span class="ov2-list-count">${countLabel}</span>
    <span class="ov2-list-total">${formatUsd(usd, true)}</span>
  `;
}

function renderSessionsPane(shell, m, scope, projectKey = '') {
  setHtmlCached(shell.listHead, buildListHeaderHtml(m, scope, projectKey));
  setClass(
    shell.listHead,
    scope === 'project' && projectKey ? 'ov2-list-head is-project tnum' : 'ov2-list-head tnum'
  );

  const recentRoots = filterRecentRoots(m, scope, projectKey);

  const key = archiveKey(m, scope, projectKey);
  if (archivePager.key !== key) {
    archivePager.key = key;
    archivePager.rows = [];
    archivePager.total = 0;
    archivePager.done = Boolean(m.archive?.pending) || !(m.archive?.count > 0);
    archivePager.loading = false;
  }
  if (!archivePager.done && archivePager.rows.length === 0) fetchArchivePage(m, scope, projectKey, key);

  const allItems = buildDisplayItems(recentRoots.concat(archivePager.rows));
  const shown = allItems.slice(0, state.visibleLimit);
  if (
    shown.length < state.visibleLimit &&
    !archivePager.done &&
    archivePager.rows.length > 0 &&
    archivePager.rows.length < state.visibleLimit * 4
  ) {
    fetchArchivePage(m, scope, projectKey, key);
  }
  const knownTotal = recentRoots.length + (archivePager.done ? archivePager.rows.length : archivePager.total);
  const shownRoots = shown.reduce((a, it) => a + 1 + it.batchSiblings.length, 0);
  const remaining = Math.max(0, knownTotal - shownRoots);

  if (shown.length === 0) {
    for (const el of shell.rowMap.values()) el.remove();
    shell.rowMap.clear();
    setDisplay(shell.list, false);
    const emptyText = archivePager.loading
      ? tr('正在读取', 'Loading')
      : scope === 'cli'
        ? tr('这段时间没有 CLI 调用', 'No CLI calls in this window')
        : tr('这段时间没有会话', 'No conversations in this window');
    setText(shell.empty, emptyText);
    setDisplay(shell.empty, true, 'block');
    setDisplay(shell.moreBtn, false);
    return;
  }

  setDisplay(shell.empty, false);
  setDisplay(shell.list, true, 'flex');
  const keep = new Set();
  for (let i = 0; i < shown.length; i++) {
    const item = shown[i];
    const id = item.lead.id;
    keep.add(id);
    let el = shell.rowMap.get(id);
    if (!el) {
      el = createRowElement(id);
      shell.rowMap.set(id, el);
    }
    patchRowElement(el, item, m);
    const at = shell.list.children[i];
    if (at !== el) shell.list.insertBefore(el, at || null);
  }
  for (const [id, el] of shell.rowMap.entries()) {
    if (!keep.has(id)) {
      el.remove();
      shell.rowMap.delete(id);
    }
  }
  if (remaining > 0) {
    const remStr = remaining.toLocaleString('en-US');
    setText(
      shell.moreBtn,
      isEn()
        ? `Load more (${remStr})`
        : `${scope === 'cli' ? '更多调用' : '更多会话'} ${remStr}`
    );
    setDisplay(shell.moreBtn, true, 'block');
  } else {
    setDisplay(shell.moreBtn, false);
  }
}

// ---------------------------------------------------------------------------
// Events view
// ---------------------------------------------------------------------------

function buildCloudPaneHtml(m) {
  const { signalCounts, signalCats, windowEvents } = m;
  let active = state.issueCategoryFilter || 'all';
  if (active !== 'all' && !signalCats.includes(active)) active = 'all';

  const cells = signalCats
    .map((c) => {
      const n = signalCounts[c] || 0;
      const label = formatIssueCategoryLabel(c);
      const tone =
        n > 0 && c === 'safety_filter'
          ? ' is-alert'
          : n > 0 && c === 'quota_429'
            ? ' is-warn'
            : '';
      const selected = active === c ? ' is-selected' : '';
      const tip = encodeTip({ title: label, body: describeIssueCategory(c) });
      return `
        <button type="button" class="ov2-metric ov2-signal${n === 0 && !selected ? ' is-zero' : ''}${tone}${selected}" ${n > 0 || selected ? `data-issue-filter="${c}"` : 'disabled'} data-tip="${escapeHtml(tip)}">
          <span class="ov2-k">${label}</span>
          <span class="ov2-m-val tnum">${n}</span>
        </button>`;
    })
    .join('');

  const list =
    active === 'all' ? windowEvents : windowEvents.filter((e) => e.category === active);
  const visible = list.slice(0, state.issuesVisibleLimit || 40);

  const rows = visible
    .map((ev) => {
      const title = ev.childLabel
        ? `${ev.threadTitle || ''}  ${ev.childLabel}`
        : ev.threadTitle || ev.threadId?.slice(0, 8) || '';
      const body = cleanCloudEventBody(ev.injectedText || ev.summary || '');
      return `
        <article class="ov2-ev" data-open-incident-thread="${escapeHtml(ev.threadId || '')}" data-focus-step="${escapeHtml(String(ev.stepIndex ?? ''))}">
          <div class="ov2-ev-head tnum">
            <span class="inc-badge ${getIssueBadgeClass(ev.category)}">${escapeHtml(formatIssueCategoryLabel(ev.category))}</span>
            <span class="ov2-ev-title">${escapeHtml(title)}</span>
            <span class="ov2-ev-time">${escapeHtml(formatTimestampShort(ev.timestampSec))}</span>
          </div>
          ${body ? `<div class="ov2-ev-body">${escapeHtml(body)}</div>` : ''}
        </article>`;
    })
    .join('');

  const rem = list.length - visible.length;
  const more =
    rem > 0
      ? `<button type="button" class="more-btn tnum" data-action="load-more-issues">${isEn() ? `Load more (${rem})` : `更多记录 ${rem}`}</button>`
      : '';

  const countText = isEn()
    ? `${list.length} ${list.length === 1 ? 'event' : 'events'}`
    : `${list.length} 条记录`;
  const headLabel =
    active === 'all' ? countText : `${formatIssueCategoryLabel(active)}  ${countText}`;

  return `
    <div class="ov2-cloud-summary">
      <div class="ov2-grid4">${cells}</div>
    </div>
    <div class="ov2-list-head ov2-cloud-list-head tnum">
      <span class="ov2-list-count">${escapeHtml(headLabel)}</span>
      ${active !== 'all' ? `<button type="button" class="ov2-link ov2-reset-filter" data-issue-filter="all">${tr('显示全部', 'Show all')}</button>` : ''}
    </div>
    <div class="ov2-ev-list">${rows || `<div class="empty-state">${tr('这段时间没有事件记录', 'No events in this window')}</div>`}</div>
    ${more}
  `;
}

// ---------------------------------------------------------------------------
// Routing view
// ---------------------------------------------------------------------------

function buildCanaryPaneHtml(m) {
  const { canaryCounts, canaryCats, windowCanaryHits } = m;
  let active = state.canaryCategoryFilter || 'all';
  if (active !== 'all' && !canaryCats.includes(active)) active = 'all';

  const cells = canaryCats
    .map((c) => {
      const n = canaryCounts[c] || 0;
      const label = formatCanaryCategoryLabel(c);
      const tone = n > 0 && c === 'unknown_model' ? ' is-warn' : '';
      const selected = active === c ? ' is-selected' : '';
      const tip = encodeTip({ title: label, body: describeCanaryCategory(c) });
      return `
        <button type="button" class="ov2-metric ov2-signal${n === 0 && !selected ? ' is-zero' : ''}${tone}${selected}" ${n > 0 || selected ? `data-canary-filter="${c}"` : 'disabled'} data-tip="${escapeHtml(tip)}">
          <span class="ov2-k">${label}</span>
          <span class="ov2-m-val tnum">${n}</span>
        </button>`;
    })
    .join('');

  const list =
    active === 'all'
      ? windowCanaryHits
      : windowCanaryHits.filter((h) => h.category === active);

  // Aggregate distinct experimental slugs in the filtered view
  const slugMap = new Map();
  for (const h of list) {
    const key = h.rawSlug;
    let g = slugMap.get(key);
    if (!g) {
      g = {
        rawSlug: key,
        fullName: h.fullName || h.shortName || key,
        provider: h.provider || 'gemini',
        category: h.category,
        sessions: new Set(),
        steps: 0,
        usd: 0,
        inp: 0,
        cr: 0,
        out: 0,
        decOut: 0,
        decSec: 0,
        ttftSum: 0,
        ttftCnt: 0,
      };
      slugMap.set(key, g);
    }
    g.sessions.add(h.rootThreadId || h.threadId);
    g.steps += Number(h.steps) || 0;
    g.usd += Number(h.costUsd) || 0;
    g.inp += Number(h.inputTokens) || 0;
    g.cr += Number(h.cacheReadTokens) || 0;
    g.out += Number(h.outputTokens) || 0;
    g.decOut += Number(h.decodeOutTokens) || 0;
    g.decSec += Number(h.decodeSec) || 0;
    g.ttftSum += Number(h.ttftSum) || 0;
    g.ttftCnt += Number(h.ttftCount) || 0;
  }
  const cohorts = Array.from(slugMap.values()).sort(
    (a, b) => b.usd - a.usd || b.steps - a.steps
  );

  let cohortsHtml = '';
  if (cohorts.length > 0) {
    const cRows = cohorts
      .map((g) => {
        const ttft = g.ttftCnt > 0 ? g.ttftSum / g.ttftCnt : 0;
        const tps = g.decSec > 0 ? g.decOut / g.decSec : 0;
        const denom = g.inp + g.cr;
        const hitPct = denom > 0 ? `${Math.round((g.cr / denom) * 100)}%` : null;
        const tipRows = [
          [tr('类型', 'Type'), formatCanaryCategoryLabel(g.category)],
          [tr('基座归属', 'Base family'), g.fullName],
          [
            tr('命中步数', 'Routed steps'),
            isEn() ? `${g.steps} ${g.steps === 1 ? 'step' : 'steps'}` : `${g.steps} 步`,
          ],
        ];
        if (hitPct) tipRows.push([tr('缓存命中', 'Cache hit'), hitPct]);
        const tipSpec = encodeTip({
          title: g.rawSlug,
          right: isEn()
            ? `${g.sessions.size} ${g.sessions.size === 1 ? 'conversation' : 'conversations'}`
            : `${g.sessions.size} 个会话`,
          rows: tipRows,
        });
        return `
          <div class="ov2-tr ov2-tr-perf" data-tip="${escapeHtml(tipSpec)}">
            <span class="ov2-td-label ov2-model-cell">${renderModelFamilyGlyph(g.provider || g.rawSlug)}<span class="ov2-model-name">${escapeHtml(g.rawSlug)}</span></span>
            <span class="ov2-td tnum">${formatUsd(g.usd, true)}</span>
            <span class="ov2-td tnum is-muted">${g.sessions.size}</span>
            <span class="ov2-td tnum">${ttft > 0 ? formatTtft(ttft) : '—'}</span>
            <span class="ov2-td tnum">${tps > 0 ? Math.round(tps) : '—'}</span>
          </div>`;
      })
      .join('');

    cohortsHtml = `
      <div class="ov2-block ov2-canary-cohorts">
        <div class="ov2-sec-head"><span class="ov2-sec-title">${tr('实验标识', 'Cohorts')}</span></div>
        <div class="ov2-table">
          <div class="ov2-tr ov2-tr-perf ov2-th">
            <span class="ov2-td-label">${tr('标识', 'Cohort')}</span>
            <span class="ov2-td">${tr('价值', 'Value')}</span>
            <span class="ov2-td">${tr('会话', 'Convs')}</span>
            <span class="ov2-td">${tr('首字', 'TTFT')}</span>
            <span class="ov2-td">tok/s</span>
          </div>
          ${cRows}
        </div>
      </div>`;
  }

  const visible = list.slice(0, state.canaryVisibleLimit || 40);
  const rows = visible
    .map((h) => {
      const title = h.childLabel
        ? `${h.threadTitle || ''}  ${h.childLabel}`
        : h.threadTitle || h.threadId?.slice(0, 8) || '';
      const routeText =
        h.desiredSlug && h.desiredSlug.toLowerCase() !== h.rawSlug.toLowerCase()
          ? `${h.desiredSlug} → ${h.rawSlug}`
          : h.rawSlug;
      const stepsLabel = isEn()
        ? `${h.steps} ${h.steps === 1 ? 'step' : 'steps'}`
        : `${h.steps} 步`;
      return `
        <article class="ov2-ev" data-open-canary-thread="${escapeHtml(h.threadId || '')}">
          <div class="ov2-ev-head tnum">
            <span class="inc-badge ${getCanaryBadgeClass(h.category)}">${escapeHtml(formatCanaryCategoryLabel(h.category))}</span>
            <span class="ov2-ev-title">${escapeHtml(title)}</span>
            <span class="ov2-ev-time">${escapeHtml(formatTimestampShort(h.timestampSec))}</span>
          </div>
          <div class="ov2-ev-meta ov2-ev-meta-row tnum"><span>${escapeHtml(routeText)}</span><span>${stepsLabel}</span><span>${formatUsd(h.costUsd, true)}</span></div>
        </article>`;
    })
    .join('');

  const rem = list.length - visible.length;
  const more =
    rem > 0
      ? `<button type="button" class="more-btn tnum" data-action="load-more-canary">${isEn() ? `Load more (${rem})` : `更多记录 ${rem}`}</button>`
      : '';

  const hitCountText = isEn()
    ? `${list.length} ${list.length === 1 ? 'hit' : 'hits'}`
    : `${list.length} 条命中记录`;
  const headLabel =
    active === 'all' ? hitCountText : `${formatCanaryCategoryLabel(active)}  ${hitCountText}`;

  return `
    <div class="ov2-cloud-summary">
      <div class="ov2-grid4">${cells}</div>
    </div>
    ${cohortsHtml}
    <div class="ov2-list-head ov2-cloud-list-head tnum">
      <span class="ov2-list-count">${escapeHtml(headLabel)}</span>
      ${active !== 'all' ? `<button type="button" class="ov2-link ov2-reset-filter" data-canary-filter="all">${tr('显示全部', 'Show all')}</button>` : ''}
    </div>
    <div class="ov2-ev-list">${rows || `<div class="empty-state">${tr('这段时间没有路由记录', 'No routing records in this window')}</div>`}</div>
    ${more}
  `;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function renderOverview() {
  const shell = ensureOverviewShell();
  const activeTab = ['overview', 'conversation', 'project', 'cli', 'cloud', 'canary'].includes(
    state.mainTab
  )
    ? state.mainTab
    : 'overview';

  if (state.hostConvId) {
    shell.currentLink.setAttribute('data-open-thread', state.hostConvId);
    setDisplay(shell.currentLink, true, 'inline');
  } else {
    setDisplay(shell.currentLink, false);
  }

  if (shell.updateBtn) {
    if (state.updateApplying) {
      setHtmlCached(shell.updateBtn, escapeHtml(tr('更新中…', 'Updating…')));
      setTip(shell.updateBtn, '');
      setDisplay(shell.updateBtn, true, 'inline');
    } else if (state.updateInfo?.hasUpdate && state.updateInfo.latestVersion) {
      const latestV = escapeHtml(state.updateInfo.latestVersion);
      const curV = state.updateInfo.currentVersion || '2.0.0';
      setHtmlCached(
        shell.updateBtn,
        isEn()
          ? `v${latestV} ↑`
          : `<span class="ov2-update-verb">更新 </span>v${latestV}`
      );
      setTip(
        shell.updateBtn,
        encodeTip({
          title: tr('发现新版本', 'Update Available'),
          right: `v${curV} → v${state.updateInfo.latestVersion}`,
          note: state.updateInfo.canSelfUpdate
            ? tr('点击直接热更新，无需重启客户端', 'Click to hot-update without restarting')
            : tr('点击前往 GitHub 查看更新', 'Click to open GitHub repository'),
        })
      );
      setDisplay(shell.updateBtn, true, 'inline');
    } else {
      setTip(shell.updateBtn, '');
      setDisplay(shell.updateBtn, false);
    }
  }

  setHtmlCached(shell.tabs, buildMainTabs(activeTab));

  if (!state.snapshot) {
    setHtmlCached(shell.wins, '');
    setDisplay(shell.live, false);
    setDisplay(shell.overviewPane, true, 'block');
    setHtmlCached(
      shell.hero,
      `<div class="ov2-hero-row"><div class="ov2-hero-main"><span class="ov2-k">${tr('等效 API 价值', 'API Value')}</span><span class="ov-hero-cost tnum">$0.00</span></div></div>`
    );
    for (const el of [
      shell.setup,
      shell.modelsSec,
      shell.issues,
      shell.canary,
      shell.projects,
      shell.sessions,
    ]) {
      setDisplay(el, false);
    }
    return;
  }

  const m = computeOverviewModel();
  setHtmlCached(shell.wins, buildWindowTabs(m.win, m.settings));

  if (m.activeCount > 0) {
    setText(shell.liveText, isEn() ? `${m.activeCount} live` : `${m.activeCount} 运行中`);
    setDisplay(shell.live, true, 'inline-flex');
  } else {
    setDisplay(shell.live, false);
  }

  if (activeTab === 'cloud') {
    setDisplay(shell.overviewPane, false);
    setDisplay(shell.canary, false);
    setDisplay(shell.projects, false);
    setDisplay(shell.sessions, false);
    setHtmlCached(shell.issues, buildCloudPaneHtml(m));
    setDisplay(shell.issues, true, 'block');
    return;
  }

  setDisplay(shell.issues, false);

  if (activeTab === 'canary') {
    setDisplay(shell.overviewPane, false);
    setDisplay(shell.projects, false);
    setDisplay(shell.sessions, false);
    setHtmlCached(shell.canary, buildCanaryPaneHtml(m));
    setDisplay(shell.canary, true, 'block');
    return;
  }

  setDisplay(shell.canary, false);

  if (activeTab === 'overview') {
    setDisplay(shell.projects, false);
    setDisplay(shell.sessions, false);
    setDisplay(shell.overviewPane, true, 'block');

    setDisplay(shell.hero, true, 'block');
    setHtmlCached(shell.hero, buildHeroHtml(m));

    if (shouldShowSetup(m.settings)) {
      setHtmlCached(shell.setup, buildSetupHtml(m.settings));
      setDisplay(shell.setup, true, 'flex');
    } else {
      setDisplay(shell.setup, false);
    }

    setDisplay(shell.modelsSec, true, 'block');
    setHtmlCached(shell.modelsSec, buildModelsHtml(m));
    return;
  }

  setDisplay(shell.overviewPane, false);

  if (activeTab === 'project' && !state.selectedProjectKey) {
    setDisplay(shell.sessions, false);
    setHtmlCached(shell.projects, buildProjectsRankingHtml(m));
    setDisplay(shell.projects, true, 'block');
    return;
  }

  setDisplay(shell.projects, false);
  setDisplay(shell.sessions, true, 'block');
  renderSessionsPane(
    shell,
    m,
    activeTab,
    activeTab === 'project' ? state.selectedProjectKey : ''
  );
}
