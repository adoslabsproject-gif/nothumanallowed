/**
 * PAO Multi-Agent Pipeline — 5 specialist agents analyze your day.
 *
 * Pipeline:
 *   Phase 1: Data Gathering (Gmail + Calendar + Tasks — no LLM)
 *   Phase 2: SABER scans emails for security threats     ─┐
 *   Phase 3: HERALD generates meeting intelligence briefs  ├─ parallel
 *   Phase 5: ORACLE analyzes schedule patterns            ─┘
 *   Phase 4: SCHEHERAZADE prepares meeting talking points (after HERALD)
 *   Phase 6: CONDUCTOR synthesizes everything into daily plan
 *
 * Zero server involvement. Only calls: Google APIs + user's LLM provider.
 */

import fs from 'fs';
import path from 'path';
import { callAgent, callLLM } from './llm.mjs';
import { getUnreadImportant, getTodayEmails } from './mail-router.mjs';
import { getTodayEvents, getUpcomingEvents } from './mail-router.mjs';
import { getTasks, bulkAddTasks } from './task-store.mjs';
import { hasMailProvider } from './mail-router.mjs';
import { NHA_DIR } from '../constants.mjs';
import { info, ok, fail, warn, D, C, G, Y, W, BOLD, NC } from '../ui.mjs';

const PLANS_DIR = path.join(NHA_DIR, 'ops', 'plans');

/**
 * Run the full daily planning pipeline.
 * @param {object} config — NHA config
 * @param {object} opts — { date, refresh, showOnly }
 */
