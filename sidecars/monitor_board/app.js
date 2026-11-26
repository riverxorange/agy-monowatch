/**
 * monowatch (`monitor_board`) Sidecar UI Entrypoint.
 * Coordinates host theme sync, post-load ETag polling, optional SSE streaming, turn detail loading, and event delegation.
 */

import {
  appEl,
  resolveRouteThreadId,
  sidecarFetch,
  state,
  syncUrlViewState,
  withSidecarToken,
} from './ui/state.js';
import { hideTooltip, initTooltips } from './ui/dom.js';
import { initThemeSync } from './ui/theme.js';
import {
  findThreadById,
  isDetailChildrenExpanded,
  isDetailIssuesExpanded,
  isThreadTreeActive,
  isZeroMessageThread,
} from './ui/selectors.js';
import { invalidateOverviewShell, renderOverview } from './ui/overview.js';
import { invalidateDetailShell, renderDetail } from './ui/detail.js';
import { loadSettings, saveSettings } from './ui/settings.js';
import { PLAN_OPTIONS } from './ui/period.js';
import { syncDocumentLang, tr } from './ui/i18n.js';

let renderedLang = '';

function render() {
  const curLang = syncDocumentLang();
  if (curLang !== renderedLang) {
    renderedLang = curLang;
    invalidateOverviewShell();
    invalidateDetailShell();
  }
  if (state.selectedThreadId) {
    invalidateOverviewShell();
    renderDetail();
  } else {
    invalidateDetailShell();
    renderOverview();
  }
  if (appEl.getAttribute('data-boot') !== 'ready') {
    appEl.setAttribute('data-boot', 'ready');
  }
}

const detailFetchInFlight = new Set();
const detailFetchPending = new Set();

