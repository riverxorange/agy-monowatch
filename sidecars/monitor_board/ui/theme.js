/**
 * Swiss Braun adaptive Light/Dark theme synchronization with Antigravity host `/preload.js`.
 */

const LIGHT_DOTS = {
  theme: 'light',
  ink: '#141413',
  mint: '#109868',
  free: '#D5D5CE',
};

const DARK_DOTS = {
  theme: 'dark',
  ink: '#F0F0EB',
  mint: '#19B37D',
  free: '#353531',
};

function parseCssColorRgb(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  const hexMatch = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgbMatch = s.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)/i);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }
  return null;
}

function isRgbDark([r, g, b]) {
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.5;
}

export function detectHostThemeMode() {
  try {
    const rootStyle = document.documentElement?.style;
    const bodyStyle = document.body?.style;
    const inlineBg =
      rootStyle?.getPropertyValue('--background') ||
      bodyStyle?.getPropertyValue('--background') ||
      getComputedStyle(document.documentElement).getPropertyValue('--background') ||
      rootStyle?.backgroundColor ||
      bodyStyle?.backgroundColor ||
      '';

    const rgb = parseCssColorRgb(inlineBg);
    if (rgb) {
      return isRgbDark(rgb) ? 'dark' : 'light';
    }
  } catch {
    // Fall back to media query below.
  }

  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  }
  return 'light';
}

export function applyThemeMode(mode = detectHostThemeMode()) {
  const resolved = mode === 'dark' ? 'dark' : 'light';
  if (document.documentElement.getAttribute('data-theme') !== resolved) {
    document.documentElement.setAttribute('data-theme', resolved);
    return true;
  }
  return false;
}

export function getDotPalette() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return isDark ? DARK_DOTS : LIGHT_DOTS;
}

export function initThemeSync(onThemeChange) {
  applyThemeMode();

  const handleCheck = () => {
    if (applyThemeMode() && typeof onThemeChange === 'function') {
      onThemeChange();
    }
  };

  if (typeof MutationObserver === 'function') {
    try {
      const obs = new MutationObserver(handleCheck);
      obs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class'],
      });
      if (document.body) {
        obs.observe(document.body, {
          attributes: true,
          attributeFilter: ['style', 'class'],
        });
      }
    } catch {
      // Ignore observer limitations in restricted environments.
    }
  }

  if (typeof window.matchMedia === 'function') {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', handleCheck);
      }
    } catch {
      // Ignore matchMedia listener errors.
    }
  }
}
