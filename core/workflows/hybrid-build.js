export const meta = {
  name: 'hybrid-build',
  description: 'Run approved, file-disjoint tasks on headless agy and opencode workers, verify each branch, cross-review it, and return only what held up',
}

// args: { tasks: [{ slug, lane: 'opencode' | 'agy', prompt, verify, files? }], review?: boolean }
// Returns { ready, failed, findings, unreviewed }: branches to merge, what did not hold up, confirmed review findings,
// and ready slugs whose cross-review did not complete.
// The script itself has no shell: every external step is a small Haiku agent that runs a wrapper and reports.

const tasks = (args && args.tasks) || []
const review = !(args && args.review === false)
if (tasks.length === 0) return { ready: [], failed: [], findings: [], error: 'args.tasks is empty' }

// The reviewer uses the other backend (and its default model) than the writer.

const wrapper = (lane) => (lane === 'agy' ? 'agy-task' : 'opencode-task')
const reviewWrapper = (lane) => (lane === 'agy' ? 'opencode-task' : 'agy-task')

const resultSchema = {
  type: 'object',
  required: ['ok', 'branch', 'worktree', 'changes'],
  properties: {
    ok: { type: 'boolean' },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    changes: { type: 'string' },
    timed_out: { type: 'boolean' },
    denied: { type: 'array', items: { type: 'string' } },
  },
}

const readResult =
  `The command blocks until the worker finishes and prints one line ending with "-> <path>/result.json". ` +
  `Read that file with Bash (\`cat <path>/result.json\`; the Read tool cannot see it) and report its ok, branch, worktree, ` +
  `changes, denied_actions (as denied) fields, and timed_out = true if its warnings mention a timeout. ` +
  `Pass timeout 600000 to the Bash tool. Do not edit anything and do not run anything else.`

// agy runs edit-only: a denied RunCommand with changes on the branch is a worker that could not run its own
// tests, not a failure. Our verify stage runs them, so such a branch is usable; anything else not-ok is not.
const shellOnly = (r) => (r.denied || []).length > 0 && (r.denied || []).every((d) => /RunCommand|shell/i.test(d))
const hasChanges = (r) => !!r.changes && !/^no changes/.test(r.changes)
const usable = (r) => !!r && (r.ok || (hasChanges(r) && !r.timed_out && shellOnly(r)))

// agy runs edit-only and a denied shell command ends its whole run with no output, so every agy prompt says so
const AGY_RULE =
  'Use only your file view, search and edit tools. Do not run any shell command (not even cat, ls or git): ' +
  'a denied command ends the run with no output and no changes.\n\n'
const promptFor = (t) => (t.lane === 'agy' ? AGY_RULE + t.prompt : t.prompt)

const start = (t) =>
  agent(
    `Run this command with the Bash tool, exactly as written:\n\n` +
      `${wrapper(t.lane)} start ${t.slug} --wait --timeout 9m - <<'TASK_PROMPT_EOF'\n${promptFor(t)}\nTASK_PROMPT_EOF\n\n${readResult}`,
    { model: 'haiku', label: `edit:${t.slug}`, schema: resultSchema },
  )

const resume = (t, why) =>
  agent(
    `Run this command with the Bash tool, exactly as written:\n\n` +
      `${wrapper(t.lane)} resume ${t.slug} --wait --timeout 9m - <<'TASK_PROMPT_EOF'\n${t.lane === 'agy' ? AGY_RULE : ''}${why}\n${t.lane === 'agy' ? '' : `When you are done, run: ${t.verify}`}\nTASK_PROMPT_EOF\n\n${readResult}`,
    { model: 'haiku', label: `resume:${t.slug}`, schema: resultSchema },
  )

const edit = async (t) => {
  let r = await start(t)
  // retry-or-stop lives here, not in the orchestrator: one resume for a timeout or a worker that left changes unfinished
  if (r && !usable(r) && (r.timed_out || hasChanges(r))) {
    const why = r.timed_out
      ? 'You ran out of time. Finish the task; keep only what the tests need.'
      : `The previous run did not finish cleanly (denied: ${(r.denied || []).join(', ') || 'none'}). Finish the task; do not use denied commands.`
    r = (await resume(t, why)) || r
  }
  return { t, r }
}

