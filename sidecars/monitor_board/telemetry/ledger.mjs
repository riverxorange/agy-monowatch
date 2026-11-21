/**
 * @fileoverview Persistent local usage ledger (`usage_ledger.sqlite`) stored inside
 * the sidecar's private data directory (`<sidecarDataDir>/usage_ledger.sqlite`).
 *
 * Preserves per-root-conversation usage summaries (cost, tokens, daily breakdowns,
 * model breakdowns, and reverted-retry totals) so that conversations deleted from
 * Antigravity remain accounted for in historical totals and daily trends.
 *
 * Strictly uses Node.js built-ins (`node:sqlite`, `node:fs`, `node:path`).
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { round } from './utils.mjs';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_ledger (
  conversation_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'conversation',
  category TEXT NOT NULL DEFAULT 'conversation',
  surface TEXT NOT NULL DEFAULT 'desktop',
  project_id TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  project_key TEXT NOT NULL DEFAULT '',
  workspace_uris_json TEXT NOT NULL DEFAULT '[]',
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  first_seen_at_ms INTEGER NOT NULL DEFAULT 0,
  last_seen_at_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_ms INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  self_usd REAL NOT NULL DEFAULT 0,
  tree_usd REAL NOT NULL DEFAULT 0,
  retry_branch_usd REAL NOT NULL DEFAULT 0,
  retry_branch_steps INTEGER NOT NULL DEFAULT 0,
  saved_cache_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  generated_images INTEGER NOT NULL DEFAULT 0,
  child_count INTEGER NOT NULL DEFAULT 0,
  model_json TEXT NOT NULL DEFAULT '{}',
  by_model_json TEXT NOT NULL DEFAULT '[]',
  waterline_json TEXT NOT NULL DEFAULT '{}',
  daily_json TEXT NOT NULL DEFAULT '{}',
  daily_models_json TEXT NOT NULL DEFAULT '{}',
  issues_counts_json TEXT NOT NULL DEFAULT '{}',
  wasted_usd REAL NOT NULL DEFAULT 0,
  snapshot_sig TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ledger_deleted_updated
  ON conversation_ledger(is_deleted, updated_at_ms DESC);
`;

function safeParseJson(str, fallback) {
  if (!str || typeof str !== 'string') return fallback;
  try {
    const parsed = JSON.parse(str);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function hydrateRow(r) {
  return {
    id: r.conversation_id,
    title: r.title || '',
    kind: r.kind || 'conversation',
    category: r.category || 'conversation',
    surface: r.surface || 'desktop',
    project: r.project_id || r.project_name
      ? { id: r.project_id || r.project_key || '', name: r.project_name || r.project_key || '' }
      : null,
    projectKey: r.project_key || '',
    workspaceUris: safeParseJson(r.workspace_uris_json, []),
    updatedAtMs: Number(r.updated_at_ms) || 0,
    firstSeenAtMs: Number(r.first_seen_at_ms) || 0,
    lastSeenAtMs: Number(r.last_seen_at_ms) || 0,
    deletedAtMs: Number(r.deleted_at_ms) || 0,
    isDeleted: Number(r.is_deleted) === 1,
    selfUsd: Number(r.self_usd) || 0,
    treeUsd: Number(r.tree_usd) || 0,
    retryBranchUsd: Number(r.retry_branch_usd) || 0,
    retryBranchSteps: Number(r.retry_branch_steps) || 0,
    savedCacheUsd: Number(r.saved_cache_usd) || 0,
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    cacheReadTokens: Number(r.cache_read_tokens) || 0,
    generatedImages: Number(r.generated_images) || 0,
    childCount: Number(r.child_count) || 0,
    model: safeParseJson(r.model_json, {}),
    byModel: safeParseJson(r.by_model_json, []),
    waterline: safeParseJson(r.waterline_json, {}),
    daily: safeParseJson(r.daily_json, {}),
    dailyModels: safeParseJson(r.daily_models_json, {}),
    issuesCounts: safeParseJson(r.issues_counts_json, {}),
    wastedUsd: Number(r.wasted_usd) || 0,
    snapshotSig: r.snapshot_sig || '',
  };
}

function createNoopLedger() {
  return {
    enabled: false,
    ledgerPath: '',
    upsertRootNode() {
      return false;
    },
    reconcileActiveIds() {
      return false;
    },
    getDeletedEntries() {
      return [];
    },
    getEntryById() {
      return null;
    },
    getStats() {
      return { totalCount: 0, deletedCount: 0, deletedUsd: 0 };
    },
    getVersion() {
      return 0;
    },
    close() {},
  };
}

export function createUsageLedger({ sidecarDataDir = '', ledgerPath = '' } = {}) {
  const resolvedPath =
    ledgerPath ||
    (sidecarDataDir ? join(sidecarDataDir, 'usage_ledger.sqlite') : '');

  if (!resolvedPath) {
    return createNoopLedger();
  }

  let db = null;
  let stmtUpsert = null;
  let stmtMarkDeleted = null;
  let stmtMarkRestored = null;
  const entries = new Map();
  let version = 0;

  try {
    mkdirSync(dirname(resolvedPath), { recursive: true });
    db = new DatabaseSync(resolvedPath, { timeout: 2500 });
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA_SQL);

    stmtUpsert = db.prepare(`
      INSERT INTO conversation_ledger (
        conversation_id, title, kind, category, surface,
        project_id, project_name, project_key, workspace_uris_json,
        updated_at_ms, first_seen_at_ms, last_seen_at_ms,
        deleted_at_ms, is_deleted,
        self_usd, tree_usd, retry_branch_usd, retry_branch_steps, saved_cache_usd,
        input_tokens, output_tokens, cache_read_tokens, generated_images, child_count,
        model_json, by_model_json, waterline_json,
        daily_json, daily_models_json, issues_counts_json, wasted_usd, snapshot_sig
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        0, 0,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?
      )
      ON CONFLICT(conversation_id) DO UPDATE SET
        title = excluded.title,
        kind = excluded.kind,
        category = excluded.category,
        surface = excluded.surface,
        project_id = excluded.project_id,
        project_name = excluded.project_name,
        project_key = excluded.project_key,
        workspace_uris_json = excluded.workspace_uris_json,
        updated_at_ms = excluded.updated_at_ms,
        last_seen_at_ms = excluded.last_seen_at_ms,
        deleted_at_ms = 0,
        is_deleted = 0,
        self_usd = excluded.self_usd,
        tree_usd = excluded.tree_usd,
        retry_branch_usd = excluded.retry_branch_usd,
        retry_branch_steps = excluded.retry_branch_steps,
        saved_cache_usd = excluded.saved_cache_usd,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        generated_images = excluded.generated_images,
        child_count = excluded.child_count,
        model_json = excluded.model_json,
        by_model_json = excluded.by_model_json,
        waterline_json = excluded.waterline_json,
        daily_json = excluded.daily_json,
        daily_models_json = excluded.daily_models_json,
        issues_counts_json = excluded.issues_counts_json,
        wasted_usd = excluded.wasted_usd,
        snapshot_sig = excluded.snapshot_sig
    `);

    stmtMarkDeleted = db.prepare(`
      UPDATE conversation_ledger
      SET is_deleted = 1, deleted_at_ms = ?
      WHERE conversation_id = ?
    `);

    stmtMarkRestored = db.prepare(`
      UPDATE conversation_ledger
      SET is_deleted = 0, deleted_at_ms = 0, last_seen_at_ms = ?
      WHERE conversation_id = ?
    `);

    const rows = db.prepare('SELECT * FROM conversation_ledger').all();
    for (const r of rows) {
      if (!r?.conversation_id) continue;
      entries.set(r.conversation_id, hydrateRow(r));
    }
  } catch {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    return createNoopLedger();
  }

  function upsertRootNode(node, projectKey = '') {
    if (!db || !node || !node.id) return false;

    const treeUsd = round(Number(node.cost?.treeUsd ?? node.cost?.selfUsd ?? 0), 6);
    const selfUsd = round(Number(node.cost?.selfUsd ?? 0), 6);
    const retryBranchUsd = round(
      Number(node.cost?.treeRetryBranchDeltaUsd ?? node.cost?.retryBranchDeltaUsd ?? 0),
      6
    );
    const retryBranchSteps = Math.max(
      0,
      Math.trunc(Number(node.cost?.treeRetryBranchStepCount ?? node.cost?.retryBranchStepCount ?? 0))
    );
    const savedCacheUsd = round(
      Number(node._internal?.treeSavedCacheUsd ?? node.cost?.savedCacheUsd ?? 0),
      6
    );
    const inputTokens = Math.max(
      0,
      Math.trunc(Number(node.tokens?.treeInput ?? node.tokens?.input ?? 0))
    );
    const outputTokens = Math.max(
      0,
      Math.trunc(Number(node.tokens?.treeOutput ?? node.tokens?.output ?? 0))
    );
    const cacheReadTokens = Math.max(
      0,
      Math.trunc(Number(node.tokens?.treeCacheRead ?? node.tokens?.cacheRead ?? 0))
    );
    const generatedImages = Math.max(
      0,
      Math.trunc(Number(node.tokens?.treeGeneratedImages ?? node.tokens?.generatedImages ?? 0))
    );

    // Skip empty zero-usage sessions so the ledger only preserves meaningful usage.
    if (
      treeUsd <= 0 &&
      inputTokens <= 0 &&
      outputTokens <= 0 &&
      cacheReadTokens <= 0 &&
      generatedImages <= 0
    ) {
      return false;
    }

    const updatedAtMs = Math.max(0, Math.trunc(Number(node.updatedAtMs) || 0));
    const childCount = Array.isArray(node.children)
      ? node.children.length
      : Math.max(0, Math.trunc(Number(node.childCount) || 0));
    const title = String(node.title || '');
    const cat =
      node.category === 'cli' || node.category === 'project'
        ? node.category
        : 'conversation';
    const pKey = String(projectKey || '');
    const sig = [
      updatedAtMs,
      treeUsd,
      selfUsd,
      retryBranchUsd,
      retryBranchSteps,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      generatedImages,
      childCount,
      cat,
      pKey,
      title,
    ].join('|');

    const prev = entries.get(node.id);
    if (prev && !prev.isDeleted && prev.snapshotSig === sig) {
      return false;
    }

    const nowMs = Date.now();
    const firstSeenAtMs = prev?.firstSeenAtMs || nowMs;
    const workspaceUris = Array.isArray(node.workspaceUris)
      ? node.workspaceUris.slice(0, 8)
      : [];
    const modelObj = {
      slug: node.model?.slug || '',
      shortName: node.model?.shortName || '',
      fullName: node.model?.fullName || '',
      rawSlug: node.model?.rawSlug || '',
      provider: node.model?.provider || 'gemini',
      softLimit: Number(node.model?.softLimit) || 0,
      maxWindow: Number(node.model?.maxWindow) || 0,
    };
    const byModel = Array.isArray(node.cost?.treeByModel)
      ? node.cost.treeByModel
      : Array.isArray(node.cost?.byModel)
        ? node.cost.byModel
        : [];
    const waterlineObj = {
      currentTokens: Number(node.waterline?.currentTokens) || 0,
      cachedTokens: Number(node.waterline?.cachedTokens) || 0,
      freshTokens: Number(node.waterline?.freshTokens) || 0,
      softLimit: Number(node.waterline?.softLimit) || 0,
    };
    const daily = node.cost?.treeDaily || node.cost?.daily || {};
    const dailyModels = node.cost?.treeDailyModels || node.cost?.dailyModels || {};
    const issuesCounts = {
      ...(node.issues?.treeCounts || node.issues?.counts || {}),
    };
    const wastedUsd = round(
      Number(node.issues?.treeWastedUsd ?? node.issues?.wastedUsd ?? 0),
      6
    );
    const projectId = node.project?.id || '';
    const projectName = node.project?.name || '';

    try {
      stmtUpsert.run(
        node.id,
        title,
        String(node.kind || 'conversation'),
        cat,
        String(node.surface || 'desktop'),
        projectId,
        projectName,
        pKey,
        JSON.stringify(workspaceUris),
        updatedAtMs,
        firstSeenAtMs,
        nowMs,
        selfUsd,
        treeUsd,
        retryBranchUsd,
        retryBranchSteps,
        savedCacheUsd,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        generatedImages,
        childCount,
        JSON.stringify(modelObj),
        JSON.stringify(byModel),
        JSON.stringify(waterlineObj),
        JSON.stringify(daily),
        JSON.stringify(dailyModels),
        JSON.stringify(issuesCounts),
        wastedUsd,
        sig
      );

      const wasDeleted = Boolean(prev?.isDeleted);
      entries.set(node.id, {
        id: node.id,
        title,
        kind: String(node.kind || 'conversation'),
        category: cat,
        surface: String(node.surface || 'desktop'),
        project: projectId || projectName ? { id: projectId, name: projectName } : null,
        projectKey: pKey,
        workspaceUris,
        updatedAtMs,
        firstSeenAtMs,
        lastSeenAtMs: nowMs,
        deletedAtMs: 0,
        isDeleted: false,
        selfUsd,
        treeUsd,
        retryBranchUsd,
        retryBranchSteps,
        savedCacheUsd,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        generatedImages,
        childCount,
        model: modelObj,
        byModel,
        waterline: waterlineObj,
        daily,
        dailyModels,
        issuesCounts,
        wastedUsd,
        snapshotSig: sig,
      });

      if (wasDeleted) {
        version += 1;
      }
      return true;
    } catch {
      return false;
    }
  }

  function reconcileActiveIds(activeIdSet, { allowMarkDeleted = true, existsOnDiskFn = null } = {}) {
    if (!db || !activeIdSet) return false;
    let changed = false;
    const nowMs = Date.now();

    for (const [id, entry] of entries.entries()) {
      const isPresent = activeIdSet.has(id);
      if (isPresent) {
        if (entry.isDeleted) {
          try {
            stmtMarkRestored.run(nowMs, id);
            entry.isDeleted = false;
            entry.deletedAtMs = 0;
            entry.lastSeenAtMs = nowMs;
            changed = true;
          } catch {
            // ignore
          }
        }
      } else if (allowMarkDeleted && !entry.isDeleted) {
        // Double-check disk presence if provided to prevent false positives on transient index lag.
        if (typeof existsOnDiskFn === 'function') {
          try {
            if (existsOnDiskFn(id)) continue;
          } catch {
            continue;
          }
        }
        try {
          stmtMarkDeleted.run(nowMs, id);
          entry.isDeleted = true;
          entry.deletedAtMs = nowMs;
          changed = true;
        } catch {
          // ignore
        }
      }
    }

    if (changed) {
      version += 1;
    }
    return changed;
  }

  function getDeletedEntries(activeIdSet = null) {
    const out = [];
    for (const entry of entries.values()) {
      if (!entry.isDeleted) continue;
      if (activeIdSet && activeIdSet.has(entry.id)) continue;
      out.push(entry);
    }
    out.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    return out;
  }

  function getEntryById(conversationId) {
    if (!conversationId) return null;
    return entries.get(conversationId) || null;
  }

  function getStats(activeIdSet = null) {
    let deletedCount = 0;
    let deletedUsd = 0;
    for (const entry of entries.values()) {
      if (!entry.isDeleted) continue;
      if (activeIdSet && activeIdSet.has(entry.id)) continue;
      deletedCount += 1;
      deletedUsd += Number(entry.treeUsd) || 0;
    }
    return {
      totalCount: entries.size,
      deletedCount,
      deletedUsd: round(deletedUsd, 6),
    };
  }

  function getVersion() {
    return version;
  }

  function close() {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
      db = null;
    }
  }

  return {
    enabled: true,
    ledgerPath: resolvedPath,
    upsertRootNode,
    reconcileActiveIds,
    getDeletedEntries,
    getEntryById,
    getStats,
    getVersion,
    close,
  };
}
