/**
 * Keyed zero-flicker Thread Detail View renderer (waterline matrix, 7 core metrics,
 * inline Swarm/Subagent/btw children, per-message ledger, and compacted summary).
 */

import { appEl, state } from './state.js';
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
  buildMatrix80Svg,
  computeDotAllocation,
  formatDuration,
  formatEnumCode,
  formatIssueCategoryLabel,
  formatPhaseLabel,
  formatTimestampShort,
  formatTokensCompact,
  formatTokensDetail,
  formatTtft,
  formatTurnTime,
  formatTurnUsd,
  formatUsd,
  getIssueBadgeClass,
  renderSummaryMarkdown,
  resolveThreadSoftLimit,
} from './format.js';
import { getDotPalette } from './theme.js';
import {
  BACK_CHEVRON_SVG,
  cleanCloudEventBody,
  describeIssueCategory,
  prettifyModelSlug,
  renderModelFamilyGlyph,
} from './format.js';
import {
  computeHitRatio,
  createEmptyHostThreadStub,
  extractTurnCompactionEvent,
  findThreadById,
  formatChildDisplayName,
  getModelsBreakdown,
  getSingleStreamNodeTps,
  getThreadTimingMetrics,
  getTurnTimingMetrics,
  isCurrentHostThread,
  isDetailChildrenExpanded,
  isPlaceholderModel,
  isPlaceholderTitle,
  isThreadTreeActive,
  isThreadTreeGenerating,
  isTurnCanaryRouted,
  isZeroMessageThread,
  resolveParentThreadId,
  resolveProjectKey,
  resolveProjectLabel,
  resolveStepCanaryBadge,
  resolveThreadCategory,
  resolveTurnCanaryBadge,
} from './selectors.js';
import {
  buildContextBreakdownTip,
  buildCostTip,
  buildDetailModelTip,
  buildDurationTip,
  buildOutputTip,
  buildStepRoutingTip,
  buildTpsTip,
  buildTtftTip,
  buildTurnRoutingTip,
} from './tooltips.js';
import { isEn, tr } from './i18n.js';

let dtShell = null;

export function invalidateDetailShell() {
  dtShell = null;
}

function ensureDetailShell(threadId) {
  if (dtShell && dtShell.threadId === threadId && dtShell.root.parentNode === appEl) {
    return dtShell;
  }
  appEl.innerHTML = `
    <div class="view-detail" data-shell="detail-live" data-detail-id="${escapeHtml(threadId)}">
      <header class="dt-header sec-pad">
        <div class="dt-nav">
          <div class="dt-nav-left">
            <button type="button" class="nav-link nav-link-primary dt-back-parent" data-open-thread="" style="display:none">${tr('主会话', 'Parent')}</button>
            <button type="button" class="nav-link dt-back-all" data-action="back">${tr('总览', 'Overview')}</button>
          </div>
          <button type="button" class="nav-link dt-open-chat" data-action="open-chat" data-conv-id="${escapeHtml(threadId)}">${tr('打开对话', 'Open Conversation')}</button>
        </div>
        <div class="dt-missing ds-empty" style="display:none"></div>
        <div class="dt-hero-row">
          <div class="dt-title-group">
            <div class="dt-title-line">
              <span class="dot-idle"></span>
              <h1 class="dt-title"></h1>
            </div>
            <div class="dt-subtitle">
              <span class="dt-sub-model"></span>
              <span class="dt-sub-extra" style="display:none"></span>
            </div>
          </div>
          <div class="dt-price-group">
            <div class="dt-price tnum"></div>
            <span class="dt-price-label">${tr('等效 API 价值', 'API Value')}</span>
          </div>
        </div>
      </header>

      <section class="dt-waterline sec-pad">
        <div class="dw-head">
          <span class="dw-label">${tr('上下文占用', 'Context')}</span>
          <span class="dw-stats tnum">
            <span class="dw-ratio"></span>
            <span class="dw-comp" style="display:none"></span>
          </span>
        </div>
        <div class="dw-matrix-wrap"></div>
        <div class="dw-foot tnum">
          <span class="dw-key"><span class="key-dot-ink"></span><span class="dw-key-cache"></span></span>
          <span class="dw-key"><span class="key-dot-mint"></span><span class="dw-key-fresh"></span></span>
          <span class="dw-key"><span class="key-dot-free"></span><span class="dw-key-free"></span></span>
          <button type="button" class="ov2-link dw-comp-btn" data-toggle-detail-summary="${escapeHtml(threadId)}" style="display:none"></button>
        </div>
        <div class="dw-summary-drawer" style="display:none">
          <div class="dw-summary-head">
            <span class="ds-title">${tr('上下文压缩摘要', 'Compacted Summary')}</span>
            <button type="button" class="ov2-link dw-summary-close" data-toggle-detail-summary="${escapeHtml(threadId)}">${tr('收起', 'Hide')}</button>
          </div>
          <div class="ds-body"></div>
        </div>
      </section>

      <section class="dt-metrics sec-pad">
        <div class="dm-item dm-hit-item">
          <span class="dm-label">${tr('缓存命中', 'Cache Hit')}</span>
          <span class="dm-val tnum dm-hit"></span>
        </div>
        <div class="dm-item dm-tps-item">
          <span class="dm-label">${tr('生成速度', 'Speed')}</span>
          <span class="dm-val tnum"><span class="dm-tps"></span><span class="dm-unit">tok/s</span></span>
        </div>
        <div class="dm-item dm-ttft-item">
          <span class="dm-label">${tr('首字延迟', 'TTFT')}</span>
          <span class="dm-val tnum dm-ttft"></span>
        </div>
        <div class="dm-item dm-dur-item">
          <span class="dm-label">${tr('总耗时', 'Duration')}</span>
          <span class="dm-val tnum dm-dur"></span>
        </div>
        <div class="dm-secondary tnum">
          <span class="dm-in-item">${tr('输入', 'In')} <span class="m-num dm-in"></span></span>
          <span class="dm-out-item">${tr('输出', 'Out')} <span class="m-num dm-out"></span></span>
          <span class="dm-cache-item">${tr('缓存读取', 'Cache Read')} <span class="m-num dm-cache"></span></span>
        </div>
      </section>

      <section class="dt-children sec-pad" style="display:none">
        <button type="button" class="dt-children-head tnum" data-toggle-detail-children="${escapeHtml(threadId)}">
          <span class="dch-left">
            <span class="dch-title">${tr('子任务', 'Subtasks')}</span>
            <span class="dch-count"></span>
            <span class="dch-active" style="display:none">
              <span class="child-dot-live is-pulsing"></span>
              <span class="dch-active-text"></span>
            </span>
          </span>
          <span class="dch-right">
            <span class="dch-cost"></span>
            <span class="dch-arrow"></span>
          </span>
        </button>
        <div class="dt-children-list" style="display:none"></div>
      </section>

      <section class="dt-turns sec-pad">
        <div class="dt-turns-head">
          <span class="dth-left">
            <span class="dth-title">${tr('逐轮明细', 'Turns')}</span>
            <span class="dth-count tnum"></span>
          </span>
          <div class="dth-controls tnum">
            <span class="dth-filter-group" style="display:none">
              <button type="button" class="turn-ctrl-btn dth-f-all" data-turn-filter="all">${tr('全部', 'All')}</button>
              <button type="button" class="turn-ctrl-btn dth-f-canary" data-turn-filter="canary"></button>
              <button type="button" class="turn-ctrl-btn dth-f-issues" data-turn-filter="issues" style="display:none"></button>
            </span>
            <span class="dth-sort-group">
              <button type="button" class="turn-ctrl-btn dth-s-desc" data-turn-sort="desc">${tr('最新', 'Newest')}</button>
              <button type="button" class="turn-ctrl-btn dth-s-asc" data-turn-sort="asc">${tr('最早', 'Oldest')}</button>
            </span>
          </div>
        </div>
        <div class="dt-turns-empty" style="display:none"></div>
        <div class="dt-turns-list"></div>
        <button type="button" class="turn-more-btn tnum" data-action="load-more-turns" style="display:none"></button>
      </section>
    </div>
  `;

  const root = appEl.firstElementChild;
  dtShell = {
    threadId,
    root,
    backParentBtn: root.querySelector('.dt-back-parent'),
    backAllBtn: root.querySelector('.dt-back-all'),
    openChatBtn: root.querySelector('.dt-open-chat'),
    missing: root.querySelector('.dt-missing'),
    heroRow: root.querySelector('.dt-hero-row'),
    dot: root.querySelector('.dt-title-line > span:first-child'),
    title: root.querySelector('.dt-title'),
    subModel: root.querySelector('.dt-sub-model'),
    subExtra: root.querySelector('.dt-sub-extra'),
    priceGroup: root.querySelector('.dt-price-group'),
    price: root.querySelector('.dt-price'),
    wlSection: root.querySelector('.dt-waterline'),
    dwRatio: root.querySelector('.dw-ratio'),
    dwComp: root.querySelector('.dw-comp'),
    dwCompBtn: root.querySelector('.dw-comp-btn'),
    summaryDrawer: root.querySelector('.dw-summary-drawer'),
    dsBody: root.querySelector('.ds-body'),
    matrixWrap: root.querySelector('.dw-matrix-wrap'),
    keyCache: root.querySelector('.dw-key-cache'),
    keyFresh: root.querySelector('.dw-key-fresh'),
    keyFree: root.querySelector('.dw-key-free'),
    metricsSection: root.querySelector('.dt-metrics'),
    dmIn: root.querySelector('.dm-in'),
    dmOutItem: root.querySelector('.dm-out-item'),
    dmOut: root.querySelector('.dm-out'),
    dmCacheItem: root.querySelector('.dm-cache-item'),
    dmCache: root.querySelector('.dm-cache'),
    dmHitItem: root.querySelector('.dm-hit-item'),
    dmHit: root.querySelector('.dm-hit'),
    dmDurItem: root.querySelector('.dm-dur-item'),
    dmDur: root.querySelector('.dm-dur'),
    dmTtftItem: root.querySelector('.dm-ttft-item'),
    dmTtft: root.querySelector('.dm-ttft'),
    dmTpsItem: root.querySelector('.dm-tps-item'),
    dmTps: root.querySelector('.dm-tps'),
    childrenSection: root.querySelector('.dt-children'),
    childrenHead: root.querySelector('.dt-children-head'),
    childrenCount: root.querySelector('.dch-count'),
    childrenActiveWrap: root.querySelector('.dch-active'),
    childrenActiveText: root.querySelector('.dch-active-text'),
    childrenCost: root.querySelector('.dch-cost'),
    childrenArrow: root.querySelector('.dch-arrow'),
    childrenList: root.querySelector('.dt-children-list'),
    childRowMap: new Map(),
    turnsSection: root.querySelector('.dt-turns'),
    turnsCount: root.querySelector('.dth-count'),
    turnsControls: root.querySelector('.dth-controls'),
    turnsFilterGroup: root.querySelector('.dth-filter-group'),
    turnsFilterAll: root.querySelector('.dth-f-all'),
    turnsFilterCanary: root.querySelector('.dth-f-canary'),
    turnsFilterIssues: root.querySelector('.dth-f-issues'),
    turnsSortDesc: root.querySelector('.dth-s-desc'),
    turnsSortAsc: root.querySelector('.dth-s-asc'),
    turnsEmpty: root.querySelector('.dt-turns-empty'),
    turnsList: root.querySelector('.dt-turns-list'),
    turnsMoreBtn: root.querySelector('.turn-more-btn'),
    turnRowMap: new Map(),
  };
  return dtShell;
}