function applyPendingFocusStep(threadId) {
  const targetStep = state.pendingFocusStep;
  if (targetStep == null || !threadId || state.selectedThreadId !== threadId) return;
  const detail = state.detailCache.get(threadId);
  if (!detail || !Array.isArray(detail.turns)) return;
  state.pendingFocusStep = null;
  const matchedTurn =
    detail.turns.find(
      (tr) =>
        Number(tr.stepStartIndex) <= targetStep && Number(tr.stepEndIndex) >= targetStep
    ) ||
    detail.turns.find(
      (tr) =>
        Array.isArray(tr.incidents) &&
        tr.incidents.some((inc) => Number(inc.stepIndex) === Number(targetStep))
    );
  if (!matchedTurn) return;

  if (state.turnFilter === 'canary' && !matchedTurn.routing?.isCanary) {
    state.turnFilter = 'all';
  } else if (
    state.turnFilter === 'issues' &&
    !(matchedTurn.incidents?.length > 0 || matchedTurn.error)
  ) {
    state.turnFilter = 'all';
  }
  state.expandedTurns.add(`${threadId}:${matchedTurn.turnNumber}`);
  const sortOrder = state.turnSort === 'asc' ? 'asc' : 'desc';
  const sorted = detail.turns
    .slice()
    .sort((a, b) =>
      sortOrder === 'desc'
        ? Number(b.turnNumber) - Number(a.turnNumber)
        : Number(a.turnNumber) - Number(b.turnNumber)
    );
  const posIdx = sorted.findIndex((tr) => tr.turnNumber === matchedTurn.turnNumber);
  if (posIdx >= state.turnVisibleLimit) {
    state.turnVisibleLimit = posIdx + 10;
  }
  setTimeout(() => {
    const el = appEl.querySelector(`[data-turn-key="${matchedTurn.turnNumber}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, 40);
}

async function fetchThreadDetail(threadId, force = false, silent = false, opts = {}) {
  if (!threadId) return;
  if (!force && state.detailCache.has(threadId)) return;
  if (detailFetchInFlight.has(threadId)) {
    if (force) detailFetchPending.add(threadId);
    return;
  }
  detailFetchInFlight.add(threadId);
  if (!silent && !state.detailCache.has(threadId)) {
    state.loadingDetailId = threadId;
    render();
  }
  try {
    let threadPath = `/api/thread?id=${encodeURIComponent(threadId)}`;
    if (state.hostConvId) {
      threadPath += `&conversationId=${encodeURIComponent(state.hostConvId)}`;
    }
    if (opts?.fastCold) {
      threadPath += '&fast=1';
    }
    const res = await sidecarFetch(threadPath, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && !data.error && data.thread) {
        state.detailCache.set(threadId, data);
        state.detailClientMs.set(threadId, Date.now());
        applyPendingFocusStep(threadId);
      }
    }
  } catch {
    // Keep graceful fallback to live snapshot fields
  } finally {
    detailFetchInFlight.delete(threadId);
    if (state.loadingDetailId === threadId) {
      state.loadingDetailId = null;
    }
    if (state.selectedThreadId === threadId) {
      applyPendingFocusStep(threadId);
      render();
    }
    if (detailFetchPending.has(threadId)) {
      detailFetchPending.delete(threadId);
      if (state.selectedThreadId === threadId) {
        fetchThreadDetail(threadId, true, true);
      }
    }
  }
}

function openThread(threadId, opts = {}) {
  if (!threadId) return;
  hideTooltip();
  const reqFilter =
    opts?.turnFilter === 'canary' || opts?.turnFilter === 'issues'
      ? opts.turnFilter
      : null;
  state.collapsedFilterTurns.clear();
  if (state.selectedThreadId !== threadId) {
    state.turnFilter = reqFilter || 'all';
    state.turnVisibleLimit = 30;
  } else if (reqFilter) {
    state.turnFilter = reqFilter;
  }
  state.pendingFocusStep =
    opts?.focusStepIndex !== undefined &&
    opts?.focusStepIndex !== null &&
    Number.isFinite(Number(opts.focusStepIndex))
      ? Number(opts.focusStepIndex)
      : null;
  state.selectedThreadId = threadId;
  state.followHostSession = Boolean(state.hostConvId && threadId === state.hostConvId);
  syncUrlViewState(threadId, false);
  applyPendingFocusStep(threadId);
  window.scrollTo(0, 0);
  render();
  fetchThreadDetail(threadId, true, state.detailCache.has(threadId));
}

function closeThread() {
  hideTooltip();
  state.selectedThreadId = null;
  state.followHostSession = false;
  syncUrlViewState(null, false);
  render();
}

function applySnapshot(snap) {
  if (!snap || snap.unchanged) return;
  const nextRev = Number(snap.rev ?? -1);
  if (nextRev >= 0 && nextRev === state.rev && state.snapshot) {
    return;
  }
  state.rev = nextRev >= 0 ? nextRev : state.rev + 1;
  state.snapshot = snap;
  state.snapshotClientMs = Date.now();
  state.bootError = '';

  if (state.selectedThreadId) {
    const live = findThreadById(snap.threads, state.selectedThreadId);
    const cached = state.detailCache.get(state.selectedThreadId);
    if (!cached) {
      if (
        state.selectedThreadId !== state.hostConvId ||
        (live && !isZeroMessageThread(live, null))
      ) {
        fetchThreadDetail(state.selectedThreadId, true, false);
      }
    } else if (live) {
      const ct = cached.thread || {};
      const detailChanged =
        live.isGenerating !== ct.isGenerating ||
        live.tokens?.output !== ct.tokens?.output ||
        live.tokens?.input !== ct.tokens?.input ||
        live.tokens?.generatedImages !== ct.tokens?.generatedImages ||
        live.updatedAtMs !== ct.updatedAtMs ||
        live.stepCount !== ct.stepCount ||
        live.waterline?.currentTokens !== ct.waterline?.currentTokens ||
        live.waterline?.softLimit !== ct.waterline?.softLimit ||
        live.compaction?.count !== cached.compaction?.count ||
        live.compaction?.latestStepIndex !== cached.compaction?.latestStepIndex ||
        (live.issues?.total || 0) !== (ct.issues?.total || 0) ||
        (live.issues?.treeTotal || 0) !== (ct.issues?.treeTotal || 0) ||
        (live.children?.length || 0) !== (ct.children?.length || 0) ||
        (Array.isArray(cached.turns) &&
          cached.turns.length === 0 &&
          !isZeroMessageThread(live, null));
      if (detailChanged) {
        fetchThreadDetail(state.selectedThreadId, true, true);
      }
    }
  }

  render();
}

let snapshotPollInFlight = false;
let sseInstance = null;
let ssePrimed = false;
let pollTimer = null;
let liveTickTimer = null;
let realtimeStarted = false;

function cleanupRealtimeSync() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (liveTickTimer) {
    clearInterval(liveTickTimer);
    liveTickTimer = null;
  }
  if (sseInstance) {
    try {
      sseInstance.close();
    } catch {
      // Ignore EventSource close failure
    }
    sseInstance = null;
  }
  ssePrimed = false;
}

async function pollSnapshotFallback() {
  if (snapshotPollInFlight) return;
  snapshotPollInFlight = true;
  try {
    let snapPath = `/api/snapshot?etag=${encodeURIComponent(state.rev)}`;
    if (state.hostConvId) {
      snapPath += `&conversationId=${encodeURIComponent(state.hostConvId)}`;
    }
    const res = await sidecarFetch(snapPath, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && !data.unchanged) {
        applySnapshot(data);
      }
    } else if (!state.snapshot) {
      state.bootError = tr(
        `本地监控接口响应异常（HTTP ${res.status}），正在自动重试…`,
        `Local telemetry endpoint returned HTTP ${res.status}, retrying…`
      );
      render();
    }
  } catch {
    if (!state.snapshot) {
      state.bootError = tr(
        '正在连接本地监控服务，请稍候…',
        'Connecting to local telemetry worker…'
      );
      render();
    }
  } finally {
    snapshotPollInFlight = false;
  }
}

async function startRealtimeSync() {
  if (realtimeStarted) return;
  realtimeStarted = true;

  const searchParams = new URLSearchParams(window.location.search);
  const isHeadlessShot =
    /\bHeadlessChrome\b/i.test(navigator.userAgent || '') ||
    searchParams.has('nosse');
  const wantsSse = !isHeadlessShot && searchParams.get('sse') === '1';

  if (state.selectedThreadId) {
    const initialDetail = fetchThreadDetail(
      state.selectedThreadId,
      true,
      false,
      { fastCold: !state.snapshot }
    );
    await Promise.race([
      initialDetail,
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    pollSnapshotFallback();
  } else {
    pollSnapshotFallback();
  }

  pollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (ssePrimed && sseInstance && sseInstance.readyState === 1) {
      return;
    }
    pollSnapshotFallback();
  }, 1200);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      pollSnapshotFallback();
    }
  });

  if (!isHeadlessShot) {
    liveTickTimer = setInterval(() => {
      if (document.visibilityState === 'hidden' || !state.snapshot) return;
      if (state.selectedThreadId) {
        const id = state.selectedThreadId;
        const live = findThreadById(state.snapshot.threads, id);
        const cached = state.detailCache.get(id);
        const node = live || cached?.thread;
        const hasLiveTurn =
          Array.isArray(cached?.turns) &&
          cached.turns.some((tr) => tr?.isLive || tr?.isGenerating);
        if (
          node?.timing?.isLiveTicking ||
          isThreadTreeActive(node) ||
          hasLiveTurn
        ) {
          renderDetail();
        }
      } else if (
        Array.isArray(state.snapshot.threads) &&
        state.snapshot.threads.some(
          (t) => t?.timing?.isLiveTicking || isThreadTreeActive(t)
        )
      ) {
        renderOverview();
      }
    }, 1000);
  }

  window.addEventListener('pagehide', cleanupRealtimeSync);

  if (wantsSse && typeof window.EventSource === 'function') {
    try {
      const streamPath = state.hostConvId
        ? `/api/stream?conversationId=${encodeURIComponent(state.hostConvId)}`
        : '/api/stream';
      const es = new EventSource(withSidecarToken(streamPath));
      sseInstance = es;
      es.addEventListener('snapshot', (ev) => {
        ssePrimed = true;
        try {
          applySnapshot(JSON.parse(ev.data));
        } catch {
          // Ignore malformed frame
        }
      });
      es.onmessage = (ev) => {
        if (!ev.data) return;
        try {
          const parsed = JSON.parse(ev.data);
          if (parsed && Array.isArray(parsed.threads)) {
            ssePrimed = true;
            applySnapshot(parsed);
          }
        } catch {
          // Ignore keepalive or non-JSON frame
        }
      };
      es.onerror = () => {
        ssePrimed = false;
      };
    } catch {
      ssePrimed = false;
    }
  }
}

function applyHostConvSwitch(nextRawId) {
  const nextId = String(nextRawId ?? '').trim();
  if (!nextId || nextId === state.hostConvId) return;

  state.hostConvId = nextId;
  state.rev = -1;
  pollSnapshotFallback();

  if (state.followHostSession) {
    hideTooltip();
    state.turnFilter = 'all';
    state.turnVisibleLimit = 30;
    state.selectedThreadId = nextId;
    syncUrlViewState(nextId, true);
    window.scrollTo(0, 0);
    render();
    fetchThreadDetail(nextId, true);
  } else {
    render();
  }
}

function initHostBridge() {
  if (window.sidecar?.getWorkspaceUris) {
    Promise.resolve()
      .then(() => window.sidecar.getWorkspaceUris())
      .then((initial) => {
        if (Array.isArray(initial)) {
          state.workspaceUris = initial;
          render();
        }
      })
      .catch(() => {
        // Ignore if host bridge not ready
      });
  }
  if (window.sidecar?.onWorkspaceChange) {
    try {
      window.sidecar.onWorkspaceChange((uris) => {
        state.workspaceUris = Array.isArray(uris) ? uris : [];
        render();
      });
    } catch {
      // Ignore
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event?.data;
    if (!msg || typeof msg !== 'object') return;
    const mType = String(msg.type || '');
    const isConvEvent =
      mType === 'conversation-change' ||
      mType === 'sidecar-conversation-change' ||
      mType === 'active-conversation-change' ||
      mType === 'session-change';
    const rawNext =
      msg.payload && typeof msg.payload === 'object' && 'conversationId' in msg.payload
        ? msg.payload.conversationId
        : 'conversationId' in msg
          ? msg.conversationId
          : undefined;
    if (!isConvEvent && rawNext === undefined) return;
    applyHostConvSwitch(rawNext);
  });

  // Poll `window.sidecar.conversationId` so host session changes without postMessage are also tracked
  if (window.sidecar) {
    setInterval(() => {
      const liveId = String(window.sidecar?.conversationId || '').trim();
      if (liveId && liveId !== state.hostConvId) {
        applyHostConvSwitch(liveId);
      }
    }, 1000);
  }
}

let updateFeedbackTimer = null;

function flashUpdateFeedback(msg) {
  state.updateFeedback = msg;
  if (updateFeedbackTimer) clearTimeout(updateFeedbackTimer);
  updateFeedbackTimer = setTimeout(() => {
    state.updateFeedback = '';
    render();
  }, 4000);
}

async function checkPluginUpdate(force = false) {
  if (state.updateChecking || state.updateApplying) return;
  if (force) {
    state.updateChecking = true;
    state.updateFeedback = '';
    render();
  }
  try {
    const res = await sidecarFetch(`/api/update-status${force ? '?force=1' : ''}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        state.updateInfo = data;
        if (force && !data.hasUpdate) {
          flashUpdateFeedback(tr('已是最新', 'Up to date'));
        }
      }
    }
  } catch {
    if (force) {
      flashUpdateFeedback(tr('网络不可达', 'Unreachable'));
    }
  } finally {
    if (force) {
      state.updateChecking = false;
    }
    render();
  }
}

