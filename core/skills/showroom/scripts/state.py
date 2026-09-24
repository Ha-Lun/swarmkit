#!/usr/bin/env python3
import json
import os
import sys
import argparse

STATE_FILE = ".showroom/state.json"

def get_state():
    if not os.path.exists(STATE_FILE):
        return {
            "project": "",
            "stage": "S0_PREFLIGHT",
            "gate": "AWAITING_HUMAN",
            "current_gate_name": "NONE",
            "assets": {},
            "decisions": [],
            "assumptions": [],
            "open_questions": [],
            "placeholders_outstanding": []
        }
    with open(STATE_FILE, "r") as f:
        return json.load(f)

def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

def update_state(key, value):
    state = get_state()
    keys = key.split('.')
    d = state
    for k in keys[:-1]:
        if k not in d:
            d[k] = {}
        d = d[k]
    
    # Try to parse JSON value if it's a dict/list string representation
    try:
        val = json.loads(value)
    except:
        val = value
        
    d[keys[-1]] = val
    save_state(state)
    print(f"Updated {key} to {val}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Showroom State Management")
    parser.add_argument("--get", action="store_true", help="Get current state")
    parser.add_argument("--set", nargs=2, metavar=('KEY', 'VALUE'), help="Set a state value (e.g. stage S1_INTAKE)")
    
    args = parser.parse_args()
    
    if args.set:
        update_state(args.set[0], args.set[1])
    else:
        print(json.dumps(get_state(), indent=2))
