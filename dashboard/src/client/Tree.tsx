// The tree canvas: own tidy layout (no libraries), SVG connectors, pan/zoom/fit.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AgentNode, PermissionRequest, WorkerTask } from '../shared/types';
import { NodeCard } from './NodeCard';
import { FitIcon, ZoomInIcon, ZoomOutIcon } from './icons';

const CARD_W = 232;
const H_GAP = 20;
const Y_GAP = 40;
const NOMINAL_H = 60;
const MIN_Z = 0.25;
const MAX_Z = 2.5;
const FIT_PAD = 24;
/** Parents whose children are all leaves wrap them into rows of this many cards. */
const WRAP_COLS = 5;

interface Placed {
  node: AgentNode;
  x: number; // left edge of the card
  y: number; // top edge
}

interface GroupBox {
  parentId: string;
  members: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  live: boolean;
}

interface Layout {
  placed: Placed[];
  groups: GroupBox[];
  w: number;
  h: number;
}

/** Header strip above a wrapped leaf grid + padding around its cards. */
const GROUP_PAD = 10;
const GROUP_HEAD = 20;

/** Leaves take consecutive x slots; parents centre over their children; depth maps to y.
 * A parent with many leaf children wraps them into a grid so the tree stays readable. */
function computeLayout(nodes: AgentNode[], heights: Record<string, number>): Layout {
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

  const place = (id: string, d: number): number => {
    depth.set(id, d);
    const list = kids.get(id);
    let cx: number;
    if (!list || list.length === 0) {
      cx = cursor * slot + CARD_W / 2;
      cursor += 1;
    } else if (list.length > WRAP_COLS && list.every((k) => !kids.has(k))) {
      const cols = WRAP_COLS;
      const base = cursor;
      list.forEach((k, i) => {
        depth.set(k, d + 1 + Math.floor(i / cols));
        x.set(k, (base + (i % cols)) * slot + CARD_W / 2);
      });
      cursor += cols;
      cx = base * slot + (cols * slot - H_GAP) / 2;
      wrapGroups.push({ parentId: id, kids: [...list] });
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
    x.set(id, cx);
    return cx;
  };
  for (const r of roots) place(r, 0);

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

  // Wrapped leaf grids: shift children down for the header strip, then box them.
  const groupedIds = new Set<string>();
  for (const g of wrapGroups) for (const k of g.kids) groupedIds.add(k);
  for (const p of placed) {
    if (groupedIds.has(p.node.id)) p.y += GROUP_HEAD;
  }

  const groups: GroupBox[] = wrapGroups.map((g) => {
    const members = placed.filter((p) => g.kids.includes(p.node.id));
    const left = Math.min(...members.map((p) => p.x));
    const right = Math.max(...members.map((p) => p.x + CARD_W));
    const top = Math.min(...members.map((p) => p.y));
    const bottom = Math.max(...members.map((p) => p.y + (heights[p.node.id] ?? NOMINAL_H)));
    return {
      parentId: g.parentId,
      members: g.kids,
      x: left - GROUP_PAD,
      y: top - GROUP_HEAD - GROUP_PAD,
      w: right - left + GROUP_PAD * 2,
      h: bottom - top + GROUP_HEAD + GROUP_PAD * 2,
      count: g.kids.length,
      live: members.some((p) => p.node.status === 'running'),
    };
  });

  let w = Math.max(1, cursor > 0 ? cursor * slot - H_GAP : 1);
  let h = Math.max(1, maxH.length > 0 ? acc - Y_GAP : 1);
  for (const g of groups) {
    w = Math.max(w, g.x + g.w);
    h = Math.max(h, g.y + g.h);
  }
  return { placed, groups, w, h };
}

interface Props {
  nodes: AgentNode[];
  permissions: PermissionRequest[];
  workers: WorkerTask[];
  workersAt: number;
  now: number;
  openNodeId: string | null;
  onOpen: (nodeId: string) => void;
  onDecide: (permission: PermissionRequest, allow: boolean, message?: string) => void;
}

interface View {
  x: number;
  y: number;
  z: number;
}

export function Tree({ nodes, permissions, workers, workersAt, now, openNodeId, onOpen, onDecide }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: FIT_PAD, y: FIT_PAD, z: 1 });
  const [heights, setHeights] = useState<Record<string, number>>({});
  const userMoved = useRef(false);
  const dragMoved = useRef(false);

  const layout = useMemo(() => computeLayout(nodes, heights), [nodes, heights]);

  // Live WorkerTask per worker node: same sessionId+nodeId, else same lane+slug.
  const taskByNode = useMemo(() => {
    const m = new Map<string, WorkerTask>();
    if (workers.length === 0) return m;
    for (const n of nodes) {
      if (n.kind !== 'worker') continue;
      const t = workers.find(
        (w) =>
          (w.sessionId != null && w.nodeId != null && w.sessionId === n.sessionId && w.nodeId === n.id) ||
          (n.worker != null && w.lane === n.worker.lane && w.slug === n.worker.slug),
      );
      if (t) m.set(n.id, t);
    }
    return m;
  }, [nodes, workers]);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const zw = (r.width - FIT_PAD * 2) / layout.w;
    const zh = (r.height - FIT_PAD * 2) / layout.h;
    const z = Math.max(MIN_Z, Math.min(zw, zh, 1));
    setView({
      x: (r.width - layout.w * z) / 2,
      y: (r.height - layout.h * z) / 2,
      z,
    });
  }, [layout.w, layout.h]);

  // Auto-fit on mount and whenever the layout size changes (nodes appearing,
  // cards growing), unless the user has panned/zoomed manually.
  useEffect(() => {
    if (!userMoved.current) fit();
  }, [fit]);

  const zoomBy = useCallback((factor: number) => {
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
  const observed = useRef(new Set<string>());
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
    for (const el of Array.from(layer.querySelectorAll<HTMLElement>('.node'))) {
      const id = el.dataset.nodeId;
      if (id && !observed.current.has(id)) {
        observed.current.add(id);
        roRef.current.observe(el);
      }
    }
  });
  useEffect(() => () => roRef.current?.disconnect(), []);

  // Connectors: rounded orthogonal elbows from parent bottom-centre to child
  // top-centre (or to a wrapped group's top-centre). 8px corner radius.
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

  const edges = useMemo(() => {
    const byId = new Map(layout.placed.map((p) => [p.node.id, p] as const));
    // Children inside a wrapped grid get no individual edges.
    const memberOf = new Set<string>();
    for (const g of layout.groups) for (const id of g.members) memberOf.add(id);
    const out: Array<{ key: string; d: string; live: boolean }> = [];
    for (const g of layout.groups) {
      const parent = byId.get(g.parentId);
      if (!parent) continue;
      const px = parent.x + CARD_W / 2;
      const py = parent.y + (heights[parent.node.id] ?? NOMINAL_H);
      const cx = g.x + g.w / 2;
      const cy = g.y;
      out.push({ key: `${g.parentId}=>group`, d: elbow(px, py, cx, cy), live: g.live });
    }
    for (const p of layout.placed) {
      if (memberOf.has(p.node.id)) continue;
      const parent = p.node.parentId ? byId.get(p.node.parentId) : undefined;
      if (!parent) continue;
      const px = parent.x + CARD_W / 2;
      const py = parent.y + (heights[parent.node.id] ?? NOMINAL_H);
      const cx = p.x + CARD_W / 2;
      const cy = p.y;
      out.push({
        key: `${parent.node.id}->${p.node.id}`,
        d: elbow(px, py, cx, cy),
        live: p.node.status === 'running',
      });
    }
    return out;
  }, [layout, heights]);

  const permByNode = useMemo(() => {
    const m = new Map<string, PermissionRequest>();
    for (const p of permissions) if (!m.has(p.nodeId)) m.set(p.nodeId, p);
    return m;
  }, [permissions]);

  return (
    <div className="canvas" ref={wrapRef} onPointerDown={onPointerDown} aria-label="Agent tree canvas">
      <div
        className="canvas-layer"
        ref={layerRef}
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
            key={`group-${g.parentId}`}
            className="node-group"
            aria-hidden="true"
            style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
          >
            <span className="node-group-label">{g.count} agents</span>
          </div>
        ))}
        {layout.placed.map(({ node, x, y }) => (
          <div key={node.id} className="node" data-node-id={node.id} style={{ left: x, top: y }}>
            <NodeCard
              node={node}
              now={now}
              task={taskByNode.get(node.id)}
              workersAt={workersAt}
              permission={permByNode.get(node.id)}
              open={openNodeId === node.id}
              onOpen={() => onOpen(node.id)}
              onDecide={onDecide}
              clickGuard={() => dragMoved.current}
            />
          </div>
        ))}
      </div>
      <div className="canvas-tools">
        <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
          <ZoomOutIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
          <ZoomInIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Fit tree to view"
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
