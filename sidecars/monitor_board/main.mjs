/**
 * monowatch (`monitor_board`) sidecar backend.
 *
 * Hosts the Auxiliary Pane Web UI, JSON telemetry endpoints, and real-time
 * Server-Sent Events (`GET /api/stream`) backed by `telemetry.mjs`.
 * Strictly read-only towards Antigravity data: never mutates user conversations, SQLite DBs,
 * or host config. The only files it writes are `settings.json`, `update_cache.json`, and
 * `usage_ledger.sqlite` inside the sidecar's private data directory.
 */

import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { createTelemetryEngine } from './telemetry.mjs';
import { createUpdater } from './updater.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function safeFileMtimeMs(p) {
  try {
    return statSync(p).mtimeMs || 0;
  } catch {
    return 0;
  }
}

const bootBundleMtimeMs = Math.max(
  safeFileMtimeMs(__filename),
  safeFileMtimeMs(join(__dirname, 'updater.mjs')),
  safeFileMtimeMs(join(__dirname, 'telemetry', 'engine.mjs')),
  safeFileMtimeMs(join(__dirname, 'telemetry', 'ledger.mjs')),
  safeFileMtimeMs(join(__dirname, 'telemetry', 'metrics.mjs')),
  safeFileMtimeMs(join(__dirname, 'telemetry', 'models.mjs')),
  safeFileMtimeMs(join(__dirname, 'telemetry', 'proto.mjs')),
  safeFileMtimeMs(join(__dirname, 'telemetry', 'routing.mjs'))
);
const LOGO_CANDIDATES = [
  join(__dirname, '..', '..', 'assets', 'logo.svg'),
  join(__dirname, 'logo.svg'),
];
const CONV_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

if (process.env.MONOWATCH_STANDALONE === '1' || process.env.THREAD_MONITOR_STANDALONE === '1') {
  process.env.ANTIGRAVITY_LS_ADDRESS ||= '127.0.0.1:0';
  process.env.ANTIGRAVITY_CSRF_TOKEN ||= 'standalone-dev';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ||= '49880';
}

function fallbackAppDataDirs() {
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(appData)) return [appData];
      }
    }
  }
  if (process.env.ANTIGRAVITY_APP_DATA_DIR && existsSync(process.env.ANTIGRAVITY_APP_DATA_DIR)) {
    return [process.env.ANTIGRAVITY_APP_DATA_DIR];
  }
  const geminiRoot = join(homedir(), '.gemini');
  try {
    return readdirSync(geminiRoot)
      .sort()
      .map((name) => join(geminiRoot, name))
      .filter((dir) => existsSync(join(dir, 'conversation_summaries.db')) || existsSync(join(dir, 'brain')));
  } catch {
    return [];
  }
}

const engine = createTelemetryEngine({
  sidecarDataDir: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || undefined,
});

function getAppDataDirs() {
  try {
    const dirs = typeof engine.appDataDirs === 'function' ? engine.appDataDirs() : engine.appDataDirs;
    if (Array.isArray(dirs) && dirs.length > 0) return dirs;
  } catch {
    // Fall back to local discovery.
  }
  return fallbackAppDataDirs();
}

// ---------------------------------------------------------------------------
// Snapshot state, revision stabilization & active generation detection
// ---------------------------------------------------------------------------

const MAX_SSE_CLIENTS = 4;
const MAX_SSE_BUFFER_BYTES = 256 * 1024;
const sseClients = new Set();
let cachedSnapshot = null;
let lastRefreshAt = 0;
let lastClientActivityAt = 0;
let lastGeneratingTickAt = 0;
let lastPinnedConvId = process.env.ANTIGRAVITY_CONVERSATION_ID || '';
let dirty = true;

function evictUnhealthySseClient(res) {
  if (!res || res.destroyed || res.writableEnded || res.writableLength > MAX_SSE_BUFFER_BYTES) {
    sseClients.delete(res);
    try {
      res?.destroy?.();
    } catch {
      // Ignore socket destroy error.
    }
    return true;
  }
  return false;
}

