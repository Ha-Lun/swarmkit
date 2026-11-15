// One artifacts fetch per open session, shared by the info panel, the chat strip and the tool rows.
import { useEffect, useState } from 'react';
import type { ArtifactsResponse } from '../shared/types';
import type { FleetBackend } from './api';

/**
 * Fetches the session's artifacts when it opens and again whenever `resultKey` changes
 * (a new `result` event on the lead). A failed fetch keeps the last good answer.
 */
export function useArtifacts(
  backend: FleetBackend,
  sessionId: string | null,
  resultKey: string,
): ArtifactsResponse | undefined {
  const [state, setState] = useState<{ id: string; data: ArtifactsResponse } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    backend.artifacts(sessionId).then(
      (data) => live && setState({ id: sessionId, data }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [backend, sessionId, resultKey]);
  return state && state.id === sessionId ? state.data : undefined;
}
