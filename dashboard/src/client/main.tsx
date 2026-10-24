import { createRoot } from 'react-dom/client';
import AppRoot from './App';
import { apiBackend } from './api';
import type { FleetBackend } from './api';
import './styles.css';

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
  el.textContent = 'Demo · scripted data, nothing runs';
  el.setAttribute('role', 'status');
  el.style.position = 'fixed';
  el.style.left = '50%';
  el.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 12px)';
  el.style.transform = 'translateX(-50%)';
  el.style.zIndex = '9999';
  el.style.pointerEvents = 'none';
  el.style.background = '#05060acc';
  el.style.color = '#f3f1ff';
  el.style.border = '1px solid rgba(243,241,255,0.25)';
  el.style.borderRadius = '999px';
  el.style.padding = '6px 12px';
  el.style.font = '12px "JetBrains Mono", monospace';
  el.style.whiteSpace = 'nowrap';
  document.body.appendChild(el);
}

resolveBackend().then(({ backend, mock, demo }) => {
  if (demo) showDemoBanner();
  createRoot(document.getElementById('root')!).render(<AppRoot backend={backend} mock={mock} />);
});
