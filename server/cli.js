#!/usr/bin/env node
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
  await import('./server.js');
}
