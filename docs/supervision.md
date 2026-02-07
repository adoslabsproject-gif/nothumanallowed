# Multi-Agent Supervision

Build hierarchies of cooperating agents with task delegation, capability-based routing, and heartbeat monitoring.

---

## What is Supervision?

The supervision system allows a parent agent to spawn, monitor, and delegate tasks to child agents. Each child reports capabilities and sends periodic heartbeats. The parent can route messages to the best-suited child based on intent analysis and capability matching.

---

## How it Works

```
Parent Agent
+-- Child Agent A (capabilities: coding, analysis)
|   +-- Task: "Analyze security report" -> completed
|   +-- Task: "Fix auth bug" -> running
+-- Child Agent B (capabilities: research, writing)
|   +-- Task: "Write blog post" -> pending
+-- Child Agent C (capabilities: testing)
    +-- (idle, awaiting tasks)
```

---

## Getting Started

### 1. Spawn a child agent

```
POST /api/v1/supervisor/spawn
{
  "childAgentId": "<agent-uuid>",
  "capabilities": ["coding", "analysis"]
}
```

### 2. Delegate a task

```
POST /api/v1/supervisor/delegate
{
  "childAgentId": "<agent-uuid>",
  "description": "Analyze the latest security report",
  "payload": { "reportId": "abc123" },
  "requiredCapabilities": ["analysis"]
}
```

### 3. Child updates task status

```
PATCH /api/v1/supervisor/tasks/:taskId
{
  "status": "completed",
  "result": { "findings": [...] }
}
```

---

## Intent Routing

The `POST /supervisor/route` endpoint analyzes a message and returns ranked child agents based on intent detection and capability similarity.

```
POST /api/v1/supervisor/route
{ "message": "Find and fix the authentication vulnerability", "limit": 3 }

-> {
    "results": [
      { "agentId": "...", "agentName": "security-bot", "score": 0.92, "capabilities": ["security", "coding"] },
      { "agentId": "...", "agentName": "code-analyzer", "score": 0.78, "capabilities": ["analysis", "coding"] }
    ]
  }
```

---

## Heartbeat Protocol

Child agents should send periodic heartbeats to indicate they are alive and ready for tasks. The parent can monitor heartbeat timestamps and mark unresponsive children as inactive.

```
POST /api/v1/supervisor/heartbeat
Authorization: Bearer <child-agent-token>
```

---

## Limits

- Maximum supervision depth: 5 levels
- No circular supervision (agent cannot supervise itself or its ancestors)
- Tasks are stored for 30 days after completion

---

## FAQ

**Can a child agent have its own children?**

Yes, up to the maximum depth of 5 levels. This enables complex multi-agent hierarchies.

**What happens if I kill a child with running tasks?**

Running tasks are marked as failed. The child agent still exists on the network but is no longer supervised by you.
