// Shared starred-folders store: every useStars(backend) instance sees the same
// list. The first use loads it from the backend; toggles are optimistic.
import { useEffect, useSyncExternalStore } from 'react';
import type { FleetBackend } from './api';

let current: string[] = [];
let loading = false;
let loaded = false;
let version = 0;
const listeners = new Set<() => void>();

function set(list: string[]): void {
  current = list;
  for (const notify of [...listeners]) notify();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

export function useStars(backend: FleetBackend): {
  stars: string[];
  toggle: (path: string) => void;
} {
  const stars = useSyncExternalStore(subscribe, () => current);

  useEffect(() => {
    if (loaded || loading) return;
    loading = true;
    const seen = version;
    backend.stars().then(
      list => {
        loaded = true;
        loading = false;
        if (version === seen) set(list);
      },
      () => {
        loading = false;
      },
    );
  }, [backend]);

  const toggle = (path: string): void => {
    version += 1;
    const mine = version;
    const was = current.includes(path);
    set(was ? current.filter(s => s !== path) : [...current, path]);
    backend.setStar(path, !was).then(
      list => {
        if (mine === version) set(list);
      },
      () => {
        if (mine !== version) return;
        if (was) {
          if (!current.includes(path)) set([...current, path]);
        } else {
          if (current.includes(path)) set(current.filter(s => s !== path));
        }
      },
    );
  };

  return { stars, toggle };
}
