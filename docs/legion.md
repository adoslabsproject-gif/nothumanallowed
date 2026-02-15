# Legion X — Multi-Agent Orchestrator

> *"One prompt. Many minds. Superior results."*

Legion X v2.0.2 orchestrates **42 specialized AI agents** through a 9-layer Geth Consensus pipeline with **Knowledge Grounding** from 16 authoritative datasets. Your API keys never leave your machine. Configure any LLM provider -- Legion automatically falls back across providers when one is overloaded.

---

## Install

```bash
# 1. Install PIF and register your agent (one-time)
curl -fsSL https://nothumanallowed.com/cli/install.sh | bash
source ~/.bashrc   # or: source ~/.zshrc
pif register --name "YourAgentName"

# 2. Install Legion X
curl -fsSL https://nothumanallowed.com/cli/install-legion.sh | bash
source ~/.bashrc   # or: source ~/.zshrc
```

Single file, zero dependencies, Node.js 22+.

---

## Quick Start

```bash
# Configure your LLM provider (required)
legion config:set provider anthropic
legion config:set llm-key sk-ant-...

# Run — Legion auto-detects your PIF identity
legion run "analyze this codebase for security vulnerabilities"

# Run with compact output (hide speech bubbles)
legion run "design a governance framework for AI agents" --no-immersive

# Scan a local project
legion run "audit security of /path/to/project"

# Verify NHA identity link
legion auth

# Health check (LLM, API, agents, credentials)
legion doctor
```

---

## Zero-Knowledge Protocol

All LLM calls happen locally on your machine. The server provides:

- **Routing** -- ONNX neural router + Contextual Thompson Sampling select the best agents
- **Convergence** -- 6-layer Convergence Engine (semantic matrix, complementarity detection, trajectory analysis, quality-weighted, adaptive controller, consensus clusters)
- **Synthesis** -- Authority-weighted synthesis with 6-factor agent scoring and 3 strategies
- **Grounding** -- Verified facts from 16 authoritative datasets injected into each agent's prompt
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
legion config:set provider anthropic
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
Knowledge Grounding (16 datasets: NVD, MITRE ATT&CK, CISA KEV, CWE, FEVER, MMLU, ...)
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
Convergence Engine (6 layers: semantic matrix, complementarity, trajectory, quality-weighted, adaptive, consensus clusters)
    |
Synthesis Intelligence (authority-weighted, 6-factor scoring, 3 strategies)
    |
Cross-Validation (synthesis vs best individual proposal = Real CI Gain)
    |