function createTurnBlockElement(turnKey) {
  const block = document.createElement('div');
  block.className = 'turn-block';
  block.setAttribute('data-turn-key', String(turnKey));

  block.innerHTML = `
    <div class="turn-comp-div turn-comp-before tnum" style="display:none">
      <span class="tcd-label"></span>
      <span class="tcd-reset"></span>
    </div>
    <div class="turn-item" data-toggle-turn="${escapeHtml(String(turnKey))}">
      <div class="turn-r1">
        <div class="turn-r1-left">
          <span class="dot-live is-pulsing turn-live-dot" style="display:none"></span>
          <span class="turn-num tnum"></span>
          <span class="turn-preview"></span>
        </div>
        <span class="turn-cost tnum"></span>
      </div>
      <div class="turn-r2 tnum">
        <div class="turn-r2-left">
          <span class="turn-routing-chip">
            <span class="turn-slug"></span>
            <span class="turn-code" style="display:none"></span>
            <span class="turn-multi" style="display:none"></span>
            <span class="turn-phase" style="display:none"></span>
            <span class="turn-canary" style="display:none"></span>
            <span class="turn-error-tag" style="display:none"></span>
          </span>
          <span class="turn-steps-toggle" style="display:none"></span>
        </div>
        <span class="turn-r2-right">
          <span class="turn-dur" style="display:none"></span>
          <span class="turn-time"></span>
        </span>
      </div>
      <div class="turn-r3 tnum">
        <div class="turn-r3-left">
          <span>${tr('输入', 'In')} <span class="m-num turn-in"></span></span>
          <span class="turn-out-wrap">${tr('输出', 'Out')} <span class="m-num turn-out"></span></span>
          <span class="turn-cache-wrap">${tr('缓存', 'Cache')} <span class="m-num turn-cache"></span><span class="ti-hit-pct turn-hit"></span></span>
          <span class="turn-img-wrap" style="display:none">${tr('生图', 'Img')} <span class="m-num turn-img"></span></span>
          <span class="turn-ttft-wrap" style="display:none">${tr('首字', 'TTFT')} <span class="m-num turn-ttft"></span></span>
          <span class="m-num turn-tps"></span>
        </div>
        <span class="turn-wl">${tr('上下文', 'Ctx')} <span class="m-num turn-wl-num"></span><span class="turn-wl-denom" style="display:none"></span></span>
      </div>
      <div class="turn-drawer" style="display:none"></div>
    </div>
    <div class="turn-comp-div turn-comp-after tnum" style="display:none">
      <span class="tcd-label"></span>
      <span class="tcd-reset"></span>
    </div>
  `;

  block._refs = {
    compBefore: block.querySelector('.turn-comp-before'),
    compBeforeLabel: block.querySelector('.turn-comp-before .tcd-label'),
    compBeforeReset: block.querySelector('.turn-comp-before .tcd-reset'),
    item: block.querySelector('.turn-item'),
    liveDot: block.querySelector('.turn-live-dot'),
    num: block.querySelector('.turn-num'),
    preview: block.querySelector('.turn-preview'),
    cost: block.querySelector('.turn-cost'),
    routingChip: block.querySelector('.turn-routing-chip'),
    slug: block.querySelector('.turn-slug'),
    code: block.querySelector('.turn-code'),
    multi: block.querySelector('.turn-multi'),
    phase: block.querySelector('.turn-phase'),
    canary: block.querySelector('.turn-canary'),
    errorTag: block.querySelector('.turn-error-tag'),
    stepsToggle: block.querySelector('.turn-steps-toggle'),
    dur: block.querySelector('.turn-dur'),
    time: block.querySelector('.turn-time'),
    inNum: block.querySelector('.turn-in'),
    outWrap: block.querySelector('.turn-out-wrap'),
    outNum: block.querySelector('.turn-out'),
    cacheWrap: block.querySelector('.turn-cache-wrap'),
    cacheNum: block.querySelector('.turn-cache'),
    hitPct: block.querySelector('.turn-hit'),
    imgWrap: block.querySelector('.turn-img-wrap'),
    imgNum: block.querySelector('.turn-img'),
    ttftWrap: block.querySelector('.turn-ttft-wrap'),
    ttftNum: block.querySelector('.turn-ttft'),
    tps: block.querySelector('.turn-tps'),
    wlWrap: block.querySelector('.turn-wl'),
    wlNum: block.querySelector('.turn-wl-num'),
    wlDenom: block.querySelector('.turn-wl-denom'),
    drawer: block.querySelector('.turn-drawer'),
    compAfter: block.querySelector('.turn-comp-after'),
    compAfterLabel: block.querySelector('.turn-comp-after .tcd-label'),
    compAfterReset: block.querySelector('.turn-comp-after .tcd-reset'),
  };

  return block;
}

