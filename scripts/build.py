#!/usr/bin/env python3
"""Compile core/agents/*.md (CLI-neutral) into per-CLI agent files.

  claude/agents/<name>.md                          Claude Code subagents
  opencode/agents/<name>.md                        OpenCode agents
  antigravity/plugins/swarmkit/skills/<name>/      Antigravity has no custom
                                                   subagents, so each specialist
                                                   ships as an on-demand skill

Outputs are committed. Run after editing anything in core/agents.
"""
import glob
import os
import shutil

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
}

CLAUDE_TOOLS = {
    'read': ['Read', 'Glob', 'Grep'],
    'edit': ['Edit', 'Write'],
    'bash': ['Bash'],
    'web': ['WebFetch', 'WebSearch'],
    'delegate': ['Task'],
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


def model_for(cli, a):
    return a.get(cli, {}).get('model') or TIER_MODELS[cli][a['tier']]


def build_claude(a, body):
    c = a.get('claude', {})
    tools = c.get('tools') or [t for cap in a['capabilities'] for t in CLAUDE_TOOLS[cap]]
    fm = {'name': a['name'], 'description': a['description'],
          'model': model_for('claude', a), 'tools': tools + c.get('extra_tools', [])}
    if c.get('hooks'):
        fm['hooks'] = c['hooks']
    write(f"{ROOT}/claude/agents/{a['name']}.md", fm, body)


def build_opencode(a, body):
    fm = {'description': a['description'], **a['opencode']}
    fm['model'] = model_for('opencode', a)
    write(f"{ROOT}/opencode/agents/{a['name']}.md", fm, body)


def build_antigravity(a, body):
    # No per-agent tool restrictions exist there, so state them as instructions.
    caps = ', '.join(a['capabilities']) or 'none (conversation only)'
    header = (f"> Specialist playbook for the **{a['name']}** role. "
              f"Allowed capabilities: {caps}. Stay within them.\n\n")
    fm = {'name': a['name'],
          'description': f"{a['description']} Load when acting as or delegating to the {a['name']} role."}
    write(f"{ROOT}/antigravity/plugins/swarmkit/skills/{a['name']}/SKILL.md", fm, header + body)


def main():
    for d in ('claude/agents', 'opencode/agents', 'antigravity/plugins/swarmkit/skills'):
        shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)
    agents = load_agents()
    for a, body in agents:
        build_claude(a, body)
        build_opencode(a, body)
        build_antigravity(a, body)
    with open(f'{ROOT}/antigravity/plugins/swarmkit/plugin.json', 'w') as f:
        f.write('{\n  "name": "swarmkit"\n}\n')
    print(f'Built {len(agents)} agents for claude, opencode, antigravity.')


if __name__ == '__main__':
    main()