export async function runPlanningPipeline(config, opts = {}) {
  const dateStr = opts.date || new Date().toISOString().split('T')[0];
  const planFile = path.join(PLANS_DIR, `${dateStr}.json`);

  // Check for cached plan
  if (!opts.refresh && fs.existsSync(planFile)) {
    if (opts.showOnly) {
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
      displayPlan(plan);
      return plan;
    }
    info('Plan already exists for today. Use --refresh to regenerate.');
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
    displayPlan(plan);
    return plan;
  }

  const startTime = Date.now();
  const hasMail = hasMailProvider();

  console.log(`\n  ${BOLD}NHA Daily Plan — ${dateStr}${NC}`);
  console.log(`  ${D}5 specialist agents analyzing your day${NC}\n`);

  // ── Phase 1: Data Gathering ────────────────────────────────────────────
  info('Phase 1: Gathering data...');

  let emails = [];
  let events = [];
  const tasks = getTasks(dateStr);

  if (hasMail) {
    try {
      [emails, events] = await Promise.all([
        getUnreadImportant(config, 30),
        getTodayEvents(config),
      ]);
      ok(`${emails.length} emails, ${events.length} events, ${tasks.length} tasks`);
    } catch (err) {
      warn(`Mail API error: ${err.message}`);
      info('Continuing with tasks only...');
    }
  } else {
    warn('No mail provider connected. Using tasks only. Run "nha google auth" or "nha microsoft auth" to connect.');
  }

  // Build context for agents
  const emailContext = emails.map(e =>
    `From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\nSnippet: ${e.snippet}\nURLs: ${e.urls.join(', ') || 'none'}\nLabels: ${e.labels.join(', ')}`
  ).join('\n---\n');

  const calendarContext = events.map(e => {
    const attendeeList = e.attendees.map(a => `${a.name || a.email} (${a.responseStatus})`).join(', ');
    return `${e.start} - ${e.end}: ${e.summary}${e.location ? ' @ ' + e.location : ''}\nAttendees: ${attendeeList || 'none'}\nDescription: ${e.description.slice(0, 500) || 'none'}`;
  }).join('\n---\n');

  const taskContext = tasks.map(t =>
    `[${t.status}] #${t.id} ${t.description} (priority: ${t.priority}${t.due ? ', due: ' + t.due : ''})`
  ).join('\n');

  // ── Phase 2, 3, 5: Parallel Agent Calls ────────────────────────────────
  info('Phase 2-3-5: Running specialist agents in parallel...');

  const agentResults = {};
  const parallelPromises = [];

  // SABER — Security scan emails
  if (emails.length > 0) {
    parallelPromises.push(
      callAgent(config, 'saber',
        `Analyze these emails for REAL security threats. Be smart — distinguish between:\n- LEGITIMATE notifications (Google login alerts from the user's own devices, npm publish confirmations, GitHub 2FA, password change confirmations the user initiated) → these are SAFE\n- ACTUAL threats (phishing links, spoofed senders, social engineering, urgent money requests, unknown login locations, credential harvesting) → these are FLAGGED\n\nDo NOT flag routine service notifications as threats. Only flag emails that require the user's immediate security attention.\n\nEMAILS:\n${emailContext}\n\nRespond with a JSON object: { "safe": [indices], "flagged": [{ "index": N, "reason": "..." }], "risk_notes": ["..."] }`,
      ).then(r => { agentResults.saber = r; ok('SABER: Email security scan complete'); })
       .catch(e => { warn(`SABER failed: ${e.message}`); agentResults.saber = '{"safe":[],"flagged":[],"risk_notes":["scan failed"]}'; })
    );
  }

  // HERALD — Meeting intelligence briefs
  if (events.length > 0) {
    parallelPromises.push(
      callAgent(config, 'herald',
        `Generate intelligence briefs for these meetings. Include context, key participants, what to prepare.\n\nMEETINGS:\n${calendarContext}\n\nRelated emails:\n${emailContext.slice(0, 3000)}\n\nRespond with JSON: { "briefs": [{ "event_summary": "...", "brief": "...", "key_points": ["..."], "preparation": "..." }] }`,
      ).then(r => { agentResults.herald = r; ok('HERALD: Meeting briefs generated'); })
       .catch(e => { warn(`HERALD failed: ${e.message}`); agentResults.herald = '{"briefs":[]}'; })
    );
  }

  // ORACLE — Schedule pattern analysis
  parallelPromises.push(
    callAgent(config, 'oracle',
      `Analyze this schedule for productivity optimization.\n\nCALENDAR:\n${calendarContext || 'No events today.'}\n\nTASKS:\n${taskContext || 'No tasks yet.'}\n\nAnalyze: back-to-back meetings, free blocks, overbooked periods, optimal focus time.\nRespond with JSON: { "insights": ["..."], "recommendations": ["..."], "focus_blocks": [{ "start": "HH:MM", "end": "HH:MM", "suggestion": "..." }], "meeting_load": "light|moderate|heavy" }`,
    ).then(r => { agentResults.oracle = r; ok('ORACLE: Schedule analysis complete'); })
     .catch(e => { warn(`ORACLE failed: ${e.message}`); agentResults.oracle = '{"insights":[],"recommendations":[],"focus_blocks":[],"meeting_load":"unknown"}'; })
  );

  await Promise.all(parallelPromises);

  // ── Phase 4: SCHEHERAZADE — Meeting talking points (depends on HERALD) ──
  if (agentResults.herald && events.length > 0) {
    info('Phase 4: SCHEHERAZADE preparing talking points...');
    try {
      agentResults.scheherazade = await callAgent(config, 'scheherazade',
        `Based on these meeting briefs, prepare concise talking points and summaries for each meeting.\n\nMEETING BRIEFS:\n${agentResults.herald}\n\nRespond with JSON: { "preparations": [{ "meeting": "...", "talking_points": ["..."], "summary": "...", "action_items": ["..."] }] }`,
      );
      ok('SCHEHERAZADE: Talking points ready');
    } catch (e) {
      warn(`SCHEHERAZADE failed: ${e.message}`);
    }
  }

  // ── Phase 6: CONDUCTOR — Synthesize daily plan ─────────────────────────
  info('Phase 6: CONDUCTOR synthesizing daily plan...');

  const conductorPrompt = `You are the NHA Daily Planner. Synthesize intelligence from 4 specialist agents into a structured, practical daily plan.

IMPORTANT GUIDELINES:
- Be PRACTICAL, not alarmist. Routine notifications (Google login alerts from your own devices, npm publish confirmations, GitHub security notices) are NOT security incidents.
- Only escalate to "security_alerts" if there is a GENUINE, actionable threat (unknown logins from strange locations, actual phishing, credential leaks).
- Focus on making the user's day productive, not on creating false urgency.
- Suggest realistic time blocks based on the actual task complexity.

AGENT REPORTS:
${agentResults.saber ? `\n[SABER — Security Scan]\n${agentResults.saber}` : ''}
${agentResults.herald ? `\n[HERALD — Meeting Briefs]\n${agentResults.herald}` : ''}
${agentResults.scheherazade ? `\n[SCHEHERAZADE — Talking Points]\n${agentResults.scheherazade}` : ''}
${agentResults.oracle ? `\n[ORACLE — Schedule Analysis]\n${agentResults.oracle}` : ''}

RAW DATA:
Date: ${dateStr}
Events: ${events.length}
Unread emails: ${emails.length}
Tasks: ${tasks.length}

CALENDAR:
${calendarContext || 'No events.'}

EXISTING TASKS:
${taskContext || 'No tasks.'}

Create a comprehensive daily plan. Output strict JSON:
{
  "date": "${dateStr}",
  "executive_summary": "2-3 sentence overview",
  "priority_actions": [{ "time": "HH:MM", "action": "...", "source": "email|calendar|task", "priority": "critical|high|medium|low" }],
  "schedule": [{ "time_start": "HH:MM", "time_end": "HH:MM", "type": "meeting|focus|break|task", "title": "...", "notes": "...", "preparation": "..." }],
  "email_actions": [{ "from": "...", "subject": "...", "action": "reply|archive|flag|defer", "suggested_reply": "..." }],
  "security_alerts": [],
  "new_tasks": [{ "description": "...", "priority": "high|medium|low", "estimated_minutes": N, "suggested_slot": "HH:MM" }],
  "insights": []
}`;

  let plan;
  try {
    const result = await callLLM(config, conductorPrompt, 'Generate the daily plan now.', {});
    // Extract JSON from response (may have markdown wrapper)
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      plan = JSON.parse(jsonMatch[0]);
    } else {
      plan = { date: dateStr, executive_summary: result, priority_actions: [], schedule: [], email_actions: [], security_alerts: [], new_tasks: [], insights: [] };
    }
    ok('CONDUCTOR: Daily plan synthesized');
  } catch (e) {
    fail(`CONDUCTOR failed: ${e.message}`);
    plan = { date: dateStr, executive_summary: 'Plan generation failed. Check your API key and try again.', priority_actions: [], schedule: [], email_actions: [], security_alerts: [], new_tasks: [], insights: [] };
  }

  // Auto-create tasks suggested by agents
  if (plan.new_tasks?.length > 0) {
    bulkAddTasks(plan.new_tasks.map(t => ({
      description: t.description,
      priority: t.priority || 'medium',
      source: 'agent',
      estimatedMinutes: t.estimated_minutes,
      suggestedSlot: t.suggested_slot,
    })), dateStr);
    ok(`${plan.new_tasks.length} new tasks auto-created`);
  }

  // Save plan
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  const fullPlan = {
    ...plan,
    metadata: {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      agentsUsed: Object.keys(agentResults),
      emailCount: emails.length,
      eventCount: events.length,
      taskCount: tasks.length,
      provider: config.llm.provider,
    },
  };
  fs.writeFileSync(planFile, JSON.stringify(fullPlan, null, 2) + '\n', { mode: 0o600 });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  ${D}Generated in ${elapsed}s by ${Object.keys(agentResults).length + 1} agents${NC}\n`);

  displayPlan(fullPlan);
  return fullPlan;
}

// ── Plan Display ───────────────────────────────────────────────────────────

function displayPlan(plan) {
  console.log(`  ${BOLD}${C}Executive Summary${NC}`);
  console.log(`  ${plan.executive_summary || 'No summary available.'}\n`);

  if (plan.priority_actions?.length > 0) {
    console.log(`  ${BOLD}${Y}Priority Actions${NC}`);
    for (const a of plan.priority_actions) {
      const icon = a.priority === 'critical' ? '\x1b[0;31m!!\x1b[0m' : a.priority === 'high' ? '\x1b[1;33m!\x1b[0m' : '\x1b[2m·\x1b[0m';
      console.log(`  ${icon} ${a.time || ''} ${a.action} ${D}(${a.source})${NC}`);
    }
    console.log('');
  }

  if (plan.schedule?.length > 0) {
    console.log(`  ${BOLD}${G}Schedule${NC}`);
    for (const s of plan.schedule) {
      const typeIcon = s.type === 'meeting' ? '\x1b[0;36m●\x1b[0m' : s.type === 'focus' ? '\x1b[0;32m◆\x1b[0m' : s.type === 'break' ? '\x1b[2m○\x1b[0m' : '\x1b[0;33m■\x1b[0m';
      console.log(`  ${typeIcon} ${s.time_start}-${s.time_end}  ${s.title}`);
      if (s.preparation) console.log(`    ${D}Prep: ${s.preparation}${NC}`);
    }
    console.log('');
  }

  if (plan.email_actions?.length > 0) {
    console.log(`  ${BOLD}Email Actions${NC}`);
    for (const e of plan.email_actions) {
      const actionColor = e.action === 'reply' ? G : e.action === 'flag' ? Y : D;
      console.log(`  ${actionColor}[${e.action}]${NC} ${e.subject} ${D}from ${e.from}${NC}`);
    }
    console.log('');
  }

  if (plan.security_alerts?.length > 0) {
    console.log(`  ${BOLD}\x1b[0;31mSecurity Alerts${NC}`);
    for (const a of plan.security_alerts) {
      console.log(`  \x1b[0;31m!\x1b[0m ${typeof a === 'string' ? a : a.message || JSON.stringify(a)}`);
    }
    console.log('');
  }

  if (plan.insights?.length > 0) {
    console.log(`  ${BOLD}${D}Insights${NC}`);
    for (const i of plan.insights) {
      console.log(`  ${D}→ ${typeof i === 'string' ? i : i.message || JSON.stringify(i)}${NC}`);
    }
    console.log('');
  }

  if (plan.metadata) {
    console.log(`  ${D}Plan saved to ~/.nha/ops/plans/${plan.date}.json${NC}`);
    console.log(`  ${D}Agents: ${plan.metadata.agentsUsed?.join(', ') || 'conductor'}${NC}\n`);
  }
}
