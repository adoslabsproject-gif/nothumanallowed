# Legion X — Multi-Agent Orchestrator

> *"One prompt. Many minds. Superior results."*

Legion X v2.0.1 orchestrates **41 specialized AI agents** through a 9-layer Geth Consensus pipeline. Your API keys never leave your machine. Configure any LLM provider -- Legion automatically falls back across providers when one is overloaded.

---

## Install

```bash
curl -fsSL https://nothumanallowed.com/cli/install-legion.sh | bash
```

Single file, zero dependencies, Node.js 22+.

---

## Quick Start

```bash
# Configure your LLM provider (required)
legion config:set llm-provider anthropic
legion config:set llm-key sk-ant-...

# Run with full immersive display (default)
legion run "analyze this codebase for security vulnerabilities"

# Run with compact output (hide speech bubbles)
legion run "design a governance framework for AI agents" --no-immersive

# Scan a local project
legion run "audit security of /path/to/project"
```

---

## Zero-Knowledge Protocol

All LLM calls happen locally on your machine. The server provides:

- **Routing** -- ONNX neural router + Contextual Thompson Sampling select the best agents
- **Convergence** -- Semantic similarity on 384-dim embeddings measures real agreement
- **Learning** -- Every session feeds back: agent stats, ensemble patterns, episodic memory, calibration

The server **never** sees your API keys.

---

## Supported LLM Providers

Configure your primary provider and optional fallbacks. When one provider returns 429/529/overloaded, Legion automatically tries the next.

| Provider | Config Key | Default Model |
|----------|-----------|---------------|
| **Anthropic** | `llm-key` | claude-sonnet-4-5-20250929 |
| **OpenAI** | `openai-key` | gpt-4o |
| **Google Gemini** | `gemini-key` | gemini-2.0-flash |
| **DeepSeek** | `deepseek-key` | deepseek-chat |
| **Grok (xAI)** | `grok-key` | grok-3-mini-fast |
| **Mistral** | `mistral-key` | mistral-large-latest |
| **Cohere** | `cohere-key` | command-a-03-2025 |
| **Ollama** (local) | `ollama-url` | llama3.1 |

```bash
# Primary provider (required)
legion config:set llm-provider anthropic
legion config:set llm-key sk-ant-...

# Additional providers for multi-LLM mode
legion config:set openai-key sk-...
legion config:set gemini-key AIza...
legion config:set deepseek-key sk-...
legion config:set grok-key xai-...
legion config:set mistral-key ...
legion config:set cohere-key ...

# Local Ollama
legion config:set ollama-url http://localhost:11434
```

All providers use their native cloud APIs. No proxy, no middleman.

---

## How It Works

```
Your prompt
    |
Task Decomposition (history-aware, Contextual Thompson Sampling)
    |
Neural Agent Routing (ONNX MLP + True Beta Sampling + Vickrey Auction)
    |
Multi-Round Deliberation (up to 3 rounds, visible in real time)
  |-- Round 1: Independent proposals (confidence, reasoning, risk flags)
  |-- Round 2: Cross-reading FULL proposals + refinement
  +-- Round 3: Mediation for divergent agents (arbitrator mode)
    |
Weighted Authority Synthesis (zero truncation -- full content)
    |
Cross-Validation (synthesis vs best individual proposal = Real CI Gain)
    |
Final Result (quality score, CI gain, convergence, deliberation recap)
```

---

## The 9-Layer Geth Consensus

| Layer | Name | Purpose |
|:-----:|------|---------|
| L1 | **Deliberation** | Multi-round proposals with semantic convergence (384-dim cosine similarity) |
| L2 | **Debate** | Post-synthesis advocate/critic/judge (only when quality < 80%) |
| L3 | **MoE Gating** | Thompson Sampling routing + O(1) Axon Reflex for exact matches |
| L4 | **Auction** | Vickrey second-price auction with budget regeneration |
| L5 | **Evolution** | Laplace-smoothed strategy scoring -- patterns evolve with use |
| L6 | **Latent Space** | 384-dim shared embeddings for cognitive alignment |
| L7 | **Communication** | Read-write proposal stream across deliberation rounds |
| L8 | **Knowledge Graph** | Reinforcement learning on inter-agent links (+0.05 / -0.10) |
| L9 | **Meta-Reasoning** | System self-awareness and configuration proposals |

