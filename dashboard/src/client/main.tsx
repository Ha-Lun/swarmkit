import { createRoot } from 'react-dom/client';
import AppRoot from './App';
import { apiBackend } from './api';
import type { FleetBackend } from './api';
import { CHUNK_RELOAD_KEY, shouldReloadChunk } from './chunkReload';
import './styles.css';

// A redeploy empties dist/: stale lazy chunks 404 as JSON. Reload once for the
// fresh index.html; the sessionStorage guard stops reload loops.
window.addEventListener('vite:preloadError', (event) => {
  const now = Date.now();
  let last: string | null = null;
  try {
    last = sessionStorage.getItem(CHUNK_RELOAD_KEY);
  } catch {
    // Storage unavailable: fall through and reload once.
  }
  if (!shouldReloadChunk(now, last)) return;
  event.preventDefault();
  try {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    // Private mode: still reload; the fresh chunk URLs should load.
  }
  window.location.reload();
});

async function resolveBackend(): Promise<{ backend: FleetBackend; mock: boolean; demo: boolean }> {
  const demo = import.meta.env.VITE_DEMO === '1';
  if (demo || (import.meta.env.DEV && new URLSearchParams(location.search).has('mock'))) {
    const { createMockBackend } = await import('./mock');
    return { backend: createMockBackend(), mock: true, demo };
  }
  return { backend: apiBackend, mock: false, demo };
}

function showDemoBanner() {
  const el = document.createElement('div');
  el.className = 'demo-strip';
  el.textContent = 'Demo · scripted data, nothing runs';
  el.setAttribute('role', 'status');
  document.body.classList.add('has-demo');
  document.body.insertBefore(el, document.getElementById('root'));
}

resolveBackend().then(({ backend, mock, demo }) => {
  if (demo) showDemoBanner();
  createRoot(document.getElementById('root')!).render(<AppRoot backend={backend} mock={mock} />);
});
