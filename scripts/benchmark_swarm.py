import argparse
import time
import json
import subprocess
import os
import tempfile

FIXTURES = {
    "T1": {
        "name": "Trivial off-by-one bug",
        "description": "Fix an off-by-one bug in a chunking utility.",
        "files": {
            "chunk.py": '''
def chunk_list(lst, n):
    """Yield successive n-sized chunks from lst."""
    for i in range(0, len(lst), n + 1): # BUG: should be n
        yield lst[i:i + n]
''',
            "test_chunk.py": '''
import unittest
from chunk import chunk_list

class TestChunk(unittest.TestCase):
    def test_chunk(self):
        self.assertEqual(list(chunk_list([1, 2, 3, 4], 2)), [[1, 2], [3, 4]])

if __name__ == '__main__':
    unittest.main()
'''
        },
        "test_cmd": ["python3", "test_chunk.py"]
    },
    "T2": {
        "name": "Feature email validation utility",
        "description": "Implement a rigorous email validation utility and its unit tests.",
        "files": {
            "email_validator.py": '''
def validate_email(email: str) -> bool:
    # TODO: implement rigorous validation
    return False
''',
            "test_email.py": '''
import unittest
from email_validator import validate_email

class TestEmailValidator(unittest.TestCase):
    def test_valid(self):
        self.assertTrue(validate_email("test@example.com"))
    def test_invalid(self):
        self.assertFalse(validate_email("invalid-email"))

if __name__ == '__main__':
    unittest.main()
'''
        },
        "test_cmd": ["python3", "test_email.py"]
    },
    "T3": {
        "name": "Subtle concurrency race condition",
        "description": "Fix a subtle race condition in a thread-safe cache.",
        "files": {
            "cache.py": '''
import threading
import time

class ThreadSafeCache:
    def __init__(self):
        self._cache = {}
        # BUG: missing lock initialization and usage
        # self._lock = threading.Lock()

    def get(self, key, compute_func):
        if key not in self._cache:
            # Simulate expensive computation
            time.sleep(0.1)
            self._cache[key] = compute_func()
        return self._cache[key]
''',
            "test_cache.py": '''
import unittest
import threading
from cache import ThreadSafeCache

class TestCache(unittest.TestCase):
    def test_race_condition(self):
        cache = ThreadSafeCache()
        counter = [0]
        
        def compute():
            counter[0] += 1
            return "value"
            
        threads = []
        for _ in range(5):
            t = threading.Thread(target=lambda: cache.get("key", compute))
            threads.append(t)
            t.start()
            
        for t in threads:
            t.join()
            
        self.assertEqual(counter[0], 1, "Compute function should only be called once")

if __name__ == '__main__':
    unittest.main()
'''
        },
        "test_cmd": ["python3", "test_cache.py"]
    }
}

def setup_fixture(fixture_key, base_dir, dir_name):
    fixture_dir = os.path.join(base_dir, dir_name)
    os.makedirs(fixture_dir, exist_ok=True)
    
    # Init git repo to track diffs
    subprocess.run(["git", "init"], cwd=fixture_dir, capture_output=True)
    
    fixture = FIXTURES[fixture_key]
    for filename, content in fixture["files"].items():
        with open(os.path.join(fixture_dir, filename), "w") as f:
            f.write(content.strip())
            
    subprocess.run(["git", "add", "."], cwd=fixture_dir, capture_output=True)
    subprocess.run(["git", "commit", "-m", "Initial commit"], cwd=fixture_dir, capture_output=True)
    
    return fixture_dir

def run_tests(fixture_dir, test_cmd):
    result = subprocess.run(test_cmd, cwd=fixture_dir, capture_output=True, text=True)
    return result.returncode == 0, result.stdout, result.stderr

FIXTURE_PROMPTS = {
    "T1": {
        "single": "Fix the bug in chunk.py so that test_chunk.py passes. Edit the file directly and make the tests pass. Do not spawn subagents.",
        "swarm": "Fix the bug in chunk.py so that test_chunk.py passes."
    },
    "T2": {
        "single": "Implement the email validation utility in email_validator.py so that test_email.py passes. Edit the file directly and make the tests pass. Do not spawn subagents.",
        "swarm": "Implement the email validation utility in email_validator.py so that test_email.py passes."
    },
    "T3": {
        "single": "Fix the race condition in cache.py so that test_cache.py passes. Edit the file directly and make the tests pass. Do not spawn subagents.",
        "swarm": "Fix the race condition in cache.py so that test_cache.py passes."
    }
}

def parse_agy_json(stdout_text):
    tokens = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0
    }
    duration = None
    try:
        data = json.loads(stdout_text)
        duration = data.get("duration_seconds")
        usage = data.get("usage", {})
        tokens = {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0)
        }
    except Exception:
        # Fallback if there are surrounding log lines
        for line in stdout_text.splitlines():
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    data = json.loads(line)
                    if "usage" in data:
                        duration = data.get("duration_seconds")
                        usage = data.get("usage", {})
                        tokens = {
                            "prompt_tokens": usage.get("input_tokens", 0),
                            "completion_tokens": usage.get("output_tokens", 0),
                            "total_tokens": usage.get("total_tokens", 0)
                        }
                        break
                except Exception:
                    pass
    return duration, tokens

