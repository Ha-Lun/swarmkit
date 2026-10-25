// Filterable `/` command menu for the composer (mirrors the CLI pickers).
import { useEffect, useRef } from 'react';
import type { SlashCommandInfo } from '../shared/types';

// Prefix matches first, then name substring, then description substring.
export function matchCommands(list: SlashCommandInfo[], query: string): SlashCommandInfo[] {
  if (!query) return list.slice(0, 50);
  const q = query.toLowerCase();
  const prefix: SlashCommandInfo[] = [];
  const sub: SlashCommandInfo[] = [];
  const desc: SlashCommandInfo[] = [];
  for (const c of list) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) sub.push(c);
    else if ((c.description ?? '').toLowerCase().includes(q)) desc.push(c);
  }
  return [...prefix, ...sub, ...desc].slice(0, 50);
}

interface Props {
  id: string;
  items: SlashCommandInfo[];
  active: number;
  loading: boolean;
  onPick: (c: SlashCommandInfo) => void;
  onHover: (i: number) => void;
}

export function SlashMenu({ id, items, active, loading, onPick, onHover }: Props) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);
  if (loading) {
    return (
      <ul id={id} role="listbox" aria-label="Commands" className="slash-menu" ref={listRef}>
        <li className="slash-empty">Loading…</li>
      </ul>
    );
  }
  if (items.length === 0) {
    return (
      <ul id={id} role="listbox" aria-label="Commands" className="slash-menu" ref={listRef}>
        <li className="slash-empty">No matching commands</li>
      </ul>
    );
  }
  return (
    <ul id={id} role="listbox" aria-label="Commands" className="slash-menu" ref={listRef}>
      {items.map((c, i) => (
        <li
          key={c.name}
          id={`${id}-${i}`}
          data-index={i}
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="slash-name">/{c.name}</span>
          {c.argumentHint && <span className="slash-hint">{c.argumentHint}</span>}
          {c.description && <span className="slash-desc">{c.description}</span>}
        </li>
      ))}
    </ul>
  );
}
