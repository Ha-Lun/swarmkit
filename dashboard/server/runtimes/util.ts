// Shared guards for the runtime adapters: narrow untyped JSON-RPC / agy payloads.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type Rec = Record<string, unknown>;

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Text of a user turn: string content, or the joined `text` parts of an array. */
export function userText(msg: SDKUserMessage): string {
  const content = rec(msg as unknown as Rec)?.message !== undefined ? rec((msg as unknown as Rec).message)?.content : undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        const p = rec(part);
        return p && p.type === 'text' && typeof p.text === 'string' ? p.text : '';
      })
      .filter(t => t.length > 0)
      .join('\n');
  }
  return '';
}

/** ACP prompt blocks of a user turn: image blocks first (mimeType + base64), then the text. */
export function userBlocks(msg: SDKUserMessage): Array<{ type: 'image'; mimeType: string; data: string } | { type: 'text'; text: string }> {
  const blocks: Array<{ type: 'image'; mimeType: string; data: string } | { type: 'text'; text: string }> = [];
  const content = rec((msg as unknown as Rec).message)?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = rec(part);
      const source = rec(p?.source);
      if (p?.type === 'image' && source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
        blocks.push({ type: 'image', mimeType: source.media_type, data: source.data });
      }
    }
  }
  blocks.push({ type: 'text', text: userText(msg) });
  return blocks;
}
