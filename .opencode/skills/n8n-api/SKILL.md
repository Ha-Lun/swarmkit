---
name: n8n-api
description: Core n8n REST API client for workflow management. Use when creating, reading, updating, or deleting n8n workflows, checking execution logs, or managing workflow activation. Provides authenticated API access to self-hosted n8n instances.
---

# n8n API Client

Core functionality for interacting with n8n instances via REST API.

## Prerequisites

Set environment variables:
```bash
export N8N_API_URL="http://your-n8n-instance:5678/api/v1"
export N8N_API_KEY="your-api-key-here"
```

## Available Scripts

### n8n_client.py

Core API client with authentication and common operations.

**Usage:**
```bash
python scripts/n8n_client.py list-workflows
python scripts/n8n_client.py get-workflow <workflow-id>
python scripts/n8n_client.py list-executions [--limit 10]
python scripts/n8n_client.py get-execution <execution-id>
python scripts/n8n_client.py create-workflow < workflow.json
python scripts/n8n_client.py update-workflow <workflow-id> < workflow.json
python scripts/n8n_client.py activate-workflow <workflow-id>
python scripts/n8n_client.py deactivate-workflow <workflow-id>
python scripts/n8n_client.py delete-workflow <workflow-id>
```

### workflow_builder.py

Workflow generation and manipulation utilities.

**Usage:**
```bash
python scripts/workflow_builder.py validate < workflow.json
python scripts/workflow_builder.py create-telegram-bot <config.json>
python scripts/workflow_builder.py create-webhook-handler <config.json>
python scripts/workflow_builder.py add-node <workflow.json> <node-config.json>
python scripts/workflow_builder.py connect-nodes <workflow.json> <source-node> <target-node>
```

## API Endpoints

Common endpoints used by the scripts:
- `GET /workflows` - List all workflows
- `GET /workflows/{id}` - Get workflow by ID
- `POST /workflows` - Create new workflow
- `PUT /workflows/{id}` - Update workflow
- `POST /workflows/{id}/activate` - Activate workflow
- `POST /workflows/{id}/deactivate` - Deactivate workflow
- `DELETE /workflows/{id}` - Delete workflow
- `GET /executions` - List executions
- `GET /executions/{id}` - Get execution details

## Authentication

All requests use API key authentication via header:
```
X-N8N-API-KEY: your-api-key
```

## Error Handling

Scripts return:
- Exit code 0 on success
- Exit code 1 on API errors (with error message to stderr)
- Exit code 2 on validation errors
- Exit code 3 on connection errors

## Common Workflows

### List all workflows
```bash
python scripts/n8n_client.py list-workflows
```

### Get workflow details
```bash
python scripts/n8n_client.py get-workflow 123
```

### Create workflow from JSON
```bash
cat workflow.json | python scripts/n8n_client.py create-workflow
```

### Activate a workflow
```bash
python scripts/n8n_client.py activate-workflow 123
```

### Get recent execution logs
```bash
python scripts/n8n_client.py list-executions --limit 20
```
