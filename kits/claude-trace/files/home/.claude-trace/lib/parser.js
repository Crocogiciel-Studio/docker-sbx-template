'use strict';

/**
 * Parses Claude Code transcript JSONL files (~/.claude/projects/<slug>/<session>.jsonl)
 * into a session model the dashboard can render.
 *
 * Format notes (verified against a live transcript, not guessed):
 * - One JSON object per line. `type` discriminates: "assistant", "user", plus
 *   bookkeeping lines ("mode", "permission-mode", "atis-latch", "last-prompt",
 *   "ai-title", "file-history-snapshot", "attachment") that carry no timeline
 *   content and are skipped here.
 * - assistant lines: message.content is an array of blocks (text / thinking /
 *   tool_use). message.usage carries input_tokens, cache_creation_input_tokens,
 *   cache_read_input_tokens, output_tokens.
 * - user lines: message.content is either a plain string (the human's typed
 *   prompt) or an array of tool_result blocks ({tool_use_id, content, is_error}).
 * - Sub-agents (the Agent/Task tool): some harnesses inline the sub-agent's own
 *   turns into the SAME file as isSidechain:true entries; others (observed in
 *   this environment) run the sub-agent out-of-band and only return its final
 *   text via the matching tool_result. Both are handled: inlined sidechain
 *   entries occurring inside a sub-agent tool_use's [start,end] timestamp window
 *   are nested under it; when none exist, the sub-agent still renders as a leaf
 *   node from the tool_use/tool_result pair alone.
 * - A transcript being actively written can end on a truncated JSON line;
 *   that line (and any other line that fails to parse) is skipped, not fatal.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
const EXPLORE_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookEdit']);
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write']);
const PLAN_TOOL_NAMES = new Set(['TodoWrite', 'ExitPlanMode']);

// Matched against "<description> <command>" together, not the command alone:
// the Bash tool's own `description` field is a natural-language statement of
// intent ("Validate kit", "Run tests", "sanity check the config loads") that
// catches verification commands no keyword list of CLI tool names ever will
// (this repo's own `docker build ...` / `sbx kit validate kits/<name>` from
// coding-assertions.md included). Broad on purpose — recall matters more than
// precision for a heuristic signal that only ever makes a session look LESS
// automatically-verified when it misses a true positive, never more.
const VERIFY_COMMAND_RE =
  /\b(test|tests|testing|lint|linting|typecheck|type-check|build|building|validate|validation|verify|verif(y|ied|ication)|check|checking|vet|audit|compile|ci)\b/i;

const REVIEW_SUBAGENT_RE = /review|audit|critique|critic|verify|security/i;

function isVerifyBashInput(input) {
  if (!input) return false;
  return VERIFY_COMMAND_RE.test(`${input.description || ''} ${input.command || ''}`);
}

function resolveTranscriptsRoot() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

function listProjectDirs(transcriptsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(transcriptsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(transcriptsRoot, e.name));
}

function listSessionFiles(transcriptsRoot) {
  const sessions = [];
  for (const projectDir of listProjectDirs(transcriptsRoot)) {
    let files;
    try {
      files = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(projectDir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      sessions.push({
        file,
        projectDir,
        sessionId: name.slice(0, -'.jsonl'.length),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

function readEntries(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Partial line (file being written concurrently) or corrupt line: skip.
    }
  }
  return entries;
}

function textOf(contentArray) {
  if (typeof contentArray === 'string') return contentArray;
  if (!Array.isArray(contentArray)) return '';
  return contentArray
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function resultTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b.text === 'string') return b.text;
        return '';
      })
      .join('\n');
  }
  return '';
}

function toolKind(name) {
  if (SUBAGENT_TOOL_NAMES.has(name)) return 'subagent';
  if (EXPLORE_TOOL_NAMES.has(name)) return 'explore';
  if (EDIT_TOOL_NAMES.has(name)) return 'edit';
  if (PLAN_TOOL_NAMES.has(name)) return 'plan';
  if (name === 'Bash') return 'exec';
  return 'other';
}

function emptyUsage() {
  return { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
}

function addUsage(a, b) {
  a.inputTokens += b.inputTokens;
  a.cacheCreationTokens += b.cacheCreationTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.outputTokens += b.outputTokens;
}

function divideUsage(u, n) {
  return {
    inputTokens: u.inputTokens / n,
    cacheCreationTokens: u.cacheCreationTokens / n,
    cacheReadTokens: u.cacheReadTokens / n,
    outputTokens: u.outputTokens / n,
  };
}

function usageFromMessage(message) {
  const u = message && message.usage;
  if (!u) return emptyUsage();
  return {
    inputTokens: u.input_tokens || 0,
    cacheCreationTokens: u.cache_creation_input_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    outputTokens: u.output_tokens || 0,
  };
}

/**
 * Builds the session model from raw JSONL entries.
 */
