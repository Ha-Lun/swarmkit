// Fake `agy` CLI for dashboard/server/runtimes/agy tests: stream-json events on stdout.
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = flag('-p') ?? '';
const conv = flag('--conversation');
const modelFlag = flag('--model') ?? 'none';
const skip = args.includes('--dangerously-skip-permissions');
const id = conv ?? 'conv-fake-1';
const emit = (obj) => console.log(JSON.stringify(obj));

process.on('SIGINT', () => {
  console.error('got SIGINT');
  process.exit(0);
});

if (prompt === 'hang') {
  emit({ event: 'init', conversation_id: id, init: { cwd: process.cwd(), tools: [], permission_mode: 'skip' } });
  setInterval(() => {}, 1000);
} else if (prompt === 'crash') {
  console.error('boom: something failed');
  process.exit(1);
} else if (prompt === 'slow') {
  const toolParams = { CommandLine: 'echo slow', WaitMsBeforeAsync: 1000, toolSummary: 'slow op' };
  emit({ event: 'init', conversation_id: id, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'skip' } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: toolParams } } });
  setTimeout(() => {
    emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: toolParams } } });
    emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'slow ' } });
    emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'done', usage: { input_tokens: 3, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 1, total_tokens: 6 } } });
    emit({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'slow result', num_turns: 1, usage: { input_tokens: 3, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 1, total_tokens: 6 } } });
  }, 300);
} else if (prompt === 'tool-no-active') {
  const toolParams = { CommandLine: 'echo hi', toolSummary: 'say hi' };
  emit({ event: 'init', conversation_id: id, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'skip' } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: toolParams } } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hello ' } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'world', usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 2, total_tokens: 15 } } });
  emit({
    event: 'result',
    result: {
      conversation_id: id,
      status: 'SUCCESS',
      response: `flags conv=${conv ?? 'none'} skip=${skip} model=${modelFlag}`,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 2, total_tokens: 15 },
    },
  });
} else if (prompt === 'tool-dup-done') {
  const toolParams = { CommandLine: 'echo hi', toolSummary: 'say hi' };
  emit({ event: 'init', conversation_id: id, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'skip' } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: toolParams } } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: toolParams } } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: toolParams } } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hello ' } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'world', usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 2, total_tokens: 15 } } });
  emit({
    event: 'result',
    result: {
      conversation_id: id,
      status: 'SUCCESS',
      response: `flags conv=${conv ?? 'none'} skip=${skip} model=${modelFlag}`,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 2, total_tokens: 15 },
    },
  });
} else {
  const toolParams = { CommandLine: 'echo hi', WaitMsBeforeAsync: 1000, toolSummary: 'say hi' };
  emit({ event: 'init', conversation_id: id, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'skip' } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: toolParams } } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: toolParams } } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hello ' } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'world', usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 2, total_tokens: 15 } } });
  const env = process.env;
  emit({
    event: 'result',
    result: {
      conversation_id: id,
      status: 'SUCCESS',
      response: `flags conv=${conv ?? 'none'} skip=${skip} model=${modelFlag} hookUrl=${env.SWARMKIT_DASH_HOOK_URL ?? 'none'} dashCwd=${env.SWARMKIT_DASH_CWD ?? 'none'} claudecode=${'CLAUDECODE' in env} opencode=${'OPENCODE' in env}`,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 2, total_tokens: 15 },
    },
  });
}