function buildTurnDrawerHtml(turn) {
  const promptText = String(turn?.promptText || turn?.preview || '').trim();
  const steps = Array.isArray(turn?.steps) ? turn.steps : [];
  const parts = [];

  if (promptText) {
    parts.push(`<div class="turn-prompt-box">${escapeHtml(promptText)}</div>`);
  }

  const showSteps =
    steps.length > 1 ||
    steps.some(
      (s) =>
        s &&
        (s.kind === 'incident' ||
          s.isCanary ||
          s.isCanaryRouted ||
          s.isUnknownModel ||
          s.wasDiscardedByFilter ||
          s.kind === 'image' ||
          s.phase)
    );

  if (showSteps && steps.length > 0) {
    let llmOrdinal = 0;
    const stepRows = steps
      .filter((st) => !(st?.kind === 'incident' && st.category === 'tool_error'))
      .map((st) => {
        if (st.kind === 'incident') {
          const badgeCls = getIssueBadgeClass(st.category);
          const catRaw = formatIssueCategoryLabel(st.category);
          const catTip = encodeTip({ title: catRaw, body: describeIssueCategory(st.category) });
          return `
            <div class="turn-incident-row tnum">
              <div class="tir-head">
                <span class="inc-badge ${badgeCls}" data-tip="${escapeHtml(catTip)}">${escapeHtml(catRaw)}</span>
              </div>
              <pre class="inc-text">${escapeHtml(cleanCloudEventBody(st.injectedText || st.summary || ''))}</pre>
            </div>
          `;
        }

        llmOrdinal += 1;
        const sSlug = escapeHtml(
          st.fullName || st.shortName || prettifyModelSlug(st.rawSlug || st.slug) || 'Model'
        );
        const sCode = '';
        const sPhase = formatPhaseLabel(st.phase);
        const sCanary = resolveStepCanaryBadge(st);
        const sDiscard = st.wasDiscardedByFilter
          ? `<span class="tsr-discarded">${tr('已被过滤', 'Discarded by filter')}</span>`
          : '';
        const sTip = escapeHtml(buildStepRoutingTip(st));
        const sDur = Number(st.durationSec ?? 0);
        const sCost = formatTurnUsd(st.costUsd ?? 0);
        const sStepLabel =
          st.kind === 'image'
            ? tr('生图', 'Image')
            : st.kind === 'checkpoint'
              ? tr('上下文压缩', 'Compaction')
              : isEn()
                ? `Step ${llmOrdinal}`
                : `第 ${llmOrdinal} 步`;

        let botLeftHtml = '';
        if (st.kind === 'image') {
          const imgCnt = st.imageCount || 1;
          botLeftHtml = `<span>${tr('生成媒体', 'Generated')} <span class="m-num">${isEn() ? `${imgCnt} ${imgCnt === 1 ? 'img' : 'imgs'}` : `${imgCnt} 张`}</span></span>`;
        } else {
          const sIn = formatTokensCompact(st.input ?? st.tokens?.input ?? 0);
          const sOut = formatTokensCompact(st.output ?? st.tokens?.output ?? 0);
          const sCache = formatTokensCompact(st.cacheRead ?? st.tokens?.cacheRead ?? 0);
          const sTtft = Number(st.ttftSec ?? 0);
          const sTps = Number(st.decodeTps ?? st.tps?.decode ?? 0);
          botLeftHtml = `
            <span>${tr('输入', 'In')} <span class="m-num">${sIn}</span></span>
            <span>${tr('输出', 'Out')} <span class="m-num">${sOut}</span></span>
            <span>${tr('缓存', 'Cache')} <span class="m-num">${sCache}</span></span>
            ${sTtft > 0 ? `<span>${tr('首字', 'TTFT')} <span class="m-num">${formatTtft(sTtft)}</span></span>` : ''}
            ${sTps > 0 ? `<span class="m-num">${Math.round(sTps)} tok/s</span>` : ''}
          `;
        }

        const sWl = Number(
          st.waterlineTokens ??
            (Number(st.input ?? st.tokens?.input ?? 0) +
              Number(st.cacheRead ?? st.tokens?.cacheRead ?? 0))
        );
        const sSoft = Number(st.softLimit || 0);
        const sTipAttr = sTip ? ` data-tip="${escapeHtml(sTip)}"` : '';

        return `
          <div class="turn-step-row tnum">
            <div class="tsr-top">
              <span class="tsr-top-left"${sTipAttr}>
                <span class="tsr-idx">${sStepLabel}</span>
                <span class="tsr-slug">${sSlug}</span>
                ${sCode ? `<span class="tsr-code">${sCode}</span>` : ''}
                ${sPhase ? `<span class="tsr-phase">${escapeHtml(sPhase)}</span>` : ''}
                ${sCanary ? `<span class="tsr-canary">${escapeHtml(sCanary)}</span>` : ''}
                ${sDiscard}
              </span>
              <span class="tsr-top-right">
                ${sDur > 0 ? `<span class="tsr-dur">${isEn() ? formatDuration(sDur) : `耗时 ${formatDuration(sDur)}`}</span>` : ''}
                <span class="tsr-cost">${sCost}</span>
              </span>
            </div>
            <div class="tsr-bot">
              <span class="tsr-bot-left">${botLeftHtml}</span>
              <span>${st.kind !== 'image' && sWl > 0 ? `${tr('上下文', 'Ctx')} <span class="m-num">${formatTokensCompact(sWl)}</span>${sSoft > 0 ? `<span class="turn-wl-denom"> / ${formatTokensCompact(sSoft)}</span>` : ''}` : ''}</span>
            </div>
          </div>
        `;
      })
      .join('');
    parts.push(`<div class="turn-steps-list">${stepRows}</div>`);
  }

  return parts.join('');
}