function pruneSseClients() {
  for (const res of [...sseClients]) {
    evictUnhealthySseClient(res);
  }
}

function noteClientActivity(convId) {
  lastClientActivityAt = Date.now();
  if (typeof convId === 'string') {
    const trimmed = convId.trim();
    if (CONV_ID_RE.test(trimmed) && trimmed !== lastPinnedConvId) {
      lastPinnedConvId = trimmed;
      dirty = true;
    }
  }
}

function hasActiveFrontend(nowMs = Date.now()) {
  pruneSseClients();
  return sseClients.size > 0 || nowMs - lastClientActivityAt < 10_000;
}

function hasFreshGeneratingThread(threads, nowMs = Date.now()) {
  if (!Array.isArray(threads)) return false;
  for (const t of threads) {
    if (!t || typeof t !== 'object') continue;
    const freshUpdate = !t.updatedAtMs || nowMs - Number(t.updatedAtMs) < 180_000;
    const freshElapsed =
      typeof t.generatingElapsedSec !== 'number' || t.generatingElapsedSec < 180;
    if ((t.isGenerating || t.timing?.isLiveTicking) && (t.status === 'working' || t.timing?.isLiveTicking) && freshUpdate && freshElapsed) {
      return true;
    }
    if (Array.isArray(t.children) && t.children.length > 0 && hasFreshGeneratingThread(t.children, nowMs)) {
      return true;
    }
  }
  return false;
}

function refreshSnapshot({ forceTickGenerating = false } = {}) {
  const nowMs = Date.now();
  if (forceTickGenerating) {
    if (!hasActiveFrontend(nowMs)) {
      return { snapshot: cachedSnapshot, changed: false };
    }
    if (!cachedSnapshot || !hasFreshGeneratingThread(cachedSnapshot.threads, nowMs)) {
      return { snapshot: cachedSnapshot, changed: false };
    }
    // Avoid churning rev every 1s when no disk writes occurred; fs.watch already pushes real writes within 120ms
    if (!dirty && nowMs - lastGeneratingTickAt < 3000) {
      return { snapshot: cachedSnapshot, changed: false };
    }
    lastGeneratingTickAt = nowMs;
  }

  const prevRev = cachedSnapshot?.rev ?? -1;
  const next = engine.getSnapshot({
    conversationId: lastPinnedConvId || process.env.ANTIGRAVITY_CONVERSATION_ID || undefined,
  });
  lastRefreshAt = Date.now();
  dirty = false;

  if (cachedSnapshot && next.rev === prevRev) {
    return { snapshot: cachedSnapshot, changed: false };
  }

  cachedSnapshot = next;
  return { snapshot: cachedSnapshot, changed: true };
}

function ensureSnapshot(convId) {
  noteClientActivity(convId);
  const minFreshMs = dirty ? 0 : (cachedSnapshot && hasFreshGeneratingThread(cachedSnapshot.threads) ? 1000 : 2500);
  if (!cachedSnapshot || dirty || Date.now() - lastRefreshAt > minFreshMs) {
    refreshSnapshot();
  }
  return cachedSnapshot;
}

// ---------------------------------------------------------------------------
// SidecarApp HTTP routes
// ---------------------------------------------------------------------------

function readLogoSvg() {
  for (const candidate of LOGO_CANDIDATES) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf-8');
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"></svg>';
}

const app = new SidecarApp();

app.page('/', () => new Response(
  readFileSync(join(__dirname, 'index.html'), 'utf-8'),
  {
    contentType: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': 'no-cache' },
  },
));

app.api('/styles.css', () => new Response(
  readFileSync(join(__dirname, 'styles.css'), 'utf-8'),
  {
    contentType: 'text/css; charset=utf-8',
    headers: { 'Cache-Control': 'no-cache' },
  },
), 'GET');

