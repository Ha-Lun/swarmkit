// Fake `agy` that records its argv and image env to the file named by RECORD_AGY, then finishes one turn.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.RECORD_AGY) {
  appendFileSync(process.env.RECORD_AGY, `${JSON.stringify({ args, imagesDir: process.env.SWARMKIT_DASH_IMAGES_DIR ?? null })}\n`);
}
const emit = obj => console.log(JSON.stringify(obj));
emit({ event: 'init', conversation_id: 'conv-rec-1', init: { cwd: process.cwd(), tools: [], permission_mode: 'skip' } });
emit({ event: 'result', result: { conversation_id: 'conv-rec-1', status: 'SUCCESS', response: 'ok', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 } } });
