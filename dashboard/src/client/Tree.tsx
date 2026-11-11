// The swarm map: a pan/zoom canvas with the agent tree (own tidy layout, SVG connectors).
// Finished children fold into one "Done (n)" node per parent so live work and failures stay in focus.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AgentNode, DecideOptions, PermissionRequest, Status, WorkerTask } from '../shared/types';
import { DoneCard, NodeCard, nodeElapsedMs } from './NodeCard';
import { agentState, foldDone, matchWorkerTask } from './chat';
import { ChevronIcon, FitIcon, ZoomInIcon, ZoomOutIcon } from './icons';

const CARD_W = 240;
const H_GAP = 20;
const Y_GAP = 48;
const NOMINAL_H = 96;
const MIN_Z = 0.25;
const MAX_Z = 2.5;
const FIT_PAD = 24;
/** A parent with more leaf children than this wraps them into a grid placed after its subtrees. */
const WRAP_COLS = 4;
/** Padding of the faint band behind a wrapped leaf grid. */
const GROUP_PAD = 12;
/** Gutter (in slots) kept on each side of a wrapped leaf group so it never touches neighbours. */
const GROUP_GUTTER = 0.2;
const FIT_MIN_Z = 0.6;
const FIT_MIN_Z_NARROW = 0.7;
/** Corner radius for rounded orthogonal edge elbows. */
const ELBOW_R = 8;

function elbow(px: number, py: number, cx: number, cy: number): string {
  if (px === cx) return `M ${px} ${py} L ${cx} ${cy}`;
  const midY = (py + cy) / 2;
  const r = Math.max(0, Math.min(ELBOW_R, Math.abs(cx - px) / 2, Math.abs(cy - py) / 2));
  if (r <= 0.5) return `M ${px} ${py} L ${px} ${midY} L ${cx} ${midY} L ${cx} ${cy}`;
  const dx = cx > px ? 1 : -1;
  return (
    `M ${px} ${py} L ${px} ${midY - r} ` +
    `Q ${px} ${midY} ${px + dx * r} ${midY} ` +
    `L ${cx - dx * r} ${midY} ` +
    `Q ${cx} ${midY} ${cx} ${midY + r} ` +
    `L ${cx} ${cy}`
  );
}

interface Placed {
  node: AgentNode;
  x: number; // left edge of the card
  y: number; // top edge
}

interface GroupBand {
  parentId: string;
  members: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  placed: Placed[];
  groups: GroupBand[];
  w: number;
  h: number;
  rootCx: number;
}

/** Leaves take consecutive x slots; parents centre over their children; depth maps to y.
 * A parent with many leaf children wraps them into a grid so the tree stays readable. */
