/**
 * User settings bridge: subscription plan and billing day.
 * Persisted server-side in the sidecar's private data dir (`/api/settings`).
 */

import { sidecarFetch, state } from './state.js';

export async function loadSettings() {
  try {
    const res = await sidecarFetch('/api/settings', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    if (data && !data.error) {
      state.settings = data;
      state.settingsLoaded = true;
    }
  } catch {
    // Keep defaults; settings are optional.
  }
}

export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  try {
    const res = await sidecarFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && !data.error) state.settings = data;
    }
  } catch {
    // Optimistic local state stays in place.
  }
}
