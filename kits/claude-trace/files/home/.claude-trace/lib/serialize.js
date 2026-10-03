'use strict';

const MAX_ACTIONS = 2000;
const MAX_TURNS = 500;
const MAX_VERIFICATIONS = 50;

function mapToObject(map) {
  const out = {};
  for (const [k, v] of map.entries()) out[k] = v;
  return out;
}

/** Converts the parser's Map/Set-bearing session model into plain JSON. */
function serializeModel(model, scoreResult) {
  const actionsTruncated = model.actions.length > MAX_ACTIONS;
  const actions = (actionsTruncated ? model.actions.slice(-MAX_ACTIONS) : model.actions).map((a) => ({
    kind: a.kind,
    toolName: a.toolName,
    timestamp: a.timestamp,
    label: a.label,
    detail: a.detail,
    isError: a.isError,
    filePath: a.filePath || null,
    hasThinking: !!a.thinking,
    subagentId: a.subagentRef ? a.subagentRef.id : null,
  }));

  const turnsTruncated = model.totals.byTurn.length > MAX_TURNS;
  const byTurn = turnsTruncated ? model.totals.byTurn.slice(-MAX_TURNS) : model.totals.byTurn;

  return {
    sessionId: model.sessionId,
    cwd: model.cwd,
    gitBranch: model.gitBranch,
    startedAt: model.startedAt,
    lastActivityAt: model.lastActivityAt,
    toolCallCount: model.toolCallCount,
    errorCount: model.errorCount,
    rawEntryCount: model.rawEntryCount,
    actions,
    actionsTruncated,
    actionsDroppedCount: actionsTruncated ? model.actions.length - MAX_ACTIONS : 0,
    filesRead: [...model.filesRead],
    filesEdited: mapToObject(
      new Map([...model.filesEdited.entries()].map(([f, evs]) => [f, evs.length]))
    ),
    verifications: model.verifications.slice(-MAX_VERIFICATIONS).map((v) => ({
      timestamp: v.timestamp,
      command: v.command,
      isError: v.isError,
    })),
    subagents: model.subagents.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      subagentType: s.subagentType,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      isError: s.isError,
      childCount: s.children.length,
      children: s.children,
      usage: s.usage,
    })),
    totals: {
      session: model.totals.session,
      byTool: mapToObject(model.totals.byTool),
      bySubagent: mapToObject(model.totals.bySubagent),
      byTurn,
      byTurnTruncated: turnsTruncated,
    },
    score: scoreResult,
  };
}

module.exports = { serializeModel };
