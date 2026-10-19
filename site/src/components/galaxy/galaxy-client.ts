// Galaxy page client: scroll progress (GSAP ScrollTrigger) -> scene; scene frames -> DOM (copy opacity, typed task,
// node labels pinned to projected 3D positions). Three.js loads lazily, only when WebGL is available.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { detectTier } from '../../lib/swarm/scene.ts';
import { beatOpacity, STATIC_POSE, typedChars } from '../../lib/galaxy/path.ts';
import type { GalaxyFrame, GalaxyScene } from '../../lib/galaxy/scene.ts';

gsap.registerPlugin(ScrollTrigger);

const root = document.querySelector<HTMLElement>('[data-gx]');
const html = document.documentElement;

async function boot(): Promise<void> {
  if (!root) return;
  const canvas = root.querySelector<HTMLCanvasElement>('[data-gx-canvas]');
  const track = root.querySelector<HTMLElement>('[data-gx-track]');
  const dataEl = document.getElementById('gx-data');
  if (!canvas || !track || !dataEl) return;
  const data = JSON.parse(dataEl.textContent || '{}') as { workers: { slug: string; lane: 'opencode' | 'agy' }[]; task: string };

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
  const typed = root.querySelector<HTMLElement>('[data-typed]');
  const rest = root.querySelector<HTMLElement>('[data-rest]');
  const approved = root.querySelector<HTMLElement>('[data-approved]');
  const nodesEl = root.querySelector<HTMLElement>('[data-nodes]');
  const labelEls = nodesEl ? [...nodesEl.querySelectorAll<HTMLElement>('[data-node]')] : [];
  let lastChars = -1;
  let pose: keyof typeof STATIC_POSE = 'galaxy';

  const setOpacity = (el: HTMLElement | null, o: number): void => {
    if (!el) return;
    el.style.opacity = o.toFixed(3);
    el.style.visibility = o < 0.01 ? 'hidden' : 'visible';
  };

  const onFrame = (f: GalaxyFrame): void => {
    const p = f.p;
    const live = html.classList.contains('gx-live');
    const planO = live ? beatOpacity.plan(p) : pose === 'constellation' ? 1 : 0;
    if (live) {
      setOpacity(hero, beatOpacity.hero(p));
      setOpacity(task, beatOpacity.task(p));
      setOpacity(plan, planO);
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
    labelEls.forEach((el, i) => {
      const n = f.nodes[i];
      if (!n) return;
      const vis = n.front ? Math.min(1, n.on * 1.4) * planO : 0;
      el.style.transform = `translate3d(${n.x.toFixed(1)}px, ${n.y.toFixed(1)}px, 0)`;
      el.style.opacity = vis.toFixed(3);
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
    const sections: [HTMLElement | null, keyof typeof STATIC_POSE][] = [[hero, 'galaxy'], [task, 'core'], [plan, 'constellation']];
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
    onUpdate: (self) => scene.setProgress(self.progress),
    onRefresh: (self) => scene.setProgress(self.progress),
  });
  scene.setProgress(st.progress);
  const io = new IntersectionObserver((entries) => scene.setActive(entries.some((e) => e.isIntersecting)), { rootMargin: '10% 0px' });
  io.observe(track);
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
