import { createRoot } from 'react-dom/client';
import AppRoot from './App';
import { apiBackend } from './api';
import type { FleetBackend } from './api';
import './styles.css';

async function resolveBackend(): Promise<{ backend: FleetBackend; mock: boolean }> {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
    const { createMockBackend } = await import('./mock');
    return { backend: createMockBackend(), mock: true };
  }
  return { backend: apiBackend, mock: false };
}

resolveBackend().then(({ backend, mock }) => {
  createRoot(document.getElementById('root')!).render(<AppRoot backend={backend} mock={mock} />);
});
