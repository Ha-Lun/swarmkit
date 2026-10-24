// Shared starred-folders store: every useStars(backend) instance sees the same
// list. The first use loads it from the backend; toggles are optimistic.
import { useEffect, useSyncExternalStore } from 'react';
import type { FleetBackend } from './api';

let current: string[] = [];
let loading = false;
let loaded = false;
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
  isStarred: (path: string) => boolean;
  toggle: (path: string) => void;
} {
  const stars = useSyncExternalStore(subscribe, () => current);

  useEffect(() => {
    if (loaded || loading) return;
    loading = true;
    backend.stars().then(
      list => {
        loaded = true;
        loading = false;
        set(list);
      },
      () => {
        loading = false;
      },
    );
  }, [backend]);

  const toggle = (path: string): void => {
    const was = current.includes(path);
    const prev = current;
    set(was ? current.filter(s => s !== path) : [...current, path]);
    backend.setStar(path, !was).then(
      list => set(list),
      () => set(prev),
    );
  };

  return { stars, isStarred: path => stars.includes(path), toggle };
}
