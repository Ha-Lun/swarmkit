import type { AgentNode, ServerEvent } from '../../src/shared/types.ts';

export interface SessionTree {
  sessionId: string;
  /** All nodes by id; 'root' is the main agent. */
  nodes: Map<string, AgentNode>;
  /** tool_use_id -> id of the node that made that tool call (routes tool_results and permission requests). */
  toolOwner: Map<string, string>;
}

export interface TreeInit {
  startedAt: number;
  /** Main-thread agent name; defaults to 'main'. */
  agentType?: string;
  prompt?: string;
}

export interface ApplyOptions {
  /** Force the node for this message: used for transcript lines read from a subagent file (agent-<id>.jsonl). */
  nodeId?: string;
}

export function createTree(sessionId: string, init: TreeInit): SessionTree {
  throw new Error('not implemented');
}

/**
 * Applies one raw message to the tree and returns the events to broadcast.
 * `msg` is either an Agent SDK message (SDKMessage: has `parent_tool_use_id`) or one parsed line of a
 * Claude Code transcript (~/.claude/projects/<proj>/<session>.jsonl or .../subagents/agent-<id>.jsonl).
 * Unknown shapes are ignored (return []).
 */
export function applyMessage(tree: SessionTree, msg: unknown, opts?: ApplyOptions): ServerEvent[] {
  throw new Error('not implemented');
}

/** Node id that owns a tool_use_id, or 'root'. */
export function ownerOf(tree: SessionTree, toolUseId: string | undefined): string {
  return (toolUseId && tree.toolOwner.get(toolUseId)) || 'root';
}

/** Sets a node's status (used for permission waits, interrupts and stops) and returns the node.upsert to broadcast. */
export function setStatus(tree: SessionTree, nodeId: string, status: AgentNode['status']): ServerEvent[] {
  throw new Error('not implemented');
}
