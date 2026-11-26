/**
 * @fileoverview Shared constants, safe filesystem/SQLite helpers, and formatting
 * primitives for the monowatch telemetry engine.
 */

import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_SOFT_LIMIT = 512_000;
export const DEFAULT_MAX_WINDOW = 1_048_576;
export const DEFAULT_ROOT_LIMIT = 140;
export const DEFAULT_INTERACTIVE_ROOT_LIMIT = 140;
export const DEFAULT_CLI_ROOT_LIMIT = 80;
export const STALE_GENERATING_SEC = 180;
export const STALE_RUNNING_SEC = 90;
export const STALE_WAITING_SEC = 120;
export const IDLE_WAKEUP_GAP_SEC = 15;

export const VALID_CONV_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

const SQLITE_RETRY_BUF =
  typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

export function round(val, digits = 6) {
  if (!Number.isFinite(val)) return 0;
  const f = 10 ** digits;
  return Math.round(val * f) / f;
}

export function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

export function fileSig(filePath) {
  const st = safeStat(filePath);
  return st ? `${st.mtimeMs}:${st.size}` : '0';
}

export function openReadOnlyDb(dbPath) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return new DatabaseSync(dbPath, { readOnly: true, timeout: 2500 });
    } catch (err) {
      lastErr = err;
      if (attempt < 2 && SQLITE_RETRY_BUF) {
        try {
          Atomics.wait(SQLITE_RETRY_BUF, 0, 0, 8 * (attempt + 1));
        } catch {
          // ignore if Atomics.wait unavailable
        }
      }
    }
  }
  throw lastErr;
}

export function dbWalSig(dbPath) {
  const main = safeStat(dbPath);
  if (!main) return null;
  const wal = safeStat(`${dbPath}-wal`);
  return `${main.mtimeMs}:${main.size}:${wal ? `${wal.mtimeMs}:${wal.size}` : '0'}`;
}

export function normalizeWorkspaceUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return '';
  try {
    return decodeURIComponent(uri.trim()).replace(/\/+$/, '');
  } catch {
    return uri.trim().replace(/\/+$/, '');
  }
}

export function parseWorkspaceUris(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map(normalizeWorkspaceUri).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeWorkspaceUri).filter(Boolean);
      }
    } catch {
      return [normalizeWorkspaceUri(trimmed)].filter(Boolean);
    }
  }
  return [];
}