app.api('/app.js', () => new Response(
  readFileSync(join(__dirname, 'app.js'), 'utf-8'),
  {
    contentType: 'application/javascript; charset=utf-8',
    headers: { 'Cache-Control': 'no-cache' },
  },
), 'GET');

app.api('/logo.svg', () => new Response(
  readLogoSvg(),
  {
    contentType: 'image/svg+xml; charset=utf-8',
    headers: { 'Cache-Control': 'private, max-age=300' },
  },
), 'GET');

function jsonNoStore(payload) {
  return new Response(JSON.stringify(payload), {
    contentType: 'application/json; charset=utf-8',
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

app.api('/api/snapshot', (data = {}) => {
  const snap = ensureSnapshot(data.conversationId);
  if (data.etag !== undefined && data.etag !== '' && Number(data.etag) === snap.rev) {
    return jsonNoStore({ unchanged: true, rev: snap.rev });
  }
  return jsonNoStore(snap);
}, 'GET');

// ---------------------------------------------------------------------------
// User settings (subscription plan, billing day)
// ---------------------------------------------------------------------------

const PLAN_PRESETS = {
  free: 0,
  pro: 19.99,
  ultra5: 99.99,
  ultra20: 199.99,
};
const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  plan: null, // { id: 'free' | 'pro' | 'ultra5' | 'ultra20' | 'custom', monthlyUsd: number }
  billingDay: null, // 1..31, null => rolling 30-day window
  billingDaySkipped: false,
  lang: 'auto', // 'auto' | 'zh' | 'en'
  updateCheck: true, // check GitHub for newer plugin releases
  planHistory: [], // [{ effectiveFrom: ISO, id, monthlyUsd }]
});

function resolveSettingsPath() {
  const execDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDir) return join(execDir, 'settings.json');
  const appData = getAppDataDirs()[0];
  if (appData) {
    return join(appData, 'sidecar_data', 'monowatch', 'monitor_board', 'data', 'settings.json');
  }
  return join(__dirname, 'settings.local.json');
}

