'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { readEntries, buildSessionModel } = require('../files/home/.claude-trace/lib/parser');

function fixture(name) {
  return path.join(__dirname, 'fixtures', name);
}

function modelFor(name) {
  return buildSessionModel(readEntries(fixture(name)));
}

test('clean session: reads, edits, and verifies the right file', () => {
  const model = modelFor('clean-session.jsonl');
  assert.equal(model.sessionId, 'clean-0001');
  assert.equal(model.cwd, '/work/app');
  assert.ok(model.filesRead.has('/work/app/src/util.js'));
  assert.deepEqual([...model.filesEdited.keys()], ['/work/app/src/util.js']);
  assert.equal(model.verifications.length, 1);
  assert.equal(model.verifications[0].isError, false);
  assert.equal(model.errorCount, 0);
  assert.equal(model.prompts.length, 1);
  assert.equal(model.prompts[0].text, 'Fix the off-by-one bug in src/util.js');
});

test('clean session: per-turn token usage is not double counted across tools', () => {
  const model = modelFor('clean-session.jsonl');
  const sumByTool = (acc, [, u]) => acc + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  const toolTotal = [...model.totals.byTool.entries()].reduce(sumByTool, 0);
  const sessionTotal =
    model.totals.session.inputTokens +
    model.totals.session.outputTokens +
    model.totals.session.cacheReadTokens +
    model.totals.session.cacheCreationTokens;
  // Every turn in this fixture has at most one tool_use, so per-tool totals
  // must never exceed the session total (they would if usage were credited
  // in full to every tool_use block in a multi-tool turn).
  assert.ok(toolTotal <= sessionTotal + 1e-6, `byTool sum (${toolTotal}) exceeds session total (${sessionTotal})`);
});

test('risky session: edit loop, missing read, failing post-edit verification', () => {
  const model = modelFor('risky-session.jsonl');
  assert.equal(model.filesRead.size, 0, 'config.js was never read');
  assert.equal(model.filesEdited.size, 1);
  const edits = model.filesEdited.get('/work/app/src/config.js');
  assert.equal(edits.length, 4, 'Write (creation) + 3 Edit calls all mutate config.js');
  assert.equal(model.errorCount, 1);
  assert.equal(model.verifications.length, 1);
  assert.equal(model.verifications[0].isError, true);

  let maxRun = 1;
  let run = 1;
  for (let i = 1; i < model.editedFileOrder.length; i++) {
    if (model.editedFileOrder[i].file === model.editedFileOrder[i - 1].file) {
      run++;
      maxRun = Math.max(maxRun, run);
    } else run = 1;
  }
  assert.equal(maxRun, 4, 'the Write + 3 Edit calls on config.js all ran back-to-back');
});

test('sub-agent session: inlined sidechain turns nest under the right Agent call by timestamp window', () => {
  const model = modelFor('subagent-session.jsonl');
  assert.equal(model.subagents.length, 1);
  const sub = model.subagents[0];
  assert.equal(sub.description, 'Review the auth.js refactor for bugs');
  assert.equal(sub.subagentType, 'code-reviewer');
  assert.ok(sub.endedAt, 'the matching tool_result closed the sub-agent window');
  assert.ok(sub.children.length >= 1, 'the inlined sidechain turn was attributed to this sub-agent');
  assert.ok(
    sub.children.some((c) => /credentials parameter is now explicit/.test(c.text)),
    'sidechain assistant text made it into the children list'
  );
});

test('sub-agent with no inlined sidechain still renders as a leaf (external-harness case)', () => {
  // Same shape as above but without the isSidechain:true lines: this is what
  // this very build environment does (sub-agent output lives outside the
  // transcript file). The parser must degrade to a leaf node, not throw.
  const entries = readEntries(fixture('subagent-session.jsonl')).filter((e) => !e.isSidechain);
  const model = buildSessionModel(entries);
  assert.equal(model.subagents.length, 1);
  assert.equal(model.subagents[0].children.length, 0);
  assert.ok(model.subagents[0].output.includes('No issues found'));
});

test('corrupt/partial JSONL: blank and truncated lines are skipped, not fatal', () => {
  const entries = readEntries(fixture('corrupt-session.jsonl'));
  // 3 well-formed lines in the fixture; the blank line and the truncated
  // trailing line must not produce entries or throw.
  assert.equal(entries.length, 3);
  const model = buildSessionModel(entries);
  assert.equal(model.sessionId, 'corrupt-0004');
  assert.ok(model.filesEdited.has('/work/app/README.md'));
});

test('missing transcripts directory does not throw', () => {
  const { listSessionFiles } = require('../files/home/.claude-trace/lib/parser');
  const sessions = listSessionFiles('/does/not/exist/at/all');
  assert.deepEqual(sessions, []);
});
