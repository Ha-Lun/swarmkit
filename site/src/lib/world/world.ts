import {
  AmbientLight, DirectionalLight, Fog, HemisphereLight, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
} from 'three';
import type { Agent } from '../agents';
import { chapterAt, createCameraPath } from './camera-path';
import { createHoneycomb } from './honeycomb';

/** The only thing the world reads. Written elsewhere (slider now, ScrollTrigger later). */
export interface SharedState { globalProgress: number }

export interface World {
  agentCount: number;
  dispose(): void;
}

export interface WorldOptions {
  /** called once per rendered frame with the frame delta in ms */
  onFrame?: (dtMs: number) => void;
}

const BG = 0x0d0e10;

export function createWorld(
  canvas: HTMLCanvasElement,
  state: SharedState,
  agents: Agent[],
  opts: WorldOptions = {},
): World {
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(BG);
  const scene = new Scene();
  scene.fog = new Fog(BG, 20, 120);
  const camera = new PerspectiveCamera(40, 1, 0.1, 400);

  const honeycomb = createHoneycomb(agents);
  scene.add(honeycomb.mesh);
  scene.add(new AmbientLight(0xffffff, 0.35));
  scene.add(new HemisphereLight(0xffffff, 0x222226, 0.9));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(-8, 20, 10);
  scene.add(key);

  const path = createCameraPath(honeycomb.lattice.radius);
  const pos = new Vector3();
  const target = new Vector3();

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  let raf = 0;
  let last = 0;
  let running = false;

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const g = state.globalProgress;
    const { chapter, chapterProgress } = chapterAt(g);
    honeycomb.update(
      chapter === 0 ? chapterProgress : 1,
      chapter < 3 ? 0 : chapter === 3 ? chapterProgress : 1,
    );
    path.sample(g, pos, target);
    camera.position.copy(pos);
    camera.lookAt(target);
    // fog follows camera distance to the lattice so the recede reads as dimming, not clipping
    (scene.fog as Fog).near = pos.length() * 0.6;
    (scene.fog as Fog).far = pos.length() * 3 + 40;
    renderer.render(scene, camera);
    if (last) opts.onFrame?.(now - last);
    last = now;
  }
  function start() {
    if (running) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

  return {
    agentCount: honeycomb.lattice.agentCount,
    dispose() {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
      honeycomb.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