function patchTurnBlockElement(
  block,
  threadId,
  turn,
  sortOrder,
  isLastVisible,
  effectiveFilter = 'all'
) {
  const refs = block._refs;
  const turnNum = turn.turnNumber ?? 1;
  const expKey = `${threadId}:${turnNum}`;
  const autoExpIssue =
    effectiveFilter === 'issues' && !state.collapsedFilterTurns.has(expKey);
  const isExpanded = state.expandedTurns.has(expKey) || autoExpIssue;

  const compEv = extractTurnCompactionEvent(turn);
  const showCompBefore = Boolean(compEv && sortOrder === 'asc');
  const showCompAfter = Boolean(compEv && sortOrder === 'desc');

  if (compEv) {
    const labelStr = compEv.index
      ? isEn()
        ? `Auto-compaction #${compEv.index}`
        : `第 ${compEv.index} 次自动压缩`
      : tr('自动压缩', 'Auto-compaction');
    const resetStr =
      compEv.afterTokens > 0
        ? isEn()
          ? `Context reduced to ${formatTokensCompact(compEv.afterTokens)}`
          : `上下文降至 ${formatTokensCompact(compEv.afterTokens)}`
        : tr('上下文已重置', 'Context reset');
    const compTip =
      compEv.beforeTokens > 0 && compEv.afterTokens > 0
        ? encodeTip({
            title: tr('上下文压缩', 'Context Compaction'),
            rows: [
              [tr('压缩前', 'Before'), formatTokensCompact(compEv.beforeTokens)],
              [tr('压缩后', 'After'), formatTokensCompact(compEv.afterTokens)],
            ],
          })
        : '';

    if (showCompBefore) {
      setText(refs.compBeforeLabel, labelStr);
      setText(refs.compBeforeReset, resetStr);
      setTip(refs.compBefore, compTip);
    }
    if (showCompAfter) {
      setText(refs.compAfterLabel, labelStr);
      setText(refs.compAfterReset, resetStr);
      setTip(refs.compAfter, compTip);
    }
  }
  setDisplay(refs.compBefore, showCompBefore, 'flex');
  setDisplay(refs.compAfter, showCompAfter, 'flex');

  const itemClass =
    isLastVisible && !showCompAfter ? 'turn-item no-tail-border' : 'turn-item';
  setClass(refs.item, itemClass);

  setDisplay(refs.liveDot, Boolean(turn.isGenerating), 'inline-block');
  setText(refs.num, `#${turnNum}`);
  const previewStr =
    String(turn.preview || '').trim() ||
    tr('（系统触发或工具续写）', '(System or tool continuation)');
  setText(refs.preview, previewStr);
  setText(refs.cost, formatTurnUsd(turn.costUsd));

  const r = turn.routing || turn.model || {};
  const rawSlug = r.rawSlug || r.slug || r.shortName || 'Model';
  const enumCode = r.code || formatEnumCode(r.enumId);
  const distinctCount = Array.isArray(r.distinctModels)
    ? r.distinctModels.length
    : Number(r.distinctModels || 1);
  const phases = Array.isArray(r.phases)
    ? r.phases.map(formatPhaseLabel).filter(Boolean)
    : [];
  const phaseStr = phases.length > 0 ? phases.join(' / ') : '';
  const canaryBadge = resolveTurnCanaryBadge(turn);
  const displayModel = r.fullName || r.shortName || prettifyModelSlug(rawSlug) || 'Model';

  setText(refs.slug, displayModel);
  setDisplay(refs.code, false);
  if (distinctCount > 1) {
    setText(refs.multi, `+${distinctCount - 1}`);
    setDisplay(refs.multi, true, 'inline');
  } else {
    setDisplay(refs.multi, false);
  }
  if (phaseStr) {
    setText(refs.phase, phaseStr);
    setDisplay(refs.phase, true, 'inline');
  } else {
    setDisplay(refs.phase, false);
  }
  setText(refs.canary, canaryBadge);
  setDisplay(refs.canary, Boolean(canaryBadge), 'inline');

  const showTurnError = turn.error && turn.error.category !== 'tool_error';
  if (showTurnError) {
    const errLabel = turn.error.category
      ? formatIssueCategoryLabel(turn.error.category)
      : turn.error.hasSafetyFilter
        ? tr('安全过滤', 'Safety Filter')
        : turn.error.hasQuotaError
          ? tr('限流', '429 Quota')
          : tr('异常', 'Error');
    setText(refs.errorTag, turn.error.count > 1 ? `${errLabel} ×${turn.error.count}` : errLabel);
    setClass(
      refs.errorTag,
      turn.error.hasQuotaError || turn.error.category === 'quota_429'
        ? 'turn-error-tag is-quota'
        : 'turn-error-tag'
    );
    setDisplay(refs.errorTag, true, 'inline');
  } else {
    setDisplay(refs.errorTag, false);
  }

  setTip(refs.routingChip, buildTurnRoutingTip(turn));

  const stepCount = Number(turn.llmStepCount ?? turn.steps?.length ?? 1);
  const incLen = Array.isArray(turn.incidents)
    ? turn.incidents.filter((inc) => inc?.category !== 'tool_error').length
    : 0;
  if (stepCount > 1 || incLen > 0) {
    const labelPrefix =
      stepCount > 1
        ? isEn()
          ? `${stepCount} steps`
          : `${stepCount} 步`
        : tr('详情', 'Details');
    setText(refs.stepsToggle, isExpanded ? tr('收起', 'Hide') : labelPrefix);
    setDisplay(refs.stepsToggle, true, 'inline');
  } else {
    setDisplay(refs.stepsToggle, false);
  }

  setText(refs.time, formatTurnTime(turn));

  const turnTiming = getTurnTimingMetrics(turn, threadId);
  if (turnTiming.durationSec > 0) {
    const durFormatted = formatDuration(turnTiming.durationSec);
    setText(refs.dur, isEn() ? durFormatted : `耗时 ${durFormatted}`);
    setClass(refs.dur, turnTiming.isLive ? 'turn-dur is-live' : 'turn-dur');
    const nonLlm = Math.max(0, turnTiming.durationSec - turnTiming.llmSec);
    setTip(
      refs.dur,
      turnTiming.llmSec > 0 && nonLlm >= 1
        ? {
            title: tr('本轮耗时构成', 'Turn Duration'),
            right: durFormatted,
            rows: [
              [tr('模型推理', 'Model inference'), formatDuration(turnTiming.llmSec)],
              [tr('工具与调度', 'Tools & harness'), formatDuration(nonLlm)],
            ],
          }
        : ''
    );
    setDisplay(refs.dur, true, 'inline');
  } else {
    setTip(refs.dur, '');
    setDisplay(refs.dur, false);
  }

  const tk = turn.tokens || {};
  const rawIn = Number(tk.input || 0);
  const rawOut = Number(tk.output || 0);
  const rawCache = Number(tk.cacheRead || 0);
  const genImgs = Number(tk.generatedImages || 0);
  setText(refs.inNum, formatTokensCompact(rawIn));
  setText(refs.outNum, formatTokensCompact(rawOut));
  if (Number(tk.thinking || 0) > 0) {
    setTip(refs.outWrap, {
      title: tr('输出构成', 'Output Breakdown'),
      right: formatTokensCompact(rawOut),
      rows: [
        [tr('思考推理', 'Thinking'), formatTokensCompact(tk.thinking || 0)],
        [tr('回复正文', 'Response'), formatTokensCompact(tk.response || 0)],
      ],
    });
  } else {
    setTip(refs.outWrap, '');
  }

  setText(refs.cacheNum, formatTokensCompact(rawCache));
  const hitRatio = computeHitRatio(rawIn, rawCache, tk.cacheHitRatio);
  if (hitRatio != null) {
    setText(refs.hitPct, `${Math.round(hitRatio * 100)}%`);
    setDisplay(refs.hitPct, true, 'inline');
  } else {
    setDisplay(refs.hitPct, false);
  }

  if (genImgs > 0) {
    setText(
      refs.imgNum,
      isEn() ? `${genImgs}` : `${genImgs} 张`
    );
    setDisplay(refs.imgWrap, true, 'inline');
  } else {
    setDisplay(refs.imgWrap, false);
  }

  if (turnTiming.ttftSec > 0) {
    setText(refs.ttftNum, formatTtft(turnTiming.ttftSec));
    setTip(refs.ttftWrap, '');
    setDisplay(refs.ttftWrap, true, 'inline');
  } else {
    setTip(refs.ttftWrap, '');
    setDisplay(refs.ttftWrap, false);
  }

  const decodeTps = Number(turn.tps?.decode ?? turn.tps?.rolling ?? turn.decodeTps ?? 0);
  setText(refs.tps, decodeTps > 0 ? `${Math.round(decodeTps)} tok/s` : '— tok/s');

  const wlTokens = Number(turn.waterlineTokens ?? rawIn + rawCache);
  const turnSoft = Number(turn.softLimit || 0);
  setText(refs.wlNum, formatTokensCompact(wlTokens));
  setTip(refs.wlWrap, '');
  if (turnSoft > 0) {
    setText(refs.wlDenom, ` / ${formatTokensCompact(turnSoft)}`);
    setDisplay(refs.wlDenom, true, 'inline');
  } else {
    setDisplay(refs.wlDenom, false);
  }

  if (isExpanded) {
    const drawerHtml = buildTurnDrawerHtml(turn);
    setHtmlCached(refs.drawer, drawerHtml);
    setDisplay(refs.drawer, Boolean(drawerHtml), 'flex');
  } else {
    setDisplay(refs.drawer, false);
  }
}