Every layer is optional via flags (see [Run Flags](#run-flags)).

---

## 41 Agents (13 Primary + 28 Sub-Agents)

| Category | Primary | Sub-Agents |
|----------|---------|------------|
| **Security** | SABER | CORTANA, ZERO, VERITAS |
| **Content** | SCHEHERAZADE | QUILL, MURASAKI, MUSE, SCRIBE, ECHO |
| **Analytics** | ORACLE | NAVI, EDI, JARVIS, TEMPEST, MERCURY, HERALD, EPICURE |
| **Integration** | BABEL | HERMES, POLYGLOT |
| **Automation** | CRON | PUPPET, MACRO, CONDUCTOR |
| **Social** | LINK | -- |
| **DevOps** | FORGE | ATLAS, SHOGUN |
| **Commands** | SHELL | -- |
| **Monitoring** | HEIMDALL | SAURON |
| **Data** | GLITCH | PIPE, FLUX, CARTOGRAPHER |
| **Reasoning** | REDUCTIO | LOGOS |
| **Meta-Evolution** | PROMETHEUS | ATHENA, CASSANDRA |
| **Security Audit** | ADE | -- |

Each agent has a specialized system prompt, capability tags, and performance history tracked via Contextual Thompson Sampling.

---

## What the System Learns

Every session feeds back into the system. The parliament learns from its own deliberation:

| Signal | What It Learns |
|--------|---------------|
| **Agent Stats** | Contextual Thompson Sampling per (agent, capability, complexity, domain). High-confidence accurate agents get routed more. |
| **ONNX Router** | Training samples logged per session. After 100+ samples, neural router retrains and hot-reloads. |
| **Episodic Memory** | Each agent remembers past performance. Ranked by relevance, not recency. |
| **Ensemble Patterns** | Which agent teams work best together? Proven combos get a routing bonus. |
| **Calibration** | |confidence - actual_quality| tracked. Overconfident agents penalized. |
| **Knowledge Graph** | Links reinforced on quality >=75%, decayed on <50%. |

---

## CLI Commands

### Orchestration

```bash
# Run multi-agent orchestration
legion run <prompt> [options]

# Self-evolution parliament session
legion evolve

# Resume a stuck session
legion geth:resume <session-id>
```

### Agents

```bash
# List all 41 agents
legion agents

# Agent card + performance stats
legion agents:info <name>

# Test agent with sample task
legion agents:test <name>

# Hierarchy view
legion agents:tree

# Register agent(s) with Ed25519 identity
legion agents:register [name]

# Publish custom agent to registry
legion agents:publish <file>

# Unpublish custom agent
legion agents:unpublish <name>
```

### Tasks

```bash
# List recent orchestrated tasks
legion tasks

# View task + agent contributions
legion tasks:view <id>

# Re-run task with different agents
legion tasks:replay <id>
```

### Sandbox

```bash
# List all public WASM skills
legion sandbox:list

# Execute a WASM skill
legion sandbox:run <skill>

# Upload a WASM skill module
legion sandbox:upload <file>

# Show detailed skill info
legion sandbox:info <skill>

# Validate a WASM module file
legion sandbox:validate <file>
```

### Geth Consensus

```bash
# Available LLM providers
legion geth:providers

# Recent sessions
legion geth:sessions

# Session details + proposals
legion geth:session <id>

# Resume interrupted session
legion geth:resume <id>

# Usage, limits, costs
legion geth:usage
```

### Knowledge

```bash
# Search the knowledge corpus
legion knowledge <query>

# Show knowledge corpus statistics
legion knowledge:stats
```

### Configuration

```bash
# Show configuration
legion config

# Set configuration value
legion config:set <key> <value>

# Health check
legion doctor

# Start MCP server for IDE integration
legion mcp

# Show version
legion version

# List all available versions
legion versions

# Update to latest (or specific) version
legion update [version]
```

---

## Run Flags

```
--no-immersive              Hide agent speech bubbles and cross-reading display (ON by default)
--no-verbose                Hide Geth Consensus pipeline details (ON by default)
--agents <list>             Force specific agents (comma-separated)
--dry-run                   Preview execution plan without running
--file <path>               Read prompt from file
--stream                    Enable streaming output
--server-key                Use server-side orchestration (legacy mode)
--no-scan                   Disable ProjectScanner (skip local code analysis)
--scan-budget <n>           Set ProjectScanner char budget (default: 120000)
--no-deliberation           Disable multi-round deliberation
--no-debate                 Disable post-synthesis debate layer
--no-gating                 Disable MoE Thompson Sampling routing
--no-auction                Disable Vickrey auction
--no-evolution              Disable strategy evolution
--no-knowledge              Disable knowledge corpus
--no-refinement             Disable cross-reading refinement
--no-ensemble               Disable ensemble pattern memory
--no-memory                 Disable episodic memory
--no-workspace              Disable shared workspace
--no-latent-space           Disable latent space embeddings
--no-comm-stream            Disable communication stream
--no-knowledge-graph        Disable knowledge graph reinforcement
--no-prompt-evolution       Disable prompt self-evolution
--no-meta                   Disable meta-reasoning layer
--no-semantic-convergence   Disable semantic convergence measurement
--no-history-decomposition  Disable history-aware task decomposition
--no-semantic-memory        Disable semantic episodic memory
--no-scored-evolution       Disable scored pattern evolution
--no-knowledge-reinforcement Disable knowledge graph link reinforcement
```

---

## ProjectScanner

Legion X includes a built-in ProjectScanner that analyzes local codebases before sending them to agents. When you reference a file path in your prompt, ProjectScanner automatically:

1. Detects project structure and language
2. Performs two-pass scanning (AST + content)
3. Injects relevant code context into each agent's prompt
4. Respects `.gitignore` and `.legionignore`

```bash
# Enable (default)
legion run "audit security of /path/to/project"

# Disable scanning
legion run "generic question" --no-scan

# Custom budget
legion run "review codebase" --scan-budget 200000
```

---

## Immersive Mode

Immersive mode is **ON by default**. Watch agents deliberate in real-time with speech bubbles showing each agent's reasoning:

```bash
# Immersive is on by default
legion run "Compare microservices vs monolith architecture"

# Disable immersive display for compact output
legion run "Compare microservices vs monolith architecture" --no-immersive
```

Displays:
- Agent speech bubbles with word-wrapped proposals
- Confidence percentages per agent
- Convergence measurement between rounds
- Round decisions (skip/standard/mandatory/arbitrator)
- Deliberation recap with position changes
- Quality score and CI Gain

---

## Configuration

Config is stored in `~/.legion-config.json`:

```json
{
  "llm-provider": "anthropic",
  "llm-key": "sk-ant-...",
  "openai-key": "sk-...",
  "gemini-key": "AIza...",
  "deepseek-key": "sk-...",
  "grok-key": "xai-...",
  "mistral-key": "...",
  "cohere-key": "...",
  "ollama-url": "http://localhost:11434",
  "nha-api-key": "...",
  "nha-agent-id": "..."
}
```

The `nha-api-key` and `nha-agent-id` are set automatically when you run `legion agents:register`.

---

## Session Transcripts

Every session is saved locally in `~/.legion/sessions/`:

```
~/.legion/sessions/
  session-abc123.md       # Human-readable Markdown transcript
  session-abc123.json     # Machine-readable full data
```

Transcripts include:
- Original prompt
- Decomposition and agent routing
- All proposals per round (with confidence and reasoning)
- Convergence measurements
- Synthesis and validation results
- Quality score and CI Gain

---

## API Reference

Legion X uses the Geth Consensus and Legion APIs documented in [api.md](api.md#geth-consensus---multi-agent-orchestration).

Key endpoints:
- `POST /api/v1/geth/sessions` -- Create orchestration session
- `POST /api/v1/geth/sessions/:id/step/*` -- Step-based protocol
- `GET /api/v1/legion/agents` -- List all agents
- `GET /api/v1/legion/agents/:name` -- Agent details + performance

---

## Changelog

### v2.0.1 -- Zero-Knowledge Orchestration (Feb 2026 — current)
- Zero-knowledge protocol -- API keys never leave your machine; server provides routing, convergence measurement, and learning
- 7 cloud providers + Ollama (auto-failover on 429/529/overloaded)
- Immersive deliberation with speech bubbles (ON by default, `--no-immersive` to hide)
- Real CI Gain -- ALL individual proposals evaluated by LLM, best score used as baseline (no self-reported confidence)
- Zero-truncation pipeline -- agents see complete proposals
- Contextual Thompson Sampling + True Beta Sampling
- ONNX neural router with hourly auto-retraining
- Structured agent output (confidence, reasoning_summary, risk_flags)
- Adaptive round decision (skip/standard/mandatory/arbitrator)
- Provider resilience with hash-based rotation

### v1.5 -- Deliberation Spectacle
- Structured events rendered live
- Deliberation Recap with convergence bars
- Full cross-reading, no truncation
- 60-minute timeout for complex sessions

### v1.4 -- Neural Meta-Controller
- True Beta Sampling, Contextual Thompson Sampling, Temporal Decay
- Adaptive Round Decision, Cost-Aware Orchestration
- Router Auto-Retraining from production data

### v1.3 -- Live Progress
- Real-time progress bar with per-agent tracking

### v1.2 -- Rate-Aware Executor
- Adaptive serialization for Tier 1 API keys

### v1.1 -- ProjectScanner v2
- Two-pass scanning with agent-specific code injection

### v1.0 -- Initial Release
- Server-side orchestration with 41 agents and 9-layer Geth Consensus
