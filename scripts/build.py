#!/usr/bin/env python3
"""Compile core/agents/*.md (CLI-neutral) into per-CLI agent files.

  claude/agents/<name>.md                          Claude Code subagents (pack: core)
  claude/packs/<pack>/agents/<name>.md             Claude Code project packs
                                                   (install.sh --pack)
  opencode/agents/<name>.md                        OpenCode agents
  antigravity/plugins/swarmkit/agents/<name>.md    Antigravity plugin agents
                                                   (invoke_subagent types)
  codex/agents/<name>.toml                         Codex custom agents

Outputs are committed. Run after editing anything in core/agents.

Per-CLI overrides: `claude.description` / `antigravity.description` in an
agent's frontmatter, and a body file at core/agents/<cli>/<name>.md (claude or
opencode) that replaces the shared body. Antigravity always uses the shared body.

Every agent sets `pack:` (one of PACKS). It only decides where the Claude build
goes; it is not emitted. OpenCode, Antigravity and Codex get every agent.
"""
import glob
import json
import os
import shutil
import tomllib

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Model per tier, per CLI. An agent's own `claude.model` / `opencode.model`
# overrides this.
TIER_MODELS = {
    'claude': {'fast': 'haiku', 'standard': 'sonnet', 'deep': 'opus'},
    'opencode': {
        'fast': 'opencode/muse-spark-1.3-contributor-free',
        'standard': 'opencode/nemotron-3.5-lightning-free',
        'deep': 'opencode/nemotron-3-ultra-free',
    },
    # Codex agents keep the session's model; the tier sets reasoning effort.
    'codex': {'fast': 'low', 'standard': 'medium', 'deep': 'high'},
}

PACKS = ('core', 'web', 'ops', 'mobile', 'n8n', 'backend', 'creative', 'swarm')

CLAUDE_TOOLS = {
    'read': ['Read', 'Glob', 'Grep'],
    'edit': ['Edit', 'Write'],
    'bash': ['Bash'],
    'web': ['WebFetch', 'WebSearch'],
    'delegate': ['Agent'],
}


def load_agents():
    agents = []
    for path in sorted(glob.glob(os.path.join(ROOT, 'core/agents/*.md'))):
        _, fm, body = open(path).read().split('---\n', 2)
        agents.append((yaml.safe_load(fm), body))
    return agents


def write(path, fm, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True, width=10**6)
    yaml.safe_load(text)  # fail loudly on anything a CLI couldn't parse
    with open(path, 'w') as f:
        f.write(f'---\n{text}---\n{body}')


def body_for(cli, a, body):
    override = f"{ROOT}/core/agents/{cli}/{a['name']}.md"
    return open(override).read() if os.path.exists(override) else body


def model_for(cli, a):
    return a.get(cli, {}).get('model') or TIER_MODELS[cli][a['tier']]


def build_claude(a, body):
    c = a.get('claude', {})
    tools = c.get('tools') or [t for cap in a['capabilities'] for t in CLAUDE_TOOLS[cap]]
    fm = {'name': a['name'], 'description': c.get('description') or a['description'],
          'model': model_for('claude', a), 'tools': tools + c.get('extra_tools', [])}
    if c.get('hooks'):
        fm['hooks'] = c['hooks']
    pack = a['pack']
    out = 'claude/agents' if pack == 'core' else f'claude/packs/{pack}/agents'
    write(f"{ROOT}/{out}/{a['name']}.md", fm, body_for('claude', a, body))


def build_opencode(a, body):
    fm = {'description': a['description'], **a['opencode']}
    fm['model'] = model_for('opencode', a)
    write(f"{ROOT}/opencode/agents/{a['name']}.md", fm, body_for('opencode', a, body))


def capability_header(a):
    # Neither agy nor Codex can restrict every tool per agent, so state the limits as instructions.
    caps = ', '.join(a['capabilities']) or 'none (conversation only)'
    kind = 'orchestrator' if a.get('role') == 'orchestrator' else 'subagent'
    return (f"> You are the **{a['name']}** {kind}. "
            f"Allowed capabilities: {caps}. Stay within them.\n\n")


def delegating_description(cli, a):
    # Claude's descriptions are written for a delegating main agent, which is what
    # agy's invoke_subagent and Codex's spawning need too, so fall back to them before the shared one.
    return a.get(cli, {}).get('description') or a.get('claude', {}).get('description') or a['description']


def build_antigravity(a, body):
    write(f"{ROOT}/antigravity/plugins/swarmkit/agents/{a['name']}.md",
          {'name': a['name'], 'description': delegating_description('antigravity', a)},
          capability_header(a) + body)


def toml_str(s, multiline=False):
    # JSON string escapes are valid TOML basic-string escapes.
    if multiline and "'''" not in s:
        return f"'''\n{s}'''"
    return json.dumps(s, ensure_ascii=False)


def build_codex(a, body):
    lines = [f"name = {toml_str(a['name'])}",
             f"description = {toml_str(delegating_description('codex', a))}",
             f"model_reasoning_effort = {toml_str(TIER_MODELS['codex'][a['tier']])}",
             f"developer_instructions = {toml_str(capability_header(a) + body, multiline=True)}"]
    if 'bash' not in a['capabilities']:
        lines += ['', '[features]', 'shell_tool = false']
    text = '\n'.join(lines) + '\n'
    tomllib.loads(text)  # fail loudly on anything Codex couldn't parse
    os.makedirs(f'{ROOT}/codex/agents', exist_ok=True)
    with open(f"{ROOT}/codex/agents/{a['name']}.toml", 'w') as f:
        f.write(text)


RULES_OUT = {
    'claude': 'claude/CLAUDE.md',
    'opencode': 'opencode/AGENTS.md',
    'antigravity': 'antigravity/plugins/swarmkit/rules/AGENTS.md',
    'codex': 'codex/AGENTS.md',
}


def build_rules():
    # Shared rules + each CLI's addendum, concatenated (no import resolution needed).
    shared = open(f'{ROOT}/core/rules/AGENTS.md').read()
    for cli, out in RULES_OUT.items():
        addendum = open(f'{ROOT}/{cli}/rules.md').read()
        os.makedirs(os.path.dirname(f'{ROOT}/{out}'), exist_ok=True)
        with open(f'{ROOT}/{out}', 'w') as f:
            f.write(f'<!-- Generated by scripts/build.py from core/rules/AGENTS.md + {cli}/rules.md. Do not edit. -->\n\n'
                    f'{shared.rstrip()}\n\n{addendum}')


def main():
    agents = load_agents()
    for a, _ in agents:  # check before anything is deleted
        if a.get('pack') not in PACKS:
            raise SystemExit(f"{a['name']}: unknown or missing pack {a.get('pack')!r} (expected one of {PACKS})")
    # The swarmkit skills dir is from the old layout (specialists as skills); kept so it gets removed.
    for d in ('claude/agents', 'claude/packs', 'opencode/agents', 'antigravity/plugins/swarmkit/agents',
              'antigravity/plugins/swarmkit/skills', 'codex/agents'):
        shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)
    for a, body in agents:
        build_claude(a, body)
        build_opencode(a, body)
        build_antigravity(a, body)
        build_codex(a, body)
    with open(f'{ROOT}/antigravity/plugins/swarmkit/plugin.json', 'w') as f:
        f.write('{\n  "name": "swarmkit"\n}\n')
    build_rules()
    print(f'Built {len(agents)} agents for claude, opencode, antigravity, codex.')


if __name__ == '__main__':
    main()
