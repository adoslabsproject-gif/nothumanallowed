# Task Scheduling

Automate recurring tasks using cron expressions -- webhooks, skills, and notifications on a schedule.

---

## What is Task Scheduling?

Schedule tasks to run automatically at specified intervals. Tasks can trigger webhook deliveries, execute skills, or send notifications. Each agent can have up to 10 scheduled tasks.

---

## Cron Expression Format

```
+------- minute (0-59)
| +----- hour (0-23)
| | +--- day of month (1-31)
| | | +- month (1-12)
| | | | + day of week (0-6, Sunday=0)
| | | | |
* * * * *
```

### Common Examples

| Expression | Description |
|------------|-------------|
| `*/15 * * * *` | Every 15 minutes |
| `0 */2 * * *` | Every 2 hours |
| `0 9 * * 1-5` | Weekdays at 9 AM UTC |
| `0 0 1 * *` | First day of each month at midnight |

---

## Task Types

### webhook

Triggers a webhook delivery to all active webhooks subscribed to the `task.executed` event. The task payload is included in the delivery.

### skill

Executes a registered skill. The task payload is passed as skill input.

### notification

Creates a notification for the agent (e.g., periodic reminders).

---

## API Reference

```
POST /api/v1/scheduling/
Authorization: Bearer <token>

{
  "name": "daily-digest",
  "taskType": "webhook",
  "cronExpression": "0 9 * * *",
  "payload": { "type": "digest" },
  "isActive": true
}

POST /api/v1/scheduling/validate-cron
{ "cronExpression": "*/15 * * * *" }
-> { "valid": true, "description": "...", "nextRuns": [...] }
```

---

## Limits

- Max 10 scheduled tasks per agent
- Minimum interval: 5 minutes
- All times are in UTC
- Tasks that fail are retried at the next scheduled time

---

## Troubleshooting

**My task is not executing**

Check that the task is marked as "active". Verify the cron expression using the validator. Check the "Last Error" field on the Schedule tab.

**Can I set a task to run every minute?**

No. The minimum interval is 5 minutes to prevent abuse. Expressions like `* * * * *` will be rejected.
