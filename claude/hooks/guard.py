import sys
import json

def main():
    if len(sys.argv) < 2:
        sys.exit(0)
    agent_name = sys.argv[1]
    
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
        
    tool_name = data.get('tool_name') or data.get('tool', '')
    if not tool_name:
        sys.exit(0)
        
    params = data.get('tool_input') or data.get('params') or {}
    cmd = params.get('command') or params.get('cmd') or ''
    path = params.get('file_path') or params.get('path') or params.get('file') or ''
    
    if agent_name in ['code-proofreader', 'security-auditor']:
        if tool_name == 'Bash':
            allowed = ['git diff', 'grep', 'rg', 'find', 'cat', 'ls']
            if not any(cmd.strip().startswith(a) for a in allowed):
                print(f"Command not allowed for {agent_name}: {cmd}", file=sys.stderr)
                sys.exit(2)
                
    elif agent_name == 'release-tester':
        if tool_name == 'Bash':
            allowed = ['npm test', 'pytest', 'cargo test', 'git status', 'git diff']
            if not any(cmd.strip().startswith(a) for a in allowed):
                print(f"Command not allowed for {agent_name}: {cmd}", file=sys.stderr)
                sys.exit(2)
                
    elif agent_name == 'test-writer':
        if tool_name in ['Edit', 'Write']:
            if 'test' not in path.lower() and 'spec' not in path.lower():
                print(f"test-writer can only modify test files: {path}", file=sys.stderr)
                sys.exit(2)
                
    elif agent_name == 'git-specialist':
        if tool_name in ['Edit', 'Write']:
            if not path.endswith('.gitignore'):
                print(f"git-specialist can only modify .gitignore: {path}", file=sys.stderr)
                sys.exit(2)

    sys.exit(0)

if __name__ == '__main__':
    main()
