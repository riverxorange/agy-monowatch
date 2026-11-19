/**
 * Lightweight, privacy-preserving GitHub version checker and in-place self-updater.
 *
 * Design guarantees:
 * - Zero telemetry uploads: only performs anonymous GET requests to GitHub (`plugin.json` / tarball).
 * - Low frequency & silent failure: caches results in `update_cache.json` (1h success TTL, 30m error TTL).
 * - Safe self-update: mutates `pluginRoot` ONLY when installed under `.gemini/config/plugins/`;
 *   uses `git pull --ff-only` when `.git` is present and clean, or pure-Node `.tar.gz` extraction
 *   (USTAR + PAX headers) for ZIP/directory installs without requiring `git` or `tar` binaries.
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const DEFAULT_REPO_SLUG = 'riverxorange/agy-monowatch';
const SUCCESS_TTL_MS = 1 * 3600 * 1000;
const ERROR_TTL_MS = 30 * 60 * 1000;
const MAX_TARBALL_BYTES = 16 * 1024 * 1024;

export function parseRepoSlug(repoField) {
  const raw =
    typeof repoField === 'string'
      ? repoField
      : repoField && typeof repoField === 'object'
        ? String(repoField.url || '')
        : '';
  const m = raw
    .trim()
    .match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git|\/)?$/i);
  if (m && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m[1])) {
    return m[1];
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.trim())) {
    return raw.trim();
  }
  return DEFAULT_REPO_SLUG;
}

function parseSemverParts(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^v/i, '');
  const m = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || '',
  };
}

export function compareSemver(a, b) {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

function readNullTermString(buf, start, length) {
  let end = start;
  const max = Math.min(buf.length, start + length);
  while (end < max && buf[end] !== 0) end++;
  return buf.subarray(start, end).toString('utf-8').trim();
}

function parsePaxRecords(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    let sp = pos;
    while (sp < buf.length && buf[sp] !== 0x20) sp++;
    if (sp >= buf.length) break;
    const recLen = parseInt(buf.subarray(pos, sp).toString('ascii'), 10);
    if (!Number.isFinite(recLen) || recLen <= sp - pos + 1 || pos + recLen > buf.length) {
      break;
    }
    const rec = buf
      .subarray(sp + 1, pos + recLen)
      .toString('utf-8')
      .replace(/\r?\n$/, '');
    const eq = rec.indexOf('=');
    if (eq > 0) {
      out[rec.slice(0, eq)] = rec.slice(eq + 1);
    }
    pos += recLen;
  }
  return out;
}

/**
 * Pure-Buffer USTAR + PAX `.tar` parser (returns array of `{ path, data }`).
 * Strips the single top-level GitHub directory prefix (`repo-main/`).
 */
export function extractTarEntries(tarBuf) {
  const files = [];
  let offset = 0;
  let nextPax = null;

  while (offset + 512 <= tarBuf.length) {
    const hdr = tarBuf.subarray(offset, offset + 512);
    offset += 512;

    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (hdr[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) continue;

    const sizeOctal = readNullTermString(hdr, 124, 12);
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    if (!Number.isFinite(size) || size < 0 || offset + size > tarBuf.length) {
      throw new Error('Malformed tar archive entry size');
    }

    const typeByte = hdr[156];
    const typeFlag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const body = tarBuf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === 'x') {
      nextPax = parsePaxRecords(body);
      continue;
    }
    if (typeFlag === 'g') {
      continue;
    }

    const name = readNullTermString(hdr, 0, 100);
    const magic = readNullTermString(hdr, 257, 6);
    const prefix = magic.startsWith('ustar') ? readNullTermString(hdr, 345, 155) : '';
    let fullPath = nextPax?.path || (prefix ? `${prefix}/${name}` : name);
    nextPax = null;

    if (typeFlag !== '0') continue;

    fullPath = fullPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const slashIdx = fullPath.indexOf('/');
    const relPath = slashIdx >= 0 ? fullPath.slice(slashIdx + 1) : fullPath;
    if (!relPath || relPath.includes('\0')) continue;
    const parts = relPath.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..' || p === '.git')) continue;

    files.push({ path: parts.join('/'), data: Buffer.from(body) });
  }

  return files;
}

