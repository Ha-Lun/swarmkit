// The tree canvas: own tidy layout (no libraries), SVG connectors, pan/zoom/fit.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AgentNode, PermissionRequest } from '../shared/types';
import { NodeCard } from './NodeCard';
import { FitIcon, ZoomInIcon, ZoomOutIcon } from './icons';

const CARD_W = 260;
const H_GAP = 36;
const Y_GAP = 48;
const NOMINAL_H = 156;
const MIN_Z = 0.25;
const MAX_Z = 2.5;
const FIT_PAD = 24;

interface Placed {
  node: AgentNode;
  x: number; // left edge of the card
  y: number; // top edge
}

interface Layout {
  placed: Placed[];
  w: number;
  h: number;
}

/** Leaves take consecutive x slots; parents centre over their children; depth maps to y. */
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

  const place = (id: string, d: number): number => {
    depth.set(id, d);
    const list = kids.get(id);
    let cx: number;
    if (!list || list.length === 0) {
      cx = cursor * slot + CARD_W / 2;
      cursor += 1;
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

  const w = Math.max(1, cursor > 0 ? cursor * slot - H_GAP : 1);
  const h = Math.max(1, maxH.length > 0 ? acc - Y_GAP : 1);
  return { placed, w, h };
}

interface Props {
  nodes: AgentNode[];
  permissions: PermissionRequest[];
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

export function Tree({ nodes, permissions, now, openNodeId, onOpen, onDecide }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: FIT_PAD, y: FIT_PAD, z: 1 });
  const [heights, setHeights] = useState<Record<string, number>>({});
  const userMoved = useRef(false);
  const dragMoved = useRef(false);

  const layout = useMemo(() => computeLayout(nodes, heights), [nodes, heights]);

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

  // Pan by pointer drag. No pointer capture: cards keep receiving clicks;
  // a >5px drag sets a guard that suppresses the stray click on release.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el || e.button !== 0) return;
    const start = { px: e.clientX, py: e.clientY, ox: view.x, oy: view.y, moved: false };
    dragMoved.current = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      if (!start.moved && Math.abs(dx) + Math.abs(dy) > 5) {
        start.moved = true;
        dragMoved.current = true;
        userMoved.current = true;
        el.classList.add('is-dragging');
      }
      if (!start.moved) return;
      ev.preventDefault();
      setView((v) => ({ ...v, x: start.ox + dx, y: start.oy + dy }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.classList.remove('is-dragging');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

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

  // Connectors: cubic bezier from parent bottom-centre to child top-centre.
  const edges = useMemo(() => {
    const byId = new Map(layout.placed.map((p) => [p.node.id, p] as const));
    const out: Array<{ key: string; d: string }> = [];
    for (const p of layout.placed) {
      const parent = p.node.parentId ? byId.get(p.node.parentId) : undefined;
      if (!parent) continue;
      const px = parent.x + CARD_W / 2;
      const py = parent.y + (heights[parent.node.id] ?? NOMINAL_H);
      const cx = p.x + CARD_W / 2;
      const cy = p.y;
      const sag = Math.min(Y_GAP, Math.max(12, (cy - py) / 2));
      out.push({
        key: `${parent.node.id}->${p.node.id}`,
        d: `M ${px} ${py} C ${px} ${py + sag}, ${cx} ${Math.max(py + 4, cy - sag)}, ${cx} ${cy}`,
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
            <path key={e.key} d={e.d} />
          ))}
        </svg>
        {layout.placed.map(({ node, x, y }) => (
          <div key={node.id} className="node" data-node-id={node.id} style={{ left: x, top: y }}>
            <NodeCard
              node={node}
              now={now}
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
