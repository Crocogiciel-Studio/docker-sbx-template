'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { readEntries, buildSessionModel } = require('../files/home/.claude-trace/lib/parser');
const { computeScore, DEFAULT_WEIGHTS } = require('../files/home/.claude-trace/lib/score');

function scoreFor(name) {
  const file = path.join(__dirname, 'fixtures', name);
  return computeScore(buildSessionModel(readEntries(file)));
}

test('clean session scores high and green', () => {
  const result = scoreFor('clean-session.jsonl');
  assert.equal(result.level, 'green');
  assert.ok(result.score >= 75, `expected >=75, got ${result.score}`);
  const byKey = Object.fromEntries(result.signals.map((s) => [s.key, s]));
  assert.ok(byKey.readBeforeEdit.contribution > 0);
  assert.ok(byKey.verificationAfterEdit.contribution > 0);
});

test('risky session scores meaningfully lower than clean, with the right signals present', () => {
  const clean = scoreFor('clean-session.jsonl');
  const risky = scoreFor('risky-session.jsonl');
  assert.ok(risky.score < clean.score, `risky (${risky.score}) should score below clean (${clean.score})`);

  const byKey = Object.fromEntries(risky.signals.map((s) => [s.key, s]));
  assert.ok(byKey.readBeforeEdit.contribution < 0, 'config.js was never read before editing');
  assert.ok(byKey.verificationAfterEdit.contribution < 0, 'the only post-edit verification failed');
  assert.ok(byKey.errorRate.contribution < 0);
  assert.ok(byKey.editLoops.contribution < 0, 'config.js was edited 3 times in a row');
});

test('a review-flavored sub-agent contributes a positive signal', () => {
  const result = scoreFor('subagent-session.jsonl');
  const reviewSignal = result.signals.find((s) => s.key === 'reviewSubagent');
  assert.ok(reviewSignal, 'expected a reviewSubagent signal');
  assert.ok(reviewSignal.contribution > 0);
});

test('signals are sorted by absolute contribution, largest first', () => {
  const result = scoreFor('risky-session.jsonl');
  for (let i = 1; i < result.signals.length; i++) {
    assert.ok(Math.abs(result.signals[i - 1].contribution) >= Math.abs(result.signals[i].contribution));
  }
});

test('score is always clamped to [0, 100] even with exaggerated weights', () => {
  const file = path.join(__dirname, 'fixtures', 'risky-session.jsonl');
  const model = buildSessionModel(readEntries(file));
  const result = computeScore(model, { ...DEFAULT_WEIGHTS, baseline: 0, errorRate: 500, editLoops: 500 });
  assert.ok(result.score >= 0 && result.score <= 100);
});

test('a session with no edits skips edit-dependent signals instead of guessing', () => {
  // Build a read-only model by hand: a prompt and a single Read action, no edits.
  const model = buildSessionModel([
    { type: 'user', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'Explain src/a.js' } },
    {
      type: 'assistant',
      timestamp: '2026-10-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/a.js' } }],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    {
      type: 'user',
      timestamp: '2026-10-01T00:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
    },
  ]);
  const result = computeScore(model);
  const keys = result.signals.map((s) => s.key);
  assert.ok(!keys.includes('readBeforeEdit'));
  assert.ok(!keys.includes('verificationAfterEdit'));
  assert.ok(!keys.includes('scopeCreep'));
  assert.equal(result.score, DEFAULT_WEIGHTS.baseline);
});
