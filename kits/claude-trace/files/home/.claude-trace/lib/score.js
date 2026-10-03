'use strict';

/**
 * Confidence score: a heuristic over *process* signals (did it read before
 * writing, did it verify, did it loop, did it wander outside what it said it
 * would touch), not a judgement of correctness. It exists to help decide how
 * closely to read a diff, never to replace reading it. See the kit's README
 * ("Confidence score") for the rationale behind each signal.
 *
 * All weights live in one place (DEFAULT_WEIGHTS) so they're easy to retune.
 */

const { REVIEW_SUBAGENT_RE } = require('./parser');

const DEFAULT_WEIGHTS = {
  baseline: 70,
  readBeforeEdit: 12,
  verificationAfterEdit: 18,
  errorRate: 15,
  scopeCreep: 10,
  diffVsExploration: 8,
  editLoops: 10,
  reviewSubagentBonus: 5,
};

const LEVEL_THRESHOLDS = { green: 75, orange: 45 };

function levelFor(score) {
  if (score >= LEVEL_THRESHOLDS.green) return 'green';
  if (score >= LEVEL_THRESHOLDS.orange) return 'orange';
  return 'red';
}

function basename(p) {
  const parts = String(p).split('/');
  return parts[parts.length - 1];
}

function countLines(s) {
  if (!s) return 0;
  return String(s).split('\n').length;
}

function computeScore(model, weights) {
  weights = weights || DEFAULT_WEIGHTS;
  const signals = [];
  const editedFiles = [...model.filesEdited.keys()];
  const hasEdits = editedFiles.length > 0;

  let score = weights.baseline;

  // 1. Were edited files read/grepped/globbed first?
  if (hasEdits) {
    const exploredBeforeEdit = editedFiles.filter((f) => model.filesRead.has(f));
    const fraction = exploredBeforeEdit.length / editedFiles.length;
    const contribution = Math.round(weights.readBeforeEdit * (fraction * 2 - 1));
    score += contribution;
    signals.push({
      key: 'readBeforeEdit',
      label: 'Files read before editing',
      contribution,
      detail: `${exploredBeforeEdit.length}/${editedFiles.length} edited files were read, grepped, or globbed earlier in the session.`,
    });
  }

  // 2. Verification after the LAST edit, and did it pass?
  if (hasEdits) {
    const lastEditTs = model.editedFileOrder.reduce(
      (max, e) => (!max || e.timestamp > max ? e.timestamp : max),
      null
    );
    const after = model.verifications.filter((v) => !lastEditTs || v.timestamp >= lastEditTs);
    const last = after[after.length - 1];
    let value;
    let detail;
    if (!after.length) {
      value = 0;
      detail = 'No test/lint/typecheck/build command ran after the last edit.';
    } else if (last.isError) {
      value = 0.3;
      detail = `Last verification after the final edit failed: ${truncate(last.command, 70)}`;
    } else {
      value = 1;
      detail = `Verified after the final edit: ${truncate(last.command, 70)}`;
    }
    const contribution = Math.round(weights.verificationAfterEdit * (value * 2 - 1));
    score += contribution;
    signals.push({ key: 'verificationAfterEdit', label: 'Verified after last edit', contribution, detail });
  }

  // 3. Tool error / retry rate.
  {
    const rate = model.toolCallCount ? model.errorCount / model.toolCallCount : 0;
    const penalty = Math.round(weights.errorRate * Math.min(1, rate / 0.2));
    if (penalty > 0) {
      score -= penalty;
      signals.push({
        key: 'errorRate',
        label: 'Tool errors / retries',
        contribution: -penalty,
        detail: `${model.errorCount} failing tool call(s) out of ${model.toolCallCount}.`,
      });
    }
  }

  // 4. Files edited that were never mentioned in a prompt or plan ("scope creep").
  if (hasEdits) {
    const planText = [
      ...model.prompts.map((p) => p.text),
      ...model.actions.filter((a) => a.kind === 'plan').map((a) => a.detail || a.label || ''),
    ]
      .join('\n')
      .toLowerCase();
    const outside = editedFiles.filter((f) => !planText.includes(basename(f).toLowerCase()));
    const fraction = outside.length / editedFiles.length;
    if (fraction > 0) {
      const penalty = Math.round(weights.scopeCreep * fraction);
      score -= penalty;
      signals.push({
        key: 'scopeCreep',
        label: 'Edits outside the stated scope',
        contribution: -penalty,
        detail: `${outside.length}/${editedFiles.length} edited file(s) never named in a prompt or plan: ${outside
          .slice(0, 3)
          .map(basename)
          .join(', ')}${outside.length > 3 ? ', …' : ''}`,
      });
    }
  }

  // 5. Diff size vs. how much exploration backed it.
  if (hasEdits) {
    let editedLines = 0;
    for (const a of model.actions) {
      if (a.kind !== 'edit') continue;
      if (a.toolName === 'Write') editedLines += countLines(a.input && a.input.content);
      else if (a.toolName === 'Edit') editedLines += countLines(a.input && a.input.new_string);
    }
    const exploredCount = model.filesRead.size;
    const ratio = editedLines / Math.max(1, exploredCount * 20);
    const penalty = Math.round(weights.diffVsExploration * Math.min(1, Math.max(0, (ratio - 1) / 4)));
    if (penalty > 0) {
      score -= penalty;
      signals.push({
        key: 'diffVsExploration',
        label: 'Large diff, little exploration',
        contribution: -penalty,
        detail: `~${editedLines} edited line(s) against ${exploredCount} distinct file(s) read.`,
      });
    }
  }

  // 6. Same file edited back-to-back, N times in a row (thrash/loop).
  if (hasEdits) {
    let maxRun = 1;
    let run = 1;
    for (let i = 1; i < model.editedFileOrder.length; i++) {
      if (model.editedFileOrder[i].file === model.editedFileOrder[i - 1].file) {
        run++;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 1;
      }
    }
    const penalty = Math.round(weights.editLoops * Math.min(1, Math.max(0, (maxRun - 2) / 3)));
    if (penalty > 0) {
      score -= penalty;
      signals.push({
        key: 'editLoops',
        label: 'Same file edited repeatedly in a row',
        contribution: -penalty,
        detail: `Longest consecutive-edit streak on one file: ${maxRun}.`,
      });
    }
  }

  // 7. A review-flavored sub-agent ran.
  {
    const reviewer = model.subagents.find((s) =>
      REVIEW_SUBAGENT_RE.test(`${s.description || ''} ${s.subagentType || ''} ${s.prompt || ''}`)
    );
    if (reviewer) {
      score += weights.reviewSubagentBonus;
      signals.push({
        key: 'reviewSubagent',
        label: 'Review sub-agent ran',
        contribution: weights.reviewSubagentBonus,
        detail: `"${reviewer.description || reviewer.subagentType || reviewer.name}" looked like a review/verification pass.`,
      });
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  signals.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return { score, level: levelFor(score), signals, weights };
}

function truncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

module.exports = { computeScore, DEFAULT_WEIGHTS, LEVEL_THRESHOLDS };
