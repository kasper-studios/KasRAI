import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasGeneratedStreamOutput } from './streamOutput.js';

test('recognizes a tool-call-only delta as generated output', () => {
  assert.equal(hasGeneratedStreamOutput({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'terminal' } }] } }],
  }), true);
});

test('recognizes text deltas as generated output', () => {
  assert.equal(hasGeneratedStreamOutput({ choices: [{ delta: { content: 'hello' } }] }), true);
});

test('does not count role-only or empty deltas as generated output', () => {
  assert.equal(hasGeneratedStreamOutput({ choices: [{ delta: { role: 'assistant', content: '' } }] }), false);
  assert.equal(hasGeneratedStreamOutput({ choices: [{ delta: {} }] }), false);
});
