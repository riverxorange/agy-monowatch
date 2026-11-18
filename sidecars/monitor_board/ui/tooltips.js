/**
 * Structured Swiss tooltip builders.
 *
 * Principle: every hover card has ONE clear focal heading (`title` + optional `right`),
 * aligned key-value rows, and returns `''` whenever it would merely repeat what is
 * already visible on screen.
 */

import { state } from './state.js';
import { encodeTip } from './dom.js';
import { isEn, tr } from './i18n.js';
import {
  formatCanaryReason,
  formatDuration,
  formatPhaseLabel,
  formatTokensCompact,
  formatTurnUsd,
  formatUsd,
  resolveThreadSoftLimit,
} from './format.js';
import {
  getModelsBreakdown,
  getSingleStreamNodeTps,
  getThreadTimingMetrics,
  isTurnCanaryRouted,
} from './selectors.js';

const WATERLINE_GROUP_LABELS = new Map([
  ['chat messages', ['对话历史', 'Messages']],
  ['tools', ['内置工具', 'Built-in Tools']],
  ['system prompt', ['系统指令', 'System Prompt']],
  ['skills', ['技能索引', 'Skills']],
  ['rules', ['用户规则', 'Rules']],
  ['user rules', ['用户规则', 'User Rules']],
  ['subagents', ['子代理', 'Subagents']],
  ['mcp tools', ['MCP 工具', 'MCP Tools']],
  ['workflows', ['工作流', 'Workflows']],
  ['memories', ['记忆库', 'Memories']],
  ['artifacts', ['产物文档', 'Artifacts']],
  ['unspecified', ['其他开销', 'Other']],
]);

function formatWaterlineGroupLabel(rawName) {
  const raw = String(rawName ?? '').trim();
  if (!raw) return tr('其他', 'Other');
  const pair = WATERLINE_GROUP_LABELS.get(raw.toLowerCase());
  if (!pair) return raw;
  return isEn() ? pair[1] : pair[0];
}

function extractContextGroups(wl, fb) {
  const rawBreakdown =
    Array.isArray(wl?.breakdown) && wl.breakdown.length > 0
      ? wl.breakdown
      : Array.isArray(fb?.breakdown)
        ? fb.breakdown
        : [];
  return rawBreakdown
    .map((g) => ({
      label: formatWaterlineGroupLabel(g?.name ?? g?.label),
      tokens: Math.round(Number(g?.tokens ?? g?.numTokens ?? 0)),
    }))
    .filter((g) => g.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}

export function buildTurnRoutingTip(turn) {
  const r = turn?.routing || turn?.model || {};
  const rawSlug = r.rawSlug || r.slug || '';
  const reqSlug = r.requestedSlug || r.desiredSlug || '';
  const phases = Array.isArray(r.phases) ? r.phases.map(formatPhaseLabel).filter(Boolean) : [];
  const rows = [];

  if (reqSlug && reqSlug !== rawSlug) {
    rows.push([tr('请求模型', 'Requested'), reqSlug]);
  }
  if (phases.length > 0) {
    rows.push([tr('执行阶段', 'Phases'), phases.join(' / ')]);
  }
  if (isTurnCanaryRouted(turn)) {
    const steps = Array.isArray(turn?.steps) ? turn.steps : [];
    const reason = r.canaryReason || steps.find((s) => s?.canaryReason)?.canaryReason || '';
    rows.push([tr('实验分组', 'Cohort'), formatCanaryReason(reason)]);
  }

  const sections = [];
  if (Array.isArray(r.distinctModels) && r.distinctModels.length > 1) {
    const mRows = [];
    for (const dm of r.distinctModels) {
      if (dm && typeof dm === 'object') {
        const name = dm.fullName || dm.shortName || dm.rawSlug || 'Model';
        mRows.push([name, formatTurnUsd(dm.costUsd)]);
      }
    }
    if (mRows.length > 1) sections.push({ label: tr('本轮模型拆分', 'Models in Turn'), rows: mRows });
  }

  if (!rawSlug && rows.length === 0 && sections.length === 0) return '';
  return encodeTip({
    title: tr('实际路由', 'Routed Model'),
    right: rawSlug || r.fullName || '',
    rows,
    sections,
  });
}

export function buildStepRoutingTip(step) {
  if (!step) return '';
  const rawSlug = step.rawSlug || step.slug || '';
  const reqSlug = step.requestedSlug || step.desiredSlug || '';
  const rows = [];
  if (reqSlug && reqSlug !== rawSlug) rows.push([tr('请求模型', 'Requested'), reqSlug]);
  const phaseLabel = formatPhaseLabel(step.phase);
  if (phaseLabel) rows.push([tr('执行阶段', 'Phase'), phaseLabel]);
  if (step.isCanary || step.isCanaryRouted) {
    rows.push([tr('实验分组', 'Cohort'), formatCanaryReason(step.canaryReason)]);
  }
  if (!rawSlug && rows.length === 0) return '';
  return encodeTip({
    title: tr('实际路由', 'Routed Model'),
    right: rawSlug,
    rows,
  });
}

export function buildCostTip(t) {
  const c = t?.cost || {};
  const total = Number(c.treeUsd ?? c.selfUsd ?? 0);
  if (total <= 0) return '';

  const rows = [];
  if ((c.childrenUsd || 0) > 0) {
    rows.push([tr('主会话', 'Main Conversation'), formatUsd(c.selfUsd)]);
    rows.push([tr('子任务', 'Subtasks'), formatUsd(c.childrenUsd)]);
  }
  const compItems = [
    [tr('模型输出', 'Output'), Number(c.outputUsd || 0), ''],
    [tr('未缓存输入', 'Uncached Input'), Number(c.inputUsd || 0), ''],
    [tr('缓存读取', 'Cache Read'), Number(c.cacheUsd || 0), ''],
  ];
  if ((c.imageUsd || 0) > 0) {
    const imgN = t?.tokens?.generatedImages || 0;
    compItems.push([
      tr('图片生成', 'Images'),
      Number(c.imageUsd),
      imgN > 0 ? tr(`${imgN} 张`, `${imgN} img`) : '',
    ]);
  }
  for (const [label, v, sub] of compItems.filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1])) {
    rows.push([label, formatUsd(v), sub]);
  }

  const sections = [];
  const models = getModelsBreakdown(t);
  if (models.length >= 2) {
    sections.push({
      label: tr('按模型', 'By Model'),
      rows: models.map((m) => [
        m.fullName || m.shortName || m.rawSlug || 'Model',
        formatUsd(m.costUsd),
      ]),
    });
  }

  return encodeTip({
    title: tr('价值构成', 'API Value Breakdown'),
    right: formatUsd(total, true),
    rows,
    sections,
  });
}

