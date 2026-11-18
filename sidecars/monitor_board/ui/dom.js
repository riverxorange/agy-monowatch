/**
 * Zero-flicker incremental DOM patching primitives and structured Swiss tooltip controller.
 *
 * Tooltip spec shape (`encodeTip` / `setTip`):
 *   {
 *     title: string,                         // Bold focal heading (left)
 *     right?: string,                        // Tabular summary value (right of heading)
 *     body?: string,                         // Concise 1–2 line prose explanation
 *     rows?: Array<[label, value, sub?]>,    // Aligned key-value rows
 *     sections?: Array<{ label?: string, rows: Array<[label, value, sub?]> }>,
 *     note?: string,                         // Muted 1-line footnote
 *   }
 */

import { getActiveTipHost, setActiveTipHost, tooltipEl } from './state.js';

const TIP_PREFIX = '\x01';

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function encodeTip(spec) {
  if (!spec) return '';
  if (typeof spec === 'string') return spec;
  return `${TIP_PREFIX}${JSON.stringify(spec)}`;
}

function renderRowsHtml(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const items = rows
    .filter((r) => Array.isArray(r) && (r[0] || r[1]))
    .map(([label, val, sub]) => {
      const subHtml = sub ? `<span class="tt-sub">${escapeHtml(sub)}</span>` : '';
      return `<div class="tt-row"><span class="tt-k">${escapeHtml(label)}</span><span class="tt-v tnum">${escapeHtml(val)}${subHtml}</span></div>`;
    })
    .join('');
  return items ? `<div class="tt-rows">${items}</div>` : '';
}

function buildTooltipHtml(raw) {
  const s = String(raw ?? '');
  if (!s) return '';
  if (!s.startsWith(TIP_PREFIX)) {
    return `<div class="tt-body">${escapeHtml(s)}</div>`;
  }
  let spec = null;
  try {
    spec = JSON.parse(s.slice(1));
  } catch {
    return '';
  }
  if (!spec || typeof spec !== 'object') return '';

  const parts = [];
  const hasBelow =
    Boolean(spec.body) ||
    (Array.isArray(spec.rows) && spec.rows.length > 0) ||
    (Array.isArray(spec.sections) && spec.sections.length > 0) ||
    Boolean(spec.note);

  if (spec.title || spec.right) {
    parts.push(
      `<div class="tt-head${hasBelow && !spec.body ? ' has-rule' : ''}">` +
        `<span class="tt-title">${escapeHtml(spec.title || '')}</span>` +
        (spec.right ? `<span class="tt-right tnum">${escapeHtml(spec.right)}</span>` : '') +
        `</div>`
    );
  }
  if (spec.body) {
    parts.push(`<div class="tt-body">${escapeHtml(spec.body)}</div>`);
  }
  const mainRows = renderRowsHtml(spec.rows);
  if (mainRows) parts.push(mainRows);

  if (Array.isArray(spec.sections)) {
    for (const sec of spec.sections) {
      if (!sec) continue;
      const secRows = renderRowsHtml(sec.rows);
      if (!secRows) continue;
      parts.push(
        `<div class="tt-sec">` +
          (sec.label ? `<div class="tt-sec-label">${escapeHtml(sec.label)}</div>` : '') +
          secRows +
          `</div>`
      );
    }
  }
  if (spec.note) {
    parts.push(`<div class="tt-note">${escapeHtml(spec.note)}</div>`);
  }
  return parts.join('');
}

function applyTooltipRaw(raw) {
  if (!tooltipEl) return false;
  const html = buildTooltipHtml(raw);
  if (!html) return false;
  if (tooltipEl._lastRaw !== raw) {
    tooltipEl.innerHTML = html;
    tooltipEl._lastRaw = raw;
  }
  return true;
}

export function setText(el, val) {
  if (!el) return;
  const next = String(val ?? '');
  if (el.textContent !== next) {
    el.textContent = next;
  }
}

export function setClass(el, cls) {
  if (!el) return;
  if (el.className !== cls) {
    el.className = cls;
  }
}

export function setDisplay(el, show, displayMode = '') {
  if (!el) return;
  const next = show ? displayMode : 'none';
  if (el.style.display !== next) {
    el.style.display = next;
  }
}

export function hideTooltip() {
  setActiveTipHost(null);
  if (!tooltipEl) return;
  tooltipEl.classList.remove('is-visible');
  tooltipEl.setAttribute('aria-hidden', 'true');
}

export function setTip(el, tipOrSpec) {
  if (!el) return;
  const next = tipOrSpec && typeof tipOrSpec === 'object' ? encodeTip(tipOrSpec) : String(tipOrSpec ?? '');
  if (!next) {
    if (el.hasAttribute('data-tip')) {
      el.removeAttribute('data-tip');
    }
    if (getActiveTipHost() === el) {
      hideTooltip();
    }
    return;
  }
  if (el.getAttribute('data-tip') !== next) {
    el.setAttribute('data-tip', next);
    if (getActiveTipHost() === el && tooltipEl?.classList.contains('is-visible')) {
      applyTooltipRaw(next);
      positionTooltipToHost(el);
    }
  }
}

export function setHtmlCached(el, html) {
  if (!el) return;
  if (el._lastHtml !== html) {
    el.innerHTML = html;
    el._lastHtml = html;
  }
}

function positionTooltipToHost(hostEl) {
  if (!tooltipEl || !hostEl) return;
  const pad = 12;
  const gap = 8;
  const hostRect = hostEl.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();

  let x = hostRect.left;
  if (x + tipRect.width + pad > window.innerWidth) {
    x = Math.max(pad, Math.min(hostRect.right - tipRect.width, window.innerWidth - tipRect.width - pad));
  }
  x = Math.max(pad, x);

  let y = hostRect.bottom + gap;
  if (y + tipRect.height + pad > window.innerHeight && hostRect.top - tipRect.height - gap >= pad) {
    y = hostRect.top - tipRect.height - gap;
  } else if (y + tipRect.height + pad > window.innerHeight) {
    y = Math.max(pad, window.innerHeight - tipRect.height - pad);
  }

  tooltipEl.style.left = `${Math.round(x)}px`;
  tooltipEl.style.top = `${Math.round(y)}px`;
}

export function initTooltips(rootEl) {
  if (!rootEl || !tooltipEl) return;

  rootEl.addEventListener('mouseover', (e) => {
    const tipHost = e.target.closest('[data-tip]');
    if (!tipHost) {
      hideTooltip();
      return;
    }
    if (getActiveTipHost() === tipHost && tooltipEl.classList.contains('is-visible')) {
      return;
    }
    const raw = tipHost.getAttribute('data-tip');
    if (!raw || !applyTooltipRaw(raw)) {
      hideTooltip();
      return;
    }
    setActiveTipHost(tipHost);
    tooltipEl.classList.add('is-visible');
    tooltipEl.setAttribute('aria-hidden', 'false');
    positionTooltipToHost(tipHost);
  });

  rootEl.addEventListener('mouseout', (e) => {
    const cur = getActiveTipHost();
    if (!cur) return;
    const rel = e.relatedTarget;
    if (rel && cur.contains(rel)) return;
    const nextHost = rel?.closest?.('[data-tip]');
    if (!nextHost) hideTooltip();
  });

  rootEl.addEventListener('mouseleave', hideTooltip);
  window.addEventListener('scroll', hideTooltip, { passive: true });
}