function readSettings() {
  try {
    const p = resolveSettingsPath();
    if (!existsSync(p)) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function sanitizePlan(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const id = String(raw.id || '');
  if (id in PLAN_PRESETS) return { id, monthlyUsd: PLAN_PRESETS[id] };
  if (id === 'custom') {
    const usd = Number(raw.monthlyUsd);
    if (Number.isFinite(usd) && usd >= 0 && usd < 100_000) {
      return { id, monthlyUsd: Math.round(usd * 100) / 100 };
    }
  }
  return undefined;
}

function writeSettings(patch = {}) {
  const prev = readSettings();
  const next = { ...prev };

  if ('plan' in patch) {
    const plan = sanitizePlan(patch.plan);
    if (plan !== undefined) {
      const changed =
        (prev.plan?.id || null) !== (plan?.id || null) ||
        (prev.plan?.monthlyUsd ?? null) !== (plan?.monthlyUsd ?? null);
      next.plan = plan;
      if (changed && plan) {
        const hist = Array.isArray(prev.planHistory) ? prev.planHistory.slice(-23) : [];
        hist.push({ effectiveFrom: new Date().toISOString(), ...plan });
        next.planHistory = hist;
      }
    }
  }
  if ('billingDay' in patch) {
    const d = patch.billingDay === null ? null : Math.trunc(Number(patch.billingDay));
    if (d === null || (d >= 1 && d <= 31)) next.billingDay = d;
  }
  if ('billingDaySkipped' in patch) {
    next.billingDaySkipped = Boolean(patch.billingDaySkipped);
  }
  if ('lang' in patch && ['auto', 'zh', 'en'].includes(patch.lang)) {
    next.lang = patch.lang;
  }
  if ('updateCheck' in patch) {
    next.updateCheck = Boolean(patch.updateCheck);
  }

  const p = resolveSettingsPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  renameSync(tmp, p);
  return next;
}

app.api('/api/settings', () => jsonNoStore(readSettings()), 'GET');

app.api('/api/settings', (data = {}) => {
  try {
    return jsonNoStore(writeSettings(data));
  } catch (err) {
    return jsonNoStore({ error: String(err?.message || err) });
  }
}, 'POST');

const updater = createUpdater({
  pluginRoot: join(__dirname, '..', '..'),
  getCachePath: () => join(dirname(resolveSettingsPath()), 'update_cache.json'),
  isEnabled: () => readSettings().updateCheck !== false,
  onScheduleRestart: () => {
    if (!process.env.MONOWATCH_STANDALONE && !process.env.THREAD_MONITOR_STANDALONE) {
      setTimeout(() => shutdown(), 600);
    }
  },
});

app.api('/api/update-status', async (data = {}) => {
  const force = data.force === '1' || data.force === true;
  return jsonNoStore(await updater.getStatus({ force }));
}, 'GET');

app.api('/api/update', async () => {
  return jsonNoStore(await updater.applyUpdate());
}, 'POST');

app.api('/api/archive', (data = {}) => {
  noteClientActivity(data.conversationId);
  let ws = [];
  try {
    ws = data.ws ? JSON.parse(String(data.ws)) : [];
  } catch {
    ws = [];
  }
  return jsonNoStore(
    engine.listArchive({
      scope: String(data.scope || 'all'),
      projectKey: String(data.projectKey || ''),
      workspaceUris: ws,
      startKey: String(data.startKey || ''),
      endKey: String(data.endKey || ''),
      offset: Number(data.offset) || 0,
      limit: Number(data.limit) || 40,
    })
  );
}, 'GET');

app.api('/api/thread', (data = {}) => {
  noteClientActivity(data.conversationId);
  const id = typeof data.id === 'string' ? data.id.trim() : '';
  if (!id) {
    return jsonNoStore({ error: 'not_found' });
  }
  if (data.fresh === '1' && typeof engine.invalidate === 'function') {
    try {
      engine.invalidate(id);
    } catch {
      // Ignore invalidation error.
    }
  }
  const reqConvId = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
  const isHostSession = Boolean(
    (reqConvId && id === reqConvId) || (lastPinnedConvId && id === lastPinnedConvId),
  );
  const detail = engine.getThreadDetail(id, {
    isHostSession,
    fastCold: data.fast === '1',
  });
  if (!detail) {
    return jsonNoStore({ error: 'not_found' });
  }
  return jsonNoStore(detail);
}, 'GET');

// ---------------------------------------------------------------------------
// SSE streaming (`GET /api/stream`), `fs.watch` coalescing & timers
// ---------------------------------------------------------------------------

const watchers = [];
const watchedKeys = new Set();
let debounceTimer = null;

function broadcastSnapshot(snap) {
  pruneSseClients();
  if (sseClients.size === 0 || !snap) return;
  const payload = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
  for (const res of [...sseClients]) {
    if (evictUnhealthySseClient(res)) continue;
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
      try {
        res.destroy?.();
      } catch {
        // Ignore socket destroy error.
      }
    }
  }
}

function broadcastKeepalive() {
  pruneSseClients();
  if (sseClients.size === 0) return;
  for (const res of [...sseClients]) {
    if (evictUnhealthySseClient(res)) continue;
    try {
      res.write(': keepalive\n\n');
    } catch {
      sseClients.delete(res);
      try {
        res.destroy?.();
      } catch {
        // Ignore socket destroy error.
      }
    }
  }
}

function refreshAndBroadcast(opts = {}) {
  try {
    const { snapshot, changed } = refreshSnapshot(opts);
    if (changed) {
      broadcastSnapshot(snapshot);
    }
  } catch (err) {
    console.error('[monitor_board] snapshot refresh error:', err?.message || err);
  }
}

// Background archive finished: next snapshot read must rebuild to include it.
engine.onArchiveReady?.(() => {
  dirty = true;
  if (sseClients.size > 0) refreshAndBroadcast();
});

function markDirtyAndSchedule(changedConvId = null) {
  dirty = true;
  if (changedConvId && typeof engine.invalidate === 'function') {
    try {
      engine.invalidate(changedConvId);
    } catch {
      // Ignore invalidation failure.
    }
  }
  pruneSseClients();
  if (sseClients.size === 0 || debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (sseClients.size > 0) {
      refreshAndBroadcast();
    }
  }, 120);
}

