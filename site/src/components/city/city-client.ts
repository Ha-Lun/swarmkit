// Client for CityStage.astro. Decides whether the scene can run at all (no WebGL or ?tier=fallback -> the
// .no-webgl static fallback), then loads three, gsap and the scene in this page's own chunk, wires scroll -> scene,
// and turns each frame's StageState into DOM updates (chapter header, terminal rows, counters, run clock, hero). The
// DOM writes happen in the scene's animation frame, never inside a scroll callback, and toggle classes (opacity in
// CSS) or text only.
import type { FeaturedRun } from '../../lib/run.ts';
import type { CityHandle, CityTier } from '../../lib/city/scene.ts';
import type { ScrollProgress } from '../../lib/city/scroll.ts';
import type { StageCounters, StageState } from '../../lib/city/types.ts';
import { formatDuration } from '../../lib/city/captions.ts';
import { CHAPTERS, chapterFor } from '../../lib/city/terminal.ts';
import type { ChapterId } from '../../lib/city/terminal.ts';

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

// A real context probe: WebGL2RenderingContext exists even when WebGL is disabled, so only creating a throwaway
// webgl2 context proves the scene can run. This runs before any dynamic import, so a no-WebGL browser fetches
// neither the three.js chunk nor any model.
function hasWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

async function boot(stage: HTMLElement) {
  let city: CityHandle | null = null;
  let scroll: ScrollProgress | null = null;

  const runEl = document.getElementById('city-run');
  const canvas = stage.querySelector<HTMLCanvasElement>('.city-canvas');
  const labelLayer = stage.querySelector<HTMLElement>('[data-city-labels]');
  const terminal = stage.querySelector<HTMLElement>('[data-terminal]');
  const termBody = terminal?.querySelector<HTMLElement>('[data-term-body]');
  const termNum = terminal?.querySelector<HTMLElement>('[data-term-num]');
  const termTitle = terminal?.querySelector<HTMLElement>('[data-term-title]');
  const termLine = terminal?.querySelector<HTMLElement>('[data-term-line]');
  const termRows = terminal ? [...terminal.querySelectorAll<HTMLElement>('.term-row')] : [];
  const approval = terminal?.querySelector<HTMLElement>('[data-approval]');
  const hero = stage.querySelector<HTMLElement>('[data-city-hero]');

  let lastChapter: ChapterId | 0 = 0;
  let revealed = 0;
  let latestEl: HTMLElement | null = null;
  let lastScrolled = -1;

  const setChapter = (n: ChapterId) => {
    if (n === lastChapter) return;
    lastChapter = n;
    if (termNum) termNum.textContent = String(n);
    if (termTitle) termTitle.textContent = CHAPTERS[n].title;
    if (termLine) termLine.textContent = CHAPTERS[n].line;
  };
  const tOf = (i: number): number => Number(termRows[i]?.dataset.t ?? Number.NaN);
  const revealTo = (runTime: number) => {
    if (termRows.length === 0) return;
    if (revealed === 0 || runTime >= tOf(revealed - 1)) {
      while (revealed < termRows.length) {
        const row = termRows[revealed];
        if (!row || !(tOf(revealed) <= runTime)) break;
        row.classList.add('is-on');
        revealed++;
      }
    } else {
      while (revealed > 0 && tOf(revealed - 1) > runTime) {
        revealed--;
        termRows[revealed]?.classList.remove('is-on');
      }
    }
    const next: HTMLElement | null = revealed > 0 ? (termRows[revealed - 1] ?? null) : null;
    if (next !== latestEl) {
      latestEl?.classList.remove('is-latest');
      next?.classList.add('is-latest');
      latestEl = next;
    }
    // One programmatic scroll per change of the revealed count, never per frame.
    // Rows flow from the top (unrevealed rows take no space); only once the body
    // is full does the newest revealed row pin to the bottom of the visible body.
    // Scrolling backwards (rows un-revealed) steps the scroll back up the same way.
    if (termBody && revealed !== lastScrolled) {
      if (!latestEl) {
        termBody.scrollTop = 0;
      } else {
        const target = latestEl.offsetTop + latestEl.offsetHeight - termBody.clientHeight;
        termBody.scrollTop = target > 0 ? target : 0;
      }
      lastScrolled = revealed;
    }
  };

  const fail = (reason: string) => {
    stage.classList.add('no-webgl');
    stage.dataset.cityFallback = reason;
    // Fallback tier: the full terminal, all rows visible, chapter header on the final chapter.
    setChapter(5);
    for (const row of termRows) row.classList.add('is-on');
    revealed = termRows.length;
    latestEl = termRows[termRows.length - 1] ?? null;
    latestEl?.classList.add('is-latest');
    if (termBody) termBody.scrollTop = termBody.scrollHeight;
    city?.dispose();
    scroll?.destroy();
    city = null;
    scroll = null;
  };

  const param = new URLSearchParams(location.search).get('tier');
  if (param === 'fallback') return fail('?tier=fallback');
  if (!hasWebGL()) return fail('no WebGL');
  if (!runEl || !canvas || !labelLayer) return fail('stage markup missing');

  const counterEls = [...stage.querySelectorAll<HTMLElement>('[data-counter]')].map((el) => ({
    el, key: el.dataset.counter as keyof StageCounters, last: -1,
    // 'merging' is transient (lots in the air right now): its cell dims while it is 0, never hides.
    cell: el.dataset.counter === 'merging' ? el.closest<HTMLElement>('.term-stat') : null,
  }));
  const clock = stage.querySelector<HTMLElement>('[data-clock]');
  let lastBeat = '';
  let lastApproved: boolean | null = null;
  let lastSecond = -1;

  const onState = (s: StageState) => {
    const chapter = chapterFor(s.beat);
    const chapterChanged = chapter !== lastChapter;
    setChapter(chapter);
    revealTo(s.runTime);
    if (s.beat !== lastBeat) {
      hero?.classList.toggle('is-off', s.beat !== 'hero');
      stage.dataset.beat = s.beat;
      lastBeat = s.beat;
    }
    // The plan-approval note belongs to the plan chapter only.
    if (approval && (s.planApproved !== lastApproved || chapterChanged)) {
      approval.classList.toggle('is-on', chapter === 2 && s.planApproved && s.planApproval !== null);
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
    const reason = e instanceof Error ? e.message : 'scene failed';
    console.info(`City scene unavailable (${reason}), showing the static replay`);
    fail(reason);
  }
}

setupCopy();
const stage = document.querySelector<HTMLElement>('[data-city-stage]');
if (stage) void boot(stage);
