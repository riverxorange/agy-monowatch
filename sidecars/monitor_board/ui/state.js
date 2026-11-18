/**
 * Shared client-side UI state, URL routing synchronization, and sidecar fetch helpers.
 */

export const appEl = document.getElementById('app');
export const tooltipEl = document.getElementById('swiss-tooltip');

export const initialSearchParams = new URLSearchParams(window.location.search);
export const sidecarToken = initialSearchParams.get('token') || '';

export function resolveRouteThreadId(searchParams, currentHostId) {
  const explicitThread = String(searchParams.get('thread') || '').trim();
  if (explicitThread) {
    return explicitThread;
  }
  if (searchParams.get('view') === 'list' || searchParams.get('tab')) {
    return null;
  }
  if (currentHostId) {
    return currentHostId;
  }
  return null;
}

const initialHostConvId = String(
  window.sidecar?.conversationId || initialSearchParams.get('conversationId') || ''
).trim();

const initialSelectedThreadId = resolveRouteThreadId(
  initialSearchParams,
  initialHostConvId
);

const initialExpandTurn = initialSearchParams.get('expandTurn');
const initialExpandedTurns = new Set();
if (initialSelectedThreadId && initialExpandTurn) {
  for (const part of initialExpandTurn.split(',')) {
    const trimmed = part.trim();
    if (trimmed) initialExpandedTurns.add(`${initialSelectedThreadId}:${trimmed}`);
  }
}

export const state = {
  rev: -1,
  snapshot: null,
  bootError: '',
  hostConvId: initialHostConvId,
  selectedThreadId: initialSelectedThreadId,
  followHostSession:
    initialSearchParams.get('view') !== 'list' &&
    !initialSearchParams.get('tab') &&
    (!initialSearchParams.get('thread') || initialSelectedThreadId === initialHostConvId),
  detailCache: new Map(),
  snapshotClientMs: Date.now(),
  detailClientMs: new Map(),
  loadingDetailId: null,
  expandedParents: new Set(),
  expandedDetailChildren: new Set(),
  collapsedDetailChildren: new Set(),
  expandedDetailIssues: new Set(),
  collapsedDetailIssues: new Set(),
  expandedDetailSummary: new Set(),
  collapsedFilterTurns: new Set(),
  expandedBatches: new Set(),
  expandedTurns: initialExpandedTurns,
  turnFilter:
    initialSearchParams.get('turnFilter') === 'canary'
      ? 'canary'
      : initialSearchParams.get('turnFilter') === 'issues'
        ? 'issues'
        : 'all',
  turnSort: initialSearchParams.get('turnSort') === 'asc' ? 'asc' : 'desc',
  turnVisibleLimit: 30,
  issueCategoryFilter: 'all',
  issuesVisibleLimit: 40,
  canaryCategoryFilter: 'all',
  canaryVisibleLimit: 40,
  pendingFocusStep: null,
  mainTab: ['overview', 'conversation', 'project', 'cli', 'cloud', 'canary'].includes(
    initialSearchParams.get('tab') || ''
  )
    ? initialSearchParams.get('tab')
    : 'overview',
  selectedProjectKey: String(initialSearchParams.get('project') || '').trim(),
  selectedProjectName: '',
  scope: 'all', // 'workspace' | 'conversation' | 'project' | 'cli' | 'all'
  overviewMode: 'home', // 'home' | 'issues'
  timeWindow: ['today', '7d', 'period', 'all'].includes(
    initialSearchParams.get('win') || ''
  )
    ? initialSearchParams.get('win')
    : 'period', // 'today' | '7d' | 'period' | 'all'
  settings: {
    plan: null,
    billingDay: null,
    billingDaySkipped: false,
    lang: 'auto',
    updateCheck: true,
    diagnostics: false,
  },
  updateInfo: null,
  updateChecking: false,
  updateApplying: false,
  updateFeedback: '',
  urlLang: ['zh', 'en'].includes((initialSearchParams.get('lang') || '').toLowerCase())
    ? initialSearchParams.get('lang').toLowerCase()
    : '',
  settingsLoaded: false,
  settingsOpen: false,
  customPlanDraft: false,
  workspaceUris: [],
  visibleLimit: 40,
};

let activeTipHost = null;

export function getActiveTipHost() {
  return activeTipHost;
}

export function setActiveTipHost(el) {
  activeTipHost = el;
}

export function withSidecarToken(path) {
  if (!sidecarToken) return path;
  if (/[?&]token=/.test(path)) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(sidecarToken)}`;
}

export function sidecarFetch(path, options = {}) {
  const url = withSidecarToken(path);
  const hasTimeout =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function';
  const fetchOptions =
    !options.signal && hasTimeout
      ? { ...options, signal: AbortSignal.timeout(8000) }
      : options;
  if (window.sidecar && typeof window.sidecar.fetch === 'function') {
    return window.sidecar.fetch(url, fetchOptions);
  }
  const headers = new Headers(fetchOptions.headers || {});
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  if (sidecarToken && !headers.has('X-Sidecar-Token')) {
    headers.set('X-Sidecar-Token', sidecarToken);
  }
  return fetch(url, { ...fetchOptions, headers });
}

export function syncUrlViewState(threadId, replace = false) {
  try {
    const url = new URL(window.location.href);
    if (threadId) {
      url.searchParams.delete('view');
      if (
        state.hostConvId &&
        threadId === state.hostConvId &&
        url.searchParams.get('conversationId') === state.hostConvId
      ) {
        url.searchParams.delete('thread');
      } else {
        url.searchParams.set('thread', threadId);
      }
    } else {
      url.searchParams.delete('thread');
      if (state.hostConvId) {
        url.searchParams.set('view', 'list');
      } else {
        url.searchParams.delete('view');
      }
      if (state.mainTab && state.mainTab !== 'overview') {
        url.searchParams.set('tab', state.mainTab);
      } else {
        url.searchParams.delete('tab');
      }
      if (state.mainTab === 'project' && state.selectedProjectKey) {
        url.searchParams.set('project', state.selectedProjectKey);
      } else {
        url.searchParams.delete('project');
      }
    }
    const relUrl = `${url.pathname}${url.search}${url.hash}`;
    if (replace) {
      window.history.replaceState({}, '', relUrl);
    } else {
      window.history.pushState({}, '', relUrl);
    }
  } catch {
    // Ignore history API restrictions under custom host protocols.
  }
}