function createDetailChildRowElement(childId) {
  const row = document.createElement('div');
  row.className = 'dt-child-row tnum';
  row.setAttribute('data-open-thread', childId);
  row.setAttribute('data-child-id', childId);
  row.innerHTML = `
    <div class="dcr-left">
      <span class="child-dot-idle"></span>
      <span class="dcr-name"></span>
      <span class="dcr-badge" style="display:none"></span>
      <span class="dcr-model"></span>
    </div>
    <div class="dcr-right">
      <span class="dcr-wl"></span>
      <span class="dcr-dur" style="display:none"></span>
      <span class="dcr-tps" style="display:none"></span>
      <span class="dcr-cost"></span>
    </div>
  `;
  row._refs = {
    dot: row.querySelector('.dcr-left > span:first-child'),
    name: row.querySelector('.dcr-name'),
    badge: row.querySelector('.dcr-badge'),
    model: row.querySelector('.dcr-model'),
    wl: row.querySelector('.dcr-wl'),
    dur: row.querySelector('.dcr-dur'),
    tps: row.querySelector('.dcr-tps'),
    cost: row.querySelector('.dcr-cost'),
  };
  return row;
}

function resolveChildBadge(ch) {
  if (ch.alert) {
    return {
      text: ch.alert.kind === 'quota' ? tr('限流', '429 Quota') : tr('异常', 'Error'),
      cls: 'dcr-badge is-err',
    };
  }
  if (ch.kind !== 'btw') {
    if (ch.workspaceMode && ch.workspaceMode !== 'inherit') {
      return { text: ch.workspaceMode, cls: 'dcr-badge' };
    }
    if (ch.swarmRole === 'narrator' || ch.swarmRole === 'monitor') {
      return { text: ch.swarmRole, cls: 'dcr-badge' };
    }
    if (ch.model?.modelSwitched) {
      return { text: tr('切模型', 'Switched'), cls: 'dcr-badge' };
    }
  }
  return null;
}

function patchDetailChildRowElement(row, ch) {
  const refs = row._refs;
  const chActive = isThreadTreeActive(ch);
  const chDot = chActive
    ? `child-dot-live${isThreadTreeGenerating(ch) ? ' is-pulsing' : ''}`
    : 'child-dot-idle';
  setClass(refs.dot, chDot);

  setText(refs.name, formatChildDisplayName(ch));

  const badge = resolveChildBadge(ch);
  if (badge) {
    setText(refs.badge, badge.text);
    setClass(refs.badge, badge.cls);
    setDisplay(refs.badge, true, 'inline');
  } else {
    setDisplay(refs.badge, false);
  }

  const modelsUsed = getModelsBreakdown(ch);
  const baseShort = ch.model?.shortName || ch.model?.rawSlug || '';
  const modelDisplay =
    baseShort && modelsUsed.length >= 2
      ? `${baseShort} +${modelsUsed.length - 1}`
      : baseShort;
  setText(refs.model, modelDisplay);
  setDisplay(refs.model, Boolean(modelDisplay), 'inline');

  const chWl = formatTokensCompact(ch.waterline?.currentTokens || 0);
  setText(refs.wl, isEn() ? `Ctx ${chWl}` : `上下文 ${chWl}`);

  const chTiming = getThreadTimingMetrics(ch, state.snapshotClientMs);
  if (chTiming.totalSec > 0) {
    const chDurStr = formatDuration(chTiming.totalSec, true);
    setText(refs.dur, isEn() ? chDurStr : `耗时 ${chDurStr}`);
    setClass(refs.dur, chTiming.isLive ? 'dcr-dur is-live' : 'dcr-dur');
    setDisplay(refs.dur, true, 'inline');
  } else {
    setDisplay(refs.dur, false);
  }

  const chTps = getSingleStreamNodeTps(ch);
  if (chTps > 0) {
    setText(refs.tps, `${Math.round(chTps)} tok/s`);
    setDisplay(refs.tps, true, 'inline');
  } else {
    setDisplay(refs.tps, false);
  }

  setText(refs.cost, formatUsd(ch.cost?.treeUsd ?? ch.cost?.selfUsd ?? 0));
  setTip(row, '');
}

