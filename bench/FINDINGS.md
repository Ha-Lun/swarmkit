# Cost-comparison findings — 2026-10-14

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
| features | 5 independent implementations vs failing tests | 0.395 | 0.278 | 0.182 | 693,795 (agy 297,898 + opencode 395,897) |

\* small ran stock on the user-default sonnet; all other runs were controlled to opus.

## Findings

1. The hybrid was never more expensive than its siblings in any run. On
   implementation-shaped work its Claude-side cost was 46% of stock and 65% of
   plain lead-dev at equal quality (5/5 test files for every variant), with the
   shortest own turn-time of the three: plan once, dispatch N workers, review,
   merge.
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
5. Known gap: the RUNNERS whitelist in `scripts/agy-task` lacks `node test/…`
   patterns, so node-file test chains hit denials when workers self-verify
   (9 denials in the features run). The hybrid compensates by merging branches
   and running the verify chain itself — works, but a whitelist extension for
   node test invocations (+ `node --version`) is the recorded tuning candidate.
6. Practical rule: use `lead-dev-hybrid` for implementation-shaped volume
   (several disjoint modules/configs of new code). Renames get `sed`-ed inline
   and small fixes stay below the delegation threshold — the hybrid adds
   overhead there, not savings. Value scales with writing volume, not file count.
7. Whole-series autonomous benchmark spend: ~USD 3.5 Claude-side.

## Reproduce

```bash
python3 bench/compare.py --dry-run                                            # preview, free
python3 bench/compare.py --yes --case features --model opus --timeout 3000 --budget 8
python3 bench/compare.py --yes --case all --model opus --repeat 3             # statistics
```
