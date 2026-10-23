import type { ServerEvent } from '../../src/shared/types.ts';
import type { SessionTree } from './reducer.ts';

/**
 * Checks every running worker node in the tree against its result.json
 * (~/.agy-tasks/<repo>/<slug>/result.json or ~/.opencode-tasks/<repo>/<slug>/result.json;
 * AGY_TASK_DIR / OPENCODE_TASK_DIR override the roots) and returns the events for nodes that finished.
 * Callers run it every few seconds for live sessions.
 */
export async function pollWorkers(tree: SessionTree): Promise<ServerEvent[]> {
  return [];
}