function buildSessionModel(entries) {
  const model = {
    sessionId: null,
    cwd: null,
    gitBranch: null,
    startedAt: null,
    lastActivityAt: null,
    actions: [], // flat chronological list (main chain only, excluding sidechain)
    prompts: [], // human prompt turns
    totals: {
      session: emptyUsage(),
      byTool: new Map(), // toolName -> usage
      bySubagent: new Map(), // subagent label -> usage
      byTurn: [], // [{ index, usage, timestamp }]
    },
    filesRead: new Set(),
    filesEdited: new Map(), // file -> [{ timestamp, toolUseId }]
    editedFileOrder: [], // chronological edit events: { file, timestamp }
    verifications: [], // { timestamp, command, isError, outputExcerpt }
    subagents: [], // { id, name, description, subagentType, prompt, startedAt, endedAt, output, children: [] }
    errorCount: 0,
    toolCallCount: 0,
    rawEntryCount: entries.length,
    partialOrCorruptLines: 0,
  };

  const toolUseById = new Map(); // tool_use_id -> { entryIndex, name, input, timestamp }
  const pendingSubagents = []; // subagent nodes awaiting their tool_result, in call order
  const mainEntries = [];
  const sidechainEntries = [];
  let turnIndex = 0;

  for (const entry of entries) {
    if (entry.isSidechain) sidechainEntries.push(entry);
    else mainEntries.push(entry);
  }

  for (const entry of mainEntries) {
    if (!model.sessionId && (entry.sessionId || entry.session_id)) {
      model.sessionId = entry.sessionId || entry.session_id;
    }
    if (!model.cwd && entry.cwd) model.cwd = entry.cwd;
    if (!model.gitBranch && entry.gitBranch) model.gitBranch = entry.gitBranch;
    if (entry.timestamp) {
      if (!model.startedAt) model.startedAt = entry.timestamp;
      model.lastActivityAt = entry.timestamp;
    }

    if (entry.type === 'assistant') {
      const message = entry.message || {};
      const usage = usageFromMessage(message);
      addUsage(model.totals.session, usage);
      model.totals.byTurn.push({ index: turnIndex++, usage, timestamp: entry.timestamp });

      const content = Array.isArray(message.content) ? message.content : [];
      const thinking = content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n');
      const text = textOf(content);

      if (text && text.trim()) {
        model.actions.push({
          kind: 'assistant_text',
          toolName: null,
          timestamp: entry.timestamp,
          label: 'Claude',
          detail: text.slice(0, 2000),
          isError: false,
        });
      }

      // A turn's `usage` covers the WHOLE assistant message, not any single
      // tool call within it. Claude Code commonly batches independent tool
      // calls into one turn (e.g. several Read calls), so crediting the
      // full-turn usage to every tool_use block would inflate the per-tool
      // sum past the session total. Split it evenly across this turn's
      // tool_use blocks instead.
      const toolUseBlockCount = content.filter((b) => b.type === 'tool_use').length;
      const perToolShare = toolUseBlockCount > 0 ? divideUsage(usage, toolUseBlockCount) : emptyUsage();

      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        model.toolCallCount++;
        const name = block.name;
        const isVerifyCommand =
          name === 'Bash' && isVerifyBashInput(block.input);
        const kind = isVerifyCommand ? 'verify' : toolKind(name);
        toolUseById.set(block.id, { name, input: block.input, timestamp: entry.timestamp });

        let byToolUsage = model.totals.byTool.get(name);
        if (!byToolUsage) {
          byToolUsage = emptyUsage();
          model.totals.byTool.set(name, byToolUsage);
        }
        addUsage(byToolUsage, perToolShare);

        const action = {
          kind,
          toolName: name,
          toolUseId: block.id,
          timestamp: entry.timestamp,
          input: block.input,
          label: describeToolUse(name, block.input),
          detail: null,
          isError: false,
          filePath: filePathOf(name, block.input),
          thinking: thinking || null,
        };
        model.actions.push(action);

        if (kind === 'subagent') {
          const node = {
            id: block.id,
            name,
            description: (block.input && block.input.description) || null,
            subagentType: (block.input && block.input.subagent_type) || null,
            prompt: (block.input && block.input.prompt) || null,
            startedAt: entry.timestamp,
            endedAt: null,
            output: null,
            isError: false,
            children: [],
            usage: emptyUsage(),
          };
          model.subagents.push(node);
          pendingSubagents.push(node);
          action.subagentRef = node;
        }

        if (kind === 'edit' && action.filePath) {
          let list = model.filesEdited.get(action.filePath);
          if (!list) {
            list = [];
            model.filesEdited.set(action.filePath, list);
          }
          list.push({ timestamp: entry.timestamp, toolUseId: block.id });
          model.editedFileOrder.push({ file: action.filePath, timestamp: entry.timestamp });
        }
        if (kind === 'explore' && action.filePath) {
          model.filesRead.add(action.filePath);
        }
      }
    } else if (entry.type === 'user') {
      const message = entry.message || {};
      const content = message.content;

      if (typeof content === 'string') {
        if (content.trim()) {
          model.prompts.push({ timestamp: entry.timestamp, text: content });
          model.actions.push({
            kind: 'prompt',
            toolName: null,
            timestamp: entry.timestamp,
            label: 'User prompt',
            detail: content.slice(0, 2000),
            isError: false,
          });
        }
        continue;
      }

      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const call = toolUseById.get(block.tool_use_id);
        const isError = !!block.is_error;
        if (isError) model.errorCount++;
        const resultText = resultTextOf(block.content);

        // Attach result to the matching action (search backwards; cheap for realistic session sizes).
        for (let i = model.actions.length - 1; i >= 0; i--) {
          const a = model.actions[i];
          if (a.toolUseId === block.tool_use_id) {
            a.isError = isError;
            a.detail = resultText.slice(0, 2000);
            break;
          }
        }

        if (call && call.name === 'Bash' && isVerifyBashInput(call.input)) {
          model.verifications.push({
            timestamp: entry.timestamp,
            command: call.input.command,
            isError,
            outputExcerpt: resultText.slice(0, 500),
          });
        }

        const subagentNode = pendingSubagents.find((n) => n.id === block.tool_use_id);
        if (subagentNode) {
          subagentNode.endedAt = entry.timestamp;
          subagentNode.output = resultText.slice(0, 4000);
          subagentNode.isError = isError;
          const idx = pendingSubagents.indexOf(subagentNode);
          if (idx !== -1) pendingSubagents.splice(idx, 1);
        }
      }
    }
  }

  // Nest inlined sidechain entries under whichever subagent's time window contains them.
  for (const entry of sidechainEntries) {
    if (!entry.timestamp) continue;
    const t = Date.parse(entry.timestamp);
    let best = null;
    let bestSpan = Infinity;
    for (const node of model.subagents) {
      const start = Date.parse(node.startedAt);
      const end = node.endedAt ? Date.parse(node.endedAt) : Date.now();
      if (t >= start && t <= end) {
        const span = end - start;
        if (span < bestSpan) {
          bestSpan = span;
          best = node;
        }
      }
    }
    if (best) {
      const text = entry.type === 'assistant' ? textOf((entry.message || {}).content) : '';
      if (entry.type === 'assistant') {
        const usage = usageFromMessage(entry.message);
        addUsage(best.usage, usage);
      }
      if (text && text.trim()) {
        best.children.push({ timestamp: entry.timestamp, text: text.slice(0, 1000) });
      }
      const content = (entry.message || {}).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            best.children.push({
              timestamp: entry.timestamp,
              text: `${describeToolUse(block.name, block.input)}`,
            });
          }
        }
      }
    }
  }

  for (const subNode of model.subagents) {
    let byAgentUsage = model.totals.bySubagent.get(subNode.description || subNode.name);
    if (!byAgentUsage) {
      byAgentUsage = emptyUsage();
      model.totals.bySubagent.set(subNode.description || subNode.name, byAgentUsage);
    }
    addUsage(byAgentUsage, subNode.usage);
  }

  return model;
}

