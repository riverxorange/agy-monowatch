/**
 * @fileoverview Local Antigravity directory discovery, SQLite summary loading,
 * projects/automations catalog scanning, and Swarm/Subagent metadata lookup.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  VALID_CONV_UUID_RE,
  dbWalSig,
  fileSig,
  openReadOnlyDb,
  parseDateMs,
  parseWorkspaceUris,
  safeStat,
} from './utils.mjs';
import { parseParentRefProto, parseStepMetadata } from './proto.mjs';

const ROLE_WORKER_RE = /^(narrator|monitor)(?:-\d+)?$/i;

export function discoverAppDataDirs(options = {}) {
  if (Array.isArray(options.appDataDirs) && options.appDataDirs.length > 0) {
    return options.appDataDirs.map((d) => resolve(d)).filter((d) => existsSync(d));
  }

  let primary = options.appDataDir ? resolve(options.appDataDir) : '';
  if (!primary && process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    let cur = resolve(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);
    for (let i = 0; i < 6; i++) {
      const base = basename(cur).toLowerCase();
      if (base === 'sidecar_data' || base === 'plugin_data') {
        primary = dirname(cur);
        break;
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  const geminiRoot = join(homedir(), '.gemini');
  if (!primary) {
    primary = join(geminiRoot, 'antigravity');
  }

  const dirs = [];
  const seen = new Set();
  const pushDir = (dir) => {
    if (!dir) return;
    const norm = resolve(dir);
    const key = norm.toLowerCase();
    if (!seen.has(key) && existsSync(norm)) {
      seen.add(key);
      dirs.push(norm);
    }
  };

  pushDir(primary);
  if (options.includeSiblingSurfaces !== false) {
    const parentRoot = dirname(primary);
    for (const name of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
      const candidate = join(parentRoot, name);
      if (
        existsSync(join(candidate, 'conversation_summaries.db')) ||
        existsSync(join(candidate, 'conversations')) ||
        existsSync(join(candidate, 'brain'))
      ) {
        pushDir(candidate);
      }
    }
  }
  return dirs;
}

export function createDiscoveryStore({ appDataDirs, primaryAppDataDir }) {
  const summariesDbCache = new Map();
  const annotationCache = new Map();
  const subagentMetaCache = new Map();
  const swarmMetaCache = new Map();
  const positivePathCache = new Map();
  const negativePathCache = new Map();
  const projectsFileCache = new Map();
  const unindexedDbCache = new Map();
  const dirtyConvIds = new Set();

  let projectsCatalogLastCheckMs = 0;
  let projectsCatalogSig = 'none';
  let projectsCatalogCached = {
    byId: new Map(),
    byFolderKey: new Map(),
    sig: 'none',
  };

  let automationsLastCheckMs = 0;
  let automationsCatalogSig = 'none';
  let automationsCached = [];

  let mergedSummarySig = '';
  let mergedSummaryMap = null;
  let indexedSummarySig = '';
  let indexedSummaryMap = null;

  function normalizeFolderKey(uri) {
    if (!uri || typeof uri !== 'string') return '';
    let s = uri.trim();
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep raw
    }
    s = s.replace(/^file:\/\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1');
    s = s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return s;
  }

  function extractFolderDisplayName(uri) {
    const norm = normalizeFolderKey(uri);
    if (!norm) return '';
    const parts = norm.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : '';
  }

  function resolveConfigRoot() {
    const parentRoot = dirname(primaryAppDataDir);
    const cand = join(parentRoot, 'config');
    if (existsSync(cand)) return cand;
    return join(homedir(), '.gemini', 'config');
  }

  function resolveProjectsConfigDir() {
    const cand = join(resolveConfigRoot(), 'projects');
    if (existsSync(cand)) return cand;
    return join(homedir(), '.gemini', 'config', 'projects');
  }

  function loadProjectsCatalog() {
    const now = Date.now();
    if (now - projectsCatalogLastCheckMs < 3000 && projectsCatalogCached) {
      return projectsCatalogCached;
    }
    projectsCatalogLastCheckMs = now;

    const dir = resolveProjectsConfigDir();
    if (!existsSync(dir)) {
      projectsCatalogSig = 'none';
      projectsCatalogCached = { byId: new Map(), byFolderKey: new Map(), sig: 'none' };
      return projectsCatalogCached;
    }

    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return projectsCatalogCached;
    }

    const byId = new Map();
    const byFolderKey = new Map();
    const sigParts = [];

    for (const fname of files) {
      const fpath = join(dir, fname);
      const sig = fileSig(fpath);
      if (sig === '0') continue;
      sigParts.push(`${fname}:${sig}`);

      const cachedFile = projectsFileCache.get(fpath);
      let entry = null;
      if (cachedFile && cachedFile.sig === sig) {
        entry = cachedFile.entry;
      } else {
        try {
          const raw = JSON.parse(readFileSync(fpath, 'utf-8'));
          const id = String(raw.id || basename(fname, '.json')).trim();
          const name = String(raw.name || '').trim();
          const resources = Array.isArray(raw.projectResources?.resources)
            ? raw.projectResources.resources
            : [];
          const folderUris = resources
            .map((r) => {
              if (typeof r?.folderUri === 'string') return r.folderUri.trim();
              if (typeof r?.gitFolder?.folderUri === 'string') return r.gitFolder.folderUri.trim();
              return '';
            })
            .filter(Boolean);
          const isInternalSidecarPseudo =
            Boolean(raw.sidecar?.sidecarId) ||
            id === 'default-cli-project' ||
            id === 'outside-of-project' ||
            (folderUris.length === 0 &&
              /\/(context_board|swarm_board|monitor_board)$/i.test(name));
          entry = {
            id,
            name: name || (folderUris[0] ? extractFolderDisplayName(folderUris[0]) : id),
            folderUris,
            isInternalSidecarPseudo,
          };
          projectsFileCache.set(fpath, { sig, entry });
        } catch {
          entry = null;
        }
      }

      if (!entry || !entry.id) continue;
      byId.set(entry.id, entry);
      if (!entry.isInternalSidecarPseudo) {
        for (const u of entry.folderUris) {
          const fk = normalizeFolderKey(u);
          if (fk) byFolderKey.set(fk, entry);
        }
      }
    }

    const combined = sigParts.join('|') || 'empty';
    projectsCatalogSig = combined;
    projectsCatalogCached = { byId, byFolderKey, sig: combined };
    return projectsCatalogCached;
  }

  function loadAutomationsCatalog() {
    const now = Date.now();
    if (now - automationsLastCheckMs < 4000) {
      return automationsCached;
    }
    automationsLastCheckMs = now;

    const roots = [
      join(resolveConfigRoot(), 'sidecars'),
      join(dirname(primaryAppDataDir), 'jetski', 'sidecars'),
    ];

    const sigParts = [];
    const items = [];
    for (const rootDir of roots) {
      if (!existsSync(rootDir)) continue;
      let entries = [];
      try {
        entries = readdirSync(rootDir).sort();
      } catch {
        continue;
      }
      for (const slug of entries) {
        const sj = join(rootDir, slug, 'sidecar.json');
        const sig = fileSig(sj);
        if (sig === '0') continue;
        sigParts.push(`${sj}:${sig}`);
        try {
          const parsed = JSON.parse(readFileSync(sj, 'utf-8'));
          if (parsed?.builtin !== 'schedule') continue;
          const args = Array.isArray(parsed.args) ? parsed.args : [];
          const scheduleCron = typeof args[0] === 'string' ? args[0].trim() : '';
          const sepIdx = args.indexOf('--');
          const promptRaw =
            sepIdx >= 0 && typeof args[sepIdx + 1] === 'string'
              ? args[sepIdx + 1]
              : typeof args[args.length - 1] === 'string'
                ? args[args.length - 1]
                : '';
          const promptSnippet = promptRaw.replace(/\s+/g, ' ').trim().slice(0, 80);
          items.push({
            id: slug,
            displayName: String(parsed.display_name || slug).trim(),
            scheduleCron,
            promptSnippet,
          });
        } catch {
          // ignore malformed sidecar.json
        }
      }
    }

    const combinedSig = sigParts.join('|') || 'none';
    if (combinedSig !== automationsCatalogSig) {
      automationsCatalogSig = combinedSig;
      automationsCached = items;
    }
    return automationsCached;
  }

  function matchAutomationForRow(row, hopRow) {
    const catalog = loadAutomationsCatalog();
    if (catalog.length === 0) return null;
    const textPool = [
      row?.title,
      row?.preview,
      hopRow?.title,
      hopRow?.preview,
    ]
      .filter(Boolean)
      .map((s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase());

    for (const item of catalog) {
      if (item.promptSnippet && item.promptSnippet.length >= 16) {
        const prefix = item.promptSnippet.slice(0, 36).toLowerCase();
        if (textPool.some((txt) => txt.includes(prefix))) {
          return {
            id: item.id,
            name: item.displayName,
            schedule: item.scheduleCron,
          };
        }
      }
    }
    const src = String(row?.source || hopRow?.source || '').toUpperCase();
    if (src.includes('SCHEDULE') || src.includes('AUTOMATION')) {
      return { id: 'scheduled', name: '定时任务', schedule: '' };
    }
    return null;
  }

  function isCliSummaryRow(row, preferredDir = '') {
    if (!row) return false;
    const src = String(row.source || '');
    if (src === 'CORTEX_TRAJECTORY_SOURCE_CLI') return true;
    const appDirCol = String(row.app_data_dir || '').toLowerCase();
    if (appDirCol === 'antigravity-cli') return true;
    const prefBase = preferredDir ? basename(preferredDir).toLowerCase() : '';
    if (prefBase === 'antigravity-cli') return true;
    const pid = String(row.project_id || '').trim();
    if (pid === 'default-cli-project') return true;
    return false;
  }

  function resolveRowSurface(row, hopRow, preferredDir) {
    if (isCliSummaryRow(row, preferredDir) || (hopRow && isCliSummaryRow(hopRow, hopRow.preferredDir))) {
      return 'cli';
    }
    const appDirCol = String(row?.app_data_dir || hopRow?.app_data_dir || '').toLowerCase();
    const prefBase = preferredDir ? basename(preferredDir).toLowerCase() : '';
    const src = String(row?.source || hopRow?.source || '').toUpperCase();
    if (
      appDirCol === 'antigravity-ide' ||
      prefBase === 'antigravity-ide' ||
      src.includes('IDE') ||
      src.includes('VSCODE')
    ) {
      return 'ide';
    }
    return 'app';
  }

  function resolveThreadClassification(row, hopRow, preferredDir, effectiveWorkspaces) {
    const surface = resolveRowSurface(row, hopRow, preferredDir);
    const catalog = loadProjectsCatalog();

    const ownPid = String(row?.project_id || '').trim();
    const rootPid = String(hopRow?.project_id || '').trim();
    const rawPid =
      ownPid && ownPid !== 'outside-of-project'
        ? ownPid
        : rootPid || ownPid;

    let project = null;

    if (rawPid && rawPid !== 'outside-of-project' && rawPid !== 'default-cli-project') {
      const known = catalog.byId.get(rawPid);
      if (known && !known.isInternalSidecarPseudo) {
        project = { id: known.id, name: known.name };
      } else if (!known) {
        let matchedByFolder = null;
        for (const ws of effectiveWorkspaces || []) {
          const fk = normalizeFolderKey(ws);
          if (fk && catalog.byFolderKey.has(fk)) {
            matchedByFolder = catalog.byFolderKey.get(fk);
            break;
          }
        }
        if (matchedByFolder) {
          project = { id: matchedByFolder.id, name: matchedByFolder.name };
        } else {
          const wsName =
            effectiveWorkspaces && effectiveWorkspaces[0]
              ? extractFolderDisplayName(effectiveWorkspaces[0])
              : '';
          project = { id: rawPid, name: wsName || rawPid.slice(0, 8) };
        }
      }
    } else if (!rawPid && surface !== 'cli' && effectiveWorkspaces && effectiveWorkspaces.length > 0) {
      for (const ws of effectiveWorkspaces) {
        const fk = normalizeFolderKey(ws);
        if (fk && catalog.byFolderKey.has(fk)) {
          const m = catalog.byFolderKey.get(fk);
          project = { id: m.id, name: m.name };
          break;
        }
      }
      if (!project) {
        const wsName = extractFolderDisplayName(effectiveWorkspaces[0]);
        if (wsName) {
          project = { id: normalizeFolderKey(effectiveWorkspaces[0]) || wsName, name: wsName };
        }
      }
    }

    const automation = matchAutomationForRow(row, hopRow);
    const category =
      surface === 'cli' ? 'cli' : project ? 'project' : 'conversation';

    return { surface, category, project, automation };
  }

  function purgeNegativePathCacheForConv(convId) {
    if (!convId) return;
    for (const k of Array.from(negativePathCache.keys())) {
      if (k.includes(convId)) {
        negativePathCache.delete(k);
      }
    }
  }

  function probeConvOnDiskDirect(convId) {
    if (!convId || !VALID_CONV_UUID_RE.test(convId)) {
      return { dbFound: '', brainFound: '', dir: '', diskSig: 'none' };
    }
    const dbRel = join('conversations', `${convId}.db`);
    const brainRel = join('brain', convId);
    const searchDirs = [
      primaryAppDataDir,
      ...appDataDirs.filter((d) => d !== primaryAppDataDir),
    ].filter(Boolean);

    let dbFound = '';
    let brainFound = '';
    let dir = '';

    for (const d of searchDirs) {
      const candDb = join(d, dbRel);
      if (!dbFound && existsSync(candDb)) {
        dbFound = candDb;
        dir = d;
        negativePathCache.delete(dbRel);
        positivePathCache.set(dbRel, candDb);
      }
      const candBrain = join(d, brainRel);
      if (!brainFound && existsSync(candBrain)) {
        brainFound = candBrain;
        if (!dir) dir = d;
        negativePathCache.delete(brainRel);
        positivePathCache.set(brainRel, candBrain);
      }
      if (dbFound && brainFound) break;
    }

    const dbSig = dbFound ? dbWalSig(dbFound) || '0' : '0';
    const brainSig = brainFound ? fileSig(brainFound) : '0';
    const diskSig =
      dbFound || brainFound ? `disk:${dbSig}:${brainSig}` : 'empty';
    return { dbFound, brainFound, dir: dir || primaryAppDataDir, diskSig };
  }

  function inspectUnindexedConvDb(dbPath, convId, preferredDir) {
    const sig = dbWalSig(dbPath);
    if (!sig) return null;

    const cached = unindexedDbCache.get(dbPath);
    if (cached && cached.sig === sig) {
      return { sig, row: cached.row };
    }

    let db = null;
    try {
      db = openReadOnlyDb(dbPath);
      let trajectoryType = 0;
      try {
        const tm = db.prepare('SELECT trajectory_type FROM trajectory_meta LIMIT 1').get();
        if (tm) trajectoryType = Number(tm.trajectory_type) || 0;
      } catch {
        // ignore missing trajectory_meta table
      }

      const isBtw = trajectoryType === 22;
      if (!isBtw) {
        unindexedDbCache.set(dbPath, { sig, row: null });
        return { sig, row: null };
      }

      let markerIdx = -1;
      try {
        const mRow = db
          .prepare(
            `SELECT idx
             FROM steps
             WHERE step_type = 101
               AND instr(CAST(step_payload AS BLOB), CAST('what follows is a side question (/btw)' AS BLOB)) > 0
             ORDER BY idx ASC
             LIMIT 1`
          )
          .get();
        if (mRow && Number.isFinite(Number(mRow.idx))) {
          markerIdx = Number(mRow.idx);
        }
      } catch {
        markerIdx = -1;
      }

      let parentRef = {
        parentTrajectoryId: '',
        parentStepIndex: -1,
        refType: 0,
        parentConversationId: '',
      };
      try {
        const prRow = db
          .prepare('SELECT idx, data FROM parent_references ORDER BY idx DESC LIMIT 1')
          .get();
        if (prRow?.data) {
          parentRef = parseParentRefProto(prRow.data);
        }
      } catch {
        // ignore missing parent_references
      }

      const branchStepIdx =
        parentRef.parentStepIndex >= 0
          ? parentRef.parentStepIndex
          : markerIdx >= 0
            ? markerIdx - 1
            : -1;
      const minStepIdx =
        markerIdx >= 0
          ? markerIdx
          : branchStepIdx >= 0
            ? branchStepIdx + 1
            : 0;

      let stepCount = 0;
      let maxMetaSec = 0;
      let isRunningStep = false;
      try {
        const cntRow = db
          .prepare('SELECT COUNT(*) AS cnt FROM steps WHERE idx >= ?')
          .get(minStepIdx);
        stepCount = Number(cntRow?.cnt) || 0;

        const latest = db
          .prepare(
            `SELECT idx, step_type, status, metadata
             FROM steps
             WHERE idx >= ?
             ORDER BY idx DESC
             LIMIT 1`
          )
          .get(minStepIdx);
        if (latest) {
          const meta = parseStepMetadata(latest.metadata);
          maxMetaSec = Math.max(meta.t7 || 0, meta.t6 || 0, meta.t1 || 0);
          const stType = Number(latest.step_type);
          const stStatus = Number(latest.status);
          isRunningStep =
            stStatus === 8 ||
            (stType === 15 && (stStatus === 1 || stStatus === 2));
        }
      } catch {
        // ignore step inspection errors
      }

      const dbSt = safeStat(dbPath);
      const walSt = safeStat(`${dbPath}-wal`);
      const updatedAtMs = Math.max(
        maxMetaSec * 1000,
        dbSt ? dbSt.mtimeMs : 0,
        walSt ? walSt.mtimeMs : 0
      );

      const parentConvId = parentRef.parentConversationId || '';
      const row = {
        conversation_id: convId,
        title: '',
        preview: '',
        step_count: stepCount,
        last_modified_time: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : '',
        workspace_uris: '[]',
        parsedWorkspaces: [],
        status: isRunningStep ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
        source: '',
        project_id: '',
        app_data_dir: basename(preferredDir || primaryAppDataDir),
        agent_name: '',
        parent_conversation_id: parentConvId,
        nesting_depth: parentConvId ? 1 : 0,
        not_fully_idle: isRunningStep ? 1 : 0,
        killed: 0,
        battle_id: '',
        winning_conversation_id: '',
        group_id: '',
        updatedAtMs,
        preferredDir: preferredDir || primaryAppDataDir,
        _unindexedDiskRow: true,
        _unindexedSig: sig,
        _isBtw: true,
        _btwMinStepIdx: minStepIdx,
        _btwBranchStepIdx: branchStepIdx,
      };
      unindexedDbCache.set(dbPath, { sig, row });
      return { sig, row };
    } catch {
      return { sig, row: cached ? cached.row : null };
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

  function createSyntheticSummaryRow(
    convId,
    { dbFound = '', brainFound = '', dir = '', workspaceUris = [], isZeroHostStub = false } = {}
  ) {
    if (dbFound) {
      const inspected = inspectUnindexedConvDb(dbFound, convId, dir || primaryAppDataDir);
      if (inspected?.row) {
        const extraWs = parseWorkspaceUris(workspaceUris);
        return extraWs.length > 0 && inspected.row.parsedWorkspaces.length === 0
          ? {
              ...inspected.row,
              workspace_uris: JSON.stringify(extraWs),
              parsedWorkspaces: extraWs,
            }
          : inspected.row;
      }
    }
    const st = dbFound || brainFound ? safeStat(dbFound || brainFound) : null;
    const cleanWs = parseWorkspaceUris(workspaceUris);
    return {
      conversation_id: convId,
      title: '',
      preview: '',
      step_count: 0,
      last_modified_time: st ? new Date(st.mtimeMs).toISOString() : '',
      workspace_uris: JSON.stringify(cleanWs),
      parsedWorkspaces: cleanWs,
      status: 'CASCADE_RUN_STATUS_IDLE',
      source: '',
      project_id: '',
      agent_name: '',
      parent_conversation_id: '',
      nesting_depth: 0,
      not_fully_idle: 0,
      killed: 0,
      battle_id: '',
      winning_conversation_id: '',
      group_id: '',
      updatedAtMs: st ? st.mtimeMs : 0,
      preferredDir: dir || primaryAppDataDir,
      _unindexedDiskRow: Boolean(dbFound || brainFound),
      _isZeroHostStub: Boolean(!dbFound && !brainFound && isZeroHostStub),
    };
  }

  function findConvFile(convId, preferredDir, relativeSubpath) {
    const cachedHit = positivePathCache.get(relativeSubpath);
    if (cachedHit) return cachedHit;

    const now = Date.now();
    const negExp = negativePathCache.get(relativeSubpath);
    if (negExp && now < negExp && !dirtyConvIds.has(convId)) {
      return '';
    }

    if (preferredDir) {
      const p = join(preferredDir, relativeSubpath);
      if (existsSync(p)) {
        negativePathCache.delete(relativeSubpath);
        positivePathCache.set(relativeSubpath, p);
        return p;
      }
    }
    for (const dir of appDataDirs) {
      if (dir === preferredDir) continue;
      const p = join(dir, relativeSubpath);
      if (existsSync(p)) {
        negativePathCache.delete(relativeSubpath);
        positivePathCache.set(relativeSubpath, p);
        return p;
      }
    }
    negativePathCache.set(relativeSubpath, now + 4000);
    return '';
  }

  function resolvePreferredDirForSource(source, fallbackDir) {
    if (source === 'CORTEX_TRAJECTORY_SOURCE_CLI') {
      const cliDir = appDataDirs.find((d) => basename(d).toLowerCase() === 'antigravity-cli');
      if (cliDir) return cliDir;
    }
    return fallbackDir || primaryAppDataDir;
  }

  function loadAllSummaryRows(opts = {}) {
    const { includeUnindexedBtw = true } = opts || {};
    const dbEntries = [];
    const indexedSigParts = [];
    for (const dir of appDataDirs) {
      const dbPath = join(dir, 'conversation_summaries.db');
      const sig = dbWalSig(dbPath);
      if (sig) {
        dbEntries.push({ dir, dbPath, sig });
        indexedSigParts.push(`${dbPath}=${sig}`);
      }
    }
    const indexedOnlySig = indexedSigParts.join('||');

    if (mergedSummaryMap) {
      const fullSigParts = [...indexedSigParts];
      for (const dir of appDataDirs) {
        const convDir = join(dir, 'conversations');
        const cDirSig = fileSig(convDir);
        if (cDirSig !== '0') {
          fullSigParts.push(`convdir:${convDir}=${cDirSig}`);
        }
      }
      for (const [uPath, uCached] of unindexedDbCache.entries()) {
        if (uCached?.row) {
          fullSigParts.push(`btw:${uPath}=${dbWalSig(uPath) || '0'}`);
        }
      }
      const combinedSig = fullSigParts.join('||');
      if (combinedSig === mergedSummarySig) {
        return new Map(mergedSummaryMap);
      }
    }

    let baseIndexed = null;
    if (indexedSummaryMap && indexedOnlySig === indexedSummarySig) {
      baseIndexed = indexedSummaryMap;
    } else {
      const nextIndexed = new Map();

      for (const { dir, dbPath, sig } of dbEntries) {
        let rows = null;
        const cached = summariesDbCache.get(dbPath);
        if (cached && cached.sig === sig) {
          rows = cached.rows;
        } else {
          let db = null;
          try {
            db = openReadOnlyDb(dbPath);
            try {
              rows = db.prepare(`
                SELECT
                  conversation_id, title, preview, step_count, last_modified_time,
                  workspace_uris, status, source, project_id, app_data_dir,
                  agent_name, parent_conversation_id, nesting_depth,
                  not_fully_idle, killed,
                  battle_id, winning_conversation_id, group_id,
                  last_user_input_time, last_user_input_step_index
                FROM conversation_summaries
              `).all();
            } catch {
              try {
                rows = db.prepare(`
                  SELECT
                    conversation_id, title, preview, step_count, last_modified_time,
                    workspace_uris, status, source, project_id, app_data_dir,
                    agent_name, parent_conversation_id, nesting_depth,
                    not_fully_idle, killed
                  FROM conversation_summaries
                `).all();
              } catch {
                rows = db.prepare(`
                  SELECT
                    conversation_id, title, preview, step_count, last_modified_time,
                    workspace_uris, status, source, project_id,
                    agent_name, parent_conversation_id, nesting_depth,
                    not_fully_idle, killed
                  FROM conversation_summaries
                `).all();
              }
            }
            summariesDbCache.set(dbPath, { sig, rows });
          } catch {
            rows = cached ? cached.rows : [];
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

        for (const r of rows) {
          const id = r.conversation_id;
          if (!id) continue;
          const updatedAtMs = parseDateMs(r.last_modified_time);
          const existing = nextIndexed.get(id);
          if (
            !existing ||
            updatedAtMs > existing.updatedAtMs ||
            (updatedAtMs === existing.updatedAtMs && (r.step_count || 0) > (existing.step_count || 0))
          ) {
            nextIndexed.set(id, {
              ...r,
              updatedAtMs,
              parsedWorkspaces: parseWorkspaceUris(r.workspace_uris),
              preferredDir: resolvePreferredDirForSource(r.source, dir),
            });
          }
        }
      }

      indexedSummarySig = indexedOnlySig;
      indexedSummaryMap = nextIndexed;
      baseIndexed = nextIndexed;
    }

    if (!includeUnindexedBtw) {
      const fastMap = new Map(baseIndexed);
      for (const uCached of unindexedDbCache.values()) {
        const uRow = uCached?.row;
        if (uRow?.conversation_id && !fastMap.has(uRow.conversation_id)) {
          fastMap.set(uRow.conversation_id, uRow);
        }
      }
      return fastMap;
    }

    const merged = new Map(baseIndexed);

    // Discover unindexed `/btw` trajectories (`trajectory_type = 22`) stored directly in `conversations/*.db`
    for (const dir of appDataDirs) {
      const convDir = join(dir, 'conversations');
      if (!existsSync(convDir)) continue;
      let files = [];
      try {
        files = readdirSync(convDir);
      } catch {
        continue;
      }
      for (const fname of files) {
        if (!fname.endsWith('.db')) continue;
        const id = fname.slice(0, -3);
        if (!VALID_CONV_UUID_RE.test(id) || merged.has(id)) continue;
        const dbPath = join(convDir, fname);
        const inspected = inspectUnindexedConvDb(dbPath, id, dir);
        if (inspected?.row) {
          merged.set(id, inspected.row);
        }
      }
    }

    // Recompute combinedSig including any newly discovered unindexed `/btw` DBs
    const nextSigParts = [...indexedSigParts];
    for (const dir of appDataDirs) {
      const convDir = join(dir, 'conversations');
      const cDirSig = fileSig(convDir);
      if (cDirSig !== '0') nextSigParts.push(`convdir:${convDir}=${cDirSig}`);
    }
    for (const [uPath, uCached] of unindexedDbCache.entries()) {
      if (uCached?.row) {
        nextSigParts.push(`btw:${uPath}=${uCached.sig}`);
      }
    }
    mergedSummarySig = nextSigParts.join('||');
    mergedSummaryMap = merged;
    return new Map(merged);
  }

  function getConversationMetadataLite(convId) {
    const cid = typeof convId === 'string' ? convId.trim() : '';
    if (!VALID_CONV_UUID_RE.test(cid)) {
      return {
        projectId: '',
        parentConversationId: '',
        rootConversationId: '',
        workspaceUris: [],
        nestingDepth: 0,
      };
    }
    const row = loadAllSummaryRows({ includeUnindexedBtw: false }).get(cid);
    let projectId = String(row?.project_id || '').trim();
    const workspaceUris = Array.isArray(row?.parsedWorkspaces) ? [...row.parsedWorkspaces] : [];
    if (!projectId && workspaceUris.length > 0) {
      const cat = loadProjectsCatalog();
      for (const wsUri of workspaceUris) {
        const fk = normalizeFolderKey(wsUri);
        const matched = fk ? cat.byFolderKey.get(fk) : null;
        if (matched?.id) {
          projectId = matched.id;
          break;
        }
      }
    }
    return {
      projectId,
      parentConversationId: String(row?.parent_conversation_id || ''),
      rootConversationId: cid,
      workspaceUris,
      nestingDepth: Number(row?.nesting_depth) || 0,
    };
  }

  function getAnnotationTitle(convId, preferredDir) {
    const p = findConvFile(convId, preferredDir, join('annotations', `${convId}.pbtxt`));
    if (!p) return '';
    const sig = fileSig(p);
    const cached = annotationCache.get(convId);
    if (cached && cached.sig === sig) return cached.title;
    let title = '';
    try {
      const txt = readFileSync(p, 'utf-8');
      const m = txt.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) {
        title = JSON.parse(`"${m[1]}"`).trim();
      }
    } catch {
      title = '';
    }
    annotationCache.set(convId, { sig, title });
    return title;
  }

  function getSwarmInfo(rootConvId, preferredDir) {
    const swarmRelDir = join('brain', rootConvId, '.system_generated', 'swarm');
    const membersPath = findConvFile(
      rootConvId,
      preferredDir,
      join(swarmRelDir, 'members.json')
    );
    if (!membersPath) return null;
    const sig = fileSig(membersPath);
    const cached = swarmMetaCache.get(membersPath);
    if (cached && cached.sig === sig) return cached.info;

    let info = null;
    try {
      const swarmDir = dirname(membersPath);
      const hasOverview = existsSync(join(swarmDir, 'view.json'));
      const hasRemoteAnchor = existsSync(join(swarmDir, 'swarm.json'));
      const raw = JSON.parse(readFileSync(membersPath, 'utf-8'));
      const membersByConvId = new Map();
      const membersByName = new Map();
      const membersObj = raw.members || {};
      for (const [rosterName, m] of Object.entries(membersObj)) {
        if (!m || typeof m !== 'object') continue;
        const rawRole = typeof m.role === 'string' ? m.role : 'worker';
        const roleMatch = ROLE_WORKER_RE.exec(rosterName);
        const systemRole =
          rawRole === 'narrator' || rawRole === 'monitor'
            ? rawRole
            : roleMatch
              ? roleMatch[1].toLowerCase()
              : '';
        const desiredModelSlug = typeof m.desired_model === 'string' ? m.desired_model : '';
        const appliedModelSlug =
          typeof m.applied_model === 'string' && m.applied_model
            ? m.applied_model
            : typeof m.model === 'string'
              ? m.model
              : '';
        const modelSwitched = Boolean(
          desiredModelSlug &&
            appliedModelSlug &&
            desiredModelSlug !== appliedModelSlug
        );
        const entry = {
          rosterName,
          conversationId: m.conversation_id || '',
          role: rawRole,
          systemRole,
          isSystemRoleWorker: Boolean(systemRole),
          workspaceMode:
            typeof m.workspace_mode === 'string' && m.workspace_mode
              ? m.workspace_mode
              : 'inherit',
          channels: Array.isArray(m.channels) ? m.channels : [],
          desiredState: typeof m.desired_state === 'string' ? m.desired_state : '',
          modelSlug: appliedModelSlug || desiredModelSlug,
          desiredModelSlug,
          appliedModelSlug,
          modelSwitched,
          killed: Boolean(m.killed),
          phase: m.phase || '',
          wakeMode: typeof m.wake_mode === 'string' ? m.wake_mode : '',
        };
        if (entry.conversationId) membersByConvId.set(entry.conversationId, entry);
        membersByName.set(rosterName, entry);
      }
      info = {
        title: typeof raw.title === 'string' ? raw.title.trim() : '',
        hasOverview,
        hasRemoteAnchor,
        membersByConvId,
        membersByName,
      };
    } catch {
      info = null;
    }
    swarmMetaCache.set(membersPath, { sig, info });
    return info;
  }

  function getSubagentDescriptor(parentConvId, childConvId, preferredDir) {
    if (!parentConvId) return null;
    const subPath = findConvFile(
      parentConvId,
      preferredDir,
      join('brain', parentConvId, '.system_generated', 'subagents', `${childConvId}.json`)
    );
    if (!subPath) return null;
    const sig = fileSig(subPath);
    const cached = subagentMetaCache.get(subPath);
    if (cached && cached.sig === sig) return cached.data;

    let data = null;
    try {
      const raw = JSON.parse(readFileSync(subPath, 'utf-8'));
      data = {
        conversationId: raw.conversationId || childConvId,
        typeName: raw.subagentDescriptor?.typeName || '',
        role: raw.subagentDescriptor?.role || '',
        state: raw.state || '',
        spawnStepIndex: raw.spawnStepIndex ?? -1,
        workspaceUris: parseWorkspaceUris(raw.workspaceUris),
      };
    } catch {
      data = null;
    }
    subagentMetaCache.set(subPath, { sig, data });
    return data;
  }

  return {
    dirtyConvIds,
    get projectsCatalogSig() {
      return projectsCatalogSig;
    },
    get mergedSummarySig() {
      return mergedSummarySig;
    },
    loadProjectsCatalog,
    loadAutomationsCatalog,
    resolveRowSurface,
    resolveThreadClassification,
    purgeNegativePathCacheForConv,
    probeConvOnDiskDirect,
    createSyntheticSummaryRow,
    findConvFile,
    loadAllSummaryRows,
    getConversationMetadataLite,
    getAnnotationTitle,
    getSwarmInfo,
    getSubagentDescriptor,
    invalidateAll() {
      summariesDbCache.clear();
      unindexedDbCache.clear();
      mergedSummarySig = '';
      mergedSummaryMap = null;
      indexedSummarySig = '';
      indexedSummaryMap = null;
      projectsCatalogLastCheckMs = 0;
      automationsLastCheckMs = 0;
      negativePathCache.clear();
    },
    invalidateConv(cid) {
      dirtyConvIds.add(cid);
      purgeNegativePathCacheForConv(cid);
      annotationCache.delete(cid);
      for (const k of Array.from(unindexedDbCache.keys())) {
        if (k.includes(cid)) {
          unindexedDbCache.delete(k);
        }
      }
      mergedSummarySig = '';
      mergedSummaryMap = null;
      indexedSummarySig = '';
      indexedSummaryMap = null;
    },
    clearAll() {
      summariesDbCache.clear();
      unindexedDbCache.clear();
      mergedSummarySig = '';
      mergedSummaryMap = null;
      indexedSummarySig = '';
      indexedSummaryMap = null;
      annotationCache.clear();
      subagentMetaCache.clear();
      swarmMetaCache.clear();
      positivePathCache.clear();
      negativePathCache.clear();
      projectsFileCache.clear();
      projectsCatalogLastCheckMs = 0;
      projectsCatalogSig = 'none';
      automationsLastCheckMs = 0;
      automationsCatalogSig = 'none';
      automationsCached = [];
      dirtyConvIds.clear();
    },
  };
}
