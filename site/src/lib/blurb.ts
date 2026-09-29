// Browser-safe text helper for the subagent cards (agents.ts reads the disk, so it cannot be imported by the page code).

/** What a subagent does, from its own description: whole sentences up to about `max` characters, cut at a word boundary if the first one is longer. */
export function blurb(description: string, max = 230): string {
  let out = '';
  for (const sent of description.split(/(?<=[.!?])\s+/)) {
    if (out && (out + ' ' + sent).length > max) break;
    out = out ? `${out} ${sent}` : sent;
    if (out.length >= max) break;
  }
  return out.length > max ? `${out.slice(0, max - 3).replace(/[\s,;:]+\S*$/, '')}...` : out;
}
