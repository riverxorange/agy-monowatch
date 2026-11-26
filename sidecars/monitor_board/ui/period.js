/**
 * Subscription plans and billing-period math.
 *
 * Daily bucket layout (see telemetry/utils.mjs):
 *   0 usd  1 input  2 cacheRead  3 output  4 savedUsd  5 images
 *   6 decodeOutTokens  7 decodeSec  8 ttftSum  9 ttftCount
 */

import { tr } from './i18n.js';

export const PLAN_OPTIONS = [
  { id: 'free', label: 'Free', monthlyUsd: 0 },
  { id: 'pro', label: 'Pro', monthlyUsd: 19.99 },
  { id: 'ultra5', label: 'Ultra 5×', monthlyUsd: 99.99 },
  { id: 'ultra20', label: 'Ultra 20×', monthlyUsd: 199.99 },
];

export function resolvePlanLabel(plan) {
  if (!plan) return '';
  const preset = PLAN_OPTIONS.find((p) => p.id === plan.id);
  return preset ? preset.label : tr('自定义', 'Custom');
}

export function dayKeyOf(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function clampedDate(year, month, day) {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, last));
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function diffDays(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
}

/**
 * Active time window.
 * - `today`: local calendar day
 * - `period`: billing cycle (billingDay set) or rolling 30 days
 * - `all`: full local history
 */
export function resolveWindow(kind, billingDay, now = new Date()) {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);

  if (kind === 'today') {
    return {
      kind,
      start: today,
      lastDay: today,
      startKey: dayKeyOf(today),
      endKey: dayKeyOf(tomorrow),
      startMs: today.getTime(),
      endMs: tomorrow.getTime(),
      totalDays: 1,
    };
  }

  if (kind === '7d') {
    const start = addDays(today, -6);
    return {
      kind,
      start,
      end: tomorrow,
      lastDay: today,
      startKey: dayKeyOf(start),
      endKey: dayKeyOf(tomorrow),
      startMs: start.getTime(),
      endMs: tomorrow.getTime(),
      totalDays: 7,
    };
  }

  if (kind === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const elapsedMs = Math.max(0, now.getTime() - start.getTime());
    return {
      kind: 'month',
      start,
      end,
      lastDay: addDays(end, -1),
      startKey: dayKeyOf(start),
      endKey: dayKeyOf(end),
      startMs: start.getTime(),
      endMs: end.getTime(),
      totalDays: Math.max(1, diffDays(start, end)),
      elapsedDays: Math.max(1, diffDays(start, today) + 1),
      remainingDays: Math.max(0, diffDays(today, end)),
      elapsedFraction: Math.min(1, elapsedMs / Math.max(1, end - start)),
    };
  }

  if (kind === 'all') {
    return {
      kind,
      startKey: '0000-00-00',
      endKey: '9999-99-99',
      startMs: 0,
      endMs: Number.POSITIVE_INFINITY,
    };
  }

  const day = Number(billingDay);
  if (day >= 1 && day <= 31) {
    let start = clampedDate(today.getFullYear(), today.getMonth(), day);
    if (start > today) {
      start = clampedDate(today.getFullYear(), today.getMonth() - 1, day);
    }
    const end = clampedDate(start.getFullYear(), start.getMonth() + 1, day);
    const elapsedMs = Math.max(0, now.getTime() - start.getTime());
    return {
      kind: 'period',
      start,
      end,
      lastDay: addDays(end, -1),
      startKey: dayKeyOf(start),
      endKey: dayKeyOf(end),
      startMs: start.getTime(),
      endMs: end.getTime(),
      totalDays: Math.max(1, diffDays(start, end)),
      elapsedDays: Math.max(1, diffDays(start, today) + 1),
      remainingDays: Math.max(0, diffDays(today, end)),
      elapsedFraction: Math.min(1, elapsedMs / Math.max(1, end - start)),
      isBilling: true,
    };
  }

  const start = addDays(today, -29);
  return {
    kind: 'period',
    start,
    end: tomorrow,
    lastDay: today,
    startKey: dayKeyOf(start),
    endKey: dayKeyOf(tomorrow),
    startMs: start.getTime(),
    endMs: tomorrow.getTime(),
    totalDays: 30,
    isRolling: true,
  };
}

export function formatMonthDay(d) {
  if (!d) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * ROI dots: one dot = `unit` months of subscription. Filled dots are the
 * multiples already earned, the mint dot is the one in progress, hollow dots
 * mark where the period is projected to end.
 */
export function computeRoiDots(current, projected = 0, maxDots = 20) {
  const cur = Math.max(0, Number(current) || 0);
  const target = Math.max(cur, Number(projected) || 0, 1);
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  let unit = steps[steps.length - 1];
  for (const s of steps) {
    if (Math.ceil(target / s - 1e-9) <= maxDots) {
      unit = s;
      break;
    }
  }
  const total = Math.max(1, Math.ceil(target / unit - 1e-9));
  const full = Math.min(total, Math.floor(cur / unit));
  const partial = full < total && cur / unit - full > 0.04 ? 1 : 0;
  return { unit, total, full, partial };
}
