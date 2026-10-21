// Galaxy page client: scroll progress (GSAP ScrollTrigger) -> scene; scene frames -> DOM (copy opacity, typed task,
// planet labels pinned to projected 3D positions). Three.js loads lazily, only when WebGL is available.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { detectTier } from '../../lib/galaxy/shared.ts';
import { beatOpacity, lateOpacity, mergeOpacity, STATIC_POSE, typedChars } from '../../lib/galaxy/path.ts';
import type { GalaxyFrame, GalaxyScene, NodeInfo } from '../../lib/galaxy/scene.ts';

gsap.registerPlugin(ScrollTrigger);

const root = document.querySelector<HTMLElement>('[data-gx]');
const html = document.documentElement;

async function boot(): Promise<void> {
  if (!root) return;
  const canvas = root.querySelector<HTMLCanvasElement>('[data-gx-canvas]');
  const track = root.querySelector<HTMLElement>('[data-gx-track]');
  const dataEl = document.getElementById('gx-data');
  if (!canvas || !track || !dataEl) return;
  const data = JSON.parse(dataEl.textContent || '{}') as { workers: NodeInfo[]; task: string };

  const tier = detectTier();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (tier === 'fallback') {
    html.classList.add('gx-nogl');
    return;
  }

  const sec = (id: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-beat="${id}"]`);
  const hero = sec('hero');
  const task = sec('task');
  const plan = sec('plan');
  const fan = sec('fan');
  const build = sec('build');
  const verify = sec('verify');
  const cron = sec('cron');
  const merge = sec('merge');
  const closeEls = [...root.querySelectorAll<HTMLElement>('[data-close]')];
  const typed = root.querySelector<HTMLElement>('[data-typed]');
  const rest = root.querySelector<HTMLElement>('[data-rest]');
  const approved = root.querySelector<HTMLElement>('[data-approved]');
  const nodesEl = root.querySelector<HTMLElement>('[data-nodes]');
  const labelEls = nodesEl ? [...nodesEl.querySelectorAll<HTMLElement>('[data-node]')] : [];
  let lastChars = -1;
  let focusKeep = -1;
  let seen = new Set<number>();
  const pos: { x: number; y: number }[] = labelEls.map(() => ({ x: 0, y: 0 }));
  const tagsOf = labelEls.map((el) => ({
    fail: el.querySelector<HTMLElement>('[data-tag="fail"]'),
    fixed: el.querySelector<HTMLElement>('[data-tag="fixed"]'),
    rev: el.querySelector<HTMLElement>('[data-tag="rev"]'),
    fixer: el.querySelector<HTMLElement>('[data-tag="fixer"]'),
  }));
  const tagBoxes = labelEls.map((el) => el.querySelector<HTMLElement>('.gx-node-tags'));
  const POSE_ORDER = ['nebula', 'core', 'constellation', 'fan', 'build', 'verify', 'cron', 'merge', 'close'] as const;
  let pose: keyof typeof STATIC_POSE = 'nebula';
  const setTag = (el: HTMLElement | null, v: number): boolean => {
    if (!el) return false;
    const on = v > 0.04;
    const d = on ? 'inline-block' : 'none';
    if (el.style.display !== d) el.style.display = d;
    if (on) el.style.opacity = Math.min(1, v).toFixed(3);
    return on;
  };

  const setOpacity = (el: HTMLElement | null, o: number): void => {
    if (!el) return;
    el.style.opacity = o.toFixed(3);
    el.style.visibility = o < 0.01 ? 'hidden' : 'visible';
  };

  const onFrame = (f: GalaxyFrame): void => {
    const p = f.p;
    const live = html.classList.contains('gx-live');
    const u = f.u;
    const mm = f.m;
    const poseI = POSE_ORDER.indexOf(pose);
    const pillO = live ? beatOpacity.plan(p) * mergeOpacity.verifyOut(mm) : poseI >= 2 && poseI <= 6 ? 1 : 0;
    const planO = live ? beatOpacity.plan(p) * lateOpacity.planOut(u) : pose === 'constellation' ? 1 : 0;
    if (live) {
      setOpacity(hero, beatOpacity.hero(p));
      setOpacity(task, beatOpacity.task(p));
      setOpacity(plan, planO);
      setOpacity(fan, lateOpacity.fan(u));
      setOpacity(build, lateOpacity.build(u));
      setOpacity(verify, lateOpacity.verify(u) * mergeOpacity.verifyOut(mm));
      setOpacity(merge, mergeOpacity.copy(mm));
      const h = hero?.firstElementChild as HTMLElement | null;
      if (h) h.style.transform = `translate3d(0, ${(-24 * (1 - beatOpacity.hero(p))).toFixed(1)}px, 0)`;
      if (typed && rest && data.task) {
        const n = typedChars(p, data.task.length);
        if (n !== lastChars) {
          lastChars = n;
          typed.textContent = data.task.slice(0, n);
          rest.textContent = data.task.slice(n);
        }
      }
    }
    setOpacity(approved, live ? beatOpacity.approved(p) : planO);
    // Each worker pill sits on the far side of its star, radially outward from Opus (node 0); Opus's own pill sits just below it.
    // A rectangle solver then separates overlaps, keeps pills clear of the copy block and inside the viewport, and a leader line
    // (CSS vars, drawn by .gx-node::after) ties each pill to its star.
    // the pills live in a fixed inset-0 box: that box is the visible area (html.clientWidth can read wider than it, e.g. with a
    // classic scrollbar, so a pill clamped to it would be clipped at the right edge)
    const box = labelEls[0]?.parentElement;
    const vw = Math.min(html.clientWidth, box?.clientWidth || Infinity, innerWidth);
    const vh = innerHeight;
    const phone = vw < 768;
    const M = 9;
    const topMin = 60;
    const G = 6;
    // phones: pills collapse to slug + helper dot, except the nearest star (largest on screen), which keeps its description
    let focus = -1;
    if (phone) {
      let best = 0;
      let cur = 0;
      f.nodes.forEach((n, i) => {
        if (i === 0 || !n.front) return;
        const r = n.rad * n.on;
        if (r > best) { best = r; focus = i; }
        if (i === focusKeep) cur = r;
      });
      if (focusKeep > 0 && cur > 0 && cur * 1.15 >= best) focus = focusKeep;
      focusKeep = focus;
    }
    labelEls.forEach((el, i) => {
      const n = f.nodes[i];
      const t = tagsOf[i];
      if (live || pose !== 'nebula') {
        setTag(t.fail, live ? n.bad : n.ok + n.bad);
        setTag(t.fixed, n.ok);
        setTag(t.rev, n.rev);
        setTag(t.fixer, u >= 0.6 ? n.on : 0);
        el.classList.toggle('is-bad', n.bad > 0.5);
        el.classList.toggle('is-ok', n.ok > 0.5);
      }
      el.classList.toggle('is-compact', phone && i !== focus);
    });
    const tagsShown = (i: number): number => [tagsOf[i].fail, tagsOf[i].fixed, tagsOf[i].rev, tagsOf[i].fixer].filter((x) => x && x.style.display === 'inline-block').length;
    const op = f.nodes[0];
    type Item = { i: number; sx: number; sy: number; rad: number; pw: number; ph: number; W: number; H: number; l: number; t: number; vis: number };
    const items: Item[] = [];
    labelEls.forEach((el, i) => {
      const n = f.nodes[i];
      const vis = n.front ? Math.min(1, n.on * 1.4) * pillO : 0;
      if (vis < 0.02) return;
      const pw = el.offsetWidth || 120;
      const ph = el.offsetHeight || 26;
      const tb = tagBoxes[i];
      const has = tagsShown(i) > 0 && tb;
      const W = Math.max(pw, has ? tb.offsetWidth : 0);
      const H = ph + (has ? tb.offsetHeight + 5 : 0);
      const rad = Math.max(n.rad || 14, 8);
      let cx = n.x;
      let cy = n.y + rad + 8 + ph / 2;
      if (i > 0) {
        let dx = n.x - op.x;
        let dy = n.y - op.y;
        const len = Math.hypot(dx, dy);
        if (len < 2) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
        const te = Math.min(dx === 0 ? Infinity : pw / 2 / Math.abs(dx), dy === 0 ? Infinity : ph / 2 / Math.abs(dy));
        const dist = rad + 14 + te;
        cx = n.x + dx * dist;
        cy = n.y + dy * dist;
      }
      items.push({ i, sx: n.x, sy: n.y, rad, pw, ph, W, H, l: cx - W / 2, t: cy - ph / 2, vis });
    });
    // the copy block of whichever beat is showing (opacity-weighted so crossfades do not jump)
    let ex = 0;
    let ey = 0;
    {
      const ws: [HTMLElement | null, number][] = live
        ? [[plan, planO], [fan, lateOpacity.fan(u)], [build, lateOpacity.build(u)], [verify, lateOpacity.verify(u) * mergeOpacity.verifyOut(mm)]]
        : [[plan, pose === 'constellation' ? 1 : 0], [fan, pose === 'fan' ? 1 : 0], [build, pose === 'build' ? 1 : 0], [verify, pose === 'verify' ? 1 : 0], [cron, pose === 'cron' ? 1 : 0]];
      let tw = 0;
      for (const [el, wgt] of ws) {
        const inner = el?.firstElementChild as HTMLElement | null;
        if (!inner || wgt < 0.01) continue;
        const r = inner.getBoundingClientRect();
        ex += wgt * r.right;
        ey += wgt * Math.max(0, r.bottom);
        tw += wgt;
      }
      if (tw > 0) {
        ex = ex / tw + M;
        ey = ey / tw + M;
      }
    }
    // the 3D nodes are soft obstacles: a pill never sits over a star
    const discs = f.nodes.filter((n) => n.on * pillO > 0.2 && n.front).map((n) => { const r = Math.max(n.rad, 10) + 3; return { x: n.x - r, y: n.y - r, w: 2 * r, h: 2 * r }; });
    const clamp = (a: Item): void => {
      a.l = Math.min(Math.max(a.l, M), Math.max(M, vw - M - a.W));
      a.t = Math.min(Math.max(a.t, topMin), Math.max(topMin, vh - M - a.H));
    };
    items.forEach(clamp);
    for (let pass = 0; pass < 80; pass++) {
      const soft = pass < 50; // stars are a preference; the copy block, pill-vs-pill and the viewport edge always win
      let moved = false;
      for (let k = 0; k < items.length; k++) {
        const a = items[k];
        if (ey > M && a.l < ex && a.t < ey) {
          if (ex - a.l < (ey - a.t) * 1.2 && ex + a.W < vw - M) a.l = ex; else a.t = ey;
          moved = true;
        }
        if (soft) {
          for (const o of discs) {
            if (a.l >= o.x + o.w || o.x >= a.l + a.W || a.t >= o.y + o.h || o.y >= a.t + a.H) continue;
            moved = true;
            const cands = [o.x + o.w + G - a.l, o.x - G - (a.l + a.W), o.y + o.h + G - a.t, o.y - G - (a.t + a.H)];
            // push along the pill's outward (radial) axis first: the smallest of the four exits wins
            let bi = 0;
            cands.forEach((c, ci) => { if (Math.abs(c) < Math.abs(cands[bi])) bi = ci; });
            if (bi < 2) a.l += cands[bi]; else a.t += cands[bi];
          }
        }
        for (let m = 0; m < k; m++) {
          const b = items[m];
          const ox = Math.min(a.l + a.W, b.l + b.W) - Math.max(a.l, b.l) + G;
          const oy = Math.min(a.t + a.H, b.t + b.H) - Math.max(a.t, b.t) + G;
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (ox < oy) {
            const d = ox / 2;
            if (a.l + a.W / 2 < b.l + b.W / 2) { a.l -= d; b.l += d; } else { a.l += d; b.l -= d; }
          } else {
            const d = oy / 2;
            if (a.t + a.H / 2 < b.t + b.H / 2) { a.t -= d; b.t += d; } else { a.t += d; b.t -= d; }
          }
          clamp(b);
        }
        clamp(a);
      }
      if (!moved && pass >= 50) break;
      if (!moved) pass = 49;
    }
    const seenNow = new Set<number>();
    items.forEach((q) => {
      const el = labelEls[q.i];
      let x = q.l + (q.W - q.pw) / 2;
      let y = q.t;
      // smooth over frames so pills do not jitter while scrolling; first appearance and reduced motion place directly
      if (!reduced && seen.has(q.i)) {
        const o = pos[q.i];
        x = o.x + (x - o.x) * 0.3;
        y = o.y + (y - o.y) * 0.3;
        if (Math.abs(x - q.l - (q.W - q.pw) / 2) < 0.3) x = q.l + (q.W - q.pw) / 2;
        if (Math.abs(y - q.t) < 0.3) y = q.t;
      }
      // the smoothing lags the solved position (and a pill that just expanded is wider than it was): never let it leave the viewport
      const ov = (q.W - q.pw) / 2;
      x = Math.min(Math.max(x, M + ov), Math.max(M + ov, vw - M - q.pw - ov));
      y = Math.min(Math.max(y, topMin), Math.max(topMin, vh - M - q.H));
      pos[q.i] = { x, y };
      seenNow.add(q.i);
      // leader: from the star's rim to the nearest point of the pill, drawn by a 100px-wide ::after scaled and rotated
      const qx = Math.min(Math.max(q.sx, x), x + q.pw);
      const qy = Math.min(Math.max(q.sy, y), y + q.ph);
      const vx = qx - q.sx;
      const vy = qy - q.sy;
      const L = Math.hypot(vx, vy);
      const r0 = q.rad * 0.9;
      const len = Math.max(0, L - r0);
      const ux = L > 0 ? vx / L : 0;
      const uy = L > 0 ? vy / L : 1;
      el.style.setProperty('--lx', `${(q.sx + ux * r0 - x).toFixed(1)}px`);
      el.style.setProperty('--ly', `${(q.sy + uy * r0 - y).toFixed(1)}px`);
      el.style.setProperty('--la', `${Math.atan2(vy, vx).toFixed(4)}rad`);
      el.style.setProperty('--ls', len < 4 ? '0' : (len / 100).toFixed(4));
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      el.style.opacity = q.vis.toFixed(3);
    });
    seen = seenNow;
    labelEls.forEach((el, i) => {
      if (!seenNow.has(i)) el.style.opacity = '0';
    });
  };

  let scene: GalaxyScene;
  try {
    const { createGalaxy } = await import('../../lib/galaxy/scene.ts');
    scene = createGalaxy(canvas, { tier, workers: data.workers, reducedMotion: reduced, onFrame });
  } catch {
    html.classList.add('gx-nogl');
    return;
  }

  if (reduced) {
    html.classList.add('gx-still');
    const sections: [HTMLElement | null, keyof typeof STATIC_POSE][] = [[hero, 'nebula'], [task, 'core'], [plan, 'constellation'], [fan, 'fan'], [build, 'build'], [verify, 'verify'], [cron, 'cron'], [merge, 'merge'], ...closeEls.map((el): [HTMLElement, keyof typeof STATIC_POSE] => [el, 'close'])];
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const hit = sections.find(([el]) => el === e.target);
        if (hit) {
          pose = hit[1];
          scene.setProgress(STATIC_POSE[pose]);
        }
      }
    }, { threshold: 0.55 });
    sections.forEach(([el]) => el && io.observe(el));
    scene.setProgress(STATIC_POSE.nebula);
    addEventListener('pagehide', () => { io.disconnect(); scene.dispose(); });
    return;
  }

  html.classList.add('gx-live');
  const st = ScrollTrigger.create({
    trigger: track,
    start: 'top top',
    end: 'bottom bottom',
    onUpdate: (self) => {
      scene.setProgress(self.progress);
    },
    onRefresh: (self) => scene.setProgress(self.progress),
  });
  scene.setProgress(st.progress);
  const io = new IntersectionObserver((entries) => scene.setActive(entries.some((e) => e.isIntersecting)), { rootMargin: '10% 0px' });
  io.observe(root);
  const move = (e: PointerEvent): void => scene.setPointer((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
  addEventListener('pointermove', move, { passive: true });
  addEventListener('pagehide', () => {
    removeEventListener('pointermove', move);
    io.disconnect();
    st.kill();
    scene.dispose();
  });
}

void boot();

// install command: copy button (no-op without the block)
{
  const copyBtn = document.getElementById('gx-install-copy');
  const copyCode = document.getElementById('gx-install-code');
  const copyStatus = document.getElementById('gx-install-status');
  copyBtn?.addEventListener('click', () => {
    const done = (label: string, note: string): void => {
      if (copyBtn) copyBtn.textContent = label;
      if (copyStatus) copyStatus.textContent = note;
      window.setTimeout(() => { if (copyBtn) copyBtn.textContent = 'Copy'; }, 2000);
    };
    const select = (): void => { if (copyCode) window.getSelection()?.selectAllChildren(copyCode); };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(copyCode?.textContent ?? '').then(() => done('Copied', 'Copied')).catch(() => { select(); done('Copy', 'Copy failed: the command is selected, press Ctrl+C'); });
    } else {
      select();
      done('Copy', 'Copy unavailable: the command is selected, press Ctrl+C');
    }
  });
}