function isInstalledPluginPath(pluginRoot) {
  const norm = resolve(pluginRoot).replace(/\\/g, '/').toLowerCase();
  return norm.includes('/.gemini/config/plugins/');
}

function execGit(args, timeoutMs = 15_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        rejectPromise(new Error(String(stderr || err.message || err).trim()));
        return;
      }
      resolvePromise(String(stdout || '').trim());
    });
  });
}

export function createUpdater({ pluginRoot, getCachePath, isEnabled, onScheduleRestart }) {
  const resolvedRoot = resolve(pluginRoot);
  let checkInFlight = null;
  let updateInFlight = null;

  function readLocalManifest() {
    try {
      const raw = JSON.parse(readFileSync(join(resolvedRoot, 'plugin.json'), 'utf-8'));
      const version = String(raw?.version || '0.0.0').trim();
      const repoSlug = parseRepoSlug(raw?.repository);
      return {
        name: String(raw?.name || 'monowatch').trim(),
        version,
        repoSlug,
        repoUrl: `https://github.com/${repoSlug}`,
      };
    } catch {
      return {
        name: 'monowatch',
        version: '0.0.0',
        repoSlug: DEFAULT_REPO_SLUG,
        repoUrl: `https://github.com/${DEFAULT_REPO_SLUG}`,
      };
    }
  }

  function readCache() {
    try {
      const p = getCachePath();
      if (!p || !existsSync(p)) return null;
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }

  function writeCache(data) {
    try {
      const p = getCachePath();
      if (!p) return;
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmp, p);
    } catch {
      // Ignore cache write errors
    }
  }

  function buildStatusPayload(local, cache) {
    const enabled = isEnabled ? Boolean(isEnabled()) : true;
    const latestVersion = String(cache?.latestVersion || local.version).replace(/^v/i, '');
    const hasUpdate = enabled && compareSemver(latestVersion, local.version) > 0;
    return {
      currentVersion: local.version,
      latestVersion,
      hasUpdate,
      enabled,
      canSelfUpdate: isInstalledPluginPath(resolvedRoot),
      repoUrl: local.repoUrl,
      releaseUrl: cache?.releaseUrl || `${local.repoUrl}/releases`,
      checkedAtMs: Number(cache?.checkedAtMs || 0),
    };
  }

  async function fetchRemoteLatest(local) {
    const headers = {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      'User-Agent': `monowatch/${local.version}`,
    };

    // Primary: raw plugin.json on main (no 60/hr GitHub API rate limit)
    const rawUrl = `https://raw.githubusercontent.com/${local.repoSlug}/main/plugin.json`;
    try {
      const res = await fetch(rawUrl, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const pkg = await res.json();
        const ver = String(pkg?.version || '').trim().replace(/^v/i, '');
        if (parseSemverParts(ver)) {
          return {
            latestVersion: ver,
            releaseUrl: `${local.repoUrl}`,
          };
        }
      }
    } catch {
      // Fall through to GitHub Releases API fallback
    }

    // Fallback: GitHub Releases latest tag
    const apiUrl = `https://api.github.com/repos/${local.repoSlug}/releases/latest`;
    const res = await fetch(apiUrl, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const rel = await res.json();
    const ver = String(rel?.tag_name || rel?.name || '')
      .trim()
      .replace(/^v/i, '');
    if (!parseSemverParts(ver)) {
      throw new Error('Invalid release version tag');
    }
    return {
      latestVersion: ver,
      releaseUrl: String(rel?.html_url || `${local.repoUrl}/releases`),
    };
  }

  async function getStatus({ force = false } = {}) {
    const local = readLocalManifest();
    const enabled = isEnabled ? Boolean(isEnabled()) : true;
    const cached = readCache();
    const now = Date.now();

    if (!enabled && !force) {
      return buildStatusPayload(local, cached);
    }

    if (!force && cached && cached.checkedAtMs) {
      const ttl = cached.ok ? SUCCESS_TTL_MS : ERROR_TTL_MS;
      if (now - Number(cached.checkedAtMs) < ttl) {
        return buildStatusPayload(local, cached);
      }
    }

    if (!checkInFlight) {
      checkInFlight = (async () => {
        try {
          const remote = await fetchRemoteLatest(local);
          const next = {
            ok: true,
            checkedAtMs: Date.now(),
            latestVersion: remote.latestVersion,
            releaseUrl: remote.releaseUrl,
          };
          writeCache(next);
          return next;
        } catch (err) {
          const next = {
            ok: false,
            checkedAtMs: Date.now(),
            latestVersion: cached?.latestVersion || local.version,
            releaseUrl: cached?.releaseUrl || `${local.repoUrl}`,
            error: String(err?.message || err),
          };
          writeCache(next);
          return next;
        } finally {
          checkInFlight = null;
        }
      })();
    }

    const fresh = await checkInFlight;
    return buildStatusPayload(local, fresh);
  }

  async function applyUpdate() {
    if (updateInFlight) return updateInFlight;
    updateInFlight = (async () => {
      try {
        const local = readLocalManifest();
        if (!isInstalledPluginPath(resolvedRoot)) {
          return {
            ok: false,
            code: 'DEV_WORKSPACE',
            repoUrl: local.repoUrl,
            message: 'Running outside ~/.gemini/config/plugins/; skipped overwriting workspace.',
          };
        }

        const hasGitDir = existsSync(join(resolvedRoot, '.git'));
        if (hasGitDir) {
          const dirtyStatus = await execGit(['-C', resolvedRoot, 'status', '--porcelain'], 8000);
          if (dirtyStatus) {
            return {
              ok: false,
              code: 'DIRTY_GIT',
              repoUrl: local.repoUrl,
              message: 'Local plugin directory has uncommitted modifications.',
            };
          }
          await execGit(['-C', resolvedRoot, 'pull', '--ff-only'], 25_000);
        } else {
          const tarUrl = `https://codeload.github.com/${local.repoSlug}/tar.gz/refs/heads/main`;
          const res = await fetch(tarUrl, {
            headers: { 'User-Agent': `monowatch/${local.version}` },
            signal: AbortSignal.timeout(25_000),
          });
          if (!res.ok) {
            throw new Error(`Download failed (HTTP ${res.status})`);
          }
          const ab = await res.arrayBuffer();
          if (ab.byteLength > MAX_TARBALL_BYTES) {
            throw new Error('Archive exceeds 16 MB safety limit');
          }
          const entries = extractTarEntries(gunzipSync(Buffer.from(ab)));
          const manifestEntry = entries.find((e) => e.path === 'plugin.json');
          if (!manifestEntry) {
            throw new Error('Downloaded archive missing plugin.json');
          }
          const remoteManifest = JSON.parse(manifestEntry.data.toString('utf-8'));
          if (remoteManifest?.name !== 'monowatch') {
            throw new Error('Manifest name mismatch');
          }

          const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
          for (const entry of entries) {
            const dest = normalize(join(resolvedRoot, entry.path));
            if (!dest.startsWith(rootPrefix)) {
              throw new Error(`Unsafe archive path: ${entry.path}`);
            }
            mkdirSync(dirname(dest), { recursive: true });
            const tmp = `${dest}.upd.tmp`;
            writeFileSync(tmp, entry.data);
            renameSync(tmp, dest);
          }
        }

        const updatedLocal = readLocalManifest();
        writeCache({
          ok: true,
          checkedAtMs: Date.now(),
          latestVersion: updatedLocal.version,
          releaseUrl: updatedLocal.repoUrl,
        });
        onScheduleRestart?.();
        return {
          ok: true,
          updatedVersion: updatedLocal.version,
        };
      } catch (err) {
        const local = readLocalManifest();
        return {
          ok: false,
          code: 'UPDATE_FAILED',
          repoUrl: local.repoUrl,
          message: String(err?.message || err),
        };
      } finally {
        updateInFlight = null;
      }
    })();
    return updateInFlight;
  }

  return {
    readLocalManifest,
    getStatus,
    applyUpdate,
  };
}
