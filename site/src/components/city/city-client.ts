// Client for CityStage.astro. Decides whether the scene can run at all (no WebGL2 or ?tier=fallback -> the
// .no-webgl static fallback), then loads three, gsap and the scene in this page's own chunk, wires scroll -> scene,
// and turns each frame's StageState into DOM updates (captions, counters, run clock, hero). The DOM writes happen in
// the scene's animation frame, never inside a scroll callback, and toggle classes (opacity in CSS) or text only.
import type { FeaturedRun } from '../../lib/run.ts';
import type { CityHandle, CityTier } from '../../lib/city/scene.ts';
import type { ScrollProgress } from '../../lib/city/scroll.ts';
import type { StageCounters, StageState } from '../../lib/city/types.ts';
import { formatDuration } from '../../lib/city/captions.ts';

function setupCopy() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    const status = btn.parentElement?.querySelector<HTMLElement>('[data-copy-status]');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy ?? '');
        if (status) status.textContent = 'Copied';
      } catch {
        if (status) status.textContent = 'Copy failed: select the command instead';
      }
    });
  }
}

const TIERS: readonly string[] = ['high', 'medium', 'low'];

async function boot(stage: HTMLElement) {
  let city: CityHandle | null = null;
  let scroll: ScrollProgress | null = null;
  const fail = (reason: string) => {
    stage.classList.add('no-webgl');
    stage.dataset.cityFallback = reason;
    city?.dispose();
    scroll?.destroy();
    city = null;
    scroll = null;
  };

  const param = new URLSearchParams(location.search).get('tier');
  if (param === 'fallback') return fail('?tier=fallback');
  if (typeof WebGL2RenderingContext === 'undefined') return fail('no WebGL2');
  const runEl = document.getElementById('city-run');
  const canvas = stage.querySelector<HTMLCanvasElement>('.city-canvas');
  const labelLayer = stage.querySelector<HTMLElement>('[data-city-labels]');
  if (!runEl || !canvas || !labelLayer) return fail('stage markup missing');

  const captions = new Map([...stage.querySelectorAll<HTMLElement>('.city-caption')].map((el) => [el.dataset.beat!, el]));
  const approval = stage.querySelector<HTMLElement>('[data-approval]');
  const hero = stage.querySelector<HTMLElement>('[data-city-hero]');
  const counterEls = [...stage.querySelectorAll<HTMLElement>('[data-counter]')].map((el) => ({
    el, key: el.dataset.counter as keyof StageCounters, last: -1,
    // 'merging' is transient (lots in the air right now): its fixed cell dims while it is 0, never hides.
    cell: el.dataset.counter === 'merging' ? el.closest<HTMLElement>('.city-counter') : null,
  }));
  const clock = stage.querySelector<HTMLElement>('[data-clock]');
  let lastBeat = '';
  let lastApproved: boolean | null = null;
  let lastSecond = -1;

  const onState = (s: StageState) => {
    if (s.beat !== lastBeat) {
      captions.get(lastBeat)?.classList.remove('is-on');
      captions.get(s.beat)?.classList.add('is-on');
      hero?.classList.toggle('is-off', s.beat !== 'hero');
      stage.dataset.beat = s.beat;
      lastBeat = s.beat;
    }
    if (approval && s.planApproved !== lastApproved) {
      approval.classList.toggle('is-on', s.planApproved && s.planApproval !== null);
      lastApproved = s.planApproved;
    }
    for (const c of counterEls) {
      const v = s.counters[c.key];
      if (v !== c.last) {
        c.el.textContent = String(v);
        c.cell?.classList.toggle('is-zero', v <= 0);
        c.last = v;
      }
    }
    const sec = Math.floor(s.runTime);
    if (clock && sec !== lastSecond) {
      clock.textContent = formatDuration(sec);
      lastSecond = sec;
    }
  };

  try {
    const run: FeaturedRun = JSON.parse(runEl.textContent ?? '');
    const [{ createScrollProgress }, { mountCity }] = await Promise.all([
      import('../../lib/city/scroll.ts'),
      import('../../lib/city/scene.ts'),
    ]);
    scroll = createScrollProgress(stage);
    stage.classList.add('is-live');
    city = await mountCity({
      canvas,
      run,
      progress: scroll.progress,
      labelLayer,
      onState,
      tier: param && TIERS.includes(param) ? (param as CityTier) : undefined,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      onScrollEnd: scroll.onScrollEnd,
      onTier: (tier, reason) => {
        stage.dataset.tier = tier;
        stage.dataset.tierReason = reason;
      },
      onFail: fail,
      visibilityTarget: stage,
    });
  } catch (e) {
    console.warn('City scene unavailable, showing the static replay:', e);
    fail(e instanceof Error ? e.message : 'scene failed');
  }
}

setupCopy();
const stage = document.querySelector<HTMLElement>('[data-city-stage]');
if (stage) void boot(stage);