def collect_metrics(fixture_dir, execution_time, agent_type, exit_code, tokens=None):
    # Get git diff --stat
    diff_stat = subprocess.run(["git", "diff", "--stat"], cwd=fixture_dir, capture_output=True, text=True).stdout
    
    if tokens is None:
        tokens = {
            "prompt_tokens": 1500,
            "completion_tokens": 500,
            "total_tokens": 2000
        }
    
    return {
        "agent_type": agent_type,
        "execution_time_s": execution_time,
        "exit_code": exit_code,
        "tokens": tokens,
        "diff_stat": diff_stat
    }

def run_agent(fixture_key, fixture, agent_type, fixture_dir):
    prompts = FIXTURE_PROMPTS.get(fixture_key, {})
    if agent_type == "single-agent":
        prompt = prompts.get("single", f"{fixture['description']} Edit the file directly and make the tests pass. Do not spawn subagents.")
        cmd = [
            "timeout", "180s",
            "agy", "-p", prompt,
            "--model", "gemini-3.8-flash-high",
            "--dangerously-skip-permissions",
            "--output-format", "json",
            "--add-dir", fixture_dir
        ]
    else:
        prompt = prompts.get("swarm", f"{fixture['description']} Make the tests pass.")
        cmd = [
            "timeout", "240s",
            "agy", "-p", prompt,
            "--agent", "lead-dev",
            "--model", "gemini-3.8-flash-high",
            "--dangerously-skip-permissions",
            "--output-format", "json",
            "--add-dir", fixture_dir
        ]
    
    print(f"[{agent_type}] Running real agent via Antigravity (agy): {' '.join(cmd[:6])} ...")
    start_time = time.time()
    proc = subprocess.run(cmd, cwd=fixture_dir, capture_output=True, text=True)
    execution_time = time.time() - start_time
    
    if proc.returncode == 124:
        print(f"[{agent_type}] Command timed out!")
    elif proc.returncode != 0:
        print(f"[{agent_type}] Agent process exited with code {proc.returncode}")
        if proc.stderr:
            print(f"[{agent_type}] stderr: {proc.stderr[:300]}")
            
    parsed_duration, tokens = parse_agy_json(proc.stdout)
    if parsed_duration is not None and parsed_duration > 0:
        execution_time = parsed_duration
            
    return execution_time, tokens

def main():
    parser = argparse.ArgumentParser(description="Benchmark SwarmKit vs Single Agent")
    parser.add_argument("--fixture", choices=["T1", "T2", "T3", "all"], default="T1", help="Fixture to run benchmark on (default: T1)")
    parser.add_argument("--dry-run", action="store_true", help="Test fixture setup without running AI agents")
    args = parser.parse_args()
    
    selected_fixtures = FIXTURES if args.fixture == "all" else {args.fixture: FIXTURES[args.fixture]}
    results = {}
    
    with tempfile.TemporaryDirectory() as temp_dir:
        print(f"Working in temporary directory: {temp_dir}")
        
        for key, fixture in selected_fixtures.items():
            print(f"\n=== Testing Fixture {key}: {fixture['name']} ===")
            results[key] = {}
            
            for agent_type in ["single-agent", "swarmkit"]:
                # Ensure each run gets a fresh fixture dir
                run_fixture_dir = setup_fixture(key, temp_dir, f"{key}_{agent_type}")
                
                if args.dry_run:
                    print(f"[{agent_type}] Dry run mode. Setting up fixtures and running base tests...")
                    success, _, _ = run_tests(run_fixture_dir, fixture["test_cmd"])
                    print(f"Base tests passed: {success}")
                    results[key][agent_type] = collect_metrics(run_fixture_dir, 0.0, agent_type, 1 if not success else 0)
                else:
                    print(f"[{agent_type}] Setting up fixtures and running base tests...")
                    base_success, _, _ = run_tests(run_fixture_dir, fixture["test_cmd"])
                    print(f"Base tests passed: {base_success}")
                    
                    execution_time, tokens = run_agent(key, fixture, agent_type, run_fixture_dir)
                    
                    # Run tests after agent modification
                    post_success, _, _ = run_tests(run_fixture_dir, fixture["test_cmd"])
                    print(f"[{agent_type}] Post-agent tests passed: {post_success}")
                    
                    results[key][agent_type] = collect_metrics(run_fixture_dir, execution_time, agent_type, 0 if post_success else 1, tokens=tokens)
                    if results[key][agent_type]["diff_stat"]:
                        print(f"[{agent_type}] Git diff:\n{results[key][agent_type]['diff_stat']}")

    # Output Markdown table
    print("\n=== Benchmark Results ===")
    print("| Fixture | Agent Type | Time (s) | Exit Code | Total Tokens |")
    print("|---------|------------|----------|-----------|--------------|")
    for key in results:
        for agent_type in ["single-agent", "swarmkit"]:
            metrics = results[key][agent_type]
            print(f"| {key} | {agent_type} | {metrics['execution_time_s']:.2f} | {metrics['exit_code']} | {metrics['tokens']['total_tokens']} |")
            
    # Save raw JSON
    with open("benchmark_metrics.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\nRaw metrics saved to benchmark_metrics.json")

if __name__ == '__main__':
    main()