/** Compact context breakdown for Overview session rows. */
export function buildWaterlineTip(t, _compactionInfo, fallbackWaterline = null) {
  const wl = t?.waterline || {};
  const current = Math.max(0, Number(wl.currentTokens || 0));
  if (current <= 0) return '';
  const softLimit = resolveThreadSoftLimit(wl, t?.model);
  const cached = Math.max(0, Number(wl.cachedTokens || 0));
  const fresh = Math.max(0, Number(wl.freshTokens ?? Math.max(0, current - cached)));
  const remaining = Math.max(0, softLimit - current);

  const rows = [
    [tr('缓存复用', 'Cached'), formatTokensCompact(cached)],
    [tr('本轮新增', 'Fresh'), formatTokensCompact(fresh)],
    [tr('距自动压缩', 'Until Compact'), formatTokensCompact(remaining)],
  ];

  const groups = extractContextGroups(wl, fallbackWaterline);
  const sections = [];
  if (groups.length > 0) {
    const sum = groups.reduce((a, g) => a + g.tokens, 0) || current || 1;
    sections.push({
      label: tr('模块构成', 'Breakdown'),
      rows: groups.slice(0, 5).map((g) => [
        g.label,
        formatTokensCompact(g.tokens),
        `${Math.round((g.tokens / sum) * 100)}%`,
      ]),
    });
  }

  return encodeTip({
    title: tr('上下文占用', 'Context Window'),
    right: `${formatTokensCompact(current)} / ${formatTokensCompact(softLimit)}`,
    rows,
    sections,
  });
}

/** Module breakdown for Detail context matrix (only shown when host breakdown exists). */
export function buildContextBreakdownTip(t, fallbackWaterline = null) {
  const wl = t?.waterline || {};
  const groups = extractContextGroups(wl, fallbackWaterline);
  if (groups.length === 0) return '';
  const current = Math.max(0, Number(wl.currentTokens || 0));
  const sum = groups.reduce((a, g) => a + g.tokens, 0) || current || 1;
  return encodeTip({
    title: tr('上下文模块构成', 'Context Breakdown'),
    right: formatTokensCompact(current || sum),
    rows: groups.map((g) => [
      g.label,
      formatTokensCompact(g.tokens),
      `${Math.round((g.tokens / sum) * 100)}%`,
    ]),
  });
}

export function buildOutputTip(t) {
  const tok = t?.tokens || {};
  const thinking = Number(tok.thinking || 0);
  const response = Number(tok.response || 0);
  const imgs = Number(tok.treeGeneratedImages || tok.generatedImages || 0);
  if (thinking <= 0 && imgs <= 0) return '';

  const rows = [];
  if (thinking > 0 || response > 0) {
    rows.push([tr('思考推理', 'Thinking'), formatTokensCompact(thinking)]);
    rows.push([tr('回复正文', 'Response'), formatTokensCompact(response)]);
  }
  if (imgs > 0) rows.push([tr('生成图片', 'Images'), tr(`${imgs} 张`, `${imgs} img`)]);

  return encodeTip({
    title: tr('输出构成', 'Output Breakdown'),
    right: formatTokensCompact(tok.output || 0),
    rows,
  });
}

