# Cost-comparison findings — 2026-10-14

**Correction (2026-10-16).** `bench/compare.py` recorded only the first `result`
event of a session. A session that resumes when background workers finish emits
one per segment, and `total_cost_usd` is cumulative, so runs that continued were
understated (turns and duration too). In this series only the features hybrid
run had several segments (five): $0.182 → $0.412, 6 → 23 turns. That reverses
finding 1 (hybrid was 46% of stock and 65% of lead-dev; it is 104% and 148%) and
weakens finding 6; the series total is ~$3.7, not ~$3.5. compare.py now merges
all segments.

What `bench/compare.py` measured across four live runs (three variants each:
stock `claude -p`, `--agent lead-dev`, `--agent lead-dev-hybrid`; primary model
opus for all controlled runs; identical task per run; disposable fixtures).
Claude-side cost is USD. Worker tokens are quota on the opencode-go / Gemini
subscriptions and are deliberately never converted to USD. Raw per-run reports
and transcripts live under `bench/results/` (gitignored, local only).

## Results

| case | shape | stock $ | lead-dev $ | hybrid $ | hybrid offloaded |
|---|---|---|---|---|---|
| small | retry task + tests (~20 lines) | 0.199* | 0.540 | 0.491 | — |
| big | `cents`→`toCents` rename, 11 files | 0.368–0.369 | 0.137–0.141 | 0.150–0.243 | 0 or ~115,000 |
| features | 5 independent implementations vs failing tests | 0.395 | 0.278 | 0.412 | 693,795 (agy 297,898 + opencode 395,897) |

\* small ran stock on the user-default sonnet; all other runs were controlled to opus.

## Findings

1. The hybrid saved no Claude-side cost in this series. On the
   implementation-shaped features case it cost 104% of stock and 148% of plain
   lead-dev at equal quality (5/5 test files for every variant), and took the
   most own turns (23 over five segments, 81 s vs 16 s and 57 s): each worker
   completion resumes the session and re-reads its context. On big it cost
   more than lead-dev in both runs; only on small was it below lead-dev.
2. Delegation choice is nondeterministic: the same rename task was handed to an
   agy worker in one run and solved inline with `sed` in the next. Single-run
   comparisons are directional; use `--repeat 3` for statistics.
3. Lane choice follows the routing table: implementation with runnable tests →
   `opencode-task`; bulk edits where the orchestrator runs tests → `agy-task`.
   The features run exercised the opencode lane for the first time.
4. `opencode-task` (headless `opencode run --standalone` + per-run overlay)
   works on the free tier, even though bench/run.py's plain probe reports that
   the free tier refuses headless runs. That probe does not cover the wrapper
   path.
5. Fixed since: the features run hit 9 worker denials because the shell
   allowlist in `scripts/agy-task` lacked `node test/…`. `RUNNER_GLOBS` now
   allows `node test/*`, `node tests/*`, `node __tests__/*`, `node --version`,
   and (after the later scaffold runs) `wc *` and `python3 test/*`/`tests/*`.
   The hybrid still merges branches and runs the verify chain itself.
6. Practical rule, unproven by this series: `lead-dev-hybrid` only pays off
   for implementation-shaped volume (several disjoint modules of new code), if
   at all. Five small functions were not enough. Renames get `sed`-ed inline
   and small fixes stay below the delegation threshold, so it adds overhead
   there. The later scaffold series (8 modules, n=3, 2026-10-15, corrected) is
   the first support: hybrid median $0.161 vs vanilla $0.320 on the same model
   (sonnet), plus 1.0–2.3M opencode tokens per run.
7. Whole-series autonomous benchmark spend: ~USD 3.7 Claude-side.

## Reproduce

```bash
python3 bench/compare.py --dry-run                                            # preview, free
python3 bench/compare.py --yes --case features --model opus --timeout 3000 --budget 8
python3 bench/compare.py --yes --case all --model opus --repeat 3             # statistics
```

## Neon vs Argon (2026-11-19, agy 1.5.12)

Two identical `--review` tasks per model, graded by hand. Plan critique: the
live-sessions dashboard plan. Branch review: the resulting `dash-live` branch,
graded against a `security-auditor` report (9 findings) as the reference.

