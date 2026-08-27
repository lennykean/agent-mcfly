# Agent McFly

[![CI](https://github.com/lennykean/agent-mcfly/actions/workflows/ci.yml/badge.svg)](https://github.com/lennykean/agent-mcfly/actions/workflows/ci.yml)
[![Publish to npm](https://github.com/lennykean/agent-mcfly/actions/workflows/publish.yml/badge.svg)](https://github.com/lennykean/agent-mcfly/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/v/agent-mcfly)](https://www.npmjs.com/package/agent-mcfly)

Agent McFly is a browser workbench for Codex, Claude Code, and Cursor Agent sessions. It replays a completed session step by step. It also follows a live session while the agent works. You can start an agent in a McFly terminal, watch its session, and speak to the agent in one window. The chat, the tool calls, the files, and the terminal always show the same step.

![The Agent McFly workbench during a replay](docs/hero.png)

## Quick start

```bash
npx agent-mcfly
```

The server starts on port 7777 and opens the browser.

| Flag | Function |
|---|---|
| `-p`, `--port <port>` | Set the server port. |
| `--no-open` | Do not open the browser. |
| `-v`, `--version` | Show the version. |

## Agents

McFly reads the sessions that each agent already writes, and it never writes to a session. The optional setup below adds a Codex lifecycle hook that reports the exact session ID to a local McFly terminal.

| Agent | Command | Sessions |
|---|---|---|
| Claude Code | `claude` | `~/.claude/projects` |
| Codex | `codex` | `~/.codex/sessions` |
| Cursor Agent | `cursor-agent` | `~/.cursor/chats` |

McFly finds the sessions of the folder that you open. It lists the agents that have a session for that folder, thus an agent shows only where you used it.

Cursor Agent keeps a session in a SQLite database. To read one, McFly's Node runtime must provide `node:sqlite` (added in Node 22.5; early supporting releases require `--experimental-sqlite`, and `--no-experimental-sqlite` disables it). Without it, the other two agents still work, while Cursor Agent shows no sessions and its MCP launcher reports unavailable.

## The workbench

**Replay.** A replay shows one step of a session at a time. The play bar at the bottom moves the playhead. All panes follow the playhead. To go to a step, click a message, a tool call, or a line of code. The tour guide toggle sets what the view does with a new item. When the tour guide is on, the view goes to the new item. When it is off, the tab of the item flashes.

![A replay in motion, with the typing animation](docs/playback.gif)

**Live sessions.** McFly follows a session while the agent works. New steps come in at the end, and the playhead stays at the end. To control the agent from McFly, start it in a McFly terminal. Then one window shows the session and the terminal that drives it.

![A live claude terminal next to the session it runs](docs/terminal.png)

**File history.** The editor shows each file as it was at the current step. The content is what the agent read or wrote at that time. To see all changes to one file, open its timeline. The timeline opens as a new tab. It lists each change from the session, and it names the step that made each line.

![The file timeline with the blame gutter and the pager](docs/timeline.png)

## Many agents at once

McFly shows more than one agent in one window. Each agent is a root workspace. A root workspace keeps its own playhead, tabs, and panes. The AGENTS list groups the roots by project folder.

To attach another agent, click **+** in the AGENTS header. To change to another root, click it. The root that you leave keeps its state. The URL holds each open root, thus a bookmark opens the full set again.

Each root has a color when two or more roots are open. The color marks the rows of that root in the AGENTS list, its terminal tab, and the title bar. To change the color, click the color square next to the project name.

Each project row has two buttons. The terminal button starts a terminal in that folder. The VS Code button opens that folder in VS Code. The VS Code button needs the `code` command on the PATH, and it shows only for a local folder.

**Sub-agents.** A sub-agent is an agent that another agent starts. The AGENTS list shows a sub-agent below its parent. To watch the session of a sub-agent, click it. A sub-agent leaves the list when the playhead moves past its last action. It comes back when the playhead moves into its life again. Codex teams, Claude Code sub-agents, and Cursor Agent subagents work the same way.

**Remote agents.** The radio-tower button in the AGENTS header connects to a host with SSH. McFly then reads the sessions of that host and runs terminals on it. A remote root works like a local root. Its address stays in the URL.

## Terminals

The LIVE TERMINAL pane keeps more than one terminal as tabs. To start a terminal, or to attach a terminal that already runs, click the **+** tab. When more than one project is open, McFly asks for the project first.

**Follow.** A terminal that runs an agent can tie to the session of that agent. When McFly starts the agent, it makes the tie on its own. When you start the agent yourself, click **follow** on the terminal. McFly ties the terminal to the session, and opens that session as a root. A tied terminal shows a green dot and the name of the agent.

**Sync.** The link button in the title bar syncs the terminals with the agents. When sync is on, McFly shows the terminal of the agent that you select. It also changes the workbench when you select a tied terminal. The terminals keep their order at all times.

## Keyboard

Every pane accepts keyboard commands. The arrow keys move along the rows of a pane, and Enter opens a row. `Ctrl` with an arrow key moves to the adjacent panel. `Ctrl+H` and `Ctrl+J` do the same from a terminal.

Each tab has a chord, for example `Alt+Shift+E` for the explorer. The transport keys change with the pane. In a pane with a history bar, they move along that pane. In all other panes, they move the session playhead.

**Vim mode.** Vim mode adds a leader key to the workbench. The default leader is the space bar. Vim mode also adds a block caret, visual mode, word motions, counts, `Ctrl+F` search, and a `:N` command bar.

| Keys | Action |
|---|---|
| `<leader>e` `<leader>g` `<leader>t` | Explorer, git, tool calls |
| `<leader>a` `<leader>z` | Agents list, agent terminal |
| `<leader>c` `` <leader>` `` | Chat, live terminal |
| `<leader>d` `<leader>w` `<leader>r` | Data, wayfinder, human review |
| `<leader>1`…`<leader>9` | Editor tabs by position |
| `<leader>/` `<leader>ff` | Grep the project, find a file |
| `<leader><leader>` `<leader>h` `<leader>l` | Play or pause, step back, step forward |
| `<leader>gg` `<leader>G` | First step, last step |
| `<leader>q` `<leader>?` | Close the tab, show all bindings |

**tmux style terminals.** This mode adds a prefix chord for the terminals. The default prefix is `Ctrl+B`. After the prefix, `c` starts a terminal. `n` and `p` change to the next or the previous terminal. `x` kills a terminal after a confirmation.

## Settings

To open the settings, click the gear icon. The SETTINGS page holds the modes and the start behavior. The KEYBINDINGS page lists each action with its keys. To change the keys of an action, write the new chord in vim notation.

| Setting | Function |
|---|---|
| vim mode | Adds the leader bindings, the caret, and the command bar. |
| tmux style terminal | Adds the prefix chord for the terminals. |
| auto-live | Opens a session at its end, and follows new activity. |
| auto tour guide | Opens a session with the tour guide on. |
| auto-sync terminals | Starts with the terminals and the agents synced. |
| default terminal | Sets what a new terminal starts as. A blank shell is the default. |
| claude flags, codex flags, cursor-agent flags | Adds flags to the command when McFly starts that agent. |

## Agent tools (MCP)

The agent routing and live peer relay are inspired by Kerry Ritter's MIT-licensed
[Parley](https://github.com/KerryRitter/parley).

The McFly MCP gives your agent tools that write to the workbench. To configure it for local agents:

```bash
mcfly mcp config
```

This command writes `~/.mcfly/mcp.json`. When Codex or Claude Code is installed, the command adds the MCP to it. For Cursor Agent, the command merges the entry into `~/.cursor/mcp.json`.

The command also merges McFly's `SessionStart` and `SessionEnd` entries into `~/.codex/hooks.json`. Codex does not run a new or changed user hook until you open `/hooks` and trust its exact definition. Until then, or when hooks are disabled, McFly uses heuristic matching where it is safe; use **Follow** when it cannot safely associate a session. McFly never bypasses Codex hook trust.

| Tool | Function |
|---|---|
| `run_table` | Runs a Bash script and shows its strict TSV output as a table in the DATA tab. |
| `highlight` | Opens a file in the workbench with the given lines highlighted. |
| `waypoint` | Marks a line with a note. |
| `waypoint_remove` | Removes waypoints from a file. |
| `workspace_state` | Gives the agent the open files, the visible lines, and the selections of the user. |
| `review_state` | Reads the open human reviews and their comment threads. |
| `review_reply` | Answers a review comment, and can mark it addressed. |
| `list_agent_providers` | Lists the Codex, Claude, and Cursor launch harnesses and whether each executable is available. |
| `spawn_agent` | Starts a headless child agent, or a visible relay-enabled peer with `kind: "peer"`, using the provider's normal approval and sandbox settings, and returns its stable session metadata. |
| `list_peers` | Lists live terminals, relay state, and whether McFly has linked their agent session. |
| `send_message` | Types one complete prompt into a relay peer, or explicitly queues it with `inbox: true`. |
| `pull_inbox` | Returns and clears messages explicitly queued for a peer. |

![A table from run_table in the DATA tab](docs/data.png)

**Waypoints.** A waypoint is a note on a line of code. The agent makes a waypoint with the `waypoint` tool. The WAYFINDER tab lists each waypoint of the session. A waypoint stays on its line after the file changes. If the line is deleted, the waypoint shows the line and its old context.

![The wayfinder with a waypoint note under its line](docs/waypoints.png)

**Human review.** A human review is a set of comment threads on lines of code, as in a pull-request review. To make a comment, click a line number. To comment on more than one line, drag along the line numbers. A thread has one of three states: open, addressed, or resolved. Agents read the threads with `review_state`, and answer with `review_reply`. A review belongs to one session. McFly keeps each review on disk as a JSON file.

![A review thread and a diff from the review checklist](docs/review.png)

**Review checklist.** A review can also hold a list of the files to read. To make the list from the working tree, click **review uncommitted**. To make it from a commit, click the checklist icon on that commit in the git pane. The list shows the changed files as a tree, and the editor shows each file as a diff. Click the box of a file when you finish that file. If the file changes after that, McFly clears the box and loads the diff again. The comments and the list are independent, thus the comments stay when you close the list. Agents see the list and its progress in `review_state`.

## Run from source

```bash
npm ci
npm ci --prefix ui
npm run build
npm start
```

## Release

Add an `NPM_TOKEN` secret to the GitHub repository. Then create and push a semantic-version tag:

```bash
git tag v0.0.1
git push origin v0.0.1
```

GitHub Actions runs the checks. Then it updates the package version and publishes the package.

## License

MIT