export function computeLayout(nodes: AgentNode[], heights: Record<string, number>): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const kids = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const list = kids.get(n.parentId);
      if (list) list.push(n.id);
      else kids.set(n.parentId, [n.id]);
    } else {
      roots.push(n.id);
    }
  }
  const byStart = (a: string, b: string) => {
    const d = (byId.get(a)?.startedAt ?? 0) - (byId.get(b)?.startedAt ?? 0);
    return d !== 0 ? d : a.localeCompare(b);
  };
  for (const list of kids.values()) list.sort(byStart);
  roots.sort(byStart);

  const slot = CARD_W + H_GAP;
  let cursor = 0;
  const x = new Map<string, number>();
  const depth = new Map<string, number>();
  const wrapGroups: Array<{ parentId: string; kids: string[] }> = [];
  const visiting = new Set<string>();

  const place = (id: string, d: number): number => {
    if (x.has(id)) return x.get(id)!;
    if (visiting.has(id)) return x.get(id) ?? 0;
    visiting.add(id);
    depth.set(id, d);
    // Cycle guard: a child already being visited (or placed) is skipped,
    // so a parent loop can never recurse forever.
    const list = (kids.get(id) ?? []).filter((k) => !visiting.has(k) && !x.has(k));
    let cx: number;
    if (list.length === 0) {
      cx = cursor * slot + CARD_W / 2;
      cursor += 1;
    } else {
      const subtrees = list.filter((k) => kids.has(k));
      const leaves = list.filter((k) => !kids.has(k));
      if (leaves.length > WRAP_COLS) {
        let min = Infinity;
        let max = -Infinity;
        for (const k of subtrees) {
          const kx = place(k, d + 1);
          min = Math.min(min, kx);
          max = Math.max(max, kx);
        }
        cursor += GROUP_GUTTER;
        const base = cursor;
        leaves.forEach((k, i) => {
          depth.set(k, d + 1 + Math.floor(i / WRAP_COLS));
          x.set(k, (base + (i % WRAP_COLS)) * slot + CARD_W / 2);
        });
        cursor += WRAP_COLS;
        cursor += GROUP_GUTTER;
        const gcx = base * slot + (WRAP_COLS * slot - H_GAP) / 2;
        min = Math.min(min, gcx);
        max = Math.max(max, gcx);
        cx = (min + max) / 2;
        wrapGroups.push({ parentId: id, kids: [...leaves] });
      } else {
        let min = Infinity;
        let max = -Infinity;
        for (const k of list) {
          const kx = place(k, d + 1);
          min = Math.min(min, kx);
          max = Math.max(max, kx);
        }
        cx = (min + max) / 2;
      }
    }
    x.set(id, cx);
    visiting.delete(id);
    return cx;
  };
  for (const r of roots) place(r, 0);
  // Cycle members (a->b->a, or a node that is its own parent) are never
  // reached from a root: place them as extra roots in start order.
  const rest = nodes.map((n) => n.id).filter((id) => !x.has(id)).sort(byStart);
  for (const id of rest) place(id, 0);

  const maxH: number[] = [];
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    maxH[d] = Math.max(maxH[d] ?? NOMINAL_H, heights[n.id] ?? NOMINAL_H);
  }
  const yAt: number[] = [];
  let acc = 0;
  for (let d = 0; d < maxH.length; d++) {
    yAt[d] = acc;
    acc += maxH[d] + Y_GAP;
  }

  const placed: Placed[] = nodes
    .filter((n) => x.has(n.id))
    .map((n) => ({ node: n, x: x.get(n.id)! - CARD_W / 2, y: yAt[depth.get(n.id) ?? 0] ?? 0 }));

  const byPlaced = new Map(placed.map((p) => [p.node.id, p] as const));
  const groups: GroupBand[] = wrapGroups.map((g) => {
    const members = g.kids.map((id) => byPlaced.get(id)).filter((p): p is Placed => p !== undefined);
    const left = Math.min(...members.map((p) => p.x));
    const right = Math.max(...members.map((p) => p.x + CARD_W));
    const top = Math.min(...members.map((p) => p.y));
    const bottom = Math.max(...members.map((p) => p.y + (heights[p.node.id] ?? NOMINAL_H)));
    return {
      parentId: g.parentId,
      members: g.kids,
      x: left - GROUP_PAD,
      y: top - GROUP_PAD,
      w: right - left + GROUP_PAD * 2,
      h: bottom - top + GROUP_PAD * 2,
    };
  });

  let w = Math.max(1, cursor > 0 ? cursor * slot - H_GAP : 1);
  let h = Math.max(1, maxH.length > 0 ? acc - Y_GAP : 1);
  for (const g of groups) {
    w = Math.max(w, g.x + g.w);
    h = Math.max(h, g.y + g.h);
  }
  const rootCx = roots.length > 0 ? (x.get(roots[0]) ?? w / 2) : w / 2;
  return { placed, groups, w, h, rootCx };
}

interface Props {
  nodes: AgentNode[];
  permissions: PermissionRequest[];
  workers: WorkerTask[];
  workersAt: number;
  now: number;
  openNodeId: string | null;
  onOpen: (nodeId: string) => void;
  onDecide: (permission: PermissionRequest, allow: boolean, message?: string, answers?: Record<string, string>, opts?: DecideOptions) => void;
  /** The session's project is untrusted: plan approval offers manual mode only. */
  untrusted?: boolean;
}

