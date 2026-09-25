// Loaded dynamically after first paint, only when a tier other than fallback was chosen (so the fallback path
// never downloads three or gsap). Wires scroll -> world, the fade-in, the intro and the fps probe.
import { gsap } from 'gsap';
import type { Agent } from '../agents';
import { initScroll, type Scroll } from '../scroll';
import type { RoutingNames } from './types';
import { markTier, createFpsProbe, type PlayTier, type TierDecision } from './tiers';
import { resetFx } from './scene-dom';
import { createWorld, type World } from './world';

export function mountWorld(decision: TierDecision, agents: Agent[], routing: RoutingNames) {
  const root = document.getElementById('world-root');
  if (!root || decision.tier === 'fallback') return;
  const canvas = document.createElement('canvas');
  root.append(canvas);

  let scroll: Scroll | null = null;
  let world: World | null = null;
  let running = true;
  const tick = (t: number) => world?.tick(t * 1000);

  function toFallback(reason: string) {
    if (!running) return;
    running = false;
    gsap.ticker.remove(tick);
    world?.intro.skip();
    world?.dispose();
    scroll?.dispose(); // back to native scrolling
    root!.remove();
    resetFx(); // hand the scenes back to the static layout
    world = null;
    scroll = null;
    document.documentElement.dataset.world = 'fallback';
    markTier('fallback', reason);
  }

  try {
    scroll = initScroll();
    world = createWorld({ canvas, agents, routing, state: scroll.state, tier: decision.tier, scroll });
  } catch {
    toFallback('WebGL unavailable'); // no context, or a shader that will not compile
    return;
  }
  markTier(decision.tier, decision.reason);
  if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __world: World }).__world = world; // inspection hook for QA
  world.warmup();
  gsap.ticker.add(tick); // after lenis.raf (added in initScroll), so the world reads this frame's scroll
  canvas.addEventListener('webglcontextlost', () => toFallback('WebGL context lost'));
  window.addEventListener('pagehide', () => toFallback('pagehide'), { once: true });

  if (!decision.forced) {
    const probe = (current: 'high' | 'medium') => createFpsProbe(current, (next: PlayTier, fps) => {
      if (!world || !running) return;
      if (next === 'fallback') return toFallback(`fps probe ${fps.toFixed(0)}`);
      if (next !== current) {
        world.setTier(next);
        markTier(next, `fps probe ${fps.toFixed(0)}, stepped down`);
        world.onFrame = probe(next); // one more probe on the lower tier
      }
    });
    world.onFrame = probe(decision.tier);
  }

  // first frame is drawn before the fade starts; the intro clock starts with it
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.classList.add('is-on');
    void world?.intro.start();
  }));
}