export function parseDateMs(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return raw;
  const normalized = String(raw).trim().replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

export function scrubInterpuncts(str) {
  if (!str) return '';
  return String(str).replace(/\u2022/g, '-').replace(/\u00b7/g, ' ');
}

// ---------------------------------------------------------------------------
// Daily buckets (local calendar day) for billing-period / time-window rollups.
// Bucket layout:
//   0 usd            1 inputTokens     2 cacheReadTokens   3 outputTokens
//   4 savedCacheUsd  5 images          6 decodeOutTokens   7 decodeSec
//   8 ttftSum        9 ttftCount       10 inputUsd         11 cacheUsd
//   12 outputUsd
// ---------------------------------------------------------------------------

export const DAILY_FIELDS = 13;
const DAILY_ROUNDED = [0, 4, 7, 8, 10, 11, 12];

export function localDayKey(sec) {
  if (!(sec > 0)) return '';
  const d = new Date(sec * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function dailyBucket(map, sec) {
  const key = localDayKey(sec);
  let b = map.get(key);
  if (!b) {
    b = new Array(DAILY_FIELDS).fill(0);
    map.set(key, b);
  }
  return b;
}

export function addDaily(
  map,
  sec,
  usd = 0,
  inp = 0,
  cr = 0,
  out = 0,
  saved = 0,
  images = 0,
  inUsd = 0,
  crUsd = 0,
  outUsd = 0
) {
  const b = dailyBucket(map, sec);
  b[0] += usd;
  b[1] += inp;
  b[2] += cr;
  b[3] += out;
  b[4] += saved;
  b[5] += images;
  b[10] += inUsd;
  b[11] += crUsd;
  b[12] += outUsd;
}

export function addDailyPerf(map, sec, decodeOut = 0, decodeSec = 0, ttftSec = 0) {
  const b = dailyBucket(map, sec);
  if (decodeOut > 0 && decodeSec > 0) {
    b[6] += decodeOut;
    b[7] += decodeSec;
  }
  if (ttftSec > 0) {
    b[8] += ttftSec;
    b[9] += 1;
  }
}

/**
 * Converts a Map bucket into a plain object. Steps without a timestamp (key '')
 * are attributed to `fallbackSec` so period totals reconcile with lifetime totals.
 */
export function finalizeDaily(map, fallbackSec = 0) {
  const outObj = {};
  for (const [rawKey, b] of map) {
    const key = rawKey || localDayKey(fallbackSec || Date.now() / 1000);
    const cur = outObj[key] || new Array(DAILY_FIELDS).fill(0);
    for (let i = 0; i < DAILY_FIELDS; i++) cur[i] += b[i];
    outObj[key] = cur;
  }
  for (const key of Object.keys(outObj)) {
    for (const i of DAILY_ROUNDED) outObj[key][i] = round(outObj[key][i], 6);
  }
  return outObj;
}

export function mergeDailyInto(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) {
    const src = source[key];
    if (!Array.isArray(src)) continue;
    const cur = target[key] || new Array(DAILY_FIELDS).fill(0);
    for (let i = 0; i < DAILY_FIELDS; i++) cur[i] += Number(src[i]) || 0;
    target[key] = cur;
  }
  return target;
}

// Per-hour buckets for recent activity (last 48h): [0 usd, 1 inp, 2 cacheRead, 3 out]
export function localHourKey(sec) {
  if (!(sec > 0)) return '';
  const d = new Date(sec * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd} ${hh}`;
}

export function addHourly(map, sec, usd = 0, inp = 0, cr = 0, out = 0) {
  if (!(sec > 0) || !(usd > 0 || inp > 0 || cr > 0 || out > 0)) return;
  const key = localHourKey(sec);
  if (!key) return;
  let b = map.get(key);
  if (!b) {
    b = [0, 0, 0, 0];
    map.set(key, b);
  }
  b[0] += usd;
  b[1] += inp;
  b[2] += cr;
  b[3] += out;
}

export function finalizeHourly(map, cutoffSec = Date.now() / 1000 - 48 * 3600) {
  const minKey = localHourKey(cutoffSec);
  const out = {};
  for (const [k, b] of map) {
    if (minKey && k < minKey) continue;
    out[k] = [round(b[0], 6), b[1], b[2], b[3]];
  }
  return out;
}

export function mergeHourlyInto(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const k of Object.keys(source)) {
    const src = source[k];
    if (!Array.isArray(src)) continue;
    const cur = target[k] || [0, 0, 0, 0];
    cur[0] += Number(src[0]) || 0;
    cur[1] += Number(src[1]) || 0;
    cur[2] += Number(src[2]) || 0;
    cur[3] += Number(src[3]) || 0;
    target[k] = cur;
  }
  return target;
}

/**
 * Per-day metrics by model: Map<dayKey, Map<modelName, number[8]>>.
 * Layout: [0 usd, 1 inp, 2 cacheRead, 3 out, 4 decodeOut, 5 decodeSec, 6 ttftSum, 7 ttftCnt]
 */
export const MODEL_DAILY_FIELDS = 8;

function modelDayBucket(map, sec, name) {
  const key = localDayKey(sec);
  let m = map.get(key);
  if (!m) {
    m = new Map();
    map.set(key, m);
  }
  const n = String(name || '其他');
  let b = m.get(n);
  if (!b) {
    b = new Array(MODEL_DAILY_FIELDS).fill(0);
    m.set(n, b);
  }
  return b;
}

export function addDailyModel(map, sec, name, usd = 0, inp = 0, cr = 0, out = 0) {
  if (!(usd > 0 || inp > 0 || cr > 0 || out > 0)) return;
  const b = modelDayBucket(map, sec, name);
  b[0] += usd;
  b[1] += inp;
  b[2] += cr;
  b[3] += out;
}

export function addDailyModelPerf(map, sec, name, decodeOut = 0, decodeSec = 0, ttftSec = 0) {
  if (!(decodeOut > 0 || ttftSec > 0)) return;
  const b = modelDayBucket(map, sec, name);
  if (decodeOut > 0 && decodeSec > 0) {
    b[4] += decodeOut;
    b[5] += decodeSec;
  }
  if (ttftSec > 0) {
    b[6] += ttftSec;
    b[7] += 1;
  }
}

export function finalizeDailyModels(map, fallbackSec = 0) {
  const outObj = {};
  for (const [rawKey, m] of map) {
    const key = rawKey || localDayKey(fallbackSec || Date.now() / 1000);
    const cur = outObj[key] || {};
    for (const [n, src] of m) {
      const dst = cur[n] || new Array(MODEL_DAILY_FIELDS).fill(0);
      for (let i = 0; i < MODEL_DAILY_FIELDS; i++) dst[i] += src[i];
      cur[n] = dst;
    }
    outObj[key] = cur;
  }
  for (const day of Object.values(outObj)) {
    for (const n of Object.keys(day)) {
      day[n][0] = round(day[n][0], 6);
      day[n][5] = round(day[n][5], 6);
      day[n][6] = round(day[n][6], 6);
    }
  }
  return outObj;
}

export function mergeDailyModelsInto(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) {
    const src = source[key];
    if (!src || typeof src !== 'object') continue;
    const cur = target[key] || {};
    for (const n of Object.keys(src)) {
      const v = src[n];
      const dst = cur[n] || new Array(MODEL_DAILY_FIELDS).fill(0);
      if (Array.isArray(v)) {
        for (let i = 0; i < MODEL_DAILY_FIELDS; i++) dst[i] += Number(v[i]) || 0;
      } else {
        dst[0] += Number(v) || 0;
      }
      cur[n] = dst;
    }
    target[key] = cur;
  }
  return target;
}