interface View {
  x: number;
  y: number;
  z: number;
}

const isLive = (state: Status) => state === 'running' || state === 'waiting';

export function Tree({ nodes, permissions, workers, workersAt, now, openNodeId, onOpen, onDecide, untrusted }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLUListElement>(null);
  const [view, setView] = useState<View>({ x: FIT_PAD, y: FIT_PAD, z: 1 });
  const [heights, setHeights] = useState<Record<string, number>>({});
  // Parents whose finished children are shown instead of folded into "Done (n)".
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const userMoved = useRef(false);
  const dragMoved = useRef(false);
  const focusKey = useRef<string | null>(null);

  // Live WorkerTask per worker node: same sessionId+nodeId, else same lane+slug.
  const taskByNode = useMemo(() => {
    const m = new Map<string, WorkerTask>();
    if (workers.length === 0) return m;
    for (const n of nodes) {
      if (n.kind !== 'worker') continue;
      const t = matchWorkerTask(n, workers);
      if (t) m.set(n.id, t);
    }
    return m;
  }, [nodes, workers]);

  const permByNode = useMemo(() => {
    const m = new Map<string, PermissionRequest>();
    for (const p of permissions) if (!m.has(p.nodeId)) m.set(p.nodeId, p);
    return m;
  }, [permissions]);

  const stateOf = useCallback(
    (n: AgentNode) => agentState(n, taskByNode.get(n.id), permByNode.has(n.id)),
    [taskByNode, permByNode],
  );
  const fold = useMemo(() => foldDone(nodes, expanded, stateOf), [nodes, expanded, stateOf]);
  const layout = useMemo(() => computeLayout(fold.nodes, heights), [fold.nodes, heights]);
  const placedById = useMemo(() => new Map(layout.placed.map((p) => [p.node.id, p] as const)), [layout]);

  const setParent = useCallback((parentId: string, open: boolean) => {
    focusKey.current = open ? `fold:${parentId}` : `done:${parentId}`;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(parentId);
      else next.delete(parentId);
      return next;
    });
  }, []);

  const allOpen = fold.foldable.size > 0 && Array.from(fold.foldable.keys()).every((id) => expanded.has(id));
  const toggleAll = () => {
    focusKey.current = null;
    setExpanded(allOpen ? new Set() : new Set(fold.foldable.keys()));
  };

  // The open agent sits inside a folded group: show its group once so the card exists
  // (a later Fold by the user is respected).
  const hostParent = useMemo(() => {
    if (openNodeId == null) return null;
    for (const g of fold.groups.values()) if (g.members.some((m) => m.id === openNodeId)) return g.parentId;
    return null;
  }, [fold.groups, openNodeId]);
  const hosted = useRef(new Set<string>());
  useEffect(() => {
    if (openNodeId == null) {
      hosted.current.clear();
      return;
    }
    const key = `${openNodeId}|${hostParent}`;
    if (hostParent == null || hosted.current.has(key)) return;
    hosted.current.add(key);
    setExpanded((prev) => new Set(prev).add(hostParent));
  }, [hostParent, openNodeId]);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const fitMin = r.width < 700 ? FIT_MIN_Z_NARROW : FIT_MIN_Z;
    const zw = (r.width - FIT_PAD * 2) / layout.w;
    const zh = (r.height - FIT_PAD * 2) / layout.h;
    const z = Math.max(fitMin, Math.min(zw, zh, 1));
    // Centre an axis that fits. One that overflows at the readable floor anchors at the
    // padding (the root card stays on screen horizontally) instead of zooming out further.
    const nx =
      layout.w * z <= r.width - FIT_PAD * 2
        ? (r.width - layout.w * z) / 2
        : Math.min(r.width / 2 - layout.rootCx * z, FIT_PAD);
    const ny = layout.h * z <= r.height - FIT_PAD * 2 ? (r.height - layout.h * z) / 2 : FIT_PAD;
    setView((prev) =>
      Math.abs(nx - prev.x) < 0.5 && Math.abs(ny - prev.y) < 0.5 && z === prev.z
        ? prev
        : { x: nx, y: ny, z },
    );
  }, [layout.w, layout.h, layout.rootCx]);

  // Auto-fit on mount and whenever the layout size changes (nodes appearing,
  // cards growing), unless the user has panned/zoomed manually.
  useEffect(() => {
    if (!userMoved.current) fit();
  }, [fit]);

  // Pan so an off-screen card (an opened agent, a keyboard-focused card) comes into view,
  // clear of the detail drawer that slides over the right edge.
  const reveal = useCallback((p: Placed, h: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const drawerW = document.querySelector('.drawer')?.getBoundingClientRect().width ?? 0;
    const width = drawerW < r.width ? r.width - drawerW : r.width;
    setView((v) => {
      const left = p.x * v.z + v.x;
      const top = p.y * v.z + v.y;
      if (left >= 0 && top >= 0 && left + CARD_W * v.z <= width && top + h * v.z <= r.height) return v;
      userMoved.current = true;
      return { ...v, x: width / 2 - (p.x + CARD_W / 2) * v.z, y: r.height / 2 - (p.y + h / 2) * v.z };
    });
  }, []);

  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (openNodeId == null) {
      revealed.current = null;
      return;
    }
    const p = placedById.get(openNodeId);
    if (!p || revealed.current === openNodeId) return;
    revealed.current = openNodeId;
    reveal(p, heights[openNodeId] ?? NOMINAL_H);
  }, [openNodeId, placedById, heights, reveal]);

  const zoomBy = useCallback((factor: number) => {
    userMoved.current = true;
    setView((v) => {
      const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * factor));
      const el = wrapRef.current;
      const k = z / v.z;
      if (!el) return { ...v, z };
      const r = el.getBoundingClientRect();
      const cx = r.width / 2;
      const cy = r.height / 2;
      return { z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('.perm, textarea, pre')) return;
      e.preventDefault();
      userMoved.current = true;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        setView((v) => {
          const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * Math.exp(-e.deltaY * 0.0025)));
          const k = z / v.z;
          return { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
        });
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Pan with one pointer, pinch-zoom with two. touch-action: none keeps the touch
  // gesture on the canvas; no pointer capture so cards keep receiving clicks.
  // A >5px move sets a guard that suppresses the stray click on release.
  const ptsRef = useRef(new Map<number, { x: number; y: number; sx: number; sy: number }>());
  const pinchRef = useRef<{ dist: number; mx: number; my: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as Element;
    if (typeof target.closest === 'function') {
      // A card's open button covers the whole card, so a drag may start on it; other controls keep their click.
      const control = target.closest('button');
      if (control && !control.classList.contains('agent-open')) return;
      if (target.closest('.perm, input, textarea, select, pre')) return;
    }
    dragMoved.current = false;
    ptsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    pinchRef.current = null;
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const pts = ptsRef.current;
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: prev.sx, sy: prev.sy });

      if (pts.size === 1) {
        if (!dragMoved.current && Math.abs(e.clientX - prev.sx) + Math.abs(e.clientY - prev.sy) > 5) {
          dragMoved.current = true;
          userMoved.current = true;
          wrapRef.current?.classList.add('is-dragging');
        }
        if (!dragMoved.current) return;
        e.preventDefault();
        setView((v) => ({ ...v, x: v.x + (e.clientX - prev.x), y: v.y + (e.clientY - prev.y) }));
        return;
      }

      // Two pointers: pinch-zoom around the midpoint, and pan with it.
      const [a, b] = Array.from(pts.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const g = pinchRef.current;
      if (g && g.dist > 0) {
        e.preventDefault();
        dragMoved.current = true;
        userMoved.current = true;
        const panX = mx - g.mx;
        const panY = my - g.my;
        setView((v) => {
          const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * (dist / g.dist)));
          const el = wrapRef.current;
          if (!el) return { ...v, z };
          const r = el.getBoundingClientRect();
          const px = mx - r.left;
          const py = my - r.top;
          const k = z / v.z;
          return { z, x: px - (px - v.x) * k + panX, y: py - (py - v.y) * k + panY };
        });
      }
      pinchRef.current = { dist, mx, my };
    };
    const onUp = (e: PointerEvent) => {
      ptsRef.current.delete(e.pointerId);
      pinchRef.current = null;
      if (ptsRef.current.size === 0) wrapRef.current?.classList.remove('is-dragging');
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  // Measure card heights so connectors meet card edges and rows don't overlap.
  const roRef = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    if (!roRef.current) {
      roRef.current = new ResizeObserver((entries) => {
        setHeights((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.nodeId;
            if (!id) continue;
            const h = Math.ceil(entry.contentRect.height);
            if (next[id] !== h) {
              next[id] = h;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      });
    }
    const els = Array.from(layer.querySelectorAll<HTMLElement>('.node'));
    const live = new Set<string>();
    for (const el of els) {
      const id = el.dataset.nodeId;
      if (id) live.add(id);
    }
    // Nodes that are gone (folded away, or after switching sessions) leave a stale
    // element behind: stop observing it and forget the id.
    for (const [id, el] of observed.current) {
      if (!live.has(id)) {
        roRef.current.unobserve(el);
        observed.current.delete(id);
      }
    }
    for (const el of els) {
      const id = el.dataset.nodeId;
      if (!id) continue;
      if (observed.current.get(id) !== el) {
        const prev = observed.current.get(id);
        if (prev) roRef.current.unobserve(prev);
        observed.current.set(id, el);
        roRef.current.observe(el);
      }
    }
    // Drop heights of gone nodes, but only when any are stale.
    setHeights((prev) => {
      let stale = false;
      for (const key of Object.keys(prev)) {
        if (!live.has(key)) {
          stale = true;
          break;
        }
      }
      if (!stale) return prev;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (!live.has(key)) delete next[key];
      }
      return next;
    });
  });
  useEffect(() => () => roRef.current?.disconnect(), []);

  // Folding replaces the control that was clicked: hand keyboard focus to its counterpart.
  useLayoutEffect(() => {
    const key = focusKey.current;
    const layer = layerRef.current;
    if (!key || !layer) return;
    focusKey.current = null;
    // key is `fold:<parentId>` (the chip on that parent) or `done:<parentId>` (the Done node, whose node id is the key).
    const fold = key.startsWith('fold:');
    const nodeId = fold ? key.slice('fold:'.length) : key;
    const host = Array.from(layer.querySelectorAll<HTMLElement>('.node')).find((el) => el.dataset.nodeId === nodeId);
    host?.querySelector<HTMLElement>(fold ? '.fold-chip' : '.agent-open')?.focus({ preventScroll: true });
  }, [expanded]);

  const edges = useMemo(() => {
    // Children inside a wrapped grid get no individual edges: the band carries one.
    const memberOf = new Set<string>();
    for (const g of layout.groups) for (const id of g.members) memberOf.add(id);
    const out: Array<{ key: string; d: string; live: boolean }> = [];
    for (const g of layout.groups) {
      const parent = placedById.get(g.parentId);
      if (!parent) continue;
      const px = parent.x + CARD_W / 2;
      const py = parent.y + (heights[parent.node.id] ?? NOMINAL_H);
      const live = g.members.some((id) => {
        const m = placedById.get(id);
        return m != null && isLive(stateOf(m.node));
      });
      out.push({ key: `${g.parentId}=>group`, d: elbow(px, py, g.x + g.w / 2, g.y), live });
    }
    for (const p of layout.placed) {
      if (memberOf.has(p.node.id)) continue;
      const parent = p.node.parentId ? placedById.get(p.node.parentId) : undefined;
      if (!parent) continue;
      // A cycle back-reference (parent at the same depth or deeper) gets no edge.
      if (parent.y >= p.y) continue;
      const px = parent.x + CARD_W / 2;
      const py = parent.y + (heights[parent.node.id] ?? NOMINAL_H);
      out.push({
        key: `${parent.node.id}->${p.node.id}`,
        d: elbow(px, py, p.x + CARD_W / 2, p.y),
        live: isLive(stateOf(p.node)),
      });
    }
    return out;
  }, [layout, placedById, heights, stateOf]);

  // Reading order for keyboard and screen readers: row by row.
  const ordered = useMemo(() => [...layout.placed].sort((a, b) => a.y - b.y || a.x - b.x), [layout.placed]);

  // Never run a click that ended a drag.
  const guarded = (fn: () => void) => () => {
    if (!dragMoved.current) fn();
  };

  // The browser scrolls the clipped canvas to a focused off-screen card; undo that and pan instead.
  const onFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const wrap = e.currentTarget;
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
    const id = (e.target as Element).closest<HTMLElement>('.node')?.dataset.nodeId;
    const p = id ? placedById.get(id) : undefined;
    if (p && id) reveal(p, heights[id] ?? NOMINAL_H);
  };

  const empty = nodes.length === 0;
  const lonely = nodes.length === 1;

  return (
    <div
      className="canvas"
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onFocus={onFocus}
      onScroll={(e) => {
        e.currentTarget.scrollLeft = 0;
        e.currentTarget.scrollTop = 0;
      }}
      role="region"
      aria-label="Agent map"
    >
      <div
        className="canvas-layer"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
          width: layout.w,
          height: layout.h,
        }}
      >
        <svg className="edges" width={layout.w} height={layout.h} aria-hidden="true">
          {edges.map((e) => (
            <path key={e.key} d={e.d} className={e.live ? 'is-live' : undefined} />
          ))}
        </svg>
        {layout.groups.map((g) => (
          <div
            key={`band-${g.parentId}`}
            className="node-band"
            aria-hidden="true"
            style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
          />
        ))}
        <ul className="canvas-nodes" ref={layerRef} aria-label="Agents">
          {ordered.map(({ node, x, y }) => {
            const group = fold.groups.get(node.id);
            return (
              <li key={node.id} className="node" data-node-id={node.id} style={{ left: x, top: y }}>
                {group ? (
                  <DoneCard
                    group={group}
                    elapsed={group.members.reduce(
                      (sum, m) => sum + nodeElapsedMs(m, now, taskByNode.get(m.id), workersAt),
                      0,
                    )}
                    onExpand={guarded(() => setParent(group.parentId, true))}
                  />
                ) : (
                  <NodeCard
                    root={node.parentId === null}
                    node={node}
                    now={now}
                    task={taskByNode.get(node.id)}
                    workersAt={workersAt}
                    permission={permByNode.get(node.id)}
                    open={openNodeId === node.id}
                    onOpen={guarded(() => onOpen(node.id))}
                    onDecide={onDecide}
                    untrusted={untrusted}
                  />
                )}
                {!group && expanded.has(node.id) && fold.foldable.has(node.id) && (
                  <button
                    type="button"
                    className="fold-chip"
                    aria-expanded="true"
                    aria-label={`Fold ${fold.foldable.get(node.id)} done agents`}
                    onClick={guarded(() => setParent(node.id, false))}
                  >
                    <ChevronIcon size={12} className="fold-chip-icon" />
                    Fold ({fold.foldable.get(node.id)})
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {empty && <p className="canvas-note">No agents yet. They appear here as soon as the session starts one.</p>}
      {lonely && permByNode.size === 0 && <p className="canvas-note">No subagents or workers yet. They show up here when the lead delegates.</p>}

      <div className="canvas-tools">
        {fold.foldable.size > 0 && (
          <button type="button" className="canvas-tool-text" onClick={toggleAll}>
            {allOpen ? 'Fold all' : 'Expand all'}
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
          <ZoomOutIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
          <ZoomInIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Fit map to view"
          onClick={() => {
            userMoved.current = false;
            fit();
          }}
        >
          <FitIcon />
        </button>
      </div>
    </div>
  );
}
