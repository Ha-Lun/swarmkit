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
  const tagsOf = labelEls.map((el) => ({
    fail: el.querySelector<HTMLElement>('[data-tag="fail"]'),
    fixed: el.querySelector<HTMLElement>('[data-tag="fixed"]'),
    rev: el.querySelector<HTMLElement>('[data-tag="rev"]'),
    fixer: el.querySelector<HTMLElement>('[data-tag="fixer"]'),
  }));
  const tagBoxes = labelEls.map((el) => el.querySelector<HTMLElement>('.gx-node-tags'));
  const POSE_ORDER = ['galaxy', 'core', 'constellation', 'fan', 'build', 'verify', 'cron', 'merge', 'close'] as const;
  let pose: keyof typeof STATIC_POSE = 'galaxy';
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
    // pills sit centred just below their node ; neighbours that would overlap are pushed apart vertically
    const wide = canvas.clientWidth >= canvas.clientHeight * 1.2;
    // portrait phones/tablets and short landscape screens: a full overlap solver that also keeps pills inside the viewport
    const solve = !wide || innerWidth < 768 || innerHeight < 520;
    labelEls.forEach((el, i) => {
      const n = f.nodes[i];
      const t = tagsOf[i];
      if (live || pose !== 'galaxy') {
        setTag(t.fail, live ? n.bad : n.ok + n.bad);
        setTag(t.fixed, n.ok);
        setTag(t.rev, n.rev);
        setTag(t.fixer, u >= 0.6 ? n.on : 0);
        el.classList.toggle('is-bad', n.bad > 0.5);
        el.classList.toggle('is-ok', n.ok > 0.5);
      }
    });
    const place = labelEls.map((el, i) => {
      const n = f.nodes[i];
      const t = tagsOf[i];
      const w = el.offsetWidth || 120;
      const tags = [t.fail, t.fixed, t.rev, t.fixer].filter((x) => x && x.style.display === 'inline-block').length;
      const tb = tagBoxes[i];
      const tw = tags > 0 && tb ? tb.offsetWidth : 0;
      const th = tags > 0 && tb ? tb.offsetHeight + 5 : 0;
      const ph = el.offsetHeight || 26;
      const fixer = !solve && el.classList.contains('gx-node-fixer');
      const h = solve ? ph + th : 32 + tags * 19;
      const W = solve ? Math.max(w, tw) : w;
      const y = fixer ? n.y - 16 - h : n.y + (n.rad || 14) + 8;
      return { el, i, x: n.x - W / 2, y, w: W, pw: w, h };
    });
    if (solve) {
      const vw = innerWidth;
      const vh = innerHeight;
      const M = 9;
      const topMin = 60;
      // keep clear of the copy block of whichever beat is showing (opacity-weighted so crossfades do not jump)
      let ex = 0;
      let ey = 0;
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
      const G = 4;
      // the 3D nodes themselves are obstacles: a pill belongs under its own planet, not over a neighbour's
      const discs = f.nodes.filter((n) => n.on * pillO > 0.2).map((n) => { const r = Math.max(n.rad, 10) + 2; return { x: n.x - r, y: n.y - r, w: 2 * r, h: 2 * r }; });
      const order = [...place].sort((a, b) => a.y - b.y);
      for (let pass = 0; pass < 80; pass++) {
        const useDiscs = pass < 40; // planets are a soft preference: if the screen is too crowded, pills clearing each other wins
        let moved = false;
        for (let k = 0; k < order.length; k++) {
          const a = order[k];
          if (a.x < ex && a.y < ey && ey > M) {
            // clear of the copy block: sideways if that is the shorter way out (landscape), otherwise below it
            if (ex - a.x < (ey - a.y) * 1.2 && ex + a.w < vw - M) a.x = ex; else a.y = ey;
            moved = true;
          }
          for (const o of useDiscs ? discs : []) {
            if (a.x >= o.x + o.w || o.x >= a.x + a.w || a.y >= o.y + o.h || o.y >= a.y + a.h) continue;
            moved = true;
            const dn = o.y + o.h + G - a.y;
            const up = o.y - G - (a.y + a.h);
            const dr = o.x + o.w + G - a.x;
            const dl = o.x - G - (a.x + a.w);
            const dv = Math.abs(dn) < Math.abs(up) ? dn : up;
            const dh = Math.abs(dr) < Math.abs(dl) ? dr : dl;
            if (Math.abs(dh) < Math.abs(dv) * 0.6) a.x += dh; else a.y += dv;
          }
          for (let m = 0; m < k; m++) {
            const b = order[m];
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + G;
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + G;
            if (ox <= 0 || oy <= 0) continue;
            moved = true;
            const lower = a.y >= b.y ? a : b;
            const full = lower.y + oy + lower.h > vh - M; // no room left below: separate sideways
            if (ox < oy * 0.6 || full) {
              const d = ox / 2;
              if (a.x + a.w / 2 < b.x + b.w / 2) { a.x -= d; b.x += d; } else { a.x += d; b.x -= d; }
            } else if (a.y >= b.y) {
              a.y += oy;
            } else {
              b.y += oy;
            }
          }
          a.x = Math.min(Math.max(a.x, M), Math.max(M, vw - M - a.w));
          a.y = Math.min(Math.max(a.y, topMin), Math.max(topMin, vh - M - a.h));
        }
        if (!moved && pass >= 40) break;
        if (!moved) pass = 39;
      }
      place.forEach((q) => {
        q.x = Math.min(Math.max(q.x, M), Math.max(M, vw - M - q.w));
        q.y = Math.min(Math.max(q.y, topMin), Math.max(topMin, vh - M - q.h));
        q.x += (q.w - q.pw) / 2;
      });
    } else {
      place.sort((a, b) => a.y - b.y);
      for (let k = 1; k < place.length; k++) {
        for (let m = k - 1; m >= 0; m--) {
          const a = place[m];
          const b = place[k];
          if (Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < (a.w + b.w) / 2 + 6 && b.y - a.y < a.h + 2) b.y = a.y + a.h + 2;
        }
      }
    }
    place.forEach((q) => {
      const n = f.nodes[q.i];
      const vis = n.front ? Math.min(1, n.on * 1.4) * pillO : 0;
      q.el.style.transform = `translate3d(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px, 0)`;
      q.el.style.opacity = vis.toFixed(3);
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
  (window as unknown as { __gx?: GalaxyScene }).__gx = scene;

  if (reduced) {
    html.classList.add('gx-still');
    const sections: [HTMLElement | null, keyof typeof STATIC_POSE][] = [[hero, 'galaxy'], [task, 'core'], [plan, 'constellation'], [fan, 'fan'], [build, 'build'], [verify, 'verify'], [cron, 'cron'], [merge, 'merge'], ...closeEls.map((el): [HTMLElement, keyof typeof STATIC_POSE] => [el, 'close'])];
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
    scene.setProgress(STATIC_POSE.galaxy);
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
      scene.setScrollVelocity(self.getVelocity());
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