async function applyPluginUpdate() {
  if (state.updateApplying) return;
  hideTooltip();
  const info = state.updateInfo;
  if (info && !info.canSelfUpdate) {
    const url = info.releaseUrl || info.repoUrl;
    if (url) window.open(url, '_blank', 'noopener');
    return;
  }
  state.updateApplying = true;
  state.updateFeedback = '';
  render();
  try {
    const res = await sidecarFetch('/api/update', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const data = res.ok ? await res.json() : null;
    if (data?.ok) {
      await new Promise((r) => setTimeout(r, 1300));
      for (let i = 0; i < 8; i++) {
        try {
          const probe = await sidecarFetch('/api/update-status', {
            headers: { Accept: 'application/json' },
          });
          if (probe.ok) break;
        } catch {
          // Wait for new worker process to come up
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      window.location.reload();
      return;
    }
    state.updateApplying = false;
    flashUpdateFeedback(tr('自动更新失败', 'Update failed'));
    const fallbackUrl = data?.repoUrl || info?.releaseUrl || info?.repoUrl;
    if (fallbackUrl) window.open(fallbackUrl, '_blank', 'noopener');
    render();
  } catch {
    state.updateApplying = false;
    flashUpdateFeedback(tr('自动更新失败', 'Update failed'));
    render();
  }
}

function readNumberInput(selector) {
  const el = appEl.querySelector(selector);
  if (!el) return NaN;
  const v = Number(String(el.value || '').trim());
  return Number.isFinite(v) ? v : NaN;
}

function handleOverviewV2Click(e) {
  const mainTabBtn = e.target.closest('[data-main-tab]');
  if (mainTabBtn) {
    e.stopPropagation();
    hideTooltip();
    const nextTab = mainTabBtn.getAttribute('data-main-tab') || 'overview';
    state.mainTab = ['overview', 'conversation', 'project', 'cli', 'cloud', 'canary'].includes(
      nextTab
    )
      ? nextTab
      : 'overview';
    state.overviewMode = 'home';
    if (nextTab === 'project') {
      state.selectedProjectKey = '';
      state.selectedProjectName = '';
    }
    if (nextTab === 'cloud') {
      state.issueCategoryFilter = 'all';
      state.issuesVisibleLimit = 40;
    }
    if (nextTab === 'canary') {
      state.canaryCategoryFilter = 'all';
      state.canaryVisibleLimit = 40;
    }
    state.visibleLimit = 40;
    syncUrlViewState(null, false);
    window.scrollTo(0, 0);
    render();
    return true;
  }

  const openProjBtn = e.target.closest('[data-open-project]');
  if (openProjBtn) {
    e.stopPropagation();
    hideTooltip();
    const pKey = openProjBtn.getAttribute('data-open-project') || '';
    const pName = openProjBtn.getAttribute('data-project-name') || '';
    state.mainTab = 'project';
    state.selectedProjectKey = pKey;
    if (pName) state.selectedProjectName = pName;
    state.overviewMode = 'home';
    state.visibleLimit = 40;
    if (state.selectedThreadId) {
      closeThread();
    } else {
      syncUrlViewState(null, false);
      window.scrollTo(0, 0);
      render();
    }
    return true;
  }

  const winBtn = e.target.closest('[data-window]');
  if (winBtn) {
    e.stopPropagation();
    hideTooltip();
    state.timeWindow = winBtn.getAttribute('data-window') || 'period';
    state.visibleLimit = 40;
    render();
    return true;
  }

  const planBtn = e.target.closest('[data-plan]');
  if (planBtn) {
    e.stopPropagation();
    const id = planBtn.getAttribute('data-plan');
    if (id === 'custom') {
      if (!state.customPlanDraft) {
        state.customPlanDraft = true;
        render();
      }
      setTimeout(() => appEl.querySelector('.ov2-custom-usd')?.focus(), 30);
      return true;
    }
    const preset = PLAN_OPTIONS.find((p) => p.id === id);
    if (!preset) return true;
    if (!state.customPlanDraft && state.settings?.plan?.id === id) {
      return true;
    }
    state.customPlanDraft = false;
    saveSettings({ plan: { id, monthlyUsd: preset.monthlyUsd } }).then(render);
    render();
    return true;
  }

  const langBtn = e.target.closest('[data-lang]');
  if (langBtn) {
    e.stopPropagation();
    const nextLang = langBtn.getAttribute('data-lang') || 'auto';
    if (['auto', 'zh', 'en'].includes(nextLang)) {
      state.urlLang = '';
      saveSettings({ lang: nextLang }).then(render);
      render();
    }
    return true;
  }

  const act = e.target.closest('[data-action]')?.getAttribute('data-action');
  if (!act) return false;

  switch (act) {
    case 'open-issues': {
      e.stopPropagation();
      const actEl = e.target.closest('[data-action]');
      state.issueCategoryFilter = actEl.getAttribute('data-issue-filter') || 'all';
      state.issuesVisibleLimit = 40;
      state.overviewMode = 'issues';
      window.scrollTo(0, 0);
      render();
      return true;
    }
    case 'close-issues':
      e.stopPropagation();
      state.overviewMode = 'home';
      render();
      return true;
    case 'close-project':
      e.stopPropagation();
      hideTooltip();
      state.selectedProjectKey = '';
      state.selectedProjectName = '';
      state.visibleLimit = 40;
      syncUrlViewState(null, false);
      window.scrollTo(0, 0);
      render();
      return true;
    case 'save-custom-plan': {
      e.stopPropagation();
      const usd = readNumberInput('.ov2-custom-usd');
      if (!(usd >= 0)) return true;
      state.customPlanDraft = false;
      saveSettings({ plan: { id: 'custom', monthlyUsd: usd } }).then(render);
      render();
      return true;
    }
    case 'save-billing-day': {
      e.stopPropagation();
      const day = Math.trunc(readNumberInput('.ov2-billing-day'));
      if (!(day >= 1 && day <= 31)) return true;
      state.timeWindow = 'period';
      saveSettings({ billingDay: day, billingDaySkipped: false }).then(render);
      render();
      return true;
    }
    case 'skip-billing-day':
      e.stopPropagation();
      saveSettings({ billingDaySkipped: true }).then(render);
      render();
      return true;
    case 'clear-billing-day':
      e.stopPropagation();
      saveSettings({ billingDay: null, billingDaySkipped: true }).then(render);
      render();
      return true;
    case 'open-settings':
      e.stopPropagation();
      state.settingsOpen = true;
      if (state.selectedThreadId) {
        closeThread();
      } else {
        render();
      }
      return true;
    case 'close-settings-backdrop':
      if (e.target !== actionBtn) return false;
      e.stopPropagation();
      state.settingsOpen = false;
      state.customPlanDraft = false;
      render();
      return true;
    case 'close-settings':
      e.stopPropagation();
      state.settingsOpen = false;
      state.customPlanDraft = false;
      render();
      return true;
    case 'check-update':
      e.stopPropagation();
      checkPluginUpdate(true);
      return true;
    case 'apply-update':
      e.stopPropagation();
      applyPluginUpdate();
      return true;
    case 'toggle-update-check': {
      e.stopPropagation();
      const nextVal = state.settings?.updateCheck === false;
      saveSettings({ updateCheck: nextVal }).then(() => {
        checkPluginUpdate(nextVal);
      });
      render();
      return true;
    }

    default:
      return false;
  }
}

appEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.closest?.('.ov2-custom-usd')) {
    appEl.querySelector('[data-action="save-custom-plan"]')?.click();
  } else if (e.target.closest?.('.ov2-billing-day')) {
    appEl.querySelector('[data-action="save-billing-day"]')?.click();
  }
});

