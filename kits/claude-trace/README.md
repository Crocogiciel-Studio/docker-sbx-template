# claude-trace

**Experimental.** A Docker Sandboxes mixin kit that runs a live dashboard
inside the sandbox showing *how* Claude Code is working on a session — its
decision timeline, sub-agents, token usage, and a process confidence score —
so you can decide how closely to review the resulting diff before you read a
line of it.

It reads Claude Code's own transcript files locally; it never sends anything
anywhere. There is no `permissions.network` block in this kit's `spec.yaml`
because the server makes zero outbound requests.

## What it shows

- **Confidence score** (0–100, green/orange/red) with the top signals driving
  it. See [Confidence score](#confidence-score) below — read that before
  trusting the number.
- **Timeline**: a chronological, collapsible list of prompts, file reads,
  edits, verification commands (tests/lint/typecheck/build), plan updates, and
  sub-agent calls, colored by kind and flagged on error.
- **Tokens**: session total, split by input/output/cache-read/cache-creation,
  broken down by tool and by sub-agent.
- **Copy PR summary**: a Markdown summary of the above for a PR description.

## Usage

```bash
sbx run claude --kit ghcr.io/<you>/claude-trace:<version>
```

By default `sbx` only pulls kits from a few trusted prefixes. Add your own
registry namespace once (verified against the real setting, not guessed —
`sbx settings get --json kit.allowedSources` shows its type and description):

```bash
sbx settings set kit.allowedSources '["ghcr.io/<you>/"]'
```

This **replaces** the allowed-sources list rather than appending to it,
since the setting's type is a plain JSON array (`sbx settings set` passes
list-typed settings as raw JSON) — include every prefix you need in one call,
e.g. `'["ghcr.io/<you>/", "ghcr.io/docker/"]'`. Use `sbx settings get
kit.allowedSources` to see the current value before overwriting it.

For local development (this repo, before pushing), point `--kit` at the
directory directly:

```bash
sbx run claude --kit ./kits/claude-trace
```

### Publishing the port

The kit declares `ports: [{container: 4317, name: dashboard}]`, so `sbx`
auto-publishes it to an **ephemeral** host port the moment the sandbox is
created — find it with `sbx ports <sandbox-name>`. (An earlier draft of this
kit used the v1 field name `publishedPorts`, which `sbx kit validate` rejects
under `schemaVersion: "2"` with `field publishedPorts not found in type
spec.specFileV2` — v2 renamed it to the plain top-level `ports` used above.)

For a stable, predictable port instead of whatever ephemeral one got
assigned, pin it explicitly:

```bash
sbx ports <sandbox-name> --publish 4317:4317
```

The server binds `0.0.0.0` inside the sandbox, and the kit's `ports` entry
intentionally omits `protocol` (rather than setting `tcp`) so only the IPv4
side (`127.0.0.1`) gets published — the kits-v2 docs note that `tcp` would
also publish `::1`, and a client arriving over that gets accepted then reset
since the server doesn't listen on IPv6. Either way — ephemeral or
pinned — the dashboard is reachable at `http://127.0.0.1:<host-port>`, never
on your LAN, regardless of what `HOST_IP` you pass to `--publish`.