const verifySchema = {
  type: 'object',
  required: ['pass', 'tail'],
  properties: { pass: { type: 'boolean' }, tail: { type: 'string' } },
}
const reviewSchema = {
  type: 'object',
  required: ['reviewed', 'findings'],
  properties: { reviewed: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } },
}
const confirmSchema = {
  type: 'object',
  required: ['confirmed'],
  properties: { confirmed: { type: 'array', items: { type: 'string' } }, refuted: { type: 'array', items: { type: 'string' } } },
}

const check = async ({ t, r }) => {
  if (!r) return { t, ok: false, why: 'dispatcher agent failed' }
  if (!usable(r)) return { t, ok: false, why: `worker not ok (${r.changes}; denied: ${(r.denied || []).join(', ') || 'none'})` }
  const v = await agent(
    `Run this with the Bash tool and report whether it exited 0 and its last 3 output lines:\n\n` +
      `cd ${r.worktree} && ${t.verify}\n\nDo not edit anything.`,
    { model: 'haiku', label: `verify:${t.slug}`, schema: verifySchema },
  )
  if (!v || !v.pass) return { t, r, ok: false, why: `verify failed: ${v ? v.tail : 'no report'}` }
  let confirmed = []
  let reviewed = !review
  if (review) {
    // a different model reads the result and the contract; only concrete defects count
    const rv = await agent(
      `Run this command with the Bash tool, exactly as written:\n\n` +
        `${reviewWrapper(t.lane)} start review-${t.slug} --wait --review --base ${r.branch} --timeout 9m - <<'TASK_PROMPT_EOF'\n` +
        `${AGY_RULE}Review the work on this branch. The task was:\n${t.prompt}\n\nRead the changed files${t.files ? ` (${t.files.join(', ')})` : ''} and the tests that define the contract. ` +
        `List only concrete defects: file, what is wrong, and the input that breaks it. Your final answer must be only that list, one defect per line, or the single word: none. Do not think aloud in the answer.\n` +
        `TASK_PROMPT_EOF\n\n` +
        `Then \`cat <path>/result.json\` as printed on its last line. Return reviewed = its ok field, and the lines of its "response" field as findings ` +
        `(empty list if the response's last non-empty line is just "none", and keep only lines that describe a defect). Finally run \`agy-task clean review-${t.slug} --force\`. Pass timeout 600000 to the Bash tool.`,
      { model: 'haiku', label: `review:${t.slug}`, schema: reviewSchema },
    )
    reviewed = !!(rv && rv.reviewed)
    const found = ((rv && rv.findings) || []).filter((f) => f && f.trim().toLowerCase() !== 'none')
    if (found.length > 0) {
      const c = await agent(
        `In ${r.worktree}, check each reviewer claim against the actual code. Confirm a claim only if you can point to the line and a failing input; refute the rest.\n\n` +
          found.map((f, i) => `${i + 1}. ${f}`).join('\n'),
        { model: 'sonnet', label: `confirm:${t.slug}`, schema: confirmSchema },
      )
      confirmed = (c && c.confirmed) || []
    }
  }
  return { t, r, ok: true, confirmed, reviewed }
}

phase('build')
const results = (await pipeline(tasks, edit, check)).filter(Boolean)

return {
  ready: results.filter((x) => x.ok).map((x) => ({ slug: x.t.slug, lane: x.t.lane, branch: x.r.branch, changes: x.r.changes })),
  failed: results.filter((x) => !x.ok).map((x) => ({ slug: x.t.slug, lane: x.t.lane, why: x.why })),
  findings: results.filter((x) => x.ok && x.confirmed.length > 0).map((x) => ({ slug: x.t.slug, confirmed: x.confirmed })),
  // ready branches whose cross-review did not complete: they passed their tests but nobody else read them
  unreviewed: results.filter((x) => x.ok && !x.reviewed).map((x) => x.t.slug),
}
