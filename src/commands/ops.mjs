/** nha ops — Daemon control for Personal Agent Operations */

import fs from 'fs';
import path from 'path';
import { startDaemon, stopDaemon, getDaemonStatus, isRunning } from '../services/ops-daemon.mjs';
import { runPlanningPipeline } from '../services/ops-pipeline.mjs';
import { loadConfig } from '../config.mjs';
import { NHA_DIR } from '../constants.mjs';
import { info, ok, fail, warn, C, G, Y, D, W, BOLD, NC, R } from '../ui.mjs';

export async function cmdOps(args) {
  const sub = args[0] || 'status';

  switch (sub) {
    case 'start': {
      const result = startDaemon();
      if (result.ok) {
        ok(`PAO daemon started (PID ${result.pid})`);
        info('Monitoring Gmail + Calendar. Notifications enabled.');

        const config = loadConfig();
        const hasTelegram = !!config.responder?.telegram?.token;
        const hasDiscord = !!config.responder?.discord?.token;
        if (hasTelegram || hasDiscord) {
          const platforms = [hasTelegram && 'Telegram', hasDiscord && 'Discord'].filter(Boolean).join(' + ');
          info(`Message responder active: ${platforms}`);
        }

        const proactive = config.ops?.proactive?.enabled !== false;
        if (proactive) {
          info('Proactive intelligence enabled (follow-ups, meeting prep, deadlines).');
        }

        info('Run "nha ops status" to check. "nha ops stop" to halt.');
      } else {
        warn(result.message);
      }
      return;
    }

    case 'stop': {
      const result = stopDaemon();
      if (result.ok) {
        ok(`Daemon stopped (PID ${result.pid})`);
      } else {
        warn(result.message);
      }
      return;
    }

    case 'restart': {
      const stopResult = stopDaemon();
      if (stopResult.ok) ok(`Daemon stopped (PID ${stopResult.pid})`);
      // Brief pause to let the process fully exit
      await new Promise(r => setTimeout(r, 1200));
      const startResult = startDaemon();
      if (startResult.ok) {
        ok(`Daemon restarted (PID ${startResult.pid})`);
        const config = loadConfig();
        const hasTelegram = !!config.responder?.telegram?.token;
        const hasDiscord = !!config.responder?.discord?.token;
        if (hasTelegram || hasDiscord) {
          const platforms = [hasTelegram && 'Telegram', hasDiscord && 'Discord'].filter(Boolean).join(' + ');
          info(`Message responder active: ${platforms}`);
        }
      } else {
        warn(startResult.message);
      }
      return;
    }

    case 'status': {
      const status = getDaemonStatus();
      const config = loadConfig();

      console.log(`\n  ${BOLD}PAO Daemon Status${NC}\n`);
      console.log(`  Running:          ${status.running ? G + 'yes' + NC + ` (PID ${status.pid})` : R + 'no' + NC}`);
      if (status.startedAt) console.log(`  Started:          ${D}${status.startedAt}${NC}`);
      if (status.lastMailCheck) console.log(`  Last mail check:  ${D}${status.lastMailCheck}${NC}`);
      if (status.lastCalendarCheck) console.log(`  Last cal check:   ${D}${status.lastCalendarCheck}${NC}`);
      if (status.lastPlanGenerated) console.log(`  Last plan:        ${D}${status.lastPlanGenerated}${NC}`);
      if (status.errors > 0) console.log(`  Errors:           ${Y}${status.errors}${NC}`);

      // Proactive Intelligence Engine status
      const proactive = status.proactive || {};
      console.log(`\n  ${BOLD}Proactive Intelligence${NC}\n`);
      console.log(`  Enabled:          ${proactive.enabled !== false ? G + 'yes' + NC : D + 'no' + NC}`);
      console.log(`  Email follow-up:  ${proactive.emailFollowUp !== false ? G + 'on' + NC : D + 'off' + NC}`);
      console.log(`  Meeting prep:     ${proactive.meetingPrep !== false ? G + 'on' + NC : D + 'off' + NC}`);
      console.log(`  Pattern detect:   ${proactive.patterns !== false ? G + 'on' + NC : D + 'off' + NC}`);
      console.log(`  Deadline alerts:  ${proactive.deadlines !== false ? G + 'on' + NC : D + 'off' + NC}`);
      if (status.lastProactiveCheck) console.log(`  Last check:       ${D}${status.lastProactiveCheck}${NC}`);
      if (status.lastPatternDetection) console.log(`  Last patterns:    ${D}${status.lastPatternDetection}${NC}`);

      // Message Responder status
      const responder = status.responder || {};
      const telegramConfigured = !!config.responder?.telegram?.token;
      const discordConfigured = !!config.responder?.discord?.token;
      console.log(`\n  ${BOLD}Message Responder${NC}\n`);
      // Surface the exact reason the responder didn't activate (missing
      // LLM key on a paid provider, missing token, etc.) instead of the
      // generic "daemon restart needed" — which is misleading because the
      // daemon IS running, the responder just refused to spin up.
      const reason = responder.reason || '';
      let inactiveHintTel = 'configured but inactive (try: nha ops stop && nha ops start)';
      if (reason.startsWith('missing_key:')) {
        const p = reason.slice('missing_key:'.length);
        inactiveHintTel = `configured but LLM key missing for provider "${p}" — fix with:  nha config set provider nha  (free Liara)  OR  nha config set ${p}-key YOUR_KEY`;
      }
      console.log(`  Telegram:         ${responder.telegram ? G + 'active' + NC : telegramConfigured ? Y + inactiveHintTel + NC : D + 'not configured' + NC}`);
      console.log(`  Discord:          ${responder.discord ? G + 'active' + NC : discordConfigured ? Y + inactiveHintTel + NC : D + 'not configured' + NC}`);
      console.log(`  Auto-route:       ${config.responder?.autoRoute !== false ? G + 'keyword routing' + NC : D + 'CONDUCTOR only' + NC}`);

      console.log('');
      return;
    }

    case 'logs': {
      const logFile = path.join(NHA_DIR, 'ops', 'daemon', 'daemon.log');
      if (!fs.existsSync(logFile)) {
        info('No daemon logs. Start with: nha ops start');
        return;
      }
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const last50 = lines.slice(-50);
      for (const line of last50) {
        console.log(`  ${D}${line}${NC}`);
      }
      return;
    }

    case 'run': {
      // One-shot: sync + plan + exit
      const config = loadConfig();
      info('Running one-shot PAO pipeline...');
      await runPlanningPipeline(config, { refresh: true });
      return;
    }

    default:
      fail(`Unknown: nha ops ${sub}`);
      info('Commands: start, stop, restart, status, logs, run');
  }
}
