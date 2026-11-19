/**
 * Formatting helpers, Swiss geometric polka-dot matrix SVG builders,
 * and compacted summary Markdown renderer.
 */

import { state } from './state.js';
import { escapeHtml } from './dom.js';
import { getDotPalette } from './theme.js';
import { tr } from './i18n.js';

export function normalizeUri(uri) {
  if (!uri) return '';
  try {
    return decodeURIComponent(String(uri))
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  } catch {
    return String(uri).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
}

export function formatUsd(val, isHero = false) {
  const n = Number(val) || 0;
  if (n === 0) return '$0.00';
  if (n >= 0.01 || isHero) {
    if (n < 0.01) return `$${n.toFixed(3)}`;
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (n >= 0.001) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

export function formatTurnUsd(val) {
  const n = Number(val) || 0;
  if (n <= 0) return '$0.00';
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(3)}`;
  if (n >= 0.0001) return `$${n.toFixed(4)}`;
  return '<$0.0001';
}

export function formatTurnTime(turn) {
  const raw = turn?.createdAt || turn?.updatedAtMs || 0;
  if (!raw) return '';
  const ms =
    typeof raw === 'number'
      ? raw < 1e11
        ? raw * 1000
        : raw
      : Date.parse(String(raw));
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return `${hh}:${mm}`;
  }
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export function formatDuration(sec, compact = false) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '—';
  if (s < 1) return `${s.toFixed(1)}s`;
  if (s < 60) {
    return compact && s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
  }
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return compact || r === 0 ? `${m}m` : `${m}m ${r}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatTtft(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '—';
  return s < 100 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export function formatTokensCompact(val) {
  const n = Math.max(0, Math.round(Number(val) || 0));
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m >= 10
      ? `${m.toFixed(1).replace(/\.0$/, '')}M`
      : `${m.toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (n >= 100_000) {
    return `${Math.round(n / 1_000)}K`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(n);
}

export function formatTokensDetail(val) {
  const n = Math.max(0, Math.round(Number(val) || 0));
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(n);
}

export function formatEnumCode(enumId) {
  const n = Number(enumId) || 0;
  if (n >= 1000 && n < 10000) return `M${n - 1000}`;
  if (n > 0) return `E${n}`;
  return '';
}

export function formatCanaryReason(reason) {
  switch (reason) {
    case 'ab_cohort':
      return tr('A/B 分桶', 'A/B Cohort');
    case 'exp_cohort':
      return tr('实验分桶', 'Preview Cohort');
    case 'tiered_pool':
    case 'tiered_cohort':
      return tr('分层池路由', 'Tiered Pool');
    case 'enum_override':
      return tr('计费枚举改写', 'Enum Override');
    case 'slug_override':
      return tr('模型代号改写', 'Model Override');
    case 'swarm_model_override':
      return tr('Swarm 模型改写', 'Swarm Override');
    case 'unknown_model':
      return tr('未收录新代号', 'Unlisted Model');
    default:
      return tr('实验分组', 'Cohort');
  }
}

export function formatPhaseLabel(phase) {
  switch (phase) {
    case 'plan':
      return tr('规划', 'Plan');
    case 'execute':
      return tr('执行', 'Execute');
    case 'review':
      return tr('复核', 'Review');
    default:
      return '';
  }
}

/** User-facing names for event categories. */
export function formatIssueCategoryLabel(cat) {
  switch (cat) {
    case 'safety_filter':
      return tr('安全过滤', 'Safety');
    case 'quota_429':
      return tr('限流', 'Quota');
    case 'server_injection':
      return tr('系统消息', 'System');
    case 'upstream_retry':
      return tr('网络重试', 'Retries');
    case 'tool_error':
      return tr('工具报错', 'Tool Error');
    default:
      return tr('异常', 'Error');
  }
}

export function describeIssueCategory(cat) {
  switch (cat) {
    case 'safety_filter':
      return tr(
        '模型回答被安全策略过滤，并替换为提示或拒答',
        'Model output filtered by the safety policy and replaced with a fallback'
      );
    case 'quota_429':
      return tr(
        '触发配额或频率上限（HTTP 429），请求直接中止',
        'Rate limit, spend cap, or quota exhaustion (HTTP 429)'
      );
    case 'server_injection':
      return tr(
        '宿主在对话中插入的系统消息（如纠错提示、续写、服务重启通知）',
        'System messages inserted by the host (e.g. correction hints, stream resume, restart notices)'
      );
    case 'upstream_retry':
      return tr(
        '上游接口断连、超时或 500 报错并触发自动重连',
        'Upstream disconnect, timeout, or 5xx error with auto-retry'
      );
    case 'tool_error':
      return tr(
        'Agent 调用工具失败（正常试错，不计入事件）',
        'Tool call error during normal agent trial-and-error'
      );
    default:
      return '';
  }
}

/** Event categories, from hard stops to retries. */
export const CLOUD_SIGNAL_CATEGORIES = [
  'safety_filter',
  'quota_429',
  'server_injection',
  'upstream_retry',
];

/** Model routing categories. */
export const CANARY_SIGNAL_CATEGORIES = [
  'unknown_model',
  'exp_cohort',
  'ab_cohort',
  'override',
];

export function classifyCanaryCategory(hit) {
  if (!hit) return 'ab_cohort';
  if (hit.isUnknownModel || hit.canaryReason === 'unknown_model') return 'unknown_model';
  if (hit.canaryReason === 'exp_cohort') return 'exp_cohort';
  if (hit.canaryReason === 'ab_cohort') return 'ab_cohort';
  return 'override';
}

export function formatCanaryCategoryLabel(cat) {
  switch (cat) {
    case 'unknown_model':
      return tr('新模型', 'Unlisted');
    case 'exp_cohort':
      return tr('实验组', 'Preview');
    case 'ab_cohort':
      return tr('AB 分桶', 'A/B Split');
    case 'override':
      return tr('模型切换', 'Rerouted');
    default:
      return tr('路由', 'Routing');
  }
}

export function describeCanaryCategory(cat) {
  switch (cat) {
    case 'unknown_model':
      return tr(
        '捕获到尚未收录的全新模型代号或未公开 M* 枚举号',
        'Newly observed model slug or unlisted M* enum identifier'
      );
    case 'exp_cohort':
      return tr(
        '显式带 exp / canary / preview / rc 后缀的候选实验版本',
        'Candidate builds tagged with exp / canary / preview / rc suffixes'
      );
    case 'ab_cohort':
      return tr(
        '同一模型的 A/B 分组（如 -a / -b / -c 后缀）',
        'A/B cohorts of the same model (-a / -b / -c suffixes)'
      );
    case 'override':
      return tr(
        '响应模型与请求模型不一致，或使用了 tiered 资源池',
        'Responded model enum differed from requested model or routed to tiered pool'
      );
    default:
      return '';
  }
}

export function getCanaryBadgeClass(cat) {
  switch (cat) {
    case 'unknown_model':
      return 'is-quota';
    case 'exp_cohort':
      return 'is-inj';
    default:
      return 'is-net';
  }
}

export function cleanCloudEventBody(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s
    .replace(/(?:\n|\s+)\(\d+\)\s*model output error[\s\S]*$/i, '')
    .replace(/(?:\n|\s+)--\s*stack trace:[\s\S]*$/i, '')
    .replace(/\s*\|model output error:\s*/gi, ': ')
    .replace(/\.\s*:\s*/g, ': ')
    .replace(/:\s*(.{16,}?)\s+model output error:\s*\1$/i, ': $1')
    .trim();
  const dedup = s.match(/^(.{24,}?)\s+\1$/i);
  if (dedup) s = dedup[1].trim();
  return s;
}

/** `gemini-4-carbon-high` -> `Gemini 4 Carbon High` (best-effort readable model name). */
export function prettifyModelSlug(slug) {
  const s = String(slug || '').trim();
  if (!s) return '';
  return s
    .replace(/^models\//, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT';
      if (/^oss$/i.test(part)) return 'OSS';
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ')
    .replace(/(\d) (\d)\b/g, '$1.$2');
}

export function getIssueBadgeClass(cat) {
  switch (cat) {
    case 'safety_filter':
      return 'is-safety';
    case 'quota_429':
      return 'is-quota';
    case 'server_injection':
      return 'is-inj';
    case 'upstream_retry':
      return 'is-net';
    case 'tool_error':
      return 'is-tool';
    default:
      return '';
  }
}

export function formatTimestampShort(secOrMs) {
  const raw = Number(secOrMs) || 0;
  if (raw <= 0) return '';
  const ms = raw < 1e11 ? raw * 1000 : raw;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return `${hh}:${mm}`;
  }
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export function resolveDefaultSoftLimit() {
  return Math.max(1, Number(state.snapshot?.defaultSoftLimit) || 512_000);
}

export function resolveThreadSoftLimit(waterline, model) {
  return Math.max(
    1,
    Number(
      waterline?.softLimit ||
        model?.softLimit ||
        state.snapshot?.defaultSoftLimit ||
        512_000
    )
  );
}

export function computeDotAllocation(waterline, model, totalSlots) {
  const softLimit = resolveThreadSoftLimit(waterline, model);
  const cached = Math.max(0, Number(waterline?.cachedTokens || 0));
  const rawCurrent = Number(
    waterline?.currentTokens ?? cached + Number(waterline?.freshTokens || 0)
  );
  const current = Math.max(0, rawCurrent);
  const fresh = Math.max(
    0,
    Number(waterline?.freshTokens ?? Math.max(0, current - cached))
  );

  if (current <= 0) {
    return { inkDots: 0, mintDots: 0, softLimit, current: 0, cached: 0, fresh: 0 };
  }

  const ratio = Math.min(1, current / softLimit);
  const filled = Math.max(1, Math.min(totalSlots, Math.round(ratio * totalSlots)));
  const rawMint = fresh > 0 ? Math.round((fresh / Math.max(1, current)) * filled) : 1;
  const mintDots = Math.min(filled, Math.max(1, rawMint));
  const inkDots = Math.max(0, filled - mintDots);

  return { inkDots, mintDots, softLimit, current, cached, fresh };
}

/** Compact 20-dot context row for narrow list cells (~110px). */
export function buildRowDotsCompactSvg(inkDots, mintDots) {
  const { ink, mint, free } = getDotPalette();
  const total = 20;
  const width = 118;
  const padX = 2.5;
  const step = (width - padX * 2) / (total - 1);
  let circles = '';
  for (let i = 0; i < total; i++) {
    const cx = (padX + i * step).toFixed(2);
    if (i < inkDots) {
      circles += `<circle cx="${cx}" cy="4" r="2.2" fill="${ink}"/>`;
    } else if (i < inkDots + mintDots) {
      circles += `<circle cx="${cx}" cy="4" r="2.2" fill="${mint}"/>`;
    } else {
      circles += `<circle cx="${cx}" cy="4" r="0.95" fill="${free}"/>`;
    }
  }
  return `<svg width="${width}" height="8" viewBox="0 0 ${width} 8" style="display:block;overflow:visible">${circles}</svg>`;
}

export function buildRow20DotsSvg(inkDots, mintDots) {
  const { ink, mint, free } = getDotPalette();
  const total = 20;
  const width = 314;
  const padX = 4;
  const step = (width - padX * 2) / (total - 1);

  let circles = '';
  for (let i = 0; i < total; i++) {
    const cx = (padX + i * step).toFixed(2);
    if (i < inkDots) {
      circles += `<circle cx="${cx}" cy="6" r="3.2" fill="${ink}"/>`;
    } else if (i < inkDots + mintDots) {
      circles += `<circle cx="${cx}" cy="6" r="3.2" fill="${mint}"/>`;
    } else {
      circles += `<circle cx="${cx}" cy="6" r="1.25" fill="${free}"/>`;
    }
  }
  return `<svg width="100%" height="12" viewBox="0 0 ${width} 12" preserveAspectRatio="xMinYMid meet" style="display:block;overflow:visible">${circles}</svg>`;
}

export function buildMatrix80Svg(inkDots, mintDots) {
  const { ink, mint, free } = getDotPalette();
  const cols = 20;
  const rows = 4;
  const width = 484;
  const height = 72;
  const padX = 5;
  const padY = 6;
  const stepX = (width - padX * 2) / (cols - 1);
  const stepY = (height - padY * 2) / (rows - 1);

  let circles = '';
  let idx = 0;
  for (let c = 0; c < cols; c++) {
    const cx = (padX + c * stepX).toFixed(2);
    for (let r = 0; r < rows; r++) {
      const cy = (padY + r * stepY).toFixed(2);
      if (idx < inkDots) {
        circles += `<circle cx="${cx}" cy="${cy}" r="3.8" fill="${ink}"/>`;
      } else if (idx < inkDots + mintDots) {
        circles += `<circle cx="${cx}" cy="${cy}" r="3.8" fill="${mint}"/>`;
      } else {
        circles += `<circle cx="${cx}" cy="${cy}" r="1.4" fill="${free}"/>`;
      }
      idx++;
    }
  }
  return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible">${circles}</svg>`;
}

function cleanSummaryPreamble(raw) {
  if (!raw) return '';
  let text = String(raw).replace(/\r\n/g, '\n').trim();
  const summaryMatches = [
    ...text.matchAll(/^[ \t]*<summary>[ \t]*\n([\s\S]*?)\n[ \t]*<\/summary>[ \t]*$/gim),
  ];
  if (summaryMatches.length > 0) {
    text = summaryMatches[summaryMatches.length - 1][1].trim();
  } else {
    text = text.replace(
      /^#\s*Resuming from a compaction\s*\n+You are continuing work on the task described above[^\n]*\n+/i,
      ''
    );
    text = text.replace(/^\{\{\s*CHECKPOINT\s+\d+\s*\}\}\s*\n+\*\*The earlier parts[^\n]*\n+/i, '');
  }
  text = text
    .split('\n')
    .filter((line) => !/^\s*(?:[-*\u2022]|\d+\.)?\s*\[Attachment:\s*[^\]]+\]\s*$/i.test(line))
    .join('\n');
  return text.trim();
}

function formatInlineMarkdown(escapedLine) {
  const codeSlots = [];
  let out = escapedLine.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeSlots.length;
    codeSlots.push(`<code>${code}</code>`);
    return `\x00CODE${idx}\x00`;
  });
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|file:\/\/\/[^\s)]+)\)/g, '$1');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out.replace(/\x00CODE(\d+)\x00/g, (_m, idx) => codeSlots[Number(idx)] || '');
}

