/**
 * `nha memory` — manage persistent user memory.
 *
 * Subcommands:
 *   nha memory add "..."      append a fact
 *   nha memory list           print current memory
 *   nha memory edit           open the memory file in $EDITOR
 *   nha memory clear          wipe everything (with confirmation)
 *   nha memory path           print the memory file path
 */

import {
  addUserMemory,
  loadUserMemory,
  clearUserMemory,
  getMemoryPath,
} from '../services/user-memory.mjs';
import { spawn } from 'child_process';

export async function runMemory(args) {
  const sub = args[0];

  if (!sub || sub === 'list' || sub === 'show') {
    const text = loadUserMemory();
    if (!text.trim()) {
      console.log('Memory empty. Add something with: nha memory add "..."');
    } else {
      console.log(text);
    }
    return;
  }

  if (sub === 'add') {
    const entry = args.slice(1).join(' ').trim();
    if (!entry) {
      console.error('Usage: nha memory add "Fact to remember"');
      process.exit(1);
    }
    addUserMemory(entry);
    console.log(`✓ Added to memory: ${entry}`);
    return;
  }

  if (sub === 'edit') {
    const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
    const proc = spawn(editor, [getMemoryPath()], { stdio: 'inherit' });
    proc.on('close', (code) => process.exit(code || 0));
    return;
  }

  if (sub === 'clear') {
    const confirm = args.includes('--yes') || args.includes('-y');
    if (!confirm) {
      console.error('This will wipe ALL stored memories. Re-run with --yes to confirm.');
      process.exit(1);
    }
    clearUserMemory();
    console.log('✓ Memory cleared.');
    return;
  }

  if (sub === 'path') {
    console.log(getMemoryPath());
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  console.error('Usage: nha memory <add|list|edit|clear|path>');
  process.exit(1);
}
