#!/usr/bin/env python3
"""
n8n workflow debugger for systematic debugging and root cause analysis.
Analyzes execution logs, identifies failure patterns, and provides diagnostics.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from typing import Dict, Any, List, Optional


class N8nDebugger:
    """Debugger for n8n workflows."""
    
    def __init__(self):
        self.api_url = os.environ.get('N8N_API_URL')
        self.api_key = os.environ.get('N8N_API_KEY')
        
        if not self.api_url:
            raise ValueError("N8N_API_URL environment variable not set")
        if not self.api_key:
            raise ValueError("N8N_API_KEY environment variable not set")
        
        self.api_url = self.api_url.rstrip('/')
    
    def _make_request(self, method: str, endpoint: str) -> Dict[str, Any]:
        """Make authenticated request to n8n API."""
        url = f"{self.api_url}{endpoint}"
        
        headers = {
            'X-N8N-API-KEY': self.api_key,
            'Accept': 'application/json'
        }
        
        try:
            req = urllib.request.Request(url, headers=headers, method=method)
            with urllib.request.urlopen(req) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')
            print(f"API Error {e.code}: {error_body}", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"Error: {str(e)}", file=sys.stderr)
            sys.exit(1)
    
    def analyze_execution(self, execution_id: str) -> Dict[str, Any]:
        """Analyze a failed execution and identify issues."""
        execution = self._make_request('GET', f'/executions/{execution_id}')
        
        report = {
            "execution_id": execution_id,
            "status": execution.get('status', 'unknown'),
            "workflow_id": execution.get('workflowId'),
            "started_at": execution.get('startedAt'),
            "stopped_at": execution.get('stoppedAt'),
            "nodes": [],
            "errors": [],
            "warnings": []
        }
        
        # Analyze each node execution
        if 'data' in execution and 'resultData' in execution['data']:
            result_data = execution['data']['resultData']
            
            if 'runData' in result_data:
                for node_name, node_runs in result_data['runData'].items():
                    for run in node_runs:
                        node_report = {
                            "name": node_name,
                            "status": run.get('executionStatus', 'unknown'),
                            "start_time": run.get('startTime'),
                            "end_time": run.get('endTime')
                        }
                        
                        # Check for errors
                        if 'error' in run:
                            error = run['error']
                            report['errors'].append({
                                "node": node_name,
                                "message": error.get('message', 'Unknown error'),
                                "description": error.get('description', ''),
                                "stack": error.get('stack', '')
                            })
                            node_report['error'] = error
                        
                        # Check data
                        if 'data' in run:
                            node_report['data_preview'] = self._preview_data(run['data'])
                        
                        report['nodes'].append(node_report)
        
        return report
    
    def _preview_data(self, data: Any, max_items: int = 5) -> Any:
        """Create a preview of data structure."""
        if isinstance(data, dict):
            return {k: self._preview_data(v, max_items) for k, v in list(data.items())[:max_items]}
        elif isinstance(data, list):
            return [self._preview_data(item, max_items) for item in data[:max_items]]
        else:
            return data
    
    def analyze_workflow(self, workflow_id: str) -> Dict[str, Any]:
        """Analyze workflow structure for potential issues."""
        workflow = self._make_request('GET', f'/workflows/{workflow_id}')
        
        report = {
            "workflow_id": workflow_id,
            "name": workflow.get('name'),
            "active": workflow.get('active'),
            "node_count": len(workflow.get('nodes', [])),
            "nodes": [],
            "issues": []
        }
        
        # Analyze each node
        for node in workflow.get('nodes', []):
            node_report = {
                "name": node.get('name'),
                "type": node.get('type'),
                "type_version": node.get('typeVersion'),
                "position": node.get('position')
            }
            
            # Check for common issues
            if not node.get('parameters'):
                report['issues'].append({
                    "node": node.get('name'),
                    "issue": "Node has no parameters configured"
                })
            
            # Check expressions
            params_str = json.dumps(node.get('parameters', {}))
            if '={{' in params_str and '}}' not in params_str:
                report['issues'].append({
                    "node": node.get('name'),
                    "issue": "Incomplete expression syntax"
                })
            
            report['nodes'].append(node_report)
        
        # Check connections
        connections = workflow.get('connections', {})
        for source_node, conn_data in connections.items():
            if 'main' in conn_data:
                for output_idx, outputs in enumerate(conn_data['main']):
                    for conn in outputs:
                        target_node = conn.get('node')
                        # Check if target node exists
                        if not any(n.get('name') == target_node for n in workflow.get('nodes', [])):
                            report['issues'].append({
                                "node": source_node,
                                "issue": f"Connection to non-existent node '{target_node}'"
                            })
        
        return report
    
    def check_telegram_webhook(self, bot_token: str) -> Dict[str, Any]:
        """Check Telegram webhook status."""
        url = f"https://api.telegram.org/bot{bot_token}/getWebhookInfo"
        
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req) as response:
                result = json.loads(response.read().decode('utf-8'))
                
                if result.get('ok'):
                    webhook_info = result['result']
                    return {
                        "url": webhook_info.get('url'),
                        "has_custom_certificate": webhook_info.get('has_custom_certificate'),
                        "pending_update_count": webhook_info.get('pending_update_count'),
                        "last_error_date": webhook_info.get('last_error_date'),
                        "last_error_message": webhook_info.get('last_error_message'),
                        "max_connections": webhook_info.get('max_connections'),
                        "allowed_updates": webhook_info.get('allowed_updates')
                    }
                else:
                    return {"error": result.get('description', 'Unknown error')}
        except Exception as e:
            return {"error": str(e)}
    
    def trace_data_flow(self, execution_id: str, node_name: str) -> Dict[str, Any]:
        """Trace data flow through a specific node."""
        execution = self._make_request('GET', f'/executions/{execution_id}')
        
        trace = {
            "execution_id": execution_id,
            "node": node_name,
            "input": None,
            "output": None,
            "error": None
        }
        
        if 'data' in execution and 'resultData' in execution['data']:
            run_data = execution['data']['resultData'].get('runData', {})
            
            if node_name in run_data:
                runs = run_data[node_name]
                if runs:
                    run = runs[0]  # First run
                    
                    # Get input data
                    if 'data' in run and 'main' in run['data']:
                        main_data = run['data']['main']
                        if main_data and len(main_data) > 0:
                            trace['input'] = self._preview_data(main_data[0])
                    
                    # Get output data
                    if 'data' in run and 'main' in run['data']:
                        main_data = run['data']['main']
                        if main_data and len(main_data) > 1:
                            trace['output'] = self._preview_data(main_data[1])
                    
                    # Get error
                    if 'error' in run:
                        trace['error'] = run['error']
        
        return trace
    
    def find_error_patterns(self, workflow_id: Optional[str] = None) -> Dict[str, Any]:
        """Find error patterns in recent executions."""
        # Get recent executions
        endpoint = '/executions?limit=50'
        if workflow_id:
            endpoint += f'&workflowId={workflow_id}'
        
        executions = self._make_request('GET', endpoint)
        
        patterns = {
            "total_executions": 0,
            "failed_executions": 0,
            "error_types": {},
            "failing_nodes": {}
        }
        
        for execution in executions.get('data', []):
            patterns['total_executions'] += 1
            
            if execution.get('status') == 'error':
                patterns['failed_executions'] += 1
                
                # Analyze errors
                if 'data' in execution and 'resultData' in execution['data']:
                    run_data = execution['data']['resultData'].get('runData', {})
                    
                    for node_name, runs in run_data.items():
                        for run in runs:
                            if 'error' in run:
                                error_msg = run['error'].get('message', 'Unknown')
                                
                                # Count error types
                                patterns['error_types'][error_msg] = patterns['error_types'].get(error_msg, 0) + 1
                                
                                # Count failing nodes
                                patterns['failing_nodes'][node_name] = patterns['failing_nodes'].get(node_name, 0) + 1
        
        return patterns


def main():
    parser = argparse.ArgumentParser(description='n8n workflow debugger')
    subparsers = parser.add_subparsers(dest='command', help='Command to execute')
    
    # analyze-execution
    parser_exec = subparsers.add_parser('analyze-execution', help='Analyze a failed execution')
    parser_exec.add_argument('execution_id', help='Execution ID')
    
    # analyze-workflow
    parser_wf = subparsers.add_parser('analyze-workflow', help='Analyze workflow structure')
    parser_wf.add_argument('workflow_id', help='Workflow ID')
    
    # check-telegram-webhook
    parser_tg = subparsers.add_parser('check-telegram-webhook', help='Check Telegram webhook status')
    parser_tg.add_argument('bot_token', help='Telegram bot token')
    
    # trace-data-flow
    parser_trace = subparsers.add_parser('trace-data-flow', help='Trace data flow through a node')
    parser_trace.add_argument('execution_id', help='Execution ID')
    parser_trace.add_argument('node_name', help='Node name')
    
    # find-error-patterns
    parser_patterns = subparsers.add_parser('find-error-patterns', help='Find error patterns')
    parser_patterns.add_argument('--workflow-id', help='Filter by workflow ID')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    try:
        debugger = N8nDebugger()
        
        if args.command == 'analyze-execution':
            report = debugger.analyze_execution(args.execution_id)
            print(json.dumps(report, indent=2))
        
        elif args.command == 'analyze-workflow':
            report = debugger.analyze_workflow(args.workflow_id)
            print(json.dumps(report, indent=2))
        
        elif args.command == 'check-telegram-webhook':
            report = debugger.check_telegram_webhook(args.bot_token)
            print(json.dumps(report, indent=2))
        
        elif args.command == 'trace-data-flow':
            trace = debugger.trace_data_flow(args.execution_id, args.node_name)
            print(json.dumps(trace, indent=2))
        
        elif args.command == 'find-error-patterns':
            patterns = debugger.find_error_patterns(args.workflow_id)
            print(json.dumps(patterns, indent=2))
    
    except ValueError as e:
        print(f"Configuration Error: {str(e)}", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