function addSafeWatch(targetPath, options, onEvent) {
  const key = `${targetPath}|${Boolean(options?.recursive)}`;
  if (watchedKeys.has(key) || !existsSync(targetPath)) return;
  try {
    const w = watch(targetPath, { persistent: false, ...options }, onEvent);
    w.on('error', () => {
      watchedKeys.delete(key);
    });
    watchedKeys.add(key);
    watchers.push(w);
  } catch {
    if (options?.recursive) {
      addSafeWatch(targetPath, { ...options, recursive: false }, onEvent);
    }
  }
}

function ensureWatchers() {
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    addSafeWatch(execDataDir, { recursive: false }, (_event, filename) => {
      if (!filename || String(filename).includes('pricing_override')) {
        markDirtyAndSchedule(null);
      }
    });
  }

  addSafeWatch(join(homedir(), '.gemini', 'config', 'projects'), { recursive: false }, () => {
    markDirtyAndSchedule(null);
  });

  addSafeWatch(join(homedir(), '.gemini', 'config', 'sidecars'), { recursive: false }, () => {
    markDirtyAndSchedule(null);
  });

  for (const appData of getAppDataDirs()) {
    // 1. Watch <appData> root for summaries DB, project state & CLI history updates
    addSafeWatch(appData, { recursive: false }, (_event, filename) => {
      const name = String(filename || '');
      if (
        !name ||
        name.startsWith('conversation_summaries.db') ||
        name.startsWith('agyhub_summaries') ||
        name.startsWith('antigravity_state') ||
        name.startsWith('jetski_state') ||
        name === 'history.jsonl'
      ) {
        markDirtyAndSchedule(null);
      }
    });

    // 2. Watch <appData>/annotations/ and <appData>/presence/ if present
    for (const subDir of ['annotations', 'presence']) {
      addSafeWatch(join(appData, subDir), { recursive: false }, (_event, filename) => {
        const m = CONV_ID_RE.exec(String(filename || ''));
        markDirtyAndSchedule(m ? m[1] : null);
      });
    }

    // 3. Watch <appData>/conversations/ for per-thread SQLite trajectory writes
    const convDir = join(appData, 'conversations');
    addSafeWatch(convDir, { recursive: false }, (_event, filename) => {
      const name = String(filename || '');
      const m = CONV_ID_RE.exec(name);
      markDirtyAndSchedule(m ? m[1] : null);
    });

    // 4. Watch <appData>/brain/ for transcript.jsonl, checkpoints & swarm board updates
    const brainDir = join(appData, 'brain');
    addSafeWatch(brainDir, { recursive: true }, (_event, filename) => {
      const rel = String(filename || '');
      if (!rel) {
        markDirtyAndSchedule(null);
        return;
      }
      const lower = rel.toLowerCase();
      const isRelevant =
        lower.includes('transcript') ||
        lower.includes('members.json') ||
        lower.includes('board.jsonl') ||
        lower.includes('swarm') ||
        !rel.includes('.');
      if (!isRelevant) return;
      const firstSeg = rel.split(/[\\/]/)[0] || '';
      const m = CONV_ID_RE.exec(firstSeg);
      markDirtyAndSchedule(m ? m[1] : null);
    });
  }
}

// Every `/api/*` route (GET included, SSE included) requires the host-issued UI token.
// The SDK itself only checks non-GET requests, which would let any local web page
// read telemetry snapshots. Standalone dev mode (no token in env) stays open.
const UI_TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';

