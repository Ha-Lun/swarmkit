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