appEl.addEventListener('click', (e) => {
  if (handleOverviewV2Click(e)) return;

  const scopeBtn = e.target.closest('[data-scope]');
  if (scopeBtn) {
    e.stopPropagation();
    state.scope = scopeBtn.getAttribute('data-scope');
    state.visibleLimit = 40;
    render();
    if (scopeBtn.hasAttribute('data-scroll-sessions')) {
      appEl.querySelector('.ov2-sessions')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }
    return;
  }

  const issueFilterBtn = e.target.closest('[data-issue-filter]');
  if (issueFilterBtn) {
    e.stopPropagation();
    hideTooltip();
    const cat = issueFilterBtn.getAttribute('data-issue-filter') || 'all';
    const nextCat = cat !== 'all' && state.issueCategoryFilter === cat ? 'all' : cat;
    if (state.issueCategoryFilter !== nextCat) {
      state.issueCategoryFilter = nextCat;
      state.issuesVisibleLimit = 40;
      render();
    }
    return;
  }

  const canaryFilterBtn = e.target.closest('[data-canary-filter]');
  if (canaryFilterBtn) {
    e.stopPropagation();
    hideTooltip();
    const cat = canaryFilterBtn.getAttribute('data-canary-filter') || 'all';
    const nextCat = cat !== 'all' && state.canaryCategoryFilter === cat ? 'all' : cat;
    if (state.canaryCategoryFilter !== nextCat) {
      state.canaryCategoryFilter = nextCat;
      state.canaryVisibleLimit = 40;
      render();
    }
    return;
  }

  const turnFilterBtn = e.target.closest('[data-turn-filter]');
  if (turnFilterBtn) {
    e.stopPropagation();
    const rawFilter = turnFilterBtn.getAttribute('data-turn-filter');
    const nextFilter =
      rawFilter === 'canary' || rawFilter === 'issues' ? rawFilter : 'all';
    if (state.turnFilter !== nextFilter) {
      state.turnFilter = nextFilter;
      state.collapsedFilterTurns.clear();
      state.turnVisibleLimit = 30;
      render();
    }
    return;
  }

  const toggleDetailSummaryBtn = e.target.closest('[data-toggle-detail-summary]');
  if (toggleDetailSummaryBtn) {
    e.stopPropagation();
    const pid = toggleDetailSummaryBtn.getAttribute('data-toggle-detail-summary');
    if (pid) {
      if (state.expandedDetailSummary.has(pid)) {
        state.expandedDetailSummary.delete(pid);
      } else {
        state.expandedDetailSummary.add(pid);
      }
      render();
    }
    return;
  }

  const turnSortBtn = e.target.closest('[data-turn-sort]');
  if (turnSortBtn) {
    e.stopPropagation();
    const nextSort = turnSortBtn.getAttribute('data-turn-sort') === 'asc' ? 'asc' : 'desc';
    if (state.turnSort !== nextSort) {
      state.turnSort = nextSort;
      render();
    }
    return;
  }

  const toggleDetailIssuesBtn = e.target.closest('[data-toggle-detail-issues]');
  if (toggleDetailIssuesBtn) {
    e.stopPropagation();
    const pid = toggleDetailIssuesBtn.getAttribute('data-toggle-detail-issues');
    const liveNode =
      findThreadById(state.snapshot?.threads, pid) || state.detailCache.get(pid)?.thread;
    const itemCount = Array.isArray(liveNode?.issues?.items) ? liveNode.issues.items.length : 0;
    if (isDetailIssuesExpanded(pid, itemCount)) {
      state.expandedDetailIssues.delete(pid);
      state.collapsedDetailIssues.add(pid);
    } else {
      state.collapsedDetailIssues.delete(pid);
      state.expandedDetailIssues.add(pid);
    }
    render();
    return;
  }

  const focusStepBtn = e.target.closest('[data-focus-turn-step]');
  if (focusStepBtn && state.selectedThreadId) {
    e.stopPropagation();
    const sIdx = Number(focusStepBtn.getAttribute('data-focus-turn-step'));
    if (Number.isFinite(sIdx)) {
      state.pendingFocusStep = sIdx;
      applyPendingFocusStep(state.selectedThreadId);
      render();
    }
    return;
  }

  const toggleDetailKidsBtn = e.target.closest('[data-toggle-detail-children]');
  if (toggleDetailKidsBtn) {
    e.stopPropagation();
    const pid = toggleDetailKidsBtn.getAttribute('data-toggle-detail-children');
    const liveNode =
      findThreadById(state.snapshot?.threads, pid) || state.detailCache.get(pid)?.thread;
    const kidsLen = Array.isArray(liveNode?.children) ? liveNode.children.length : 0;
    const currentlyExp = isDetailChildrenExpanded(pid, kidsLen);
    if (currentlyExp) {
      state.expandedDetailChildren.delete(pid);
      state.collapsedDetailChildren.add(pid);
    } else {
      state.collapsedDetailChildren.delete(pid);
      state.expandedDetailChildren.add(pid);
    }
    render();
    return;
  }

  const toggleTurnTarget = e.target.closest('[data-toggle-turn]');
  if (toggleTurnTarget && state.selectedThreadId) {
    if (
      e.target.closest('.turn-drawer') &&
      window.getSelection &&
      String(window.getSelection()).length > 0
    ) {
      return;
    }
    e.stopPropagation();
    const tNum = toggleTurnTarget.getAttribute('data-toggle-turn');
    const expKey = `${state.selectedThreadId}:${tNum}`;
    if (state.turnFilter === 'issues') {
      if (state.expandedTurns.has(expKey)) {
        state.expandedTurns.delete(expKey);
        state.collapsedFilterTurns.add(expKey);
      } else if (state.collapsedFilterTurns.has(expKey)) {
        state.collapsedFilterTurns.delete(expKey);
      } else {
        state.collapsedFilterTurns.add(expKey);
      }
    } else if (state.expandedTurns.has(expKey)) {
      state.expandedTurns.delete(expKey);
    } else {
      state.expandedTurns.add(expKey);
    }
    render();
    return;
  }

  const toggleChildrenBtn = e.target.closest('[data-toggle-children]');
  if (toggleChildrenBtn) {
    e.stopPropagation();
    const pid = toggleChildrenBtn.getAttribute('data-toggle-children');
    if (state.expandedParents.has(pid)) {
      state.expandedParents.delete(pid);
    } else {
      state.expandedParents.add(pid);
    }
    render();
    return;
  }

  const toggleBatchBtn = e.target.closest('[data-toggle-batch]');
  if (toggleBatchBtn) {
    e.stopPropagation();
    const bkey = toggleBatchBtn.getAttribute('data-toggle-batch');
    if (state.expandedBatches.has(bkey)) {
      state.expandedBatches.delete(bkey);
    } else {
      state.expandedBatches.add(bkey);
    }
    render();
    return;
  }

  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    const act = actionBtn.getAttribute('data-action');
    if (act === 'back') {
      e.stopPropagation();
      closeThread();
      return;
    }
    if (act === 'open-chat') {
      e.stopPropagation();
      const convId = actionBtn.getAttribute('data-conv-id');
      if (convId && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(convId);
      }
      return;
    }
    if (act === 'load-more') {
      e.stopPropagation();
      state.visibleLimit += 40;
      render();
      return;
    }
    if (act === 'load-more-turns') {
      e.stopPropagation();
      state.turnVisibleLimit += 40;
      render();
      return;
    }
    if (act === 'load-more-issues') {
      e.stopPropagation();
      state.issuesVisibleLimit += 40;
      render();
      return;
    }
    if (act === 'load-more-canary') {
      e.stopPropagation();
      state.canaryVisibleLimit += 40;
      render();
      return;
    }
  }

  const openCanaryTarget = e.target.closest('[data-open-canary-thread]');
  if (openCanaryTarget) {
    e.stopPropagation();
    openThread(openCanaryTarget.getAttribute('data-open-canary-thread'), {
      turnFilter: 'canary',
    });
    return;
  }

  const openIncTarget = e.target.closest('[data-open-incident-thread]');
  if (openIncTarget) {
    e.stopPropagation();
    const tid = openIncTarget.getAttribute('data-open-incident-thread');
    const stepAttr = openIncTarget.getAttribute('data-focus-step');
    openThread(tid, {
      turnFilter: 'issues',
      focusStepIndex: stepAttr != null && stepAttr !== '' ? Number(stepAttr) : null,
    });
    return;
  }

  const openTarget = e.target.closest('[data-open-thread]');
  if (openTarget) {
    e.stopPropagation();
    openThread(openTarget.getAttribute('data-open-thread'));
  }
});

