#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const [, , group, command] = process.argv;

if (group === 'mcp' && command === 'start') {
  const { startMcp } = await import('./mcp.js');
  await startMcp();
} else if (group === 'mcp' && command === 'config') {
  const { configureMcp } = await import('./mcp.js');
  const result = configureMcp();
  console.log(`wrote ${result.file}`);
  console.log(JSON.stringify(result.manifest, null, 2));
  for (const status of result.adapters) console.log(status);
} else if (group === 'mcp') {
  console.error('usage: mcfly mcp <start|config>');
  process.exitCode = 1;
} else {
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        version: { type: 'boolean', short: 'v' },
        port: { type: 'string', short: 'p' },
        'no-open': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    console.error(error.message);
    console.error('usage: mcfly [-p|--port <port>] [--no-open] [-v|--version] | mcfly mcp <start|config>');
    process.exit(1);
  }
  if (args.version) {
    console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
    process.exit(0);
  }
  if (args.help) {
    console.log('usage: mcfly [-p|--port <port>] [--no-open] [-v|--version] | mcfly mcp <start|config>');
    process.exit(0);
  }
  if (args.port) {
    if (!/^\d+$/.test(args.port)) {
      console.error(`port must be a number, got: ${args.port}`);
      process.exit(1);
    }
    process.env.PORT = args.port;
  }
  // auto-open is a CLI nicety only: `node server/server.js` (dev, restart
  // scripts) stays silent
  if (!args['no-open']) process.env.MCFLY_OPEN = '1';
  await import('./server.js');
}
