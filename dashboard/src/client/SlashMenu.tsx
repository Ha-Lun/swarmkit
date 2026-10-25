// Filterable `/` command menu for the composer (mirrors the CLI pickers).
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
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

/**
 * Slash-menu state for a textarea: open while the text is a lone `/token`, loads the list
 * once per opening. `onKeyDown` returns true when it consumed the key; call `onChange` on edits.
 */
export function useSlashMenu(
  text: string,
  setText: (t: string) => void,
  loadCommands: () => Promise<SlashCommandInfo[]>,
  inputRef: RefObject<HTMLTextAreaElement | null>,
): {
  menu: ReactNode;
  inputProps: Record<string, string | boolean | undefined>;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onChange: () => void;
} {
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [commands, setCommands] = useState<SlashCommandInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const wasOpenRef = useRef(false);
  const loadRef = useRef(loadCommands);
  loadRef.current = loadCommands;
  const menuId = `slash-${useId().replace(/:/g, '')}`;

  const open = /^\/\S*$/.test(text) && !dismissed;
  const filtered = open ? matchCommands(commands, text.slice(1)) : [];
  const clamped = filtered.length === 0 ? 0 : Math.min(active, filtered.length - 1);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const id = ++reqRef.current;
      setLoading(true);
      loadRef.current().then(
        (list) => {
          if (reqRef.current !== id) return;
          setCommands(list);
          setLoading(false);
        },
        () => {
          if (reqRef.current !== id) return;
          setCommands([]);
          setLoading(false);
        },
      );
    }
    wasOpenRef.current = open;
  }, [open]);

  const pick = (c: SlashCommandInfo) => {
    setText(`/${c.name} `);
    setDismissed(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = filtered.length;
      if (n > 0) setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n));
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
      return true;
    }
    if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) && filtered.length > 0) {
      e.preventDefault();
      pick(filtered[clamped]);
      return true;
    }
    return false;
  };

  return {
    menu: open ? (
      <SlashMenu
        id={menuId}
        items={filtered}
        active={clamped}
        loading={loading || !wasOpenRef.current}
        onPick={pick}
        onHover={setActive}
      />
    ) : null,
    inputProps: {
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': open,
      'aria-controls': open ? menuId : undefined,
      'aria-activedescendant': open && filtered.length > 0 ? `${menuId}-${clamped}` : undefined,
    },
    onKeyDown,
    onChange: () => {
      setDismissed(false);
      setActive(0);
    },
  };
}
