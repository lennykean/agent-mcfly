# Agent McFly

Agent McFly is a browser workbench for Codex and Claude Code sessions. It replays completed sessions step by step, and it follows live sessions while they run. You can start an agent in a McFly terminal, see its session live, and talk to the agent in the same window. The workbench shows the chat, the tool calls, the file changes, and the terminal output. All panes show the same step.

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

## The workbench

**Replay.** The workbench plays a session step by step. The chat, the editor, and the terminal always show the same step. You can move the playhead to each step. You can click a message, a tool call, or a line of code to go to its step. The tour guide toggle controls the view. When the toggle is on, the view goes to each new item. When the toggle is off, the tab of the item flashes.

![A replay in motion, with the typing animation](docs/playback.gif)

**Live sessions.** McFly follows an agent while it works. You can also start the agent in a McFly terminal. Then one window shows the session and the terminal that controls it.

![A live claude terminal next to a replay](docs/terminal.png)

**File history.** The editor shows each file with the content that the agent read or wrote at the current step. You can also open a timeline view for a file. The timeline view opens as a separate tab. It shows each change to the file from the session, with the source step for each line.

![The file timeline with the blame gutter and the pager](docs/timeline.png)

**Sub-agents.** When an agent starts a sub-agent, the sub-agent appears under it in the AGENTS list. Click the sub-agent to watch its own session. A sub-agent leaves the list when the playhead moves past its last action. Move the playhead back into its life, and it returns. Codex teams and Claude Code sub-agents both work this way.

## Many agents at once

McFly holds several agents in one window. Each agent is a root workspace with its own playhead, tabs, and panes. The AGENTS list groups the roots by project folder.

Use the **+** button in the AGENTS header to attach another agent. Click a root to switch to it. The workspace you leave keeps its state. The URL carries every open root, so a bookmark restores the whole set.

With two or more roots, each root takes a color. The color marks its rows in the AGENTS list, its terminal tab, and the title bar of the workbench you are in. Click the color square next to the project name to choose another color.

Each project row also has two actions. The terminal icon starts a terminal in that folder. The VS Code icon opens that folder in VS Code. The VS Code icon needs the `code` command on your PATH, and it shows for local folders only.

**Remote agents.** The radio-tower button in the AGENTS header connects to a host over SSH. McFly then reads that host's sessions and runs terminals there. A remote root behaves like a local one, and its address stays in the URL.

## Terminals

The LIVE TERMINAL pane holds several terminals as tabs. The **+** tab starts a new one or attaches a terminal that already runs. When more than one project is open, the picker asks which project the terminal starts in.

**Follow.** A terminal that runs an agent can be tied to that agent's session. Click **follow** on the terminal. McFly ties the terminal to the session and opens the session as a root. A tied terminal shows a green dot and the agent's name.

**Sync.** The link button in the title bar syncs terminals and agents. When sync is on, picking an agent shows its terminal, and picking a tied terminal switches the workbench. Terminals never reorder, and switching agents never changes the terminal list.

## Keyboard

Every pane answers the keyboard. Arrow keys walk the rows of a pane. Enter opens the row. `Ctrl` with an arrow key moves between panels, and `Ctrl+H` or `Ctrl+J` do the same from inside a terminal.

Each tab has a direct chord, such as `Alt+Shift+E` for the explorer. The transport keys are contextual. In a pane with its own history bar, they walk that pane. Everywhere else they move the session playhead.

**Vim mode.** Turn on vim mode in the settings to add a leader key. Space is the default leader. Vim mode also adds a block caret, visual mode, word motions, counts, `Ctrl+F` search, and a `:N` command bar.

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

**tmux style terminals.** Turn on tmux style terminals for a prefix chord (`Ctrl+B` by default): `c` starts a terminal, `n` and `p` cycle them, and `x` kills one after a confirmation.

## Settings

The gear icon opens the settings. The SETTINGS page holds the modes and the start behavior. The KEYBINDINGS page lists every action with its keys, and you can rebind an action in vim notation.

| Setting | Function |
|---|---|
| vim mode | Adds the leader bindings, the caret, and the command bar. |
| tmux style terminal | Adds the prefix chord for terminals. |
| auto-live | Opens a session at its end, following new activity. |
| auto tour guide | Opens a session with the tour guide on. |
| auto-sync terminals | Starts with terminals and agents synced. |
| default terminal | Sets what a new terminal starts as. A blank shell is the default. |
| claude flags, codex flags | Adds flags to the command when McFly starts that agent. |

## Agent tools (MCP)

Configure the McFly MCP for local agents:

```bash
mcfly mcp config
```

This command writes `~/.mcfly/mcp.json`. When Codex and Claude Code are installed, the command also adds the MCP to them.

The MCP gives agents these tools:

| Tool | Function |
|---|---|
| `run_table` | Runs a Bash script and shows its strict TSV output as a table in the DATA tab. |
| `highlight` | Opens a file in the workbench with the given lines highlighted. |
| `waypoint` | Marks a line with a note. |
| `waypoint_remove` | Removes waypoints from a file. |
| `workspace_state` | Gives the agent the open files, the visible lines, and the selections of the user. |
| `review_state` | Reads the open human reviews and their comment threads. |
| `review_reply` | Replies to a review comment, and can mark it addressed. |

![A table from run_table in the DATA tab](docs/data.png)

**Waypoints.** An agent can attach a note to a line of code. The wayfinder lists the notes. A note stays on its line after the file changes. If the line is deleted, a snapshot shows the line and its old context.

![The wayfinder with a waypoint note under its line](docs/waypoints.png)

**Human review.** You can add a comment to a line, the same as in a pull-request review. Click a line number, or drag along the line numbers to select a range. Agents read the comment threads and reply through the MCP. Each thread has one of three states: open, addressed, or resolved. A review belongs to one session. The reviews stay on disk as JSON files.

![A review thread with an agent reply](docs/review.png)

**Review checklist.** A review can also carry a punch list of the files to read. Choose **review uncommitted** for the working tree, or click the checklist icon on a commit in the git graph to diff from that commit. The list shows the changed files as a tree, and you tick each file as you finish it. If a file changes after you tick it, McFly clears the tick and reloads its diff. Comments and the checklist are independent: closing the checklist keeps the comments. Agents see the checklist and its progress through `review_state`.

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
