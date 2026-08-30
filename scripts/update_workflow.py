import os
import glob
import re

def process_file(filepath):
    if not os.path.exists(filepath):
        return
    with open(filepath, 'r') as f:
        content = f.read()
    
    original_content = content
    
    # 1. Give executing specialists 'question: allow'
    if 'mode: subagent' in content and 'task: deny' in content:
        if 'question: allow' not in content:
            content = content.replace('task: deny', 'task: deny\n  question: allow')
            
    # 2. Update lead-dev.md specifically
    if 'lead-dev.md' in filepath:
        content = content.replace('read: deny', 'read: allow')
        content = content.replace('glob: deny', 'glob: allow')
        content = content.replace(
            '- You NEVER read project files. `explore` reads them and returns a context brief you consume as text.',
            '- You MAY read top-level configuration files (like package.json, opencode.jsonc, README.md) to make quick routing decisions. For deep codebase exploration, spawn `explore`.'
        )
        # Update workflow steps
        # Remove step 4, 5, 6, 7 and replace
        workflow_pattern = re.compile(r'4\. \*\*Plan\*\*(.*?)(?=7\.5\. \*\*Pre-commit check\*\*|8\. \*\*Synthesize\*\*)', re.DOTALL)
        
        new_workflow = """4. **Specialist Execution (Stateful & Native Workspace)** — Spawn the relevant executing specialist(s) and pass `Workspace: "branch"` or `"share"` via the `invoke_subagent` tool to automatically create an isolated environment with dependencies intact.
   - Instruct the specialist to **plan first, use the `ask_question` tool to get user approval, and then execute** within their single run.
   - The handoff should include the context brief and explicit instructions to self-test before returning.

"""
        content = workflow_pattern.sub(new_workflow, content)
        
        # Update 7.5 Pre-commit -> now handled by specialist
        content = content.replace('7.5. **Pre-commit check** — after the executing specialist reports success, dispatch `release-tester` on the worktree', 
                                  '5. **Closed-Loop Testing** — The executing specialist runs its own tests (or dispatches `release-tester`) and self-corrects up to 3 times before returning to you.')
        content = content.replace('8. **Synthesize**', '6. **Synthesize**')
        content = content.replace('9. **Quality gate**', '7. **Quality gate**')
        
        # Update quality gate to be parallel
        content = content.replace(
            '- `security-auditor` — security review of all changes\n   - `code-proofreader` — dead code',
            'Dispatch the following in **PARALLEL** using a single `invoke_subagent` call with an array:\n   - `security-auditor` — security review of all changes\n   - `code-proofreader` — dead code'
        )
        
        # Handoff format updates
        content = content.replace('Mode: plan | execute   (default: execute)\n', '')
        content = content.replace('**`Mode: plan`** is the new field. When set, the specialist returns only its plan output format, does not edit any files, and does not run write tools. The orchestrator waits for the user\'s approval before re-spawning in execute mode.',
                                  '**Interactive Planning**: Instruct the specialist to use the `ask_question` tool to verify its plan with the user before applying edits.')

    # 3. Update AGENTS.md globally (the rules)
    if 'AGENTS.md' in filepath:
        # Replace the workflow block
        workflow_block = """```
[1. Analyze & Route] ➔ [2. Pre-flight Brief (explore)] ➔ [3. Reference Check (UI)]
        ➔ [4. Plan Formation] ➔ [5. Interactive User Approval (ask_question)]
        ➔ [6. Worktree Isolation (git-specialist)] ➔ [7. Specialist Execution (invoke_subagent)]
        ➔ [7.5 Pre-Commit Checks (release-tester)] ➔ [8. Synthesis] ➔ [9. Quality Gate]
```"""
        new_workflow_block = """```
[1. Analyze & Route] ➔ [2. Pre-flight Brief (explore)] ➔ [3. Reference Check (UI)]
        ➔ [4. Stateful Specialist Execution with Workspace Branching (invoke_subagent)]
        ➔ [5. Specialist self-corrects & tests] ➔ [6. Synthesis] ➔ [7. Parallel Quality Gate]
```"""
        content = content.replace(workflow_block, new_workflow_block)
        
        # Replace steps 4-7.5
        steps_pattern = re.compile(r'4\. \*\*Plan Formation\*\*.*?7\.5\. \*\*Pre-Commit Checks\*\*.*?(?=8\. \*\*Synthesis\*\*)', re.DOTALL)
        new_steps = """4. **Stateful Specialist Execution**:
   - Define the specialist if not yet defined using `define_subagent`.
   - Invoke the specialist using `invoke_subagent` passing `Workspace: "branch"` or `"share"`. 
   - Instruct the specialist to formulate a plan, use `ask_question` to get user approval, and then execute.

5. **Closed-Loop Testing**:
   - The executing specialist is responsible for running tests and linters, self-correcting any errors before returning.

"""
        content = steps_pattern.sub(new_steps, content)
        
        # Parallel Quality Gate
        content = content.replace('Invoke `security-auditor` (`Model: "pro"`), `code-proofreader` (`Model: "pro"`), and `git-specialist` (`Model: "flash"`) before finalizing.',
                                  'Invoke `security-auditor`, `code-proofreader`, and `git-specialist` **concurrently** in a single `invoke_subagent` call before finalizing.')

        content = content.replace('Mode: plan | execute (default: execute)\n', '')
        
    # 4. Remove Mode: plan from specialists
    if 'Mode: plan' in content or 'Plan mode' in content:
        content = re.sub(r'- \*\*Plan mode\*\*:.*?\n', '', content)
        content = re.sub(r'When spawned with `Mode: plan`,.*?\n', '', content)
        content = re.sub(r'If `Mode: plan` in handoff.*?\n', '', content)
        content = re.sub(r'### Plan mode \(read-only, no edits\).*?(?=### Execute mode)', '### Plan Phase (Use ask_question)\nCreate this plan and use `ask_question` to get user approval before proceeding to edit.\n', content, flags=re.DOTALL)
        
        # Specific replaces
        content = content.replace('The orchestrator will re-spawn you in execute mode after the user approves the plan.', 
                                  'Use the `ask_question` tool to get user approval on your plan before proceeding with edits.')
        content = content.replace('When the orchestrator spawns you with `Mode: plan`, return ONLY the plan below. Do not edit any files, do not run write tools.',
                                  'Before editing files, formulate a plan and use the `ask_question` tool to present it to the user. Do not proceed until approved.')

    if content != original_content:
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"Updated {filepath}")

# Find all relevant markdown files
search_paths = [
    '/home/ha-lun/opencode-config/agents/*.md',
    '/home/ha-lun/opencode-config/.agents/agents/*.md',
    '/home/ha-lun/opencode-config/.agents/rules/*.md',
    '/home/ha-lun/opencode-config/AGENTS.md'
]

files_to_process = []
for p in search_paths:
    files_to_process.extend(glob.glob(p))

for f in set(files_to_process):
    process_file(f)