| Task | Model | Wall | Tokens | Result |
|---|---|---|---|---|
| Plan critique | Argon high | 445 s | 326k | 11 findings; 10 shared with Neon high, 1 unique (already known) |
| Plan critique | Neon high | 228 s | 148k | 11 findings; about 5–6 unique and real, including a client merge bug that shipped otherwise |
| Plan critique | Neon xhigh | 343 s | 300k | 10 findings; the only run to flag the terminal-identity class (`tty_nr` vs pane tty, unsent draft or open modal, stopped/zombie states) at plan time |
| Branch review | Argon high | 527 s | 491k | 10 real; 2 of 9 auditor findings; 1 unique (pane-less held sessions unreachable) |
| Branch review | Neon high | 455 s | 240k | 12 real or plausible; 3 of 9 auditor findings; about 5 unique, including a stdin EPIPE server crash |

Findings:
1. Neon matched or beat Argon on every task at about half the time and tokens.
2. Neither model at high caught the security-auditor's terminal-identity
   findings on the branch; keep `security-auditor` for injection and auth paths.
3. xhigh was accepted on 1.5.12 and thought more than high (24.6k vs 14.2k
   thinking tokens), so the reported reduced-thinking issue did not block it.
4. agy's `/usage` lists no Neon group: Neon draws on the shared "Gemini Models"
   quota with Hydrogen, while Argon had its own small weekly quota.

Decision: Argon is retired from the worker allowlist; Neon xhigh is the plan
critic, Hydrogen xhigh its fallback.

## Neon vs Hydrogen (2026-11-20)

Tasks have known answers from later commits in this repo. Every run started
from a clean worktree at the parent commit.
- **R1:** read-only review of b0506e5 (secrets redaction cache). The key is
  03c0666: an empty store gets cached for 1 s, leaving secrets unredacted.
- **R2:** read-only review of 7f03ee7's `dashboard/server` diff. The key is
  4b658d0:
  - (a) the fsutil turn scan trusts the stat size taken before open;
  - (b) the held-head cache is not cleared when a transcript is missing.
- **I1:** implement b0506e5 from a spec, graded by b0506e5's tests plus the
  03c0666 bug test.

Cost is the drop in the shared "Gemini Models" 5-hour quota during the run.
`/usage` reads come from lagging replicas, so the bench takes the lowest of 5
reads. Treat small deltas as ±0.5 points. The weekly bucket was too coarse to
use. The run was stopped after 9 of 12 runs to save quota, so Neon xhigh on R2
and Neon on I1 were not measured.

| Task | Model | Wall | Tokens | 5 h quota | Result |
|---|---|---|---|---|---|
| R1 | Hydrogen high | 102 s | 91k | 0.4% | miss; reported no bugs |
| R1 | Hydrogen xhigh | 289 s | 267k | 2.6% | miss; 1 minor stale-cache finding |
| R1 | Neon high | 407 s | 136k | 3.0% | **hit**: the empty-store cache fails open for 1 s; fix matches 03c0666 |
| R1 | Neon xhigh | 725 s | 647k | 9.2% | **hit**: same findings as Neon high |
| R2 | Hydrogen high | 199 s | 137k | 1.3% | (a) yes, (b) no; plus the stale `head.key` bug, 1 minor |
| R2 | Hydrogen xhigh | 450 s | 290k | 3.8% | (a) yes, (b) no; plus `head.key`, fork-timeout zombie upsert |
| R2 | Neon high | 550 s | 234k | 5.4% | (a) yes, (b) no; plus `head.key`, fork timeout, 4 more (7 total) |
| I1 | Hydrogen high | 123 s | 76k | 1.0% | 122/122 key tests, tsc ok; fails the 03c0666 bug test |
| I1 | Hydrogen xhigh | 268 s | 142k | 1.1% | same as high |

Findings:
1. Only Neon caught the R1 security bug. Hydrogen missed it at both efforts,
   and high reported the commit clean.
2. Neon xhigh found nothing that Neon high missed on R1, at about 3x the quota
   and 1.8x the wall time.
3. Neon costs about twice as much per token as Hydrogen: roughly 0.02 vs 0.01
   points of 5 h quota per 1k tokens. It also uses more tokens, so Neon high
   costs about 4-7x Hydrogen high and about 1.3x Hydrogen xhigh.
4. Every R2 run missed the held-head bug (b). Every R2 run found a bug the key
   lacks, still on main: `transcripts.ts` `headSummary` passes the cached
   `head.key` to `fileHasTurn` along with a fresh `st.size`, so `resumable`
   can be stale.
5. On implementation, Hydrogen high matched xhigh at the same quota and half
   the time. Neither avoided the empty-store pitfall the spec left out.

Decision (approved 2026-11-20): reviews and plan critiques move from Neon xhigh to Neon
high. Hydrogen high stays the implementation default and becomes the dashboard's
agy lead default.
