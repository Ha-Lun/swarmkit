# n8n Agents Setup Guide

This guide explains how to configure and use the n8n workflow automation agents.

## Prerequisites

### 1. Generate n8n API Key

1. Log into your n8n web interface (via Tailscale MagicDNS)
2. Go to **Settings** → **API**
3. Click **Create API Key**
4. Copy the API key (you won't see it again)

### 2. Find Your n8n API URL

Your n8n instance is running on Docker with Tailscale MagicDNS. The API URL format is:

```
http://[your-magicdns-hostname]:5678/api/v1
```

**Example:**
- Web UI: `http://n8n.myserver.tail12345.ts.net`
- API URL: `http://n8n.myserver.tail12345.ts.net:5678/api/v1`

**To find your exact URL:**
1. Open your browser and go to your n8n web interface
2. Note the URL (it will be your MagicDNS hostname)
3. Append `/api/v1` to get the API URL
4. Make sure the port is included (usually `:5678`)

### 3. Set Environment Variables

Add these to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.):

```bash
export N8N_API_URL="http://your-magicdns-hostname:5678/api/v1"
export N8N_API_KEY="your-api-key-here"
```

Then reload your shell:
```bash
source ~/.bashrc  # or source ~/.zshrc
```

### 4. Test the Setup

Verify the connection works:

```bash
# List all workflows
python .opencode/skills/n8n-api/scripts/n8n_client.py list-workflows

# Should return JSON array of your workflows
```

## Available Agents

### n8n-workflow-builder

**Model:** `opencode-go/qwen3.7-plus`

**Purpose:** Build and design n8n workflows from requirements

**Capabilities:**
- Create workflows via n8n API
- Design workflow architecture
- Advanced Telegram Bot integration
- Self-hosted deployment ops

**Example usage:**
```
"Build me a Telegram bot that responds to /start command"
"Create a workflow that monitors a webhook and sends notifications"
```

### n8n-debugger

**Model:** `opencode-go/deepseek-v4-pro`

**Purpose:** Systematic debugging and root cause analysis

**Capabilities:**
- Analyze execution logs
- Identify failure patterns
- Trace data flow
- Telegram webhook diagnostics

**Example usage:**
```
"Debug why my workflow is failing"
"Analyze execution 12345"
"Check my Telegram webhook status"
```

## Available Skills

### n8n-api

Core API client for workflow management.

**Scripts:**
- `n8n_client.py` - List, get, create, update, activate, delete workflows
- `workflow_builder.py` - Validate, generate, and manipulate workflow JSON

### n8n-debugging

Systematic debugging methodology.

**Scripts:**
- `workflow_debugger.py` - Analyze executions, trace data flow, find error patterns

## Common Commands

### List workflows
```bash
python .opencode/skills/n8n-api/scripts/n8n_client.py list-workflows
```

### Get workflow details
```bash
python .opencode/skills/n8n-api/scripts/n8n_client.py get-workflow <workflow-id>
```

### Analyze failed execution
```bash
python .opencode/skills/n8n-debugging/scripts/workflow_debugger.py analyze-execution <execution-id>
```

### Check Telegram webhook
```bash
python .opencode/skills/n8n-debugging/scripts/workflow_debugger.py check-telegram-webhook <bot-token>
```

### Create Telegram bot workflow
```bash
cat > telegram-config.json << 'EOF'
{
  "name": "My Telegram Bot",
  "commands": [
    {"command": "start", "description": "Start command"},
    {"command": "help", "description": "Help command"}
  ]
}
EOF

python .opencode/skills/n8n-api/scripts/workflow_builder.py create-telegram-bot telegram-config.json
```

## Troubleshooting

### Connection Error
- Check that `N8N_API_URL` is correct
- Verify n8n is running: `docker ps | grep n8n`
- Check Tailscale connection: `tailscale status`

### Authentication Error
- Verify `N8N_API_KEY` is correct
- Regenerate API key in n8n Settings → API
- Ensure API is enabled in n8n settings

### No Workflows Found
- Check that you're connecting to the right n8n instance
- Verify the API key has permissions to read workflows
- Try creating a test workflow manually in n8n UI

## Security Notes

- Never commit `N8N_API_KEY` to version control
- Use environment variables, not hardcoded values
- Regenerate API keys periodically
- Restrict API key permissions in n8n if possible

## Next Steps

1. Set up your environment variables
2. Test the connection with `list-workflows`
3. Restart opencode to load the new agents
4. Try asking the agents to help with your workflows!

Example prompts:
- "Build me a workflow that..."
- "Debug why my workflow is failing"
- "Analyze execution ID 12345"
- "Create a Telegram bot that..."