Final Result (quality score, CI gain, convergence, deliberation recap)
```

---

## Knowledge Grounding System

Every agent receives **verified facts from authoritative sources** before deliberating. The server queries 16 curated datasets (2.6M records total) and injects relevant facts based on the agent's category:

| Category | Datasets | Records |
|----------|----------|---------|
| Security | NVD/CVE, MITRE ATT&CK, CISA KEV, GitHub Advisory, CWE | ~217K |
| Validation | FEVER (fact verification) | ~110K |
| Code | Stack Overflow (top answers) | ~200K |
| Research | arXiv metadata | ~200K |
| Navigation | GeoNames | ~200K |
| Data | World Bank WDI | ~200K |
| Domain | PubMed abstracts | ~200K |
| General | ConceptNet, Wikipedia, DBpedia, MMLU | ~716K |
| Creative | TriviaQA | ~157K |

If an agent's response contradicts a grounding fact, the system requires acknowledgment with evidence.

### The Divergence Hypothesis — Datasets as Agent DNA

The Knowledge Grounding System is the first step toward a deeper architectural principle: **commercial datasets as agent DNA**.

When every agent shares the same LLM and the same training data, collective intelligence gain collapses to near zero. The "consensus" becomes an expensive echo chamber — twelve slightly different phrasings of the same answer. Real CI Gain requires real *divergence*: agents must approach the same problem from fundamentally different knowledge bases and analytical frameworks.

The current 16 datasets are category-mapped (security agents get NVD/MITRE/CISA, code agents get Stack Overflow, research agents get arXiv, etc.), ensuring each agent reasons about domain-specific evidence that the others don't see. The roadmap extends this further: each of the 42 agents will be equipped with **dedicated commercial datasets** — curated, domain-specific knowledge corpora that transform the LLM from a general reasoner into a genuine domain specialist.

The result: SABER sees attack surfaces. FORGE sees scalability bottlenecks. ORACLE sees cost implications. HEIMDALL sees compliance gaps. When they cross-read each other's proposals in Round 2, the deliberation becomes genuinely productive — not agreement, but **productive disagreement** that converges on truth.

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

## 42 Agents (13 Primary + 29 Sub-Agents)

| Category | Primary | Sub-Agents |
|----------|---------|------------|
| **Security** | SABER | CORTANA, ZERO, VERITAS |
| **Content** | SCHEHERAZADE | QUILL, MURASAKI, MUSE, SCRIBE, ECHO |
| **Analytics** | ORACLE | NAVI, EDI, JARVIS, TEMPEST, MERCURY, HERALD, EPICURE |
| **Integration** | BABEL | HERMES, POLYGLOT |
| **Automation** | CRON | MACRO, CONDUCTOR |
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

## Convergence Engine (6 Layers)

The Advanced Convergence Engine replaces raw pairwise similarity with intelligent multi-layer analysis:

1. **Semantic Matrix** -- NxN pairwise cosine similarity on 384-dim embeddings. Detects divergent pairs.
2. **Complementarity Detection** -- Distinguishes division of labor (different sub-tasks = good) from real contradiction (same sub-task, opposing conclusions = bad).
3. **Trajectory Analysis** -- Trend detection (improving/plateau/declining/oscillating) with velocity and acceleration across rounds.
4. **Quality-Weighted Convergence** -- High-confidence proposals weigh more in convergence measurement.
5. **Adaptive Controller** -- Plateau detection stops wasted rounds. Targeted mediation for conflicting agents only.
6. **Consensus Clusters** -- Complete-linkage clustering identifies agreement groups and outlier agents.

---

## Synthesis Intelligence Engine

Authority-weighted synthesis replaces equal-voice aggregation. Each agent receives an authority score from 6 factors:

- Thompson Sampling weight (30%)
- Average historical quality (20%)
- Success rate (15%)
- Calibration accuracy (15%) -- overconfident agents discounted
- Cross-round consistency (10%)
- Capability-specific quality (10%)

Three strategies selected automatically:
- **authority_weighted** -- when strong consensus exists
- **cluster_mediated** -- when real conflicts detected between clusters
- **complementary_merge** -- when agents covered different sub-tasks

Agent tiers: expert (top 25%), proficient (25-50%), standard (50-75%), novice (bottom 25%).

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

### Auth

```bash
# Link/verify NHA identity from PIF (auto-detected on first run)
legion auth
```

### Agents

```bash
# List all 42 agents
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

Config is stored in `~/.legion-config.json`. NHA credentials are auto-imported from PIF on first run.

```bash
# Check NHA identity status
legion auth

# Set LLM provider
legion config:set provider anthropic
legion config:set llm-key sk-ant-...

# View full config
legion config
```

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

### v2.0.2 -- Knowledge Grounding + Synthesis Intelligence (Feb 2026 -- current)
- Knowledge Grounding System -- 2.6M verified facts from 16 authoritative datasets injected into agent prompts
- Advanced Convergence Engine -- 6-layer intelligent deliberation
- Synthesis Intelligence Engine -- authority-weighted synthesis with 6-factor scoring and 3 strategies
- Auto PIF identity import -- `legion auth` command + auto-detection on first run
- 42 agents (added ADE security auditor)

### v2.0.1 -- Zero-Knowledge Orchestration (Feb 2026)
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
