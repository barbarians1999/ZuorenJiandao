import assert from 'node:assert/strict';
import { nextPasteTranscriptRequest } from './pasteTranscriptRequest';

assert.equal(nextPasteTranscriptRequest(0), 1);
assert.equal(nextPasteTranscriptRequest(4), 5);
assert.equal(nextPasteTranscriptRequest(-1), 1);
assert.equal(nextPasteTranscriptRequest(Number.NaN), 1);
console.log('pasteTranscriptRequest.verify: each request receives a fresh monotonic token');
