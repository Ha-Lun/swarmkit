// Swarm homepage client: scroll-scrubbed particle story, word reveals, bar + copy button.
// Content is fully readable with no JS; all hidden-initial states are set from here only.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { createSwarm, detectTier } from '../../lib/swarm/scene.ts';
import type { Swarm } from '../../lib/swarm/scene.ts';
import type { Lane } from '../../lib/swarm/formations.ts';

gsap.registerPlugin(ScrollTrigger);

const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(pointer: fine)').matches;

function readLanes(canvas: HTMLCanvasElement): Lane[] {
  const fallback: Lane[] = ['opencode', 'agy', 'opencode', 'agy'];
  const raw = canvas.dataset.lanes;
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((l) => l === 'agy' || l === 'opencode')) {
      return parsed as Lane[];
    }
  } catch {
    // Keep the fallback lanes.
  }
  return fallback;
}

let swarm: Swarm | null = null;
const canvas = document.querySelector<HTMLCanvasElement>('[data-swarm-canvas]');
if (canvas) {
  const tier = detectTier();
  // reducedMotion still gets a (static) scene; only 'fallback' skips WebGL entirely.
  if (tier === 'fallback') {
    root.classList.add('no-webgl');
  } else {
    try {
      swarm = createSwarm(canvas, { tier, lanes: readLanes(canvas), reducedMotion });
      root.classList.add('swarm-live');
      swarm.setProgress(0);
    } catch {
      swarm = null;
      root.classList.add('no-webgl');
    }
  }
}

const story = document.querySelector('[data-swarm-story]');
if (story) {
  ScrollTrigger.create({
    trigger: story,
    start: 'top top',
    end: 'bottom bottom',
    scrub: reducedMotion ? true : 0.6,
    onUpdate: (self) => {
      swarm?.setProgress(self.progress);
    },
  });
}

if (!reducedMotion) {
  const beats = document.querySelectorAll('[data-swarm-story] [data-beat]');
  beats.forEach((beat) => {
    const words = beat.querySelectorAll('.w > span');
    if (words.length > 0) {
      gsap.from(words, {
        yPercent: 110,
        opacity: 0,
        stagger: 0.06,
        duration: 0.9,
        ease: 'expo.out',
        scrollTrigger: {
          trigger: beat,
          start: 'top 70%',
          toggleActions: 'play none none reverse',
        },
      });
    }
    const fades = beat.querySelectorAll('[data-swarm-fade]');
    if (fades.length > 0) {
      gsap.from(fades, {
        y: 16,
        opacity: 0,
        stagger: 0.08,
        duration: 0.7,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: beat,
          start: 'top 70%',
          toggleActions: 'play none none reverse',
        },
      });
    }
  });
}

if (swarm && finePointer && !reducedMotion) {
  window.addEventListener(
    'pointermove',
    (e) => {
      swarm?.setPointer((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
    },
    { passive: true },
  );
}

window.addEventListener('resize', () => {
  swarm?.resize();
});

const bar = document.getElementById('swarmbar');
if (bar) {
  const onScroll = () => {
    bar.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

const copyBtn = document.getElementById('swarm-install-copy');
const copyCode = document.getElementById('swarm-install-code');
const copyStatus = document.getElementById('swarm-install-status');
copyBtn?.addEventListener('click', () => {
  const done = (label: string, note: string) => {
    if (copyBtn) copyBtn.textContent = label;
    if (copyStatus) copyStatus.textContent = note;
    window.setTimeout(() => {
      if (copyBtn) copyBtn.textContent = 'Copy';
    }, 2000);
  };
  const text = copyCode?.textContent ?? '';
  if (navigator.clipboard) {
    navigator.clipboard
      .writeText(text)
      .then(() => done('Copied', 'Copied'))
      .catch(() => {
        if (copyCode) window.getSelection()?.selectAllChildren(copyCode);
        done('Copy', 'Copy failed: the command is selected, press Ctrl+C');
      });
  } else {
    if (copyCode) window.getSelection()?.selectAllChildren(copyCode);
    done('Copy', 'Copy unavailable: the command is selected, press Ctrl+C');
  }
});
