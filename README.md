# Agent McFly

Agent McFly replays Codex and Claude Code sessions in a browser workbench.

The workbench shows chat, tool calls, file changes, terminal output, subagents, and live sessions.

## Run with npx

```bash
npx agent-mcfly
```

Open `http://localhost:7777` after the server starts.

## Semantic data MCP

Configure the McFly MCP for supported local agents:

```bash
mcfly mcp config
```

This writes `~/.mcfly/mcp.json` and best-effort configures Codex and Claude Code. The MCP's `run_table` tool runs Bash and requires strict TSV on stdout; successful results appear in McFly's Data tab.

## Run from source

```bash
npm ci
npm ci --prefix ui
npm run build
npm start
```

## Release

Add an `NPM_TOKEN` secret to the GitHub repository.

Create and push a semantic-version tag:

```bash
git tag v0.0.1
git push origin v0.0.1
```

GitHub Actions will run the checks, update the package version, and publish the package.

## License

MIT