function computeIndentDepth(rawLine) {
  const lead = (rawLine.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ').length;
  if (lead <= 1) return 0;
  if (lead <= 4) return 1;
  if (lead <= 7) return 2;
  return 3;
}

export function renderSummaryMarkdown(rawMarkdown) {
  const cleaned = cleanSummaryPreamble(rawMarkdown);
  if (!cleaned) return '';

  const lines = cleaned.split('\n');
  const html = [];
  let inCode = false;
  let codeBuf = [];
  let listBuf = [];
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length > 0) {
      html.push(`<p>${formatInlineMarkdown(paraBuf.join(' '))}</p>`);
      paraBuf = [];
    }
  };

  const flushList = () => {
    if (listBuf.length > 0) {
      html.push(`<div class="md-list-group">${listBuf.join('\n')}</div>`);
      listBuf = [];
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      flushPara();
      flushList();
      if (!inCode) {
        inCode = true;
        codeBuf = [];
      } else {
        html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      codeBuf.push(rawLine);
      continue;
    }

    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushPara();
      flushList();
      const level = Math.min(4, headingMatch[1].length);
      html.push(`<h${level}>${formatInlineMarkdown(escapeHtml(headingMatch[2]))}</h${level}>`);
      continue;
    }

    const depth = computeIndentDepth(rawLine);

    const ulMatch = trimmed.match(/^[-*\u2022]\s+(.+)$/);
    if (ulMatch) {
      flushPara();
      listBuf.push(
        `<div class="md-ul md-d${depth}"><span class="md-dot"></span><div class="md-txt">${formatInlineMarkdown(escapeHtml(ulMatch[1]))}</div></div>`
      );
      continue;
    }

    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      flushPara();
      listBuf.push(
        `<div class="md-ol md-d${depth}"><span class="md-num tnum">${escapeHtml(olMatch[1])}.</span><div class="md-txt">${formatInlineMarkdown(escapeHtml(olMatch[2]))}</div></div>`
      );
      continue;
    }

    flushList();
    paraBuf.push(escapeHtml(trimmed));
  }

  if (inCode && codeBuf.length > 0) {
    html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  flushPara();
  flushList();

  return html.join('\n');
}

