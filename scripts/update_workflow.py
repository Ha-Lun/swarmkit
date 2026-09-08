import os
import glob
import re

def process_file(filepath):
    if not os.path.exists(filepath):
        return
    with open(filepath, 'r') as f:
        content = f.read()
    
    original_content = content
    
    # 1. Update lead-dev.md specifically
    if 'lead-dev.md' in filepath:
        content = content.replace('read: deny', 'read: allow')
        content = content.replace('glob: deny', 'glob: allow')
        content = content.replace(
            '- You NEVER read project files. `explore` reads them and returns a context brief you consume as text.',
            '- You MAY read top-level configuration files (like package.json, opencode.jsonc, README.md) to make quick routing decisions. For deep codebase exploration, spawn `explore`.'
        )
        if '(You MAY and MUST call `write_to_file` ONLY to create orchestration artifacts' not in content:
            content = content.replace(
                '- You NEVER write project files. `junior-dev`, `frontend-specialist`, `backend-specialist`, etc. do the writing.',
                '- You NEVER write project files. `junior-dev`, `frontend-specialist`, `backend-specialist`, etc. do the writing. (You MAY and MUST call `write_to_file` ONLY to create orchestration artifacts in `<appDataDir>/brain/<conversation-id>/`, such as `implementation_plan.md` with `RequestFeedback: true`).'
            )
        # Update workflow steps 4-9 in lead-dev.md
        lead_workflow_pattern = re.compile(
            r'4\. \*\*(Plan|Specialist Execution).*?(?=### B\. Read-only tasks)',
            re.DOTALL
        )
        
        new_lead_workflow = """4. **Plan Formation (Artifact & Visible Plan)** — Formulate a clear, structured implementation plan based on the request and context brief.
   - **Mandatory Artifact Creation**: Write the full implementation plan to `<appDataDir>/brain/<conversation-id>/implementation_plan.md` using `write_to_file` with `ArtifactMetadata` setting `RequestFeedback: true`, `UserFacing: true`, and a descriptive summary.
   - Detail the approach, files to modify, changes per file, testing strategy, and any risks. Print the structured plan in the chat.

5. **Interactive User Approval (ask_question)** — Call `ask_question` (or `question`) to obtain explicit user confirmation:
   - **MANDATORY PLAN EMBEDDING RULE**: You MUST embed the complete implementation plan directly inside the `question` argument string of `ask_question` (e.g. `"<full plan markdown>\\n\\nDo you approve this implementation plan?"`). Antigravity suppresses chat text during tool invocations; bare questions without the plan text are strictly forbidden.
   - **Options**:
     - **Option 1**: `"(Recommended) Approve and proceed"`
     - **Option 2**: `"Modify plan"`
     - **Option 3**: `"Cancel"`
   - If the user requests modifications, adjust the plan, update the artifact, and prompt again with the updated plan embedded in `ask_question`.

6. **Specialist Execution with Workspace Branching** — Spawn the relevant executing specialist(s) and pass `Workspace: "branch"` or `"share"` via `invoke_subagent` (or `task`) to automatically create an isolated environment with dependencies intact.
   - Pass the approved plan in the handoff prompt so the specialist executes the agreed-upon changes directly.
   - The handoff should include the context brief and explicit instructions to self-test before returning.

7. **Closed-Loop Testing** — The executing specialist runs its own tests (or dispatches `release-tester` via bash) and self-corrects up to 3 times before returning to you. This guarantees you only receive working code.

8. **Synthesize** — Combine specialist outputs. Surface remaining concerns to the user. Show the diff summary. If two specialists gave conflicting recommendations, analyze both, decide, and explain your reasoning to the user.

9. **Quality gate** — Before declaring work complete on any production-relevant task, dispatch the following in **PARALLEL** using a single `invoke_subagent` call with an array:
   - `security-auditor` — security review of all changes
   - `code-proofreader` — dead code, redundant code, unused exports, stale refactor leftovers (wraps the canonical `ponytail-review` procedure with a confidence layer; the user can also run `/ponytail-review` or `/ponytail-audit` directly)
   - `release-tester` — test suite, lint, typecheck. **Run only if step 7 did not already run it** (testing and release testing are mutually exclusive — tests run once per task).
   - `git-specialist` — commit hygiene, diff review, branch state

   **Tier 1 skip rule:** Skip the entire quality gate when **all** of the following are true:
   - The task is Tier 1 trivial (zero domain substance — typos, simple renames, version bumps, README touch-ups, single-line config tweaks).
   - The diff is ≤ 30 lines across ≤ 3 files, and the change touches no auth module, secrets file, payment integration, RLS policy, DB schema/migration, data model, or user input path.

   When skipping, note in synthesis: "Quality gate skipped — Tier 1 trivial task (≤30 lines, ≤3 files, no auth/secrets/data/user-input/payment paths)." The user may explicitly request the full gate at any time; if they do, run it regardless of tier or diff size.

"""
        content = lead_workflow_pattern.sub(lambda _: new_lead_workflow, content)
        
        # Handoff format updates
        content = content.replace('Mode: plan | execute   (default: execute)\n', '')
        content = content.replace(
            '**Interactive Planning**: Instruct the specialist to use the `ask_question` tool to verify its plan with the user before applying edits.',
            '**Execution Handoff**: Pass the approved plan directly to the specialist. Specialists do not ask the user for approval or formulate plans; they execute the approved plan provided by lead-dev.'
        )
        content = content.replace(
            '**`Mode: plan`** is the new field. When set, the specialist returns only its plan output format, does not edit any files, and does not run write tools. The orchestrator waits for the user\'s approval before re-spawning in execute mode.',
            '**Execution Handoff**: Pass the approved plan directly to the specialist. Specialists do not ask the user for approval or formulate plans; they execute the approved plan provided by lead-dev.'
        )
        content = content.replace(
            'Files that may be changed: (paths — omit or set to "none" in plan mode)',
            'Files that may be changed: (paths)\nApproved plan: (full approved implementation plan)'
        )
        content = content.replace(
            'Return format: (what the specialist should return — "plan output format only" in plan mode, "standard output" in execute mode)',
            'Return format: (what the specialist should return — "standard execution summary")'
        )

    # 2. Update AGENTS.md globally (the rules)
    if 'AGENTS.md' in filepath:
        if '(You MAY and MUST call `write_to_file` ONLY to create orchestration artifacts' not in content:
            content = content.replace(
                '- **You NEVER write, edit, or refactor code files directly.** You are strictly prohibited from calling `write_to_file` or `replace_file_content` directly on project source code.',
                '- **You NEVER write, edit, or refactor code files directly.** You are strictly prohibited from calling `write_to_file` or `replace_file_content` directly on project source code. (You MAY and MUST call `write_to_file` ONLY to create orchestration artifacts in `<appDataDir>/brain/<conversation-id>/`, such as `implementation_plan.md` with `RequestFeedback: true`).'
            )
        # Replace the workflow diagram block
        workflow_diag_pattern = re.compile(r'```\n\[1\. Analyze & Route\].*?\[.*Quality Gate\]\n```', re.DOTALL)
        new_workflow_block = """```
[1. Analyze & Route] ➔ [2. Pre-flight Brief (explore)] ➔ [3. Reference Check (UI)]
        ➔ [4. Plan Formation (Artifact & Visible Plan)] ➔ [5. Interactive User Approval (ask_question)]
        ➔ [6. Specialist Execution with Workspace Branching (invoke_subagent)]
        ➔ [7. Closed-Loop Testing] ➔ [8. Synthesis] ➔ [9. Parallel Quality Gate]
```"""
        content = workflow_diag_pattern.sub(lambda _: new_workflow_block, content)
        
        # Replace steps 4-9
        steps_pattern = re.compile(r'4\. \*\*Plan.*?(?=### Flow B: Read-Only Tasks)', re.DOTALL)
        new_steps = """4. **Plan Formation (Artifact & Visible Plan)**:
   - Formulate the implementation plan based on the request and context brief.
   - **Mandatory Artifact Creation**: Write the full implementation plan to `<appDataDir>/brain/<conversation-id>/implementation_plan.md` using `write_to_file` with `ArtifactMetadata` setting `RequestFeedback: true`, `UserFacing: true`, and a descriptive summary.
   - Detail the approach, files to modify, changes per file, testing strategy, and any risks. Print the structured plan in the main chat response as visible markdown.

5. **Interactive User Approval (ask_question)**:
   - Call `ask_question` to obtain explicit user confirmation:
   - **MANDATORY PLAN EMBEDDING RULE**: You MUST embed the complete implementation plan directly inside the `question` argument string of `ask_question` (e.g. `"<full plan markdown>\\n\\nDo you approve this implementation plan?"`). Antigravity suppresses chat text during tool invocations; bare questions without the plan text are strictly forbidden.
     - **Question**: `"<full plan markdown>\\n\\nDo you approve this implementation plan?"`
     - **Option 1**: `"(Recommended) Approve and proceed"`
     - **Option 2**: `"Modify plan"`
     - **Option 3**: `"Cancel"`
   - If the user requests modifications, update the artifact, adjust the plan, and prompt again with the updated plan embedded in `ask_question`.

6. **Specialist Execution with Workspace Branching**:
   - Define the specialist if not yet defined using `define_subagent`.
   - Invoke the specialist using `invoke_subagent` passing `Workspace: "branch"` or `"share"`, passing the approved plan.
   - Instruct the specialist to execute the approved plan.

7. **Closed-Loop Testing**:
   - The executing specialist is responsible for running tests and linters, self-correcting any errors before returning.

8. **Synthesis**:
   - Synthesize the specialist results and summarize diffs.

9. **Parallel Quality Gate**:
   - Invoke `security-auditor`, `code-proofreader`, and `git-specialist` **concurrently** in a single `invoke_subagent` call before finalizing.
   - *Tier 1 Skip Rule*: Skip only if ≤ 30 lines across ≤ 3 files with zero auth/security/DB implications.

---

"""
        content = steps_pattern.sub(lambda _: new_steps, content)

        # Handoff template in AGENTS.md
        content = content.replace('Mode: plan | execute (default: execute)\n', '')
        content = content.replace(
            'Files that may be changed: [List of file paths or "None" if in plan mode]',
            'Files that may be changed: [List of file paths]\nApproved plan: [Full approved implementation plan]'
        )
        content = content.replace(
            'Return format: [Plan output format or standard execution summary]',
            'Return format: [Standard execution summary]'
        )
        
    # 3. Remove subagent planning & ask_question instructions from specialists
    if 'frontend-specialist.md' in filepath:
        content = re.sub(
            r'### Plan Phase \(Use ask_question\)\s*\nCreate this plan and use `ask_question` to get user approval before proceeding to edit\.\s*\n',
            'Specialists execute the approved plan provided by lead-dev.\n\n',
            content
        )
        content = re.sub(
            r'### Plan mode \(read-only, no edits\).*?(?=### Execute mode)',
            'Specialists execute the approved plan provided by lead-dev.\n\n',
            content,
            flags=re.DOTALL
        )

    if 'backend-specialist.md' in filepath or 'monitoring-specialist.md' in filepath:
        content = re.sub(
            r'### Plan mode \(read-only, do not edit\)\s*\n\s*Before editing files, formulate a plan and use the `ask_question` tool to present it to the user\. Do not proceed until approved\..*?(?=### Execute mode)',
            'Specialists execute the approved plan provided by lead-dev.\n\n',
            content,
            flags=re.DOTALL
        )

    if content != original_content:
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"Updated {filepath}")

REPO_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
search_paths = [
    os.path.join(REPO_DIR, 'agents', '*.md'),
    os.path.join(REPO_DIR, '.agents', 'agents', '*.md'),
    os.path.join(REPO_DIR, '.agents', 'rules', '*.md'),
    os.path.join(REPO_DIR, 'AGENTS.md')
]

files_to_process = []
for p in search_paths:
    files_to_process.extend(glob.glob(p))

for f in set(files_to_process):
    process_file(f)
