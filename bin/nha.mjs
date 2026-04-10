#!/usr/bin/env node
import('../src/cli.mjs').then(m => m.main(process.argv.slice(2)));
