/** nha plan — Generate daily plan using 5 specialist agents */

import { runPlanningPipeline } from '../services/ops-pipeline.mjs';
import { loadConfig } from '../config.mjs';
import { fail } from '../ui.mjs';

export async function cmdPlan(args) {
  const config = loadConfig();

  if (!config.llm.apiKey) {
    fail('No API key configured. Run: nha config set key YOUR_KEY');
    process.exit(1);
  }

  let date = null;
  let refresh = false;
  let showOnly = false;

  for (const arg of args) {
    if (arg === '--refresh') { refresh = true; continue; }
    if (arg === '--show') { showOnly = true; continue; }
    if (arg === 'tomorrow') {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      date = d.toISOString().split('T')[0];
      continue;
    }
    if (arg === 'yesterday') {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      date = d.toISOString().split('T')[0];
      continue;
    }
    if (arg.startsWith('--date=')) {
      date = arg.split('=')[1];
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      date = arg;
      continue;
    }
  }

  await runPlanningPipeline(config, { date, refresh, showOnly });
}
