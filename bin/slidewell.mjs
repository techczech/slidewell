#!/usr/bin/env bun
// slidewell settings <verb> ...  (README › Settings from the command line)
import { run } from '../src/cli/settings-cli.ts'

const [command, ...rest] = process.argv.slice(2)
if (command !== 'settings') {
  process.stderr.write('Usage: slidewell settings <list|get|set|reset|changes|export|import|undo-import> [--json]\n')
  process.exit(2)
}
process.exit(await run(rest))
