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
