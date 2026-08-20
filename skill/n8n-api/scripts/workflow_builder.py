#!/usr/bin/env python3
"""
n8n workflow builder utilities.
Provides workflow generation, validation, and manipulation.
"""

import argparse
import json
import sys
import uuid
from typing import Dict, Any, List, Optional


def generate_uuid() -> str:
    """Generate a UUID for node IDs."""
    return str(uuid.uuid4())


def validate_workflow(workflow: Dict[str, Any]) -> bool:
    """Validate workflow JSON structure."""
    required_fields = ['name', 'nodes', 'connections']
    
    for field in required_fields:
        if field not in workflow:
            print(f"Validation Error: Missing required field '{field}'", file=sys.stderr)
            return False
    
    if not isinstance(workflow['nodes'], list):
        print("Validation Error: 'nodes' must be an array", file=sys.stderr)
        return False
    
    if not isinstance(workflow['connections'], dict):
        print("Validation Error: 'connections' must be an object", file=sys.stderr)
        return False
    
    # Validate each node
    for i, node in enumerate(workflow['nodes']):
        if 'name' not in node:
            print(f"Validation Error: Node {i} missing 'name'", file=sys.stderr)
            return False
        if 'type' not in node:
            print(f"Validation Error: Node {i} missing 'type'", file=sys.stderr)
            return False
    
    print("Validation: OK", file=sys.stderr)
    return True


def create_telegram_bot_workflow(config: Dict[str, Any]) -> Dict[str, Any]:
    """Create a Telegram bot workflow from configuration."""
    workflow = {
        "name": config.get('name', 'Telegram Bot'),
        "nodes": [
            {
                "parameters": {
                    "updates": config.get('updates', ['message']),
                    "additionalFields": {}
                },
                "id": generate_uuid(),
                "name": "Telegram Trigger",
                "type": "n8n-nodes-base.telegramTrigger",
                "typeVersion": 1,
                "position": [250, 300],
                "webhookId": "telegram-trigger"
            }
        ],
        "connections": {},
        "active": False,
        "settings": {},
        "tags": []
    }
    
    # Add command handler if specified
    if 'commands' in config:
        switch_node = {
            "parameters": {
                "rules": {
                    "rules": []
                }
            },
            "id": generate_uuid(),
            "name": "Command Router",
            "type": "n8n-nodes-base.switch",
            "typeVersion": 1,
            "position": [450, 300]
        }
        
        for i, cmd in enumerate(config['commands']):
            switch_node['parameters']['rules']['rules'].append({
                "value": f"/{cmd['command']}",
                "output": i
            })
        
        workflow['nodes'].append(switch_node)
        workflow['connections']["Telegram Trigger"] = {
            "main": [[{"node": "Command Router", "type": "main", "index": 0}]]
        }
    
    return workflow


def create_webhook_workflow(config: Dict[str, Any]) -> Dict[str, Any]:
    """Create a webhook handler workflow."""
    workflow = {
        "name": config.get('name', 'Webhook Handler'),
        "nodes": [
            {
                "parameters": {
                    "httpMethod": config.get('method', 'POST'),
                    "path": config.get('path', 'webhook'),
                    "responseMode": "onReceived",
                    "options": {}
                },
                "id": generate_uuid(),
                "name": "Webhook",
                "type": "n8n-nodes-base.webhook",
                "typeVersion": 1,
                "position": [250, 300],
                "webhookId": "webhook-trigger"
            }
        ],
        "connections": {},
        "active": False,
        "settings": {},
        "tags": []
    }
    
    return workflow


def add_node(workflow: Dict[str, Any], node_config: Dict[str, Any]) -> Dict[str, Any]:
    """Add a node to an existing workflow."""
    if 'nodes' not in workflow:
        workflow['nodes'] = []
    
    # Generate ID if not provided
    if 'id' not in node_config:
        node_config['id'] = generate_uuid()
    
    # Set default position if not provided
    if 'position' not in node_config:
        # Position nodes horizontally
        x_offset = 250 + (len(workflow['nodes']) * 200)
        node_config['position'] = [x_offset, 300]
    
    workflow['nodes'].append(node_config)
    return workflow


def connect_nodes(workflow: Dict[str, Any], source_node: str, target_node: str, 
                  source_index: int = 0, target_index: int = 0) -> Dict[str, Any]:
    """Connect two nodes in a workflow."""
    if 'connections' not in workflow:
        workflow['connections'] = {}
    
    if source_node not in workflow['connections']:
        workflow['connections'][source_node] = {"main": []}
    
    # Ensure main array has enough outputs
    while len(workflow['connections'][source_node]['main']) <= source_index:
        workflow['connections'][source_node]['main'].append([])
    
    # Add connection
    workflow['connections'][source_node]['main'][source_index].append({
        "node": target_node,
        "type": "main",
        "index": target_index
    })
    
    return workflow


def main():
    parser = argparse.ArgumentParser(description='n8n workflow builder')
    subparsers = parser.add_subparsers(dest='command', help='Command to execute')
    
    # validate
    subparsers.add_parser('validate', help='Validate workflow JSON from stdin')
    
    # create-telegram-bot
    parser_telegram = subparsers.add_parser('create-telegram-bot', help='Create Telegram bot workflow')
    parser_telegram.add_argument('config', help='Config JSON file')
    
    # create-webhook-handler
    parser_webhook = subparsers.add_parser('create-webhook-handler', help='Create webhook handler workflow')
    parser_webhook.add_argument('config', help='Config JSON file')
    
    # add-node
    parser_add = subparsers.add_parser('add-node', help='Add node to workflow')
    parser_add.add_argument('workflow', help='Workflow JSON file')
    parser_add.add_argument('node_config', help='Node config JSON file')
    
    # connect-nodes
    parser_connect = subparsers.add_parser('connect-nodes', help='Connect two nodes')
    parser_connect.add_argument('workflow', help='Workflow JSON file')
    parser_connect.add_argument('source', help='Source node name')
    parser_connect.add_argument('target', help='Target node name')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    try:
        if args.command == 'validate':
            workflow = json.load(sys.stdin)
            if not validate_workflow(workflow):
                sys.exit(2)
            print(json.dumps(workflow, indent=2))
        
        elif args.command == 'create-telegram-bot':
            with open(args.config) as f:
                config = json.load(f)
            workflow = create_telegram_bot_workflow(config)
            print(json.dumps(workflow, indent=2))
        
        elif args.command == 'create-webhook-handler':
            with open(args.config) as f:
                config = json.load(f)
            workflow = create_webhook_workflow(config)
            print(json.dumps(workflow, indent=2))
        
        elif args.command == 'add-node':
            with open(args.workflow) as f:
                workflow = json.load(f)
            with open(args.node_config) as f:
                node_config = json.load(f)
            workflow = add_node(workflow, node_config)
            print(json.dumps(workflow, indent=2))
        
        elif args.command == 'connect-nodes':
            with open(args.workflow) as f:
                workflow = json.load(f)
            workflow = connect_nodes(workflow, args.source, args.target)
            print(json.dumps(workflow, indent=2))
    
    except json.JSONDecodeError as e:
        print(f"JSON Error: {str(e)}", file=sys.stderr)
        sys.exit(2)
    except FileNotFoundError as e:
        print(f"File Error: {str(e)}", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
