#!/usr/bin/env python3
"""
n8n REST API client for workflow management.
Provides authenticated access to n8n instances.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from typing import Optional, Dict, Any, List


class N8nClient:
    """Client for n8n REST API."""
    
    def __init__(self, api_url: Optional[str] = None, api_key: Optional[str] = None):
        self.api_url = api_url or os.environ.get('N8N_API_URL')
        self.api_key = api_key or os.environ.get('N8N_API_KEY')
        
        if not self.api_url:
            raise ValueError("N8N_API_URL environment variable not set")
        if not self.api_key:
            raise ValueError("N8N_API_KEY environment variable not set")
        
        # Remove trailing slash if present
        self.api_url = self.api_url.rstrip('/')
    
    def _make_request(self, method: str, endpoint: str, data: Optional[Dict] = None) -> Dict[str, Any]:
        """Make authenticated request to n8n API."""
        url = f"{self.api_url}{endpoint}"
        
        headers = {
            'X-N8N-API-KEY': self.api_key,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
        
        try:
            if data:
                req = urllib.request.Request(
                    url,
                    data=json.dumps(data).encode('utf-8'),
                    headers=headers,
                    method=method
                )
            else:
                req = urllib.request.Request(url, headers=headers, method=method)
            
            with urllib.request.urlopen(req) as response:
                response_data = response.read().decode('utf-8')
                if response_data:
                    return json.loads(response_data)
                return {}
        
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')
            print(f"API Error {e.code}: {error_body}", file=sys.stderr)
            sys.exit(1)
        except urllib.error.URLError as e:
            print(f"Connection Error: {e.reason}", file=sys.stderr)
            sys.exit(3)
        except Exception as e:
            print(f"Error: {str(e)}", file=sys.stderr)
            sys.exit(1)
    
    def list_workflows(self) -> List[Dict]:
        """List all workflows."""
        result = self._make_request('GET', '/workflows')
        return result.get('data', [])
    
    def get_workflow(self, workflow_id: str) -> Dict[str, Any]:
        """Get workflow by ID."""
        return self._make_request('GET', f'/workflows/{workflow_id}')
    
    def create_workflow(self, workflow_data: Dict[str, Any]) -> Dict[str, Any]:
        """Create new workflow."""
        return self._make_request('POST', '/workflows', workflow_data)
    
    def update_workflow(self, workflow_id: str, workflow_data: Dict[str, Any]) -> Dict[str, Any]:
        """Update existing workflow."""
        return self._make_request('PUT', f'/workflows/{workflow_id}', workflow_data)
    
    def activate_workflow(self, workflow_id: str) -> Dict[str, Any]:
        """Activate workflow."""
        return self._make_request('POST', f'/workflows/{workflow_id}/activate')
    
    def deactivate_workflow(self, workflow_id: str) -> Dict[str, Any]:
        """Deactivate workflow."""
        return self._make_request('POST', f'/workflows/{workflow_id}/deactivate')
    
    def delete_workflow(self, workflow_id: str) -> Dict[str, Any]:
        """Delete workflow."""
        return self._make_request('DELETE', f'/workflows/{workflow_id}')
    
    def list_executions(self, limit: int = 10) -> List[Dict]:
        """List recent executions."""
        result = self._make_request('GET', f'/executions?limit={limit}')
        return result.get('data', [])
    
    def get_execution(self, execution_id: str) -> Dict[str, Any]:
        """Get execution details with logs."""
        return self._make_request('GET', f'/executions/{execution_id}')


def main():
    parser = argparse.ArgumentParser(description='n8n API client')
    subparsers = parser.add_subparsers(dest='command', help='Command to execute')
    
    # list-workflows
    subparsers.add_parser('list-workflows', help='List all workflows')
    
    # get-workflow
    parser_get = subparsers.add_parser('get-workflow', help='Get workflow by ID')
    parser_get.add_argument('workflow_id', help='Workflow ID')
    
    # list-executions
    parser_exec = subparsers.add_parser('list-executions', help='List recent executions')
    parser_exec.add_argument('--limit', type=int, default=10, help='Number of executions to list')
    
    # get-execution
    parser_get_exec = subparsers.add_parser('get-execution', help='Get execution details')
    parser_get_exec.add_argument('execution_id', help='Execution ID')
    
    # create-workflow
    subparsers.add_parser('create-workflow', help='Create workflow from stdin JSON')
    
    # update-workflow
    parser_update = subparsers.add_parser('update-workflow', help='Update workflow from stdin JSON')
    parser_update.add_argument('workflow_id', help='Workflow ID')
    
    # activate-workflow
    parser_activate = subparsers.add_parser('activate-workflow', help='Activate workflow')
    parser_activate.add_argument('workflow_id', help='Workflow ID')
    
    # deactivate-workflow
    parser_deactivate = subparsers.add_parser('deactivate-workflow', help='Deactivate workflow')
    parser_deactivate.add_argument('workflow_id', help='Workflow ID')
    
    # delete-workflow
    parser_delete = subparsers.add_parser('delete-workflow', help='Delete workflow')
    parser_delete.add_argument('workflow_id', help='Workflow ID')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    try:
        client = N8nClient()
        
        if args.command == 'list-workflows':
            workflows = client.list_workflows()
            print(json.dumps(workflows, indent=2))
        
        elif args.command == 'get-workflow':
            workflow = client.get_workflow(args.workflow_id)
            print(json.dumps(workflow, indent=2))
        
        elif args.command == 'list-executions':
            executions = client.list_executions(args.limit)
            print(json.dumps(executions, indent=2))
        
        elif args.command == 'get-execution':
            execution = client.get_execution(args.execution_id)
            print(json.dumps(execution, indent=2))
        
        elif args.command == 'create-workflow':
            workflow_data = json.load(sys.stdin)
            result = client.create_workflow(workflow_data)
            print(json.dumps(result, indent=2))
        
        elif args.command == 'update-workflow':
            workflow_data = json.load(sys.stdin)
            result = client.update_workflow(args.workflow_id, workflow_data)
            print(json.dumps(result, indent=2))
        
        elif args.command == 'activate-workflow':
            result = client.activate_workflow(args.workflow_id)
            print(json.dumps(result, indent=2))
        
        elif args.command == 'deactivate-workflow':
            result = client.deactivate_workflow(args.workflow_id)
            print(json.dumps(result, indent=2))
        
        elif args.command == 'delete-workflow':
            result = client.delete_workflow(args.workflow_id)
            print(json.dumps(result, indent=2))
    
    except ValueError as e:
        print(f"Configuration Error: {str(e)}", file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
