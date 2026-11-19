import assert from 'node:assert/strict';
import { createWhisperProgressParser } from './native-asr-progress';

const values: number[] = [];
const parse = createWhisperProgressParser(value => values.push(value));
parse('server ready\nwhisper_print_progress_callback: pro');
parse('gress =  57%\rwhisper_print_progress_callback: progress = 100');
parse('%\nwhisper_print_progress_callback: progress = 57%\n');
parse('whisper_print_progress_callback: progress = 101%\nmodel download 44%');
assert.deepEqual(values, [57, 100], 'only valid inference percentages are forwarded, including split chunks');
const fresh: number[] = [];
createWhisperProgressParser(value => fresh.push(value))('whisper_print_progress_callback: progress =  5%');
assert.deepEqual(fresh, [5], 'a new recognition starts its own progress');
console.log('native-asr-progress.verify: real whisper progress parsing, chunking and boundaries passed');