function hasValidToken(req, url) {
  if (!UI_TOKEN) return true;
  const provided = String(req.headers?.['x-sidecar-token'] || url.searchParams.get('token') || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(UI_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Only loopback or non-web (host webview) origins may read responses cross-origin.
function isTrustedOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

function applyCorsHeaders(req, res) {
  const origin = req.headers?.origin;
  if (!origin || !isTrustedOrigin(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Sidecar-Token, Accept, Cache-Control, Last-Event-ID',
  );
}

function injectModuleImportTokens(jsSource, token) {
  if (!token) return jsSource;
  const q = `?token=${encodeURIComponent(token)}`;
  return jsSource.replace(
    /(\bfrom\s+["'])(\.[^"'?]+)(["'])/g,
    `$1$2${q}$3`
  );
}

function serveJsModule(filePath, url, res) {
  if (!existsSync(filePath)) return false;
  const raw = readFileSync(filePath, 'utf-8');
  const token = url.searchParams.get('token') || '';
  const body = token ? injectModuleImportTokens(raw, token) : raw;
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
  return true;
}

function serveStylesCss(url, res) {
  const cssPath = join(__dirname, 'styles.css');
  if (!existsSync(cssPath)) return false;
  const raw = readFileSync(cssPath, 'utf-8');
  const token = url.searchParams.get('token') || '';
  const body = token
    ? raw.replace(/(\/fonts\/[a-z0-9._-]+\.woff2)/gi, `$1?token=${encodeURIComponent(token)}`)
    : raw;
  res.writeHead(200, {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
  return true;
}

function serveFontAsset(fontName, res) {
  const filePath = join(__dirname, 'fonts', fontName);
  if (!existsSync(filePath)) return false;
  const buf = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'font/woff2',
    'Content-Length': String(buf.length),
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  res.end(buf);
  return true;
}

function injectSubresourceTokens(html, token) {
  if (!token) return html;
  const q = `?token=${encodeURIComponent(token)}`;
  return html
    .replace(/(["'])\/preload\.js\1/g, `$1/preload.js${q}$1`)
    .replace(/(["'])\/styles\.css\1/g, `$1/styles.css${q}$1`)
    .replace(/(["'])\/app\.js\1/g, `$1/app.js${q}$1`)
    .replace(/(["'])\/logo\.svg\1/g, `$1/logo.svg${q}$1`)
    .replace(/(\/fonts\/[a-z0-9._-]+\.woff2)/gi, `$1${q}`);
}

function serveIndexHtml(url, res) {
  noteClientActivity(url.searchParams.get('conversationId'));
  const rawHtml = readFileSync(join(__dirname, 'index.html'), 'utf-8');
  const token = url.searchParams.get('token') || process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
  const body = token ? injectSubresourceTokens(rawHtml, token) : rawHtml;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function handleSseStream(req, res, url) {
  noteClientActivity(url?.searchParams?.get('conversationId'));
  pruneSseClients();
  while (sseClients.size >= MAX_SSE_CLIENTS) {
    const oldest = sseClients.values().next().value;
    if (!oldest) break;
    sseClients.delete(oldest);
    try {
      oldest.destroy?.();
    } catch {
      // Ignore oldest client destroy error.
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  req.socket?.setNoDelay?.(true);

  try {
    // 2KB comment padding ensures reverse proxies / custom protocol streams flush immediately
    res.write(`: ${' '.repeat(2048)}\n\n`);
  } catch {
    try {
      res.destroy?.();
    } catch {
      // Ignore write/destroy failure.
    }
    return;
  }

  sseClients.add(res);
  const cleanup = () => {
    sseClients.delete(res);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  setImmediate(() => {
    if (evictUnhealthySseClient(res)) return;
    try {
      const snap = ensureSnapshot();
      if (snap && !evictUnhealthySseClient(res)) {
        res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      }
    } catch (err) {
      console.error('[monitor_board] initial SSE snapshot failed:', err?.message || err);
    }
  });
}

const server = await app.run();

// Override SDK's default synchronous `execFileSync('agentapi')` handler so
// `/preload.js`'s startup metadata probe never blocks the Node event loop.
app.api('/_sidecar/get-conversation-metadata', (data = {}) => {
  const convId = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
  noteClientActivity(convId);
  return {
    response: {
      conversationMetadata: {
        metadata: engine.getConversationMetadataLite(convId),
      },
    },
  };
}, 'POST');

console.log(`[monitor_board] app data dirs: ${getAppDataDirs().join(', ') || '(none yet)'}`);

const sdkListeners = server.listeners('request');
server.removeAllListeners('request');
server.on('request', (req, res) => {
  applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (url.pathname.startsWith('/api/') && !hasValidToken(req, url)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      serveIndexHtml(url, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/styles.css') {
      if (serveStylesCss(url, res)) return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
      const fontName = url.pathname.slice(7);
      if (/^[a-z0-9._-]+\.woff2$/i.test(fontName)) {
        if (serveFontAsset(fontName, res)) return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      if (serveJsModule(join(__dirname, 'app.js'), url, res)) return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/ui/')) {
      const modName = url.pathname.slice(4);
      if (/^[a-z0-9_-]+\.js$/i.test(modName)) {
        if (serveJsModule(join(__dirname, 'ui', modName), url, res)) return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      handleSseStream(req, res, url);
      return;
    }
  } catch {
    // Delegate malformed URLs to SDK handler.
  }
  for (const listener of sdkListeners) {
    listener.call(server, req, res);
  }
});

ensureWatchers();

// Gentle one-shot background warmup after startup if no frontend has opened yet
const warmupTimer = setTimeout(() => {
  if (!cachedSnapshot && Date.now() - lastClientActivityAt > 1500) {
    try {
      refreshSnapshot();
    } catch {
      // Ignore background warmup failure.
    }
  }
}, 2500);
warmupTimer.unref?.();

// Safety sweep every 5000ms (attaches late watchers; refreshes only for active SSE streams)
const sweepTimer = setInterval(() => {
  if (
    !process.env.MONOWATCH_STANDALONE &&
    !process.env.THREAD_MONITOR_STANDALONE &&
    bootBundleMtimeMs > 0
  ) {
    const curMtimeMs = Math.max(
      safeFileMtimeMs(__filename),
      safeFileMtimeMs(join(__dirname, 'updater.mjs')),
      safeFileMtimeMs(join(__dirname, 'telemetry', 'engine.mjs')),
      safeFileMtimeMs(join(__dirname, 'telemetry', 'metrics.mjs')),
      safeFileMtimeMs(join(__dirname, 'telemetry', 'models.mjs')),
      safeFileMtimeMs(join(__dirname, 'telemetry', 'proto.mjs')),
      safeFileMtimeMs(join(__dirname, 'telemetry', 'routing.mjs'))
    );
    if (curMtimeMs > bootBundleMtimeMs + 50) {
      shutdown();
      return;
    }
  }
  ensureWatchers();
  pruneSseClients();
  if (sseClients.size > 0 && dirty) {
    refreshAndBroadcast();
  }
}, 5000);
sweepTimer.unref?.();

// Live tick strictly while an SSE client is connected AND a fresh thread is generating
const generatingTimer = setInterval(() => {
  pruneSseClients();
  if (sseClients.size === 0 || !cachedSnapshot) return;
  refreshAndBroadcast({ forceTickGenerating: true });
}, 1000);
generatingTimer.unref?.();

// Keepalive comment every 15s for SSE proxies / WebViews
const keepaliveTimer = setInterval(() => {
  broadcastKeepalive();
}, 15000);
keepaliveTimer.unref?.();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(warmupTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  clearInterval(sweepTimer);
  clearInterval(generatingTimer);
  clearInterval(keepaliveTimer);
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  for (const res of sseClients) {
    try { res.end(); } catch {}
  }
  sseClients.clear();
  try { engine.close?.(); } catch {}
  app.close().finally(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