function renderDetailChildren(shell, threadId, t, liveThread) {
  const children =
    Array.isArray(liveThread?.children) && liveThread.children.length > 0
      ? liveThread.children
      : Array.isArray(t?.children)
        ? t.children
        : [];

  if (children.length === 0) {
    for (const el of shell.childRowMap.values()) {
      el.remove();
    }
    shell.childRowMap.clear();
    setDisplay(shell.childrenSection, false);
    return;
  }

  setDisplay(shell.childrenSection, true, 'flex');

  const runningKids = children.filter((c) => isThreadTreeActive(c)).length;
  const kidsCost =
    t?.cost?.childrenUsd ??
    liveThread?.cost?.childrenUsd ??
    children.reduce(
      (acc, c) => acc + Number(c.cost?.treeUsd ?? c.cost?.selfUsd ?? 0),
      0
    );
  const isExp = isDetailChildrenExpanded(threadId, children.length);

  setText(shell.childrenCount, isEn() ? `${children.length}` : `${children.length} 个`);
  if (runningKids > 0) {
    setText(
      shell.childrenActiveText,
      runningKids === children.length
        ? tr('全部活跃', 'All live')
        : isEn()
          ? `${runningKids} live`
          : `${runningKids} 活跃`
    );
    setDisplay(shell.childrenActiveWrap, true, 'inline-flex');
  } else {
    setDisplay(shell.childrenActiveWrap, false);
  }

  setText(
    shell.childrenCost,
    isEn() ? formatUsd(kidsCost) : `合计 ${formatUsd(kidsCost)}`
  );
  setText(shell.childrenArrow, isExp ? tr('收起', 'Hide') : tr('展开', 'Show'));
  setTip(shell.childrenHead, '');

  if (!isExp) {
    setDisplay(shell.childrenList, false);
    return;
  }

  setDisplay(shell.childrenList, true, 'flex');
  const keepIds = new Set();
  for (let i = 0; i < children.length; i++) {
    const ch = children[i];
    const cid = ch.id;
    keepIds.add(cid);

    let rowEl = shell.childRowMap.get(cid);
    if (!rowEl) {
      rowEl = createDetailChildRowElement(cid);
      shell.childRowMap.set(cid, rowEl);
    }
    patchDetailChildRowElement(rowEl, ch);

    const curAtIdx = shell.childrenList.children[i];
    if (curAtIdx !== rowEl) {
      shell.childrenList.insertBefore(rowEl, curAtIdx || null);
    }
  }

  for (const [cid, el] of shell.childRowMap.entries()) {
    if (!keepIds.has(cid)) {
      el.remove();
      shell.childRowMap.delete(cid);
    }
  }
}

function renderDetailTurns(shell, threadId, cachedDetail, isZeroHostSession = false) {
  setDisplay(shell.turnsSection, true, 'flex');

  if (isZeroHostSession) {
    for (const el of shell.turnRowMap.values()) {
      el.remove();
    }
    shell.turnRowMap.clear();
    setText(shell.turnsCount, isEn() ? '0' : '0 轮');
    setDisplay(shell.turnsControls, false);
    setDisplay(shell.turnsList, false);
    setDisplay(shell.turnsMoreBtn, false);
    const syncingInitial = !state.snapshot && state.loadingDetailId === threadId;
    setText(
      shell.turnsEmpty,
      syncingInitial
        ? tr('正在同步当前会话数据…', 'Syncing current conversation…')
        : tr('等待首条消息产生用量数据', 'Waiting for first message')
    );
    setDisplay(shell.turnsEmpty, true, 'block');
    return;
  }

  if (!cachedDetail) {
    for (const el of shell.turnRowMap.values()) {
      el.remove();
    }
    shell.turnRowMap.clear();
    setText(shell.turnsCount, '');
    setDisplay(shell.turnsControls, false);
    setDisplay(shell.turnsList, false);
    setDisplay(shell.turnsMoreBtn, false);
    setText(
      shell.turnsEmpty,
      state.loadingDetailId === threadId
        ? tr('正在同步每轮用量明细…', 'Syncing turn details…')
        : tr('暂无轮次明细记录', 'No turn records available')
    );
    setDisplay(shell.turnsEmpty, true, 'block');
    return;
  }

  const rawTurns = Array.isArray(cachedDetail.turns) ? cachedDetail.turns : [];
  const totalTurns = Number(cachedDetail.turnSummary?.totalTurns ?? rawTurns.length);
  const hasTurnCloudIssue = (turnItem) =>
    Boolean(
      (Array.isArray(turnItem?.incidents) &&
        turnItem.incidents.some((inc) => inc && inc.category !== 'tool_error')) ||
        (turnItem?.error && turnItem.error.category !== 'tool_error')
    );

  const canaryTurnCount = rawTurns.filter((turnItem) => isTurnCanaryRouted(turnItem)).length;
  const issueTurnCount = rawTurns.filter(hasTurnCloudIssue).length;

  setText(shell.turnsCount, isEn() ? `${totalTurns}` : `${totalTurns} 轮`);

  if (rawTurns.length === 0) {
    for (const el of shell.turnRowMap.values()) {
      el.remove();
    }
    shell.turnRowMap.clear();
    setDisplay(shell.turnsControls, false);
    setDisplay(shell.turnsList, false);
    setDisplay(shell.turnsMoreBtn, false);
    setText(
      shell.turnsEmpty,
      threadId === state.hostConvId
        ? tr('等待首条消息产生用量数据', 'Waiting for first message')
        : tr('当前会话暂无推理用量记录', 'No inference turns recorded in this conversation')
    );
    setDisplay(shell.turnsEmpty, true, 'block');
    return;
  }

  setDisplay(shell.turnsControls, true, 'inline-flex');
  const showFilters = canaryTurnCount > 0 || issueTurnCount > 0;
  let effectiveFilter = showFilters ? state.turnFilter : 'all';
  if (effectiveFilter === 'canary' && canaryTurnCount === 0) effectiveFilter = 'all';
  if (effectiveFilter === 'issues' && issueTurnCount === 0) effectiveFilter = 'all';

  if (showFilters) {
    setDisplay(shell.turnsFilterGroup, true, 'inline-flex');
    setClass(
      shell.turnsFilterAll,
      `turn-ctrl-btn dth-f-all${effectiveFilter === 'all' ? ' is-active' : ''}`
    );
    if (canaryTurnCount > 0) {
      setText(
        shell.turnsFilterCanary,
        isEn() ? `Routing ${canaryTurnCount}` : `路由 ${canaryTurnCount}`
      );
      setClass(
        shell.turnsFilterCanary,
        `turn-ctrl-btn dth-f-canary${effectiveFilter === 'canary' ? ' is-active' : ''}`
      );
      setDisplay(shell.turnsFilterCanary, true, 'inline');
    } else {
      setDisplay(shell.turnsFilterCanary, false);
    }
    if (issueTurnCount > 0) {
      setText(
        shell.turnsFilterIssues,
        isEn() ? `Events ${issueTurnCount}` : `事件 ${issueTurnCount}`
      );
      setClass(
        shell.turnsFilterIssues,
        `turn-ctrl-btn dth-f-issues${effectiveFilter === 'issues' ? ' is-active' : ''}`
      );
      setDisplay(shell.turnsFilterIssues, true, 'inline');
    } else {
      setDisplay(shell.turnsFilterIssues, false);
    }
  } else {
    setDisplay(shell.turnsFilterGroup, false);
  }

  const sortOrder = state.turnSort === 'asc' ? 'asc' : 'desc';
  setClass(
    shell.turnsSortDesc,
    `turn-ctrl-btn dth-s-desc${sortOrder === 'desc' ? ' is-active' : ''}`
  );
  setClass(
    shell.turnsSortAsc,
    `turn-ctrl-btn dth-s-asc${sortOrder === 'asc' ? ' is-active' : ''}`
  );

  const filtered =
    effectiveFilter === 'canary'
      ? rawTurns.filter((turnItem) => isTurnCanaryRouted(turnItem))
      : effectiveFilter === 'issues'
        ? rawTurns.filter(hasTurnCloudIssue)
        : rawTurns.slice();

  filtered.sort((a, b) => {
    const na = Number(a.turnNumber ?? 0);
    const nb = Number(b.turnNumber ?? 0);
    return sortOrder === 'desc' ? nb - na : na - nb;
  });

  if (filtered.length === 0) {
    for (const el of shell.turnRowMap.values()) {
      el.remove();
    }
    shell.turnRowMap.clear();
    setDisplay(shell.turnsList, false);
    setDisplay(shell.turnsMoreBtn, false);
    setText(shell.turnsEmpty, tr('未筛选到匹配的轮次', 'No matching turns'));
    setDisplay(shell.turnsEmpty, true, 'block');
    return;
  }

  setDisplay(shell.turnsEmpty, false);
  setDisplay(shell.turnsList, true, 'flex');

  const visibleTurns = filtered.slice(0, state.turnVisibleLimit);
  const remaining = Math.max(0, filtered.length - visibleTurns.length);

  const keepKeys = new Set();
  for (let i = 0; i < visibleTurns.length; i++) {
    const turnItem = visibleTurns[i];
    const key = String(turnItem.turnNumber ?? i + 1);
    keepKeys.add(key);

    let blockEl = shell.turnRowMap.get(key);
    if (!blockEl) {
      blockEl = createTurnBlockElement(key);
      shell.turnRowMap.set(key, blockEl);
    }
    patchTurnBlockElement(
      blockEl,
      threadId,
      turnItem,
      sortOrder,
      i === visibleTurns.length - 1,
      effectiveFilter
    );

    const curNode = shell.turnsList.children[i];
    if (curNode !== blockEl) {
      shell.turnsList.insertBefore(blockEl, curNode || null);
    }
  }

  for (const [k, el] of shell.turnRowMap.entries()) {
    if (!keepKeys.has(k)) {
      el.remove();
      shell.turnRowMap.delete(k);
    }
  }

  if (remaining > 0) {
    setText(
      shell.turnsMoreBtn,
      isEn() ? `Load more turns (${remaining})` : `显示更多轮次 (剩余 ${remaining} 轮)`
    );
    setDisplay(shell.turnsMoreBtn, true, 'block');
  } else {
    setDisplay(shell.turnsMoreBtn, false);
  }
}