To use a different container port (e.g. it's already taken), edit both
`CLAUDE_TRACE_PORT` and the matching `ports[0].container` in `spec.yaml`
*before* creating the sandbox — a kit's `environment` and `ports` blocks are
applied at creation, not re-read afterwards.

### iTerm2 Toolbelt integration

This part is the least verified piece of this kit — iTerm2's docs site
blocked automated fetches while writing this, so the signature below is
reconstructed from search-indexed excerpts of iTerm2's own Python API docs,
not a page read end-to-end. Confirm it against `pydoc3 iterm2.tool` (after
`pip3 install iterm2`) or iTerm2's own docs before relying on it.

iTerm2's Python API exposes `iterm2.async_register_web_view_tool(...)`,
which registers a Toolbelt panel that renders a URL in a web view. A script
like this, dropped in
`~/Library/Application Support/iTerm2/Scripts/AutoLaunch/`, registers the
dashboard every time iTerm2 starts:

```python
#!/usr/bin/env python3
import iterm2

async def main(connection):
    await iterm2.async_register_web_view_tool(
        connection,
        display_name="claude-trace",
        identifier="com.example.claude-trace",
        reveal_if_already_registered=True,
        url="http://127.0.0.1:4317",
    )

iterm2.run_until_complete(main)
```

Enable the panel from iTerm2's menu: **Toolbelt > claude-trace**. There is no
documented way to *unregister* a tool, but re-running the script with the
same `identifier` and a new `url` updates it in place — handy if you publish
the dashboard on a different host port next time.

## Confidence score

The score is a **process heuristic**, not a correctness judgement — it tells
you how closely the *session* resembles one you wouldn't need to review
carefully, not whether the *code* is right. It always shows its signals; it
is never just a number. Read the diff regardless — this exists to help you
decide how fast to read it, not whether to.

Weights live in one object at the top of
`files/home/.claude-trace/lib/score.js` (`DEFAULT_WEIGHTS`) so they're easy to
retune. Starting from a baseline of 70:

| Signal | What it checks |
| --- | --- |
| Files read before editing | Were edited files `Read`/`Grep`/`Glob`'d earlier in the session? |
| Verified after last edit | Did a test/lint/typecheck/build-looking command run *after* the final edit, and did it pass? |
| Tool errors / retries | Failing tool calls as a fraction of all tool calls. |
| Edits outside stated scope | Edited files never named in a prompt or a plan update (`TodoWrite`/`ExitPlanMode`) — a substring match on the filename, so it's a coarse proxy, not a real intent check. |
| Large diff, little exploration | Edited line count vs. distinct files read. |
| Same file edited repeatedly in a row | Longest consecutive-edit streak on one file — a thrash/loop proxy. |
| Review sub-agent ran | Any sub-agent whose description/type/prompt looks like a review, audit, or security pass (bonus only — its absence is never penalized). |

Known rough edges, by design rather than oversight:

- **Brand-new files look identical to blind overwrites.** "Read before
  editing" and "edits outside scope" can't tell a freshly-created file (which
  can't have been read, and may not share a name with anything in the
  prompt) from an existing file edited blind. A session that's mostly new
  files will score lower than it deserves on these two signals specifically
  — read the other signals too.
- **"Outside scope" is a filename substring match** against prompts and plan
  text, not a real announced-scope check. It flags `utils.js` as in-scope if
  the word "utils" appears anywhere in the conversation, scope-related or
  not.
- **The verification regex is broad on purpose.** It matches
  `test|lint|typecheck|build|validate|verify|check|vet|audit|compile|ci`
  against the Bash tool's `description` *and* `command` together — the
  description is what usually carries intent (`sbx kit validate` or
  `docker build` don't contain any test-runner name, but a description like
  "Validate kit" does). This trades precision for recall: a false positive
  here makes the score more lenient, never stricter.

## Limits

- **The published host port is ephemeral by default** — pin it with
  `sbx ports --publish` if you want it stable across sandbox recreates (see
  [Publishing the port](#publishing-the-port)).
- **No process supervision mid-session.** Docker Sandboxes re-runs `setup.startup`
  commands on every sandbox (re)start, but nothing restarts a background
  startup process if it dies between starts. `spec.yaml` wraps the server in
  its own `while true` restart loop as the only mitigation; a crash loop
  would still show up as repeated `[claude-trace]` log lines in
  `~/.claude-trace.log` inside the sandbox.
- **Sub-agent nesting is best-effort.** Some harnesses inline a sub-agent's
  own turns into the same transcript file (`isSidechain: true`); the
  dashboard nests those under the sub-agent that spawned them by matching
  timestamps against that sub-agent's call window. Other harnesses (this kit
  was *built* inside one) run sub-agents out-of-band and only return their
  final text — in that case the sub-agent still renders, just as a leaf node
  with no visible internal steps.
- **Single most-recent session by default.** The dashboard follows whichever
  `*.jsonl` under the transcripts root has the newest mtime; pass
  `?session=<id>` in the URL (see `GET /api/sessions` for the list) to pin a
  different one.
- **Polls, doesn't watch.** Transcript changes are detected by polling file
  mtimes every 1.5s, not `fs.watch` — this repo's own top-level `CLAUDE.md`
  notes that the sandbox's virtiofs mount doesn't reliably deliver
  filesystem events.
- **`sbx kit pack`/`push` bundles this whole directory**, `test/` and
  `README.md` included — there's no kit-level ignore file. The published OCI
  artifact therefore ships the test fixtures too; they're tiny, synthetic,
  and contain nothing sensitive.

## Development

```bash
node --test kits/claude-trace/test/*.test.js      # unit tests on the parser + scorer
sbx kit validate kits/claude-trace                 # schema check
sbx kit pack kits/claude-trace -o /tmp/claude-trace.zip && unzip -l /tmp/claude-trace.zip
CLAUDE_TRACE_PORT=4317 node kits/claude-trace/files/home/.claude-trace/server.js   # run it locally against your own ~/.claude/projects
```