window.addEventListener('popstate', () => {
  const params = new URLSearchParams(window.location.search);
  const tabParam = params.get('tab') || 'overview';
  state.mainTab = ['overview', 'conversation', 'project', 'cli', 'cloud', 'canary'].includes(
    tabParam
  )
    ? tabParam
    : 'overview';
  state.selectedProjectKey = String(params.get('project') || '').trim();
  const tid = resolveRouteThreadId(params, state.hostConvId);
  state.selectedThreadId = tid;
  state.followHostSession = Boolean(
    params.get('view') !== 'list' &&
      !params.get('tab') &&
      (!params.get('thread') || tid === state.hostConvId)
  );
  render();
  if (tid) fetchThreadDetail(tid, false);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.settingsOpen) {
    state.settingsOpen = false;
    state.customPlanDraft = false;
    render();
  }
});

initThemeSync(() => render());
initTooltips(appEl);
initHostBridge();
render();
loadSettings().then(() => {
  render();
  setTimeout(() => {
    checkPluginUpdate(false);
  }, 1800);
});
setInterval(() => {
  if (document.visibilityState === 'visible') {
    checkPluginUpdate(false);
  }
}, 1 * 3600 * 1000);
if (document.readyState === 'complete') {
  setTimeout(() => {
    startRealtimeSync();
  }, 0);
} else {
  window.addEventListener(
    'load',
    () => {
      setTimeout(() => {
        startRealtimeSync();
      }, 0);
    },
    { once: true }
  );
}
