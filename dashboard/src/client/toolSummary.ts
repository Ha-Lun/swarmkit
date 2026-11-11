// One-line, lowercase summary of a tool run: "ran 3 commands, read 2 files, edited 1 file".
import type { ToolKey } from './format';

const PHRASE: Record<ToolKey, [verb: string, one: string, many: string]> = {
  bash: ['ran', 'command', 'commands'],
  read: ['read', 'file', 'files'],
  edit: ['edited', 'file', 'files'],
  search: ['ran', 'search', 'searches'],
  web: ['made', 'web request', 'web requests'],
  agent: ['started', 'agent', 'agents'],
  other: ['used', 'other tool', 'other tools'],
};

export function toolSummary(groups: Array<{ key: ToolKey; count: number }>): string {
  const parts = groups
    .filter((g) => g.count > 0)
    .map((g) => {
      const [verb, one, many] = PHRASE[g.key];
      return `${verb} ${g.count} ${g.count === 1 ? one : many}`;
    });
  return parts.length > 0 ? parts.join(', ') : 'used tools';
}