export function renderDetail() {
  const id = state.selectedThreadId;
  const shell = ensureDetailShell(id);
  const cachedDetail = state.detailCache.get(id);
  const liveThread = findThreadById(state.snapshot?.threads, id);
  const rawThread = liveThread || cachedDetail?.thread;
  const isHostTarget = Boolean(state.hostConvId && id === state.hostConvId);
  const palette = getDotPalette();

  const parentId = resolveParentThreadId(rawThread, id);
  let backLabel = tr('返回总览', 'Overview');
  if (state.mainTab === 'cloud') {
    backLabel = tr('返回事件', 'Events');
  } else if (state.mainTab === 'canary') {
    backLabel = tr('返回路由', 'Routing');
  } else if (state.mainTab === 'conversation') {
    backLabel = tr('返回对话', 'Conversations');
  } else if (state.mainTab === 'project') {
    backLabel = state.selectedProjectName
      ? isEn()
        ? state.selectedProjectName
        : `返回 ${state.selectedProjectName}`
      : tr('返回项目', 'Projects');
  } else if (state.mainTab === 'cli') {
    backLabel = tr('返回 CLI', 'CLI');
  }
  if (parentId) {
    shell.backParentBtn.setAttribute('data-open-thread', parentId);
    setClass(shell.backParentBtn, 'back-btn dt-back-parent');
    setHtmlCached(
      shell.backParentBtn,
      `${BACK_CHEVRON_SVG}<span>${tr('返回主会话', 'Parent')}</span>`
    );
    setDisplay(shell.backParentBtn, true, 'inline-flex');
    setClass(shell.backAllBtn, 'nav-link dt-back-all');
    setHtmlCached(shell.backAllBtn, escapeHtml(backLabel));
  } else {
    setDisplay(shell.backParentBtn, false);
    setClass(shell.backAllBtn, 'back-btn dt-back-all');
    setHtmlCached(shell.backAllBtn, `${BACK_CHEVRON_SVG}<span>${escapeHtml(backLabel)}</span>`);
  }

  if (!rawThread && !isHostTarget) {
    setDisplay(shell.openChatBtn, false);
    setDisplay(shell.heroRow, false);
    setDisplay(shell.wlSection, false);
    setDisplay(shell.metricsSection, false);
    setDisplay(shell.issuesSection, false);
    setDisplay(shell.childrenSection, false);
    setDisplay(shell.turnsSection, false);
    setDisplay(shell.summaryWrap, false);
    setText(
      shell.missing,
      state.loadingDetailId === id
        ? tr('正在读取线程详情…', 'Loading conversation details…')
        : tr('未找到对应线程记录', 'Conversation record not found')
    );
    setDisplay(shell.missing, true, 'block');
    return;
  }

  const t = rawThread || createEmptyHostThreadStub(id);
  const isZeroHostSession = isHostTarget && isZeroMessageThread(t, cachedDetail);

  setDisplay(shell.missing, false);
  setDisplay(shell.openChatBtn, !isZeroHostSession && t.kind !== 'btw', 'inline');
  setDisplay(shell.heroRow, true, 'flex');
  setDisplay(shell.wlSection, true, 'block');
  setDisplay(shell.metricsSection, true, 'grid');
  setDisplay(shell.summaryWrap, true, 'block');

  const compactionInfo = cachedDetail?.compaction || null;
  const active = isThreadTreeActive(t);
  const currentHost = isHostTarget || isCurrentHostThread(t);
  const dotClass = active
    ? 'dot-live is-pulsing'
    : currentHost
      ? 'dot-current'
      : 'dot-idle';
  setClass(shell.dot, dotClass);

  const syncingInitialHost =
    isZeroHostSession && !state.snapshot && state.loadingDetailId === id;
  const rawBaseTitle = isZeroHostSession
    ? syncingInitialHost
      ? tr('当前会话', 'Current Conversation')
      : isPlaceholderTitle(t.title, id)
        ? tr('当前新会话', 'New Conversation')
        : t.title
    : t.title || t.roleLabel || t.id.slice(0, 8);
  const displayTitle =
    t.kind === 'btw' && !/^\/btw\b/i.test(rawBaseTitle)
      ? `/btw ${rawBaseTitle}`
      : rawBaseTitle;
  setText(shell.title, displayTitle);

  const modelsUsed = getModelsBreakdown(t);
  const rawFullModel =
    t.model?.fullName || t.model?.shortName || t.model?.rawSlug || '';
  let fullModelDisplay = '';
  if (isZeroHostSession && isPlaceholderModel(rawFullModel)) {
    fullModelDisplay = syncingInitialHost
      ? tr('正在同步会话数据…', 'Syncing conversation…')
      : tr('等待首条消息', 'Waiting for first message');
  } else {
    const baseFullModel = rawFullModel || 'Model';
    fullModelDisplay =
      modelsUsed.length >= 2
        ? `${baseFullModel} +${modelsUsed.length - 1}`
        : baseFullModel;
  }
  setHtmlCached(
    shell.subModel,
    isZeroHostSession
      ? escapeHtml(fullModelDisplay)
      : `${renderModelFamilyGlyph(t.model)}<span>${escapeHtml(fullModelDisplay)}</span>`
  );
  setTip(shell.subModel, isZeroHostSession ? '' : buildDetailModelTip(t));

  const cat = resolveThreadCategory(t);
  const projLabel = resolveProjectLabel(t);
  const projKey = cat === 'project' ? resolveProjectKey(t) : '';
  const extraParts = [];
  if (cat === 'project' && projLabel) {
    extraParts.push(
      projKey
        ? `<button type="button" class="ov2-link dt-proj-link" data-open-project="${escapeHtml(projKey)}" data-project-name="${escapeHtml(projLabel)}">${escapeHtml(projLabel)}</button>`
        : escapeHtml(projLabel)
    );
  }
  if (cat === 'cli') extraParts.push('CLI');
  if (t.kind === 'btw') extraParts.push(tr('/btw 侧问', '/btw side question'));
  if (t.automation) extraParts.push(tr('定时任务', 'Scheduled'));

  const extraHtml = extraParts.join('<span class="dt-sub-sep"></span>');
  setHtmlCached(shell.subExtra, extraHtml);
  setDisplay(shell.subExtra, Boolean(extraHtml), 'inline-flex');

  setText(shell.price, formatUsd(t.cost?.treeUsd ?? t.cost?.selfUsd ?? 0, true));
  setTip(shell.priceGroup || shell.price, isZeroHostSession ? '' : buildCostTip(t));

  const softLimit = resolveThreadSoftLimit(t.waterline, t.model);
  const currentTokens = Math.max(0, Number(t.waterline?.currentTokens || 0));
  const cachedTokens = Math.max(0, Number(t.waterline?.cachedTokens || 0));
  const freshTokens = Math.max(
    0,
    Number(t.waterline?.freshTokens ?? Math.max(0, currentTokens - cachedTokens))
  );
  const remainingTokens = Math.max(0, softLimit - currentTokens);
  const softPct = Math.round((currentTokens / softLimit) * 100);

  const compCount = Number(compactionInfo?.count ?? t.compaction?.count ?? 0);
  const latestStepIdx =
    compactionInfo?.latestStepIndex ?? t.compaction?.latestStepIndex ?? null;

  setText(
    shell.dwRatio,
    `${formatTokensCompact(currentTokens)} / ${formatTokensCompact(softLimit)} (${softPct}%)`
  );
  const summaryExpanded = compCount > 0 && state.expandedDetailSummary.has(id);
  if (compCount > 0) {
    setText(
      shell.dwComp,
      isEn() ? `Compacted ${compCount}×` : `已压缩 ${compCount} 次`
    );
    setDisplay(shell.dwComp, true, 'inline');
    setText(
      shell.dwCompBtn,
      summaryExpanded
        ? tr('收起压缩摘要', 'Hide summary')
        : tr('查看压缩摘要', 'View summary')
    );
    setDisplay(shell.dwCompBtn, true, 'inline');
  } else {
    setDisplay(shell.dwComp, false);
    setDisplay(shell.dwCompBtn, false);
  }
  setTip(shell.wlSection, '');
  const ctxBreakdownTip = isZeroHostSession
    ? ''
    : buildContextBreakdownTip(t, cachedDetail?.thread?.waterline || null);
  setTip(shell.matrixWrap, ctxBreakdownTip);
  setTip(shell.dwRatio, ctxBreakdownTip);

  const { inkDots, mintDots } = computeDotAllocation(t.waterline, t.model, 80);
  const matrixSig = `${palette.theme}:${inkDots}:${mintDots}`;
  if (shell.matrixWrap._matrixSig !== matrixSig) {
    shell.matrixWrap.innerHTML = buildMatrix80Svg(inkDots, mintDots);
    shell.matrixWrap._matrixSig = matrixSig;
  }

  setText(
    shell.keyCache,
    isEn()
      ? `Cached ${formatTokensDetail(cachedTokens)}`
      : `缓存 ${formatTokensDetail(cachedTokens)}`
  );
  setText(
    shell.keyFresh,
    isEn()
      ? `Fresh ${formatTokensDetail(freshTokens)}`
      : `新增 ${formatTokensDetail(freshTokens)}`
  );
  setText(
    shell.keyFree,
    isEn()
      ? `Free ${formatTokensDetail(remainingTokens)}`
      : `剩余 ${formatTokensDetail(remainingTokens)}`
  );

  const rawIn = Number(t.tokens?.input || 0);
  const rawCache = Number(t.tokens?.cacheRead || 0);
  setText(shell.dmIn, formatTokensDetail(rawIn));
  setText(shell.dmOut, formatTokensDetail(t.tokens?.output || 0));
  setTip(shell.dmOutItem, isZeroHostSession ? '' : buildOutputTip(t));
  setText(shell.dmCache, formatTokensDetail(rawCache));
  setTip(shell.dmCacheItem, '');

  const hitRatio = computeHitRatio(rawIn, rawCache, t.tokens?.cacheHitRatio);
  setText(shell.dmHit, hitRatio != null ? `${(hitRatio * 100).toFixed(1)}%` : '—');
  setTip(shell.dmHitItem, '');

  const timingNode = t?.timing ? t : cachedDetail?.thread?.timing ? cachedDetail.thread : t;
  const detailBaseMs =
    timingNode === cachedDetail?.thread
      ? state.detailClientMs.get(id) || state.snapshotClientMs
      : state.snapshotClientMs;
  const dtTiming = getThreadTimingMetrics(timingNode, detailBaseMs);
  if (isZeroHostSession) {
    setText(shell.dmDur, '—');
    setClass(shell.dmDur, 'dm-val tnum dm-dur');
    setTip(shell.dmDurItem, '');
    setText(shell.dmTtft, '—');
    setTip(shell.dmTtftItem, '');
  } else {
    setText(shell.dmDur, formatDuration(dtTiming.totalSec));
    setClass(
      shell.dmDur,
      dtTiming.isLive && dtTiming.totalSec > 0
        ? 'dm-val tnum dm-dur is-live'
        : 'dm-val tnum dm-dur'
    );
    setTip(shell.dmDurItem, buildDurationTip(timingNode, detailBaseMs));
    setText(shell.dmTtft, formatTtft(dtTiming.ttftSec));
    setTip(shell.dmTtftItem, buildTtftTip(timingNode));
  }

  const tpsVal = getSingleStreamNodeTps(t);
  setText(shell.dmTps, tpsVal > 0 ? tpsVal.toFixed(1) : '—');
  setTip(shell.dmTpsItem, isZeroHostSession ? '' : buildTpsTip(t));

  renderDetailChildren(shell, id, t, liveThread);
  renderDetailTurns(shell, id, cachedDetail, isZeroHostSession);

  setDisplay(shell.summaryDrawer, summaryExpanded, 'block');
  if (summaryExpanded) {
    const summaryMd = compactionInfo?.summaryMarkdown || '';
    const summarySig = `${compCount}|${latestStepIdx ?? ''}|${Boolean(!cachedDetail && state.loadingDetailId === id)}|${summaryMd.length}|${isEn() ? 'en' : 'zh'}`;
    if (shell.dsBody._summarySig !== summarySig) {
      let summaryBodyHtml = '';
      if (!cachedDetail && state.loadingDetailId === id) {
        summaryBodyHtml = `<div class="ds-empty">${tr('正在加载完整压缩摘要…', 'Loading compacted summary…')}</div>`;
      } else if (!summaryMd.trim()) {
        summaryBodyHtml = `<div class="ds-empty">${tr('未读取到压缩摘要正文', 'Compacted summary text unavailable')}</div>`;
      } else {
        summaryBodyHtml = `<div class="ds-prose">${renderSummaryMarkdown(summaryMd)}</div>`;
      }
      shell.dsBody.innerHTML = summaryBodyHtml;
      shell.dsBody._summarySig = summarySig;
    }
  }
}
