/**
 * Automated unit & SQLite integration tests for the monowatch telemetry engine.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  cleanTurnPrompt,
  createPricingRegistry,
  createTelemetryEngine,
  detectCanaryRouting,
  detectSystemInjection101,
  parseErrorStepSlice,
  parseImageGenStepSlice,
  parseParentRefProto,
  parseToolFailureSlice,
  resolveOrchestratorPhase,
} from '../telemetry.mjs';
import { compareSemver, extractTarEntries, parseRepoSlug, summarizeReleaseNotes } from '../updater.mjs';

function encodeVarint(val) {
  const bytes = [];
  let v = Number(val) >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return bytes;
}

function pbVarint(fn, val) {
  return [...encodeVarint((fn << 3) | 0), ...encodeVarint(val)];
}

function pbBytes(fn, buf) {
  const b = buf instanceof Uint8Array ? buf : Buffer.from(String(buf), 'utf8');
  return [...encodeVarint((fn << 3) | 2), ...encodeVarint(b.length), ...b];
}

function buildStepMetadataBlob({
  t1 = 1_794_800_000,
  t6 = 1_794_800_002,
  t7 = 1_794_800_006,
  requestedEnum = 1528,
  modelEnum = 1528,
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  apiProvider = 24,
  thinkingTokens = 0,
  responseTokens = 0,
} = {}) {
  const ts1 = pbVarint(1, t1);
  const ts6 = pbVarint(1, t6);
  const ts7 = pbVarint(1, t7);
  const usage = [
    ...pbVarint(1, modelEnum),
    ...pbVarint(2, inputTokens),
    ...pbVarint(3, outputTokens),
    ...pbVarint(5, cacheReadTokens),
    ...pbVarint(6, apiProvider),
    ...(thinkingTokens > 0 ? pbVarint(9, thinkingTokens) : []),
    ...(responseTokens > 0 ? pbVarint(10, responseTokens) : []),
  ];
  return Buffer.from([
    ...pbBytes(1, Uint8Array.from(ts1)),
    ...pbBytes(6, Uint8Array.from(ts6)),
    ...pbBytes(7, Uint8Array.from(ts7)),
    ...pbBytes(9, Uint8Array.from(usage)),
    ...pbVarint(11, requestedEnum),
  ]);
}

function buildUserPayloadBlob(text) {
  const inner = pbBytes(2, Buffer.from(text, 'utf8'));
  return Buffer.from(pbBytes(19, Uint8Array.from(inner)));
}

function buildSystemPayloadBlob(text) {
  const inner = pbBytes(1, Buffer.from(text, 'utf8'));
  return Buffer.from(pbBytes(114, Uint8Array.from(inner)));
}

test('Canary routing calibration separates A/B cohorts, tiered subagent defaults, and Orchestrator handoffs', () => {
  const exp = detectCanaryRouting({
    rawSlug: 'gemini-4-hydrogen-exp-a',
    desiredSlug: 'gemini-4-hydrogen-high',
    requestedEnum: 1525,
    respondedEnum: 1525,
  });
  assert.equal(exp.isCanaryRouted, true);
  assert.equal(exp.canaryReason, 'exp_cohort');

  const tieredDefault = detectCanaryRouting({
    rawSlug: 'gemini-3.8-flash-tiered',
    desiredSlug: 'gemini-3.8-flash-tiered',
    requestedEnum: 1320,
    respondedEnum: 1320,
  });
  assert.equal(tieredDefault.isCanaryRouted, false);

  const orchHandoff = detectCanaryRouting({
    rawSlug: 'gemini-flash-worker-agy',
    desiredSlug: 'gemini-pro-orchestrator',
    requestedEnum: 1667,
    respondedEnum: 1669,
    sessionIsOrchestrator: true,
  });
  assert.equal(orchHandoff.isCanaryRouted, false);

  const nonCanaryHyphenLetter = detectCanaryRouting({
    rawSlug: 'custom-model-x',
    desiredSlug: 'custom-model-x',
    requestedEnum: 1900,
    respondedEnum: 1900,
  });
  assert.equal(nonCanaryHyphenLetter.isCanaryRouted, false);

  const abBucket = detectCanaryRouting({
    rawSlug: 'gemini-4-argon-b',
    desiredSlug: 'gemini-4-argon-high',
    requestedEnum: 1417,
    respondedEnum: 1417,
  });
  assert.equal(abBucket.isCanaryRouted, true);
  assert.equal(abBucket.canaryTag, 'b');

  const extraHighTier = detectCanaryRouting({
    rawSlug: 'gemini-4-hydrogen-extra-high',
    desiredSlug: 'gemini-4-hydrogen-xhigh',
    requestedEnum: 1528,
    respondedEnum: 1528,
  });
  assert.equal(extraHighTier.isCanaryRouted, false);
});

test('Orchestrator two-phase resolver classifies Plan, Execute, and Review transitions', () => {
  assert.equal(
    resolveOrchestratorPhase({
      sessionIsOrchestrator: true,
      stepSlug: 'gemini-pro-orchestrator',
      stepEnumId: 1667,
      afterPlanReview: false,
    }),
    'plan'
  );
  assert.equal(
    resolveOrchestratorPhase({
      sessionIsOrchestrator: true,
      stepSlug: 'gemini-flash-worker-agy',
      stepEnumId: 1669,
      afterPlanReview: false,
    }),
    'execute'
  );
  assert.equal(
    resolveOrchestratorPhase({
      sessionIsOrchestrator: true,
      stepSlug: 'gemini-pro-orchestrator',
      stepEnumId: 1667,
      afterPlanReview: true,
    }),
    'review'
  );
});

test('Pricing registry disambiguates Claude Sonnet/Opus, resolves M669, honors over200k & effectiveFrom schedules', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'monowatch-price-'));
  try {
    const overridePath = join(tempRoot, 'pricing_override.json');
    writeFileSync(
      overridePath,
      JSON.stringify({
        models: {
          'gemini-4-carbon-high': {
            inputRate: 2.0,
            cacheRate: 0.1,
            outputRate: 10.0,
            over200k: {
              thresholdTokens: 200_000,
              inputRate: 4.0,
              cacheRate: 0.2,
              outputRate: 15.0,
            },
            schedule: [
              {
                effectiveFrom: '2026-12-01T00:00:00Z',
                inputRate: 1.5,
                cacheRate: 0.075,
                outputRate: 7.5,
              },
            ],
          },
        },
      }),
      'utf-8'
    );

    const registry = createPricingRegistry({ pricingOverridePath: overridePath });
    assert.equal(registry.refreshIfNeeded(), true);

    const sonnet = registry.resolveModelBySlugOrText('claude-sonnet-5-5-high', 0);
    assert.equal(sonnet.slug, 'claude-sonnet-5-5-high');
    assert.equal(sonnet.inputRate, 2.0);

    const opus = registry.resolveModelBySlugOrText('claude-opus-5-5-high', 0);
    assert.equal(opus.slug, 'claude-opus-5-5-high');
    assert.equal(opus.inputRate, 4.0);
    const opusLongCtx = registry.resolveStepRates(opus, 0, 320_000);
    assert.equal(opusLongCtx.inputRate, 4.0);

    const gptOss = registry.resolveModelBySlugOrText('gpt-oss-120b-maas', 342);
    assert.equal(gptOss.inputRate, 0.09);
    assert.equal(gptOss.outputRate, 0.36);

    const argonBuiltIn = registry.slugCatalog.get('gemini-4-argon-high');
    assert.equal(registry.resolveStepRates(argonBuiltIn, 0, 250_000).inputRate, 4.0);

    const worker = registry.resolveModelBySlugOrText('gemini-flash-worker-agy', 1669);
    assert.equal(worker.slug, 'gemini-flash-worker-agy');
    assert.equal(worker.inputRate, 1.5);

    const neonMed = registry.resolveModelBySlugOrText('gemini-4-neon', 1533);
    assert.equal(neonMed.slug, 'gemini-4-neon-medium');
    assert.equal(neonMed.shortName, 'Neon');
    assert.equal(neonMed.inputRate, 3.0);
    assert.equal(neonMed.cacheRate, 0.15);
    assert.equal(neonMed.outputRate, 15.0);
    assert.equal(registry.resolveStepRates(neonMed, 0, 250_000).inputRate, 3.0);

    const neonOrch = registry.resolveModelBySlugOrText('gemini-pro-orchestrator-neon', 0);
    assert.equal(neonOrch.slug, 'gemini-pro-orchestrator-neon');
    assert.equal(neonOrch.fullName, 'Gemini 4 Neon (Orchestrator)');

    const carbon = registry.slugCatalog.get('gemini-4-carbon-high');
    const novNormal = registry.resolveStepRates(
      carbon,
      Date.parse('2026-11-10T00:00:00Z') / 1000,
      100_000
    );
    assert.equal(novNormal.inputRate, 2.0);

    const novLongCtx = registry.resolveStepRates(
      carbon,
      Date.parse('2026-11-10T00:00:00Z') / 1000,
      250_000
    );
    assert.equal(novLongCtx.inputRate, 4.0);

    const decScheduled = registry.resolveStepRates(
      carbon,
      Date.parse('2026-12-02T00:00:00Z') / 1000,
      100_000
    );
    assert.equal(decScheduled.inputRate, 1.5);

    const imgLiteRate = registry.resolveImageStepRate('gemini-3.1-flash-lite-image', 0);
    assert.equal(imgLiteRate.perImageUsd, 0.034);

    const imgRate = registry.resolveImageStepRate('gemini-3.1-flash-image', 0);
    assert.equal(imgRate.perImageUsd, 0.067);
  } finally {
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test('Proto slice extractors handle generate_image wire boundaries, errors, and /btw parent_references', () => {
  const imgBuf = Buffer.from(
    '\x12gemini-3.1-flash-imageB\x18file:///tmp/out_01.png\x00',
    'latin1'
  );
  const parsedImg = parseImageGenStepSlice(imgBuf);
  assert.equal(parsedImg.modelSlug, 'gemini-3.1-flash-image');
  assert.equal(parsedImg.hasOutputFile, true);

  const imgLiteBuf = Buffer.from(
    '\x12gemini-3.1-flash-lite-imageB\x18file:///tmp/out_02.png\x00',
    'latin1'
  );
  const parsedImgLite = parseImageGenStepSlice(imgLiteBuf);
  assert.equal(parsedImgLite.modelSlug, 'gemini-3.1-flash-lite-image');
  assert.equal(parsedImgLite.hasOutputFile, true);

  const errBuf = Buffer.from(
    '\x12$API error: RESOURCE_EXHAUSTED (429) Quota exceeded\x00',
    'utf8'
  );
  const parsedErr = parseErrorStepSlice(errBuf);
  assert.equal(parsedErr.isQuotaError, true);
  assert.match(parsedErr.message, /RESOURCE_EXHAUSTED/);

  const parentConv = '11111111-1111-4111-8111-111111111111';
  const parentTraj = '33333333-3333-4333-8333-333333333333';
  const prBuf = Buffer.from([
    ...pbBytes(1, parentTraj),
    ...pbVarint(2, 29),
    ...pbVarint(5, 2),
    ...pbBytes(6, parentConv),
  ]);
  const parsedRef = parseParentRefProto(prBuf);
  assert.equal(parsedRef.parentConversationId, parentConv);
  assert.equal(parsedRef.parentTrajectoryId, parentTraj);
  assert.equal(parsedRef.parentStepIndex, 29);
  assert.equal(parsedRef.refType, 2);

  const markerPrompt = cleanTurnPrompt(
    'Above is the conversation history from the parent conversation; what follows is a side question (/btw) branched from that conversation.',
    { isSystem: true }
  );
  assert.equal(markerPrompt.kindHint, 'btw_marker');
});

test('End-to-end /btw trajectory (trajectory_type=22) isolates post-branch steps without double-counting parent usage', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'monowatch-e2e-btw-'));
  const appData = join(tempRoot, 'antigravity');
  const convDir = join(appData, 'conversations');
  mkdirSync(convDir, { recursive: true });

  const parentId = '11111111-1111-4111-8111-111111111111';
  const btwId = '22222222-2222-4222-8222-222222222222';
  const parentTrajId = '33333333-3333-4333-8333-333333333333';

  let engine = null;
  try {
    const sumDb = new DatabaseSync(join(appData, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        step_count INTEGER,
        last_modified_time TEXT,
        workspace_uris TEXT,
        status TEXT,
        source TEXT,
        project_id TEXT,
        app_data_dir TEXT,
        agent_name TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER,
        not_fully_idle INTEGER,
        killed INTEGER,
        battle_id TEXT,
        winning_conversation_id TEXT,
        group_id TEXT,
        last_user_input_time TEXT,
        last_user_input_step_index INTEGER
      );
    `);
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, source, project_id, app_data_dir,
          agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parentId,
        '主任务会话',
        '帮我分析架构',
        2,
        '2026-11-15T10:00:00Z',
        '[]',
        'CASCADE_RUN_STATUS_IDLE',
        'CORTEX_TRAJECTORY_SOURCE_CASCADE',
        '',
        'antigravity',
        '',
        '',
        0,
        0,
        0
      );
    sumDb.close();

    // Create parent conversation DB (steps 0..1)
    const pDb = new DatabaseSync(join(convDir, `${parentId}.db`));
    pDb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, trajectory_type INTEGER);
      CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    `);
    pDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run(parentTrajId, 4);
    const parentStep1Meta = buildStepMetadataBlob({
      t1: 1_794_736_790,
      t6: 1_794_736_792,
      t7: 1_794_736_795,
      requestedEnum: 1528,
      modelEnum: 1528,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
    });
    pDb
      .prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)')
      .run(0, 14, 3, buildStepMetadataBlob({ t1: 1_794_736_780, t6: 0, t7: 0 }), buildUserPayloadBlob('帮我分析架构'));
    pDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(1, 15, 3, parentStep1Meta, Buffer.alloc(0));
    pDb.close();

    // Create unindexed `/btw` DB (`trajectory_type = 22`) containing cloned parent steps 0..1 + post-branch steps 2..4
    const bDb = new DatabaseSync(join(convDir, `${btwId}.db`));
    bDb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, trajectory_type INTEGER);
      CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    `);
    bDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('44444444-4444-4444-8444-444444444444', 22);
    bDb
      .prepare('INSERT INTO parent_references VALUES (?, ?)')
      .run(
        0,
        Buffer.from([
          ...pbBytes(1, parentTrajId),
          ...pbVarint(2, 1),
          ...pbVarint(5, 2),
          ...pbBytes(6, parentId),
        ])
      );
    // Cloned parent steps 0..1 (must NOT be counted toward `/btw` cost/tokens!)
    bDb
      .prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)')
      .run(0, 14, 3, buildStepMetadataBlob({ t1: 1_794_736_780, t6: 0, t7: 0 }), buildUserPayloadBlob('帮我分析架构'));
    bDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(1, 15, 3, parentStep1Meta, Buffer.alloc(0));
    // `/btw` marker + side question + single post-branch planner step
    bDb
      .prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)')
      .run(
        2,
        101,
        3,
        buildStepMetadataBlob({ t1: 1_794_736_900, t6: 0, t7: 0 }),
        buildSystemPayloadBlob(
          'Above is the conversation history from the parent conversation; what follows is a side question (/btw) branched from that conversation.'
        )
      );
    bDb
      .prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)')
      .run(
        3,
        14,
        3,
        buildStepMetadataBlob({ t1: 1_794_736_905, t6: 0, t7: 0 }),
        buildUserPayloadBlob('这个 /btw 支线是怎么计费的？')
      );
    // Gemini 4 Hydrogen XHigh (`1528`, $1.50/1M in, $0.075/1M cache, $7.50/1M out):
    // 100k in ($0.15) + 200k cache ($0.015) + 10k out ($0.075) = $0.24
    bDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      4,
      15,
      3,
      buildStepMetadataBlob({
        t1: 1_794_736_906,
        t6: 1_794_736_908,
        t7: 1_794_736_914,
        requestedEnum: 1528,
        modelEnum: 1528,
        inputTokens: 100_000,
        cacheReadTokens: 200_000,
        outputTokens: 10_000,
      }),
      Buffer.alloc(0)
    );
    bDb.close();

    engine = createTelemetryEngine({ appDataDirs: [appData], includeSiblingSurfaces: false });
    const snap = engine.getSnapshot();
    assert.equal(snap.threads.length, 1);

    const parentNode = snap.threads[0];
    assert.equal(parentNode.id, parentId);
    assert.equal(parentNode.children.length, 1);

    const btwNode = parentNode.children[0];
    assert.equal(btwNode.id, btwId);
    assert.equal(btwNode.kind, 'btw');
    assert.equal(btwNode.roleLabel, '/btw');
    assert.equal(btwNode.btwBranchStepIndex, 1);
    assert.equal(btwNode.title, '这个 /btw 支线是怎么计费的？');

    // Strictly post-branch step 4 only (no cloned parent 1M in / 100k out)
    assert.equal(btwNode.tokens.input, 100_000);
    assert.equal(btwNode.tokens.cacheRead, 200_000);
    assert.equal(btwNode.tokens.output, 10_000);
    assert.equal(btwNode.cost.selfUsd, 0.24);
    assert.equal(btwNode.stepCount, 3);

    // Parent tree rollup includes `/btw` cost cleanly
    assert.equal(parentNode.cost.childrenUsd, 0.24);
    assert.equal(
      Math.round((parentNode.cost.treeUsd - parentNode.cost.selfUsd) * 1e6) / 1e6,
      0.24
    );

    const detail = engine.getThreadDetail(btwId);
    assert.ok(detail);
    assert.equal(detail.turns.length, 1);
    assert.equal(detail.turns[0].stepStartIndex, 3);
    assert.equal(detail.turns[0].costUsd, 0.24);
    assert.equal(detail.turns[0].preview, '这个 /btw 支线是怎么计费的？');
  } finally {
    engine?.close();
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test('Fast cold-start helpers resolve metadata lite, cold detail fast-path, and ETag unchanged short-circuit', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'monowatch-fastcold-'));
  const appData = join(tempRoot, 'antigravity');
  const convDir = join(appData, 'conversations');
  mkdirSync(convDir, { recursive: true });

  const parentId = '55555555-5555-4555-8555-555555555555';
  const btwId = '66666666-6666-4666-8666-666666666666';
  const expectedProjectId = '77777777-7777-4777-8777-777777777777';

  let engine = null;
  try {
    const sumDb = new DatabaseSync(join(appData, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        step_count INTEGER,
        last_modified_time TEXT,
        workspace_uris TEXT,
        status TEXT,
        source TEXT,
        project_id TEXT,
        app_data_dir TEXT,
        agent_name TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER,
        not_fully_idle INTEGER,
        killed INTEGER
      );
    `);
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, source, project_id, app_data_dir,
          agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parentId,
        '冷启动快速路径',
        '检查详情秒开',
        2,
        '2026-11-16T06:00:00Z',
        '["file:///c:/workspace/demo"]',
        'CASCADE_RUN_STATUS_IDLE',
        'CORTEX_TRAJECTORY_SOURCE_CASCADE',
        expectedProjectId,
        'antigravity',
        '',
        '',
        0,
        0,
        0
      );
    sumDb.close();

    const pDb = new DatabaseSync(join(convDir, `${parentId}.db`));
    pDb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, trajectory_type INTEGER);
      CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    `);
    pDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('88888888-8888-4888-8888-888888888888', 4);
    pDb
      .prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)')
      .run(0, 14, 3, buildStepMetadataBlob({ t1: 1_794_808_000, t6: 0, t7: 0 }), buildUserPayloadBlob('检查详情秒开'));
    pDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      1,
      15,
      3,
      buildStepMetadataBlob({
        t1: 1_794_808_001,
        t6: 1_794_808_002,
        t7: 1_794_808_004,
        requestedEnum: 1528,
        modelEnum: 1528,
        inputTokens: 50_000,
        outputTokens: 5_000,
        cacheReadTokens: 0,
      }),
      Buffer.alloc(0)
    );
    pDb.close();

    // Unindexed trajectory DB on disk that `fastCold: true` should skip scanning
    const bDb = new DatabaseSync(join(convDir, `${btwId}.db`));
    bDb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, trajectory_type INTEGER);
      CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    `);
    bDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('99999999-9999-4999-8999-999999999999', 22);
    bDb
      .prepare('INSERT INTO parent_references VALUES (?, ?)')
      .run(
        0,
        Buffer.from([
          ...pbBytes(1, '88888888-8888-4888-8888-888888888888'),
          ...pbVarint(2, 1),
          ...pbVarint(5, 2),
          ...pbBytes(6, parentId),
        ])
      );
    bDb.close();

    engine = createTelemetryEngine({ appDataDirs: [appData], includeSiblingSurfaces: false });

    const lite = engine.getConversationMetadataLite(parentId);
    assert.equal(lite.projectId, expectedProjectId);
    assert.equal(lite.rootConversationId, parentId);
    assert.equal(lite.nestingDepth, 0);
    assert.deepEqual(lite.workspaceUris, ['file:///c:/workspace/demo']);

    const invalidLite = engine.getConversationMetadataLite('not-a-uuid');
    assert.equal(invalidLite.projectId, '');

    const fastDetail = engine.getThreadDetail(parentId, { isHostSession: true, fastCold: true });
    assert.ok(fastDetail);
    assert.equal(fastDetail.thread.id, parentId);
    assert.equal(fastDetail.turns.length, 1);
    // Skipped unindexed `/btw` DB on cold detail path
    assert.equal(fastDetail.thread.children.length, 0);

    const snap = engine.getSnapshot();
    assert.equal(snap.threads.length, 1);
    assert.equal(snap.threads[0].children.length, 1);

    const unchanged = engine.getSnapshot({ etag: snap.rev });
    assert.deepEqual(unchanged, { unchanged: true, rev: snap.rev });
  } finally {
    engine?.close();
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test('Error/moderation/injection/tool-failure extractors handle safety retries, server injections, tool failures, and legacy IDE false positives', () => {
  const safetyBuf = Buffer.from(
    '\x12$Your previous response was blocked by content safety filters. Retries remaining: 32(391ce60c-1802-49e3-8320-98ce882599c9-969',
    'utf8'
  );
  const safety = parseErrorStepSlice(safetyBuf);
  assert.equal(safety.ignored, false);
  assert.equal(safety.category, 'safety_filter');
  assert.equal(safety.retriesRemaining, 3);
  assert.equal(safety.isQuotaError, false);

  const quota = parseErrorStepSlice(
    Buffer.from('\x12$API error: RESOURCE_EXHAUSTED (429) Quota exceeded\x00', 'utf8')
  );
  assert.equal(quota.ignored, false);
  assert.equal(quota.category, 'quota_429');
  assert.equal(quota.isQuotaError, true);

  const spendCap = parseErrorStepSlice(
    Buffer.from(
      '\x12$API error: billing account spend cap reached or AI credits balance depleted\x00',
      'utf8'
    )
  );
  assert.equal(spendCap.ignored, false);
  assert.equal(spendCap.category, 'quota_429');
  assert.equal(spendCap.isQuotaError, true);

  const modelUnavail = parseErrorStepSlice(
    Buffer.from('\x12$Model unavailable (attempt 2/10), retrying in 12s\x00', 'utf8')
  );
  assert.equal(modelUnavail.ignored, false);
  assert.equal(modelUnavail.category, 'upstream_retry');
  assert.equal(modelUnavail.attempt, 2);

  const inj = parseErrorStepSlice(
    Buffer.from(
      '\x12$Guidance: You are trying to correct an earlier malformed call generated by the model.\x00',
      'utf8'
    )
  );
  assert.equal(inj.ignored, false);
  assert.equal(inj.category, 'server_injection');

  const contInj = parseErrorStepSlice(
    Buffer.from(
      '\x12$The stream was interrupted. Please continue the task you were working on.\x00',
      'utf8'
    )
  );
  assert.equal(contInj.ignored, false);
  assert.equal(contInj.category, 'server_injection');

  const retry = parseErrorStepSlice(
    Buffer.from('\x12$API error (attempt 2): stream idle timeout\x00', 'utf8')
  );
  assert.equal(retry.ignored, false);
  assert.equal(retry.category, 'upstream_retry');
  assert.equal(retry.attempt, 2);

  const legacy = parseErrorStepSlice(
    Buffer.from(
      '\x12\x0dwrite_to_file\x1a\x30{"AbsolutePath":"/tmp/a.md","CodeContent":"hi"}',
      'utf8'
    )
  );
  assert.equal(legacy.ignored, true);
  assert.equal(legacy.category, '');

  const rejectedTool = parseToolFailureSlice(
    Buffer.from('\x12\x1bcall_abc123 run_command\x1a\x08rejected', 'utf8'),
    6
  );
  assert.equal(rejectedTool.category, 'tool_error');
  assert.equal(rejectedTool.toolName, 'run_command');
  assert.equal(rejectedTool.isRejected, true);

  const failedTool = parseToolFailureSlice(
    Buffer.from('\x12\x18call_abc123 run_command\x1a\x05error', 'utf8'),
    7
  );
  assert.equal(failedTool.category, 'tool_error');
  assert.equal(failedTool.toolName, 'run_command');
  assert.equal(failedTool.isRejected, false);

  const notice101 = detectSystemInjection101(
    buildSystemPayloadBlob(
      '[Notice] All your subagents and background tasks have been stopped due to server restart.'
    )
  );
  assert.ok(notice101);
  assert.equal(notice101.category, 'server_injection');

  const normal101 = detectSystemInjection101(
    buildSystemPayloadBlob(
      'Above is the conversation history from the parent conversation; what follows is a side question (/btw) branched from that conversation.'
    )
  );
  assert.equal(normal101, null);
});

test('End-to-end issue forensics attribute discarded safety-filter planner cost without double-counting selfUsd or turnsSum', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'monowatch-e2e-issues-'));
  const appData = join(tempRoot, 'antigravity');
  const convDir = join(appData, 'conversations');
  mkdirSync(convDir, { recursive: true });

  const convId = '77777777-7777-4777-8777-777777777777';
  const trajId = '88888888-8888-4888-8888-888888888888';
  let engine = null;

  try {
    const sumDb = new DatabaseSync(join(appData, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        step_count INTEGER,
        last_modified_time TEXT,
        workspace_uris TEXT,
        status TEXT,
        source TEXT,
        project_id TEXT,
        app_data_dir TEXT,
        agent_name TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER,
        not_fully_idle INTEGER,
        killed INTEGER
      );
    `);
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, source, project_id, app_data_dir,
          agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        convId,
        '异常测试会话',
        '生成测试内容',
        6,
        '2026-11-16T08:00:00Z',
        '[]',
        'CASCADE_RUN_STATUS_IDLE',
        'CORTEX_TRAJECTORY_SOURCE_CASCADE',
        '',
        'antigravity',
        '',
        '',
        0,
        0,
        0
      );
    sumDb.close();

    const db = new DatabaseSync(join(convDir, `${convId}.db`));
    db.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, trajectory_type INTEGER);
      CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run(trajId, 4);

    // Step 0: user prompt
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      0,
      14,
      3,
      buildStepMetadataBlob({ t1: 1_794_800_000, t6: 0, t7: 0 }),
      buildUserPayloadBlob('生成测试内容')
    );

    // Step 1: planner step ($0.24) discarded by safety filter
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      1,
      15,
      3,
      buildStepMetadataBlob({
        t1: 1_794_800_001,
        t6: 1_794_800_003,
        t7: 1_794_800_006,
        requestedEnum: 1528,
        modelEnum: 1528,
        inputTokens: 100_000,
        cacheReadTokens: 200_000,
        outputTokens: 10_000,
      }),
      Buffer.alloc(0)
    );

    // Step 2: safety_filter interception
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      2,
      17,
      3,
      buildStepMetadataBlob({ t1: 1_794_800_007, t6: 0, t7: 1_794_800_007 }),
      Buffer.from(
        '\x12$Your previous response was blocked by content safety filters. Retries remaining: 32(391ce60c-1802-49e3-8320-98ce882599c9-969',
        'utf8'
      )
    );

    // Step 3: rewritten planner step ($0.24)
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      3,
      15,
      3,
      buildStepMetadataBlob({
        t1: 1_794_800_008,
        t6: 1_794_800_010,
        t7: 1_794_800_014,
        requestedEnum: 1528,
        modelEnum: 1528,
        inputTokens: 100_000,
        cacheReadTokens: 200_000,
        outputTokens: 10_000,
      }),
      Buffer.alloc(0)
    );

    // Step 4: failed tool call (step_type = 132, status = 7)
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      4,
      132,
      7,
      buildStepMetadataBlob({ t1: 1_794_800_015, t6: 0, t7: 1_794_800_016 }),
      Buffer.from('\x12\x1ecall_abc123 run_command\x1a\x05error', 'utf8')
    );

    // Step 5: legacy IDE step_type=17 false positive (must be ignored)
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      5,
      17,
      3,
      buildStepMetadataBlob({ t1: 1_794_800_017, t6: 0, t7: 1_794_800_017 }),
      Buffer.from(
        '\x12\x0dwrite_to_file\x1a\x30{"AbsolutePath":"/tmp/a.md","CodeContent":"hi"}',
        'utf8'
      )
    );
    db.close();

    engine = createTelemetryEngine({ appDataDirs: [appData], includeSiblingSurfaces: false });
    const snap = engine.getSnapshot();
    assert.equal(snap.threads.length, 1);

    const node = snap.threads[0];
    assert.equal(node.cost.selfUsd, 0.48);
    assert.equal(node.issues.total, 2);
    assert.equal(node.issues.wastedUsd, 0.24);
    assert.equal(node.issues.counts.safety_filter, 1);
    assert.equal(node.issues.counts.tool_error, 1);

    assert.equal(snap.issuesSummary.totalCount, 2);
    assert.equal(snap.issuesSummary.wastedUsd, 0.24);
    assert.equal(snap.issuesSummary.counts.safety_filter, 1);
    assert.equal(snap.issuesSummary.counts.tool_error, 1);

    const detail = engine.getThreadDetail(convId);
    assert.ok(detail);
    assert.equal(detail.turns.length, 1);
    assert.equal(detail.turns[0].costUsd, 0.48);
    assert.equal(detail.turns[0].incidents.length, 2);
    assert.equal(detail.turns[0].llmStepCount, 2);

    const incidentSteps = detail.turns[0].steps.filter((s) => s.kind === 'incident');
    assert.equal(incidentSteps.length, 2);

    const step1 = detail.turns[0].steps.find((s) => s.stepIndex === 1 && s.kind !== 'incident');
    const step3 = detail.turns[0].steps.find((s) => s.stepIndex === 3 && s.kind !== 'incident');
    assert.equal(step1?.wasDiscardedByFilter, true);
    assert.equal(step3?.wasDiscardedByFilter, false);
  } finally {
    engine?.close();
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

function buildTarBlock({ name, typeFlag = '0', content = Buffer.alloc(0), prefix = '' }) {
  const hdr = Buffer.alloc(512, 0);
  hdr.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
  hdr.write('0000644\0', 100, 8, 'ascii');
  hdr.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  hdr[156] = typeFlag.charCodeAt(0);
  hdr.write('ustar\0', 257, 6, 'ascii');
  if (prefix) hdr.write(prefix, 345, Math.min(155, Buffer.byteLength(prefix)), 'utf8');
  const padLen = Math.ceil(content.length / 512) * 512;
  const body = Buffer.alloc(padLen, 0);
  content.copy(body);
  return Buffer.concat([hdr, body]);
}

test('Updater semver comparator, repo slug parser, and USTAR+PAX tar extractor reject unsafe paths', () => {
  assert.equal(compareSemver('1.2.0', '1.1.9'), 1);
  assert.equal(compareSemver('v2.0.0', '2.0.0'), 0);
  assert.equal(compareSemver('2.0.0-rc.1', '2.0.0'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.1'), -1);

  assert.equal(
    parseRepoSlug('https://github.com/riverxorange/agy-monowatch.git'),
    'riverxorange/agy-monowatch'
  );
  assert.equal(
    parseRepoSlug({ type: 'git', url: 'https://github.com/org/repo/' }),
    'org/repo'
  );

  const paxBody = ' path=monowatch-main/sidecars/ui/i18n.js\n';
  const paxRecord = `${Buffer.byteLength(paxBody) + 2}${paxBody}`;
  const tarBuf = Buffer.concat([
    buildTarBlock({
      name: 'pax_global_header',
      typeFlag: 'g',
      content: Buffer.from('52 comment=abcdef\n', 'utf8'),
    }),
    buildTarBlock({
      name: 'monowatch-main/plugin.json',
      content: Buffer.from('{"name":"monowatch"}', 'utf8'),
    }),
    buildTarBlock({
      name: 'PaxHeader/i18n.js',
      typeFlag: 'x',
      content: Buffer.from(paxRecord, 'utf8'),
    }),
    buildTarBlock({
      name: 'truncated',
      content: Buffer.from('export const ok = 1;', 'utf8'),
    }),
    buildTarBlock({
      name: 'monowatch-main/../evil.sh',
      content: Buffer.from('bad', 'utf8'),
    }),
    buildTarBlock({
      name: 'monowatch-main/.git/config',
      content: Buffer.from('bad', 'utf8'),
    }),
    Buffer.alloc(1024, 0),
  ]);

  const entries = extractTarEntries(tarBuf);
  assert.deepEqual(
    entries.map((e) => e.path),
    ['plugin.json', 'sidecars/ui/i18n.js']
  );
  assert.equal(entries[0].data.toString('utf8'), '{"name":"monowatch"}');
  assert.deepEqual(
    summarizeReleaseNotes(
      `## What's New\n\n- Added \`usage_ledger.sqlite\` for **deleted** sessions\n- See [docs](https://example.com) for details\n`
    ),
    ['Added usage_ledger.sqlite for deleted sessions', 'See docs for details']
  );
  assert.deepEqual(summarizeReleaseNotes(''), []);
});

test('End-to-end reverted retry branches from transcript.jsonl are merged into primary cost, tokens, and daily breakdowns', () => {
  const root = mkdtempSync(join(tmpdir(), 'monowatch-revert-'));
  const appData = join(root, 'antigravity');
  const convDir = join(appData, 'conversations');
  const convId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const logsDir = join(appData, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(convDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  let engine = null;
  try {
    const sumDb = new DatabaseSync(join(appData, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT,
        workspace_uris TEXT, status TEXT, source TEXT, project_id TEXT, app_data_dir TEXT,
        agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER,
        not_fully_idle INTEGER, killed INTEGER
      );
    `);
    sumDb
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        convId,
        'Revert Retry Test',
        'Ask again',
        2,
        '2026-11-21T10:05:00.000Z',
        '[]',
        'CASCADE_RUN_STATUS_IDLE',
        'CORTEX_TRAJECTORY_SOURCE_CASCADE',
        '',
        'antigravity',
        '',
        '',
        0,
        0,
        0
      );
    sumDb.close();

    // SQLite only contains the surviving branch after revert (step 1: $0.24 on M528)
    // M528 rates: input $1.50/M, cache $0.075/M, output $7.50/M
    // 100k in ($0.15) + 200k cache ($0.015) + 10k out ($0.075) = $0.24
    const db = new DatabaseSync(join(convDir, `${convId}.db`));
    db.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, trajectory_type INTEGER);
      CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('traj-revert-1', 4);
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      0,
      14,
      3,
      buildStepMetadataBlob({ t1: 1_795_168_800, t6: 0, t7: 0 }),
      buildUserPayloadBlob('Edited prompt')
    );
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      1,
      15,
      3,
      buildStepMetadataBlob({
        t1: 1_795_168_801,
        t6: 1_795_168_802,
        t7: 1_795_168_805,
        requestedEnum: 1528,
        modelEnum: 1528,
        inputTokens: 100_000,
        cacheReadTokens: 200_000,
        outputTokens: 10_000,
      }),
      Buffer.alloc(0)
    );
    db.close();

    // Append-only transcript.jsonl has 2 reverted steps (step 1 & step 3, each $0.24)
    // followed by the new branch step 1 (plus a duplicate flush of the exact same new step 1)
    const lines = [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T10:00:05.000Z',
        input_tokens: 100_000,
        cache_read_tokens: 200_000,
        output_tokens: 10_000,
      }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T10:01:05.000Z',
        input_tokens: 100_000,
        cache_read_tokens: 200_000,
        output_tokens: 10_000,
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T10:02:05.000Z',
        input_tokens: 100_000,
        cache_read_tokens: 200_000,
        output_tokens: 10_000,
      }),
      // Duplicate flush of the exact same surviving step 1 (must NOT be double-counted)
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T10:02:05.000Z',
        input_tokens: 100_000,
        cache_read_tokens: 200_000,
        output_tokens: 10_000,
      }),
    ];
    writeFileSync(join(logsDir, 'transcript.jsonl'), `${lines.join('\n')}\n`, 'utf8');

    engine = createTelemetryEngine({ appDataDirs: [appData], includeSiblingSurfaces: false });
    const snap = engine.getSnapshot();
    assert.equal(snap.threads.length, 1);

    const node = snap.threads[0];
    // Surviving ($0.24) + 2 reverted steps ($0.48) = $0.72
    assert.equal(node.cost.retryBranchStepCount, 2);
    assert.equal(node.cost.retryBranchDeltaUsd, 0.48);
    assert.equal(node.cost.selfUsd, 0.72);
    assert.equal(node.cost.treeUsd, 0.72);
    assert.equal(node.tokens.input, 300_000);
    assert.equal(node.tokens.cacheRead, 600_000);
    assert.equal(node.tokens.output, 30_000);

    // Daily total must also equal $0.72
    const dailyUsd = Object.values(node.cost.daily).reduce((acc, v) => acc + (Number(v?.[0]) || 0), 0);
    assert.ok(Math.abs(dailyUsd - 0.72) < 1e-6);
    assert.equal(node.cost.byModel[0].costUsd, 0.72);

    const sumDaily = (i) =>
      Object.values(node.cost.daily).reduce((acc, v) => acc + (Number(v?.[i]) || 0), 0);
    assert.equal(sumDaily(1), 300_000);
    assert.equal(sumDaily(2), 600_000);
    assert.equal(sumDaily(3), 30_000);
    assert.ok(Math.abs(sumDaily(10) + sumDaily(11) + sumDaily(12) - 0.72) < 1e-6);
    const modelDaily = Object.values(node.cost.dailyModels).flatMap((day) => Object.values(day));
    assert.equal(modelDaily.reduce((acc, v) => acc + v[2], 0), 600_000);
    assert.equal(modelDaily.reduce((acc, v) => acc + v[3], 0), 30_000);
    assert.equal(node.tokens.thinking + node.tokens.response, node.tokens.output);

    const detail = engine.getThreadDetail(convId);
    const turnsSum = detail.turns.reduce((acc, t) => acc + (Number(t.costUsd) || 0), 0);
    assert.ok(Math.abs(turnsSum - (node.cost.selfUsd - node.cost.retryBranchDeltaUsd)) < 1e-6);
  } finally {
    engine?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Exact duplicate re-flush of an earlier transcript step does not evict later live steps as reverted', () => {
  const root = mkdtempSync(join(tmpdir(), 'monowatch-reflush-'));
  const appData = join(root, 'antigravity');
  const convDir = join(appData, 'conversations');
  const convId = 'dddddddd-3333-4333-8333-333333333333';
  const logsDir = join(appData, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(convDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  let engine = null;
  try {
    const sumDb = new DatabaseSync(join(appData, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT,
        workspace_uris TEXT, status TEXT, source TEXT, project_id TEXT, app_data_dir TEXT,
        agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER,
        not_fully_idle INTEGER, killed INTEGER
      );
    `);
    sumDb
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        convId,
        'Duplicate Flush Test',
        'Hello',
        4,
        '2026-11-21T10:05:00.000Z',
        '[]',
        'CASCADE_RUN_STATUS_IDLE',
        'CORTEX_TRAJECTORY_SOURCE_CASCADE',
        '',
        'antigravity',
        '',
        '',
        0,
        0,
        0
      );
    sumDb.close();

    const db = new DatabaseSync(join(convDir, `${convId}.db`));
    db.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, trajectory_type INTEGER);
      CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('traj-reflush-1', 4);
    const insertStep = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)');
    insertStep.run(
      0,
      14,
      3,
      buildStepMetadataBlob({ t1: 1_795_168_800, t6: 0, t7: 0 }),
      buildUserPayloadBlob('Hello')
    );
    for (const [idx, tSec] of [
      [1, 1_795_168_801],
      [3, 1_795_168_861],
    ]) {
      insertStep.run(
        idx,
        15,
        3,
        buildStepMetadataBlob({
          t1: tSec,
          t6: tSec + 1,
          t7: tSec + 4,
          requestedEnum: 1528,
          modelEnum: 1528,
          inputTokens: 100_000,
          cacheReadTokens: 200_000,
          outputTokens: 10_000,
        }),
        Buffer.alloc(0)
      );
    }
    db.close();

    const line = (stepIndex, createdAt) =>
      JSON.stringify({
        step_index: stepIndex,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: createdAt,
        input_tokens: 100_000,
        cache_read_tokens: 200_000,
        output_tokens: 10_000,
      });
    const lines = [
      line(1, '2026-11-21T10:00:05.000Z'),
      line(3, '2026-11-21T10:01:05.000Z'),
      line(1, '2026-11-21T10:00:05.000Z'),
    ];
    writeFileSync(join(logsDir, 'transcript.jsonl'), `${lines.join('\n')}\n`, 'utf8');

    engine = createTelemetryEngine({ appDataDirs: [appData], includeSiblingSurfaces: false });
    const snap = engine.getSnapshot();
    assert.equal(snap.threads.length, 1);

    const node = snap.threads[0];
    assert.equal(node.cost.retryBranchStepCount, 0);
    assert.equal(node.cost.retryBranchDeltaUsd, 0);
    assert.equal(node.cost.selfUsd, 0.48);
    assert.equal(node.tokens.input, 200_000);
    assert.equal(node.tokens.cacheRead, 400_000);
    assert.equal(node.tokens.output, 20_000);
  } finally {
    engine?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('End-to-end local usage ledger preserves deleted conversations across restarts without double-counting live ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'monowatch-ledger-'));
  const appData = join(root, 'antigravity');
  const sidecarData = join(root, 'sidecar_data');
  const convDir = join(appData, 'conversations');
  mkdirSync(convDir, { recursive: true });
  mkdirSync(sidecarData, { recursive: true });

  const convLive = 'bbbbbbbb-1111-4111-8111-111111111111';
  const convDel = 'cccccccc-2222-4222-8222-222222222222';

  const makeConvDb = (id, tSec) => {
    const db = new DatabaseSync(join(convDir, `${id}.db`));
    db.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, trajectory_type INTEGER);
      CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run(`traj-${id}`, 4);
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      0,
      14,
      3,
      buildStepMetadataBlob({ t1: tSec, t6: 0, t7: 0 }),
      buildUserPayloadBlob('Hello')
    );
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      1,
      15,
      3,
      buildStepMetadataBlob({
        t1: tSec + 1,
        t6: tSec + 2,
        t7: tSec + 4,
        requestedEnum: 1528,
        modelEnum: 1528,
        inputTokens: 100_000,
        cacheReadTokens: 200_000,
        outputTokens: 10_000,
      }),
      Buffer.alloc(0)
    );
    db.close();
  };

  let engine1 = null;
  let engine2 = null;
  try {
    const sumDb = new DatabaseSync(join(appData, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT,
        workspace_uris TEXT, status TEXT, source TEXT, project_id TEXT, app_data_dir TEXT,
        agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER,
        not_fully_idle INTEGER, killed INTEGER
      );
    `);
    const ins = sumDb.prepare(
      'INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    ins.run(
      convLive,
      'Live Session',
      'Hello',
      2,
      '2026-11-21T10:10:00.000Z',
      '[]',
      'CASCADE_RUN_STATUS_IDLE',
      'CORTEX_TRAJECTORY_SOURCE_CASCADE',
      '',
      'antigravity',
      '',
      '',
      0,
      0,
      0
    );
    ins.run(
      convDel,
      'Soon Deleted Session',
      'Hello',
      2,
      '2026-11-21T10:05:00.000Z',
      '[]',
      'CASCADE_RUN_STATUS_IDLE',
      'CORTEX_TRAJECTORY_SOURCE_CASCADE',
      '',
      'antigravity',
      '',
      '',
      0,
      0,
      0
    );
    sumDb.close();

    makeConvDb(convLive, 1_795_169_400);
    makeConvDb(convDel, 1_795_169_100);

    engine1 = createTelemetryEngine({
      appDataDirs: [appData],
      sidecarDataDir: sidecarData,
      includeSiblingSurfaces: false,
    });

    const snap1 = engine1.getSnapshot();
    assert.equal(snap1.threads.length, 2);
    assert.equal(snap1.totals.costUsd, 0.48);

    // Simulate Antigravity permanently deleting `convDel`
    const sumDb2 = new DatabaseSync(join(appData, 'conversation_summaries.db'));
    sumDb2.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(convDel);
    sumDb2.close();
    rmSync(join(convDir, `${convDel}.db`), { force: true });

    const archiveReady = new Promise((resolve) => {
      const off = engine1.onArchiveReady(() => {
        off();
        resolve();
      });
    });

    engine1.invalidate();
    engine1.getSnapshot();
    await archiveReady;

    const snap2 = engine1.getSnapshot();
    assert.equal(snap2.threads.length, 1);
    assert.equal(snap2.threads[0].id, convLive);
    assert.equal(snap2.totals.costUsd, 0.24);
    assert.equal(snap2.archive.deletedCount, 1);
    assert.equal(snap2.archive.deletedUsd, 0.24);
    assert.equal(snap2.archive.count, 1);

    const archivedList = engine1.listArchive({ scope: 'all' });
    assert.equal(archivedList.rows.length, 1);
    assert.equal(archivedList.rows[0].id, convDel);
    assert.equal(archivedList.rows[0].isDeleted, true);
    assert.equal(archivedList.rows[0].cost.treeUsd, 0.24);

    // Detail fallback for deleted session
    const delDetail = engine1.getThreadDetail(convDel);
    assert.ok(delDetail);
    assert.equal(delDetail.isDeletedFromLedger, true);
    assert.equal(delDetail.thread.isDeleted, true);
    assert.equal(delDetail.thread.cost.treeUsd, 0.24);

    engine1.close();
    engine1 = null;

    // Restart engine from disk and verify ledger persists without double-counting `convLive`
    engine2 = createTelemetryEngine({
      appDataDirs: [appData],
      sidecarDataDir: sidecarData,
      includeSiblingSurfaces: false,
    });
    const archiveReady2 = new Promise((resolve) => {
      const off = engine2.onArchiveReady(() => {
        off();
        resolve();
      });
    });
    engine2.getSnapshot();
    await archiveReady2;

    const snap3 = engine2.getSnapshot();
    assert.equal(snap3.threads.length, 1);
    assert.equal(snap3.archive.deletedCount, 1);
    assert.equal(snap3.archive.deletedUsd, 0.24);
  } finally {
    engine1?.close();
    engine2?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
