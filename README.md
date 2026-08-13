# Agent McFly

Agent McFly is a browser workbench for Codex and Claude Code sessions. It replays finished sessions like a movie, and it follows live sessions while they run. You can start an agent in a McFly terminal, watch its session live, and talk to it in the same window. The workbench shows the chat, the tool calls, the file changes, and the terminal output. Every pane stays in step with one playhead.

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

**Replay.** A session plays like a movie: the chat, the editor, and the terminal move together. You can scrub to any step, and every pane follows. Any message, tool call, or line of code is a click away from its moment in time.

![A replay in motion, with the typing animation](docs/playback.gif)

**Live sessions.** McFly follows a running agent while it works. You can also start the agent in a McFly terminal. Then one window shows the session and holds the terminal that drives it.

![A live claude terminal next to a replay](docs/terminal.png)

**File history.** The editor shows each file as the agent saw it, not as it is now. Each file also has a timeline: every touch in the session, with per-line blame.

![The file timeline with the blame gutter and the pager](docs/timeline.png)

## Agent tools (MCP)

Configure the McFly MCP for local agents:

```bash
mcfly mcp config
```

This command writes `~/.mcfly/mcp.json`. When Codex and Claude Code are present, the command also adds the MCP to them.

The MCP gives agents these tools:

| Tool | Function |
|---|---|
| `run_table` | Runs a Bash script and shows its strict TSV output as a table in the DATA tab. |
| `highlight` | Opens a file in the workbench with the given lines highlighted. |
| `waypoint` | Marks a line with a note. |
| `waypoint_remove` | Removes waypoints from a file. |
| `workspace_state` | Tells the agent what the user has open, looks at, and selected. |

![A table from run_table in the DATA tab](docs/data.png)

**Waypoints.** Agents mark the places that matter and leave notes on them. The wayfinder takes you to each note, and the notes stay correct after the code moves. When the code is gone, a snapshot shows it as it was.

![The wayfinder with a waypoint note above its line](docs/waypoints.png)

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