function filePathOf(toolName, input) {
  if (!input) return null;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (toolName === 'Grep' && typeof input.path === 'string') return input.path;
  return null;
}

function describeToolUse(name, input) {
  input = input || {};
  switch (name) {
    case 'Read':
      return `Read ${shortPath(input.file_path)}`;
    case 'Edit':
      return `Edit ${shortPath(input.file_path)}`;
    case 'Write':
      return `Write ${shortPath(input.file_path)}`;
    case 'Grep':
      return `Grep "${truncate(input.pattern, 40)}"`;
    case 'Glob':
      return `Glob "${truncate(input.pattern, 40)}"`;
    case 'Bash':
      return truncate(input.description || input.command, 60);
    case 'Agent':
    case 'Task':
      return `Sub-agent: ${truncate(input.description || input.subagent_type || 'unnamed', 60)}`;
    case 'TodoWrite':
      return 'Update plan';
    case 'ExitPlanMode':
      return 'Exit plan mode';
    case 'WebFetch':
      return `Fetch ${truncate(input.url, 50)}`;
    case 'WebSearch':
      return `Search "${truncate(input.query, 40)}"`;
    default:
      return name;
  }
}

function shortPath(p) {
  if (!p) return '?';
  const parts = String(p).split('/');
  return parts.length > 3 ? `.../${parts.slice(-2).join('/')}` : p;
}

function truncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

module.exports = {
  resolveTranscriptsRoot,
  listSessionFiles,
  readEntries,
  buildSessionModel,
  VERIFY_COMMAND_RE,
  REVIEW_SUBAGENT_RE,
};