export const BACK_CHEVRON_SVG =
  '<svg class="back-icon" width="7" height="12" viewBox="0 0 7 12" aria-hidden="true"><path d="M5.75 1.5L1.25 6L5.75 10.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function resolveModelProvider(nameOrModel) {
  if (!nameOrModel) return '';
  if (typeof nameOrModel === 'object') {
    const p = String(nameOrModel.provider || '').toLowerCase();
    if (p === 'claude' || p === 'anthropic') return 'claude';
    if (p === 'openai' || p === 'gpt') return 'openai';
    if (p === 'gemini' || p === 'google') return 'gemini';
    const joined = `${nameOrModel.fullName || ''} ${nameOrModel.shortName || ''} ${nameOrModel.rawSlug || ''}`;
    return resolveModelProvider(joined);
  }
  const s = String(nameOrModel).toLowerCase();
  if (/(claude|opus|sonnet|haiku|anthropic)/.test(s)) return 'claude';
  if (/(gpt|openai|o1-|o3-|o4-)/.test(s)) return 'openai';
  if (/(gemini|carbon|argon|hydrogen|neon|flash)/.test(s)) return 'gemini';
  return 'other';
}

// Official monochrome SVG path data from Simple Icons (CC0-1.0, viewBox 0 0 24 24).
const SIMPLE_ICONS_PATHS = {
  gemini:
    'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
  claude:
    'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
  openai:
    'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
};

export function renderModelFamilyGlyph(nameOrModel) {
  const provider = resolveModelProvider(nameOrModel);
  const path = SIMPLE_ICONS_PATHS[provider];
  if (path) {
    return `<svg class="model-glyph" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" fill="currentColor"/></svg>`;
  }
  return '<svg class="model-glyph" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
}