export function buildCacheTip() {
  return '';
}

export function buildTpsTip(t) {
  const tps = t?.tps || {};
  const singleRate = getSingleStreamNodeTps(t);
  const latest = Number(tps.latestDecode || 0);
  if (singleRate <= 0 || latest <= 0 || Math.abs(singleRate - latest) < 3) return '';
  return encodeTip({
    title: tr('生成速度', 'Decode Speed'),
    rows: [
      [tr('近期均值', 'Rolling Avg'), `${Math.round(singleRate)} tok/s`],
      [tr('最近一步', 'Latest Step'), `${Math.round(latest)} tok/s`],
    ],
  });
}

export function buildDurationTip(t, baseClientMs = state.snapshotClientMs) {
  const m = getThreadTimingMetrics(t, baseClientMs);
  if (m.totalSec <= 0 || m.llmSec <= 0) return '';
  const hasKids = Array.isArray(t?.children) && t.children.length > 0;
  const nonLlm = Math.max(0, m.totalSec - m.llmSec);
  if (nonLlm < 1 && !hasKids) return '';

  const rows = [[tr('模型推理', 'Model Inference'), formatDuration(m.llmSec)]];
  if (nonLlm >= 1) rows.push([tr('工具与调度', 'Tools & Orchestration'), formatDuration(nonLlm)]);
  if (hasKids && m.treeLlmSec > m.llmSec + 0.5) {
    rows.push([tr('子任务推理', 'Subtask Inference'), formatDuration(m.treeLlmSec - m.llmSec)]);
  }
  return encodeTip({
    title: tr('耗时构成', 'Duration Breakdown'),
    right: formatDuration(m.totalSec),
    rows,
  });
}

export function buildTtftTip(t) {
  const tm = t?.timing || {};
  const avg = Number(tm.avgTtftSec ?? 0);
  const lat = Number(tm.latestTtftSec ?? t?.tps?.latestTtftSec ?? 0);
  const hasThinking = Number(t?.tokens?.thinking || 0) > 0 || avg >= 5;
  if (avg <= 0 && lat <= 0) return '';
  if (Math.abs(avg - lat) < 0.2 && !hasThinking) return '';

  const rows = [];
  if (avg > 0) rows.push([tr('会话平均', 'Conversation Avg'), `${avg.toFixed(1)}s`]);
  if (lat > 0 && Math.abs(avg - lat) >= 0.2) rows.push([tr('最近一步', 'Latest Step'), `${lat.toFixed(1)}s`]);

  return encodeTip({
    title: tr('首字延迟', 'Time to First Token'),
    rows,
    note: hasThinking
      ? tr('思考型模型包含输出前的思考时间', 'Includes pre-output thinking time on reasoning models')
      : '',
  });
}

export function buildDetailModelTip(t) {
  const models = getModelsBreakdown(t);
  if (models.length < 2 && !t?.model?.modelSwitched) return '';
  const rows = models.map((m) => {
    const tps = Number(m.decodeSec) > 0 ? Number(m.decodeOutTokens || 0) / Number(m.decodeSec) : 0;
    return [
      m.fullName || m.shortName || m.rawSlug || 'Model',
      formatUsd(m.costUsd),
      tps > 0 ? `${Math.round(tps)} tok/s` : '',
    ];
  });
  return encodeTip({
    title: tr('使用过的模型', 'Models Used'),
    rows,
    note: t?.model?.modelSwitched
      ? tr(
          `曾从 ${t.model.switchedFromSlug} 切换至 ${t.model.switchedToSlug}`,
          `Switched from ${t.model.switchedFromSlug} to ${t.model.switchedToSlug}`
        )
      : '',
  });
}

export function buildChildRowTip(ch) {
  if (!ch) return '';
  const tokIn = formatTokensCompact(ch.tokens?.input || 0);
  const tokOut = formatTokensCompact(ch.tokens?.output || 0);
  const tokCache = formatTokensCompact(ch.tokens?.cacheRead || 0);
  return encodeTip({
    title: ch.model?.fullName || ch.model?.shortName || tr('子任务', 'Subtask'),
    right: formatUsd(ch.cost?.treeUsd ?? ch.cost?.selfUsd ?? 0),
    rows: [
      [tr('缓存读取', 'Cache Read'), tokCache],
      [tr('未命中输入', 'Uncached Input'), tokIn],
      [tr('模型输出', 'Output'), tokOut],
    ],
  });
}
