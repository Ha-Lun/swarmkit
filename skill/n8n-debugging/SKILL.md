---
name: n8n-debugging
description: Systematic debugging and root cause analysis for n8n workflows. Use when workflows fail, produce incorrect results, or need performance optimization. Analyzes execution logs, identifies failure patterns, and provides structured diagnostic reports. Specializes in Telegram integration debugging.
---

# n8n Workflow Debugger

Systematic debugging methodology for n8n workflows.

## Prerequisites

Set environment variables:
```bash
export N8N_API_URL="http://your-n8n-instance:5678/api/v1"
export N8N_API_KEY="your-api-key-here"
```

## Available Scripts

### workflow_debugger.py

Log analysis and systematic debugging.

**Usage:**
```bash
python scripts/workflow_debugger.py analyze-execution <execution-id>
python scripts/workflow_debugger.py analyze-workflow <workflow-id>
python scripts/workflow_debugger.py check-telegram-webhook <bot-token>
python scripts/workflow_debugger.py trace-data-flow <execution-id> <node-name>
python scripts/workflow_debugger.py find-error-patterns [--workflow-id <id>]
```

## Systematic Debugging Methodology

### Phase 1: Information Gathering
1. Get workflow ID or execution ID from user
2. Retrieve workflow definition via n8n_client.py
3. Fetch recent execution logs
4. Identify failure points and error messages

### Phase 2: Analysis
1. Check node configurations (parameters, expressions)
2. Trace data flow through each node (input → output)
3. Identify error messages and stack traces
4. Check external API responses (HTTP status, response body)

### Phase 3: Root Cause Identification
Categorize the issue:
- **Configuration error** - Wrong parameters, missing fields, invalid expressions
- **Data transformation error** - Wrong format, missing data, null values
- **API integration error** - Authentication failure, rate limiting, timeout
- **Logic error** - Wrong conditions, infinite loops, missing branches
- **Telegram-specific** - Message format, callback issues, webhook problems

### Phase 4: Solution
1. Propose specific fix with code/JSON
2. Explain why the fix works
3. Suggest preventive measures

## Output Format

Always provide:
1. **Summary** - What's broken in one sentence
2. **Root Cause** - Why it's broken
3. **Evidence** - Log excerpts or configuration issues
4. **Solution** - Specific fix with code/JSON
5. **Prevention** - How to avoid this in the future

## Common Failure Patterns

### Telegram Trigger Not Firing
- Check webhook URL configuration
- Verify bot token is correct
- Check Telegram Bot API webhook status with `getWebhookInfo`
- Verify n8n webhook URL is accessible from internet

### Callback Data Not Received
- Verify callback_data is set in inline keyboard
- Check Telegram Trigger node is configured for callback_query updates
- Ensure callback_data matches expected pattern
- Check for callback expiration (Telegram limits to 24h)

### HTTP Request Failing
- Check authentication (headers, API keys, OAuth)
- Verify URL and HTTP method
- Check request body format (JSON, form-data, etc.)
- Look for rate limiting (429 errors)
- Check timeout settings

### Data Transformation Errors
- Check expression syntax (={{ }})
- Verify variable names and paths (use $json.fieldName)
- Check for null/undefined values
- Validate JSON structure
- Check for circular references

### Infinite Loops
- Check loop termination conditions
- Verify batch processing limits
- Look for circular references in connections
- Check SplitInBatches node configuration

### Expression Errors
- Invalid expression syntax
- Missing or wrong variable references
- Type mismatches (string vs number)
- Date/time formatting issues

## Debugging Commands

### Analyze a failed execution
```bash
python scripts/workflow_debugger.py analyze-execution 12345
```

### Analyze workflow structure
```bash
python scripts/workflow_debugger.py analyze-workflow 67
```

### Check Telegram webhook status
```bash
python scripts/workflow_debugger.py check-telegram-webhook YOUR_BOT_TOKEN
```

### Trace data flow through a specific node
```bash
python scripts/workflow_debugger.py trace-data-flow 12345 "HTTP Request"
```

### Find error patterns in recent executions
```bash
python scripts/workflow_debugger.py find-error-patterns
```

## Tips

- Always start with the most recent failed execution
- Check node execution order and timing
- Look for patterns in multiple failures
- Verify external service status (Telegram API, third-party APIs)
- Check n8n instance logs if API doesn't show enough detail
