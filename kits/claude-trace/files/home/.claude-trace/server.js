'use strict';

/**
 * claude-trace dashboard server. Zero dependencies (Node core modules only) so
 * the kit never needs outbound network access inside the sandbox.
 *
 * Reads Claude Code's own transcript files (never writes to them), and polls
 * instead of using fs.watch: this repo's own CLAUDE.md notes that virtiofs
 * (the sandbox's mount type) does not reliably deliver filesystem events.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { resolveTranscriptsRoot, listSessionFiles, readEntries, buildSessionModel } = require('./lib/parser');
const { computeScore } = require('./lib/score');
const { serializeModel } = require('./lib/serialize');

const PORT = Number(process.env.CLAUDE_TRACE_PORT || process.env.PORT || 4317);
const HOST = '0.0.0.0';
const POLL_MS = 1500;
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

function safeListSessions() {
  try {
    return listSessionFiles(resolveTranscriptsRoot());
  } catch (err) {
    console.error('[claude-trace] failed to list sessions:', err.message);
    return [];
  }
}

function buildState(sessionFile) {
  const entries = readEntries(sessionFile);
  const model = buildSessionModel(entries);
  const score = computeScore(model);
  return serializeModel(model, score);
}

/** Resolves which session file to serve: explicit ?session=<id>, else the most recently active one. */
function resolveSessionFile(query) {
  const sessions = safeListSessions();
  if (!sessions.length) return null;
  if (query.session) {
    const match = sessions.find((s) => s.sessionId === query.session);
    if (match) return match;
  }
  return sessions[0];
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handleSessions(req, res) {
  const sessions = safeListSessions().map((s) => ({
    sessionId: s.sessionId,
    projectDir: path.basename(s.projectDir),
    mtimeMs: s.mtimeMs,
    size: s.size,
  }));
  sendJson(res, 200, { sessions, transcriptsRoot: resolveTranscriptsRoot() });
}

function handleState(req, res, query) {
  const session = resolveSessionFile(query);
  if (!session) {
    sendJson(res, 200, { empty: true, transcriptsRoot: resolveTranscriptsRoot() });
    return;
  }
  try {
    const state = buildState(session.file);
    sendJson(res, 200, state);
  } catch (err) {
    console.error('[claude-trace] failed to build state:', err.message);
    sendJson(res, 200, { empty: true, error: 'parse-failed', transcriptsRoot: resolveTranscriptsRoot() });
  }
}

function handleStream(req, res, query) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  let lastMtime = null;
  let lastSessionFile = null;

  const tick = () => {
    let session;
    try {
      session = resolveSessionFile(query);
    } catch (err) {
      console.error('[claude-trace] stream: list sessions failed:', err.message);
      return;
    }
    if (!session) {
      res.write(`event: empty\ndata: {}\n\n`);
      return;
    }
    if (session.file === lastSessionFile && session.mtimeMs === lastMtime) {
      res.write(': keepalive\n\n');
      return;
    }
    lastSessionFile = session.file;
    lastMtime = session.mtimeMs;
    try {
      const state = buildState(session.file);
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    } catch (err) {
      console.error('[claude-trace] stream: build state failed:', err.message);
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'parse-failed' })}\n\n`);
    }
  };

  tick();
  const interval = setInterval(tick, POLL_MS);
  req.on('close', () => clearInterval(interval));
}

function handleIndex(req, res) {
  fs.readFile(INDEX_HTML, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('claude-trace: failed to load UI');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  const query = Object.fromEntries(url.searchParams.entries());

  try {
    if (url.pathname === '/api/sessions') return handleSessions(req, res);
    if (url.pathname === '/api/state') return handleState(req, res, query);
    if (url.pathname === '/api/stream') return handleStream(req, res, query);
    if (url.pathname === '/' || url.pathname === '/index.html') return handleIndex(req, res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    console.error('[claude-trace] request handler crashed:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('internal error');
    }
  }
});

server.on('error', (err) => {
  console.error('[claude-trace] server error:', err.message);
});

server.listen(PORT, HOST, () => {
  console.log(`[claude-trace] listening on http://${HOST}:${PORT} (transcripts: ${resolveTranscriptsRoot()})`);
});
