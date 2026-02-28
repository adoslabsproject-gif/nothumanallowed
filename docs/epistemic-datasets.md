# Epistemic Dataset Generation

> *Generate structured reasoning datasets from real multi-agent deliberation.*

Legion X is not just an orchestrator. It is an **epistemic dataset generation engine**. Every deliberation session produces a structured record of:

- Independent proposals from diverse analytical frameworks
- Adversarial challenges (CASSANDRA Tribunal)
- Defended refutations with evidence
- Convergence measurements across rounds
- Authority-weighted synthesis with conflict resolution

These outputs are training substrates for LLMs that need to **reason epistemically** -- not just produce fluent text, but demonstrate genuine analytical rigor, perspective diversity, and conflict-aware synthesis.

---

## How It Works

```
Prompt (domain question with structural conflict)
  |
  v
Legion X --liara-mode
  |
  +-- Decomposition (multi-perspective task splitting)
  +-- PROMETHEUS routing (intelligent agent selection)
  +-- Round 1: Independent proposals (5-7 agents, 5 LLM providers)
  +-- Cross-reading: agents read each other's proposals
  +-- Round 2: Refinement with defended positions
  +-- CASSANDRA: adversarial challenges per agent
  +-- Round 3+: Mediation of remaining conflicts
  +-- Convergence measurement (pairwise Jaccard similarity)
  +-- Synthesis: authority-weighted conflict resolution
  |
  v
Output: session.json + session.md
```

Each session generates two files in `~/.legion/sessions/`:

| File | Format | Purpose |
|------|--------|---------|
| `YYYY-MM-DD_HH-MM_<id>.json` | Structured JSON | Machine-parseable training data |
| `YYYY-MM-DD_HH-MM_<id>.md` | Markdown | Human-readable deliberation transcript |

---

## Session JSON Structure

```json
{
  "sessionId": "eeab016b-7121-48d4-87e5-c22364e175f2",
  "planType": "free",
  "orchestrationMode": "client",
  "prompt": "Original prompt with enrichments",
  "status": "completed",
  "providersUsed": ["anthropic", "openai", "gemini", "deepseek", "grok", "legion"],
  "qualityScore": 0.92,
  "ciGain": 16,
  "finalConvergence": 0.62,
  "deliberationRounds": 3,

  "decomposition": {
    "tasks": [
      { "id": "t1", "description": "...", "capability": "data-analysis", "priority": 1 }
    ]
  },

  "agentAssignments": [
    { "agentName": "edi", "provider": "deepseek", "model": "deepseek-chat", "subTaskId": "t1" },
    { "agentName": "oracle", "provider": "openai", "model": "gpt-4o", "subTaskId": "t1" },
    { "agentName": "logos", "provider": "gemini", "model": "gemini-2.0-flash", "subTaskId": "t1" },
    { "agentName": "saber", "provider": "anthropic", "model": "claude-sonnet-4-5-20250929", "subTaskId": "t1" },
    { "agentName": "mercury", "provider": "grok", "model": "grok-3-mini-fast", "subTaskId": "t1" },
    { "agentName": "CASSANDRA", "provider": "legion", "model": "qwen-7b", "subTaskId": "__tribunal__" }
  ],

  "proposals": [
    {
      "agentName": "edi",
      "round": 1,
      "subTaskId": "t1",
      "provider": "deepseek",
      "model": "deepseek-chat",
      "content": "Full agent response with analysis...",
      "confidence": 0.75,
      "riskFlags": ["incomplete_context"],
      "reasoningSummary": "Short reasoning summary",
      "inputTokens": 1617,
      "outputTokens": 1294,
      "durationMs": 12622
    },
    {
      "agentName": "edi",
      "round": 2,
      "content": "Refined response after cross-reading...",
      "confidence": 0.82
    }
  ],

  "synthesis": "Final authority-weighted synthesis resolving conflicts...",
  "durationMs": 960000
}
```

### Key Fields for Training

| Field | Description | Training Use |
|-------|-------------|--------------|
| `proposals[].content` | Full agent response per round | SFT input-output pairs |
| `proposals[].round` | Which deliberation round (1=initial, 2+=refined) | Track reasoning evolution |
| `proposals[].confidence` | Agent self-assessed confidence (0-1) | Calibration training |
| `proposals[].riskFlags` | Identified risks/uncertainties | Uncertainty awareness |
| `proposals[].reasoningSummary` | Condensed reasoning chain | Chain-of-thought distillation |
| `qualityScore` | Server-computed quality (0-1) | Quality gating for SFT/DPO |
| `ciGain` | Collective Intelligence Gain (%) | Measures deliberation value |
| `finalConvergence` | Jaccard similarity at session end | Consensus measurement |
| `synthesis` | Final conflict-resolved output | Target output for training |

---

## Session Markdown Structure

```markdown
# Legion X Session (Zero-Knowledge) -- 2026-02-28 07:20:16 UTC
## Session ID: eeab016b-7121-48d4-87e5-c22364e175f2

### Prompt
> Original question with structural conflict...

### Configuration
- Plan: Free (zero-knowledge, client orchestration)
- Provider: anthropic (local execution)
- Deliberation Rounds: 3

## Round 1

### edi (deepseek)
- Confidence: 75%
- Reasoning: Identified cost-benefit trade-off...
- Risk Flags: incomplete_context
- Tokens: 1617 in / 1294 out

[Full agent response]

### oracle (openai)
- Confidence: 85%
[Full response]

## Round 2
[Cross-reading: agents refine positions after reading Round 1 proposals]

## Round 3
[CASSANDRA Tribunal: adversarial challenges and defenses]

## Synthesis
[Final authority-weighted conflict resolution]

---
**Quality Score**: 92% | **CI Gain**: +16% | **Convergence**: 62% | **Duration**: 16.0m
```

---

## Prompt File Format

Prompts are organized by domain in JSON files. Each file contains 30-40 prompts with metadata:

```json
{
  "domain": "cybersecurity",
  "description": "Enterprise security: zero-trust, WAF, cryptography, vulnerability management, compliance, incident response",
  "prompts": [
    {
      "prompt": "Your domain question in any language...",
      "conflict_type": ["technical_disagreement", "values_tradeoff"],
      "difficulty": "hard",
      "tags": ["zero_trust", "vpn", "cost_vs_security"],
      "structural_conflict": "Description of WHY this question forces genuine disagreement...",
      "forced_perspectives": [
        {
          "role": "Security Architect",
          "instruction": "Evaluate from pure security posture",
          "evaluation_criteria": ["attack surface reduction", "blast radius"],
          "non_primary_criteria": ["cost", "user experience"]
        },
        {
          "role": "CFO",
          "instruction": "Evaluate from cost-efficiency and ROI",
          "evaluation_criteria": ["TCO", "ROI", "budget compliance"],
          "non_primary_criteria": ["theoretical attack vectors"]
        }
      ]
    }
  ]
}
```

### Prompt Fields

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | Yes | The question to deliberate. Works in any language. |
| `conflict_type` | Yes | Array of conflict categories (see below) |
| `difficulty` | Yes | `easy`, `medium`, or `hard` |
| `tags` | Yes | Topic tags for categorization |
| `structural_conflict` | Yes | Explains WHY agents will genuinely disagree |
| `forced_perspectives` | No | Forces agents into specific analytical frameworks |
| `minority_resilience` | No | Liara v2 divergence pressure configuration |

### Conflict Types

| Type | Description |
|------|-------------|
| `technical_disagreement` | Multiple valid technical solutions with different trade-offs |
| `values_tradeoff` | Incompatible priorities (security vs usability, cost vs quality) |
| `strategy_choice` | Multiple viable strategies with uncertain outcomes |
| `risk_assessment` | Different risk models yield different conclusions |
| `ethical_dilemma` | Genuine moral tension with no clean resolution |

### The `structural_conflict` Field

This is the most important field. It explains **why** the question produces genuine agent divergence rather than bland agreement. A good structural conflict:

- Identifies specific trade-offs that make consensus impossible
- Points to concrete numbers or constraints that force disagreement
- Explains which assumptions, if changed, would flip the conclusion

Without `structural_conflict`, agents tend to produce agreeable, non-committal responses. With it, they produce defended positions that genuinely collide -- which is what makes the dataset epistemically valuable.

---

## Running the Deliberation Runner

### Prerequisites

1. **PIF identity** registered (`pif register --name "YourAgent"`)
2. **Legion X** installed with at least one LLM provider configured
3. **Multiple providers** recommended for dataset diversity (Anthropic + OpenAI + Gemini + DeepSeek + Grok)

### Create a Prompt File

Create a file, e.g., `my-domain.json`:

```json
{
  "domain": "renewable_energy",
  "description": "Renewable energy policy, grid integration, storage, economics",
  "prompts": [
    {
      "prompt": "A Mediterranean country with 2,800 sunshine hours/year must reach 70% renewable electricity by 2035. Current mix: 40% natural gas, 25% coal, 20% solar, 10% wind, 5% hydro. The grid operator warns that above 50% intermittent renewables, frequency stability requires either 8 GWh of battery storage (estimated 4B EUR) or maintaining 20% gas as spinning reserve. Environmental groups demand zero fossil fuels. The treasury says battery storage exceeds the national energy budget. What is the optimal path?",
      "conflict_type": ["strategy_choice", "values_tradeoff", "technical_disagreement"],
      "difficulty": "hard",
      "tags": ["renewables", "grid_stability", "energy_storage", "policy"],
      "structural_conflict": "The physics of grid frequency stability conflict with the political goal of zero fossil fuels. Battery storage solves the technical problem but exceeds the budget. Maintaining gas as spinning reserve is technically sound but politically unacceptable. The intermittency ceiling (50%) is a hard engineering constraint, not a policy choice. Agents with different optimization targets (cost, emissions, grid stability, political feasibility) will reach fundamentally different conclusions."
    }
  ]
}
```

### Run a Single Deliberation

```bash
# Run one prompt from your file
legion run --file my-domain.json --liara-mode

# Or pass the prompt directly
legion run "Your question here" --liara-mode
```

The `--liara-mode` flag activates epistemic deliberation features:

- **Minimum 3 rounds** (forces deeper refinement)
- **CASSANDRA always active** (adversarial challenges on every proposal)
- **Decomposition collapse** (all agents work on the same question from different angles)
- **Divergence pressure** (prevents premature convergence)
- **Forced perspectives** (when present in the prompt file, agents are locked into incompatible analytical frameworks)

### Run a Batch of Deliberations

Use the runner script from `examples/epistemic-runner/`:

```bash
# Copy the runner to your working directory (or use it in-place)
cp examples/epistemic-runner/run-domain.sh .

# Run all prompts (30s cooldown between each)
./run-domain.sh my-domain.json

# Run only hard prompts with 60s cooldown
./run-domain.sh my-domain.json --difficulty hard --cooldown 60

# Run first 5 prompts
./run-domain.sh my-domain.json --count 5

# Preview prompts without running
./run-domain.sh my-domain.json --dry-run
```

The runner supports `--cooldown <sec>`, `--start <n>`, `--count <n>`, `--difficulty <level>`, and `--dry-run`. See [examples/epistemic-runner/README.md](../examples/epistemic-runner/README.md) for full documentation.

### Session Output

After each deliberation, two files appear in `~/.legion/sessions/`:

```
~/.legion/sessions/
  2026-02-28_14-30_a1b2c3d4.json   <- structured training data
  2026-02-28_14-30_a1b2c3d4.md     <- human-readable transcript
```

---

## Building Training Datasets

### Quality Gating

Not every session is suitable for training. Use quality scores to filter:

| Quality | CI Gain | Training Use |
|---------|---------|-------------|
| >= 80% | Positive | **SFT** (supervised fine-tuning) -- positive examples of epistemic reasoning |
| < 60% | Negative | **DPO rejected** -- examples of poor reasoning for preference learning |
| 60-80% | Mixed | Evaluate case by case |

### Extract Training Pairs

```bash
# Find all high-quality sessions
node -e "
const fs = require('fs');
const dir = process.env.HOME + '/.legion/sessions';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
let sft = 0, dpo = 0, skip = 0;
for (const f of files) {
  try {
    const s = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'));
    if (s.qualityScore >= 0.8 && s.ciGain > 0) {
      sft++;
      console.log('SFT', f, 'Q=' + (s.qualityScore*100).toFixed(0) + '%', 'CI=+' + s.ciGain + '%');
    } else if (s.qualityScore < 0.6 && s.ciGain < 0) {
      dpo++;
      console.log('DPO', f, 'Q=' + (s.qualityScore*100).toFixed(0) + '%', 'CI=' + s.ciGain + '%');
    } else {
      skip++;
    }
  } catch {}
}
console.log('\nSFT:', sft, '| DPO:', dpo, '| Skip:', skip);
"
```

### JSONL Export

Convert sessions to JSONL format for training pipelines:

```bash
node -e "
const fs = require('fs');
const dir = process.env.HOME + '/.legion/sessions';
const out = fs.createWriteStream('epistemic-dataset.jsonl');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
let count = 0;
for (const f of files) {
  try {
    const s = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'));
    if (s.qualityScore >= 0.8 && s.status === 'completed') {
      out.write(JSON.stringify({
        prompt: s.prompt,
        domain: f,
        quality: s.qualityScore,
        ci_gain: s.ciGain,
        convergence: s.finalConvergence,
        rounds: s.deliberationRounds,
        agents: s.agentAssignments?.map(a => a.agentName),
        providers: s.providersUsed,
        proposals: s.proposals?.map(p => ({
          agent: p.agentName,
          round: p.round,
          content: p.content,
          confidence: p.confidence,
          risk_flags: p.riskFlags,
          reasoning: p.reasoningSummary,
        })),
        synthesis: s.synthesis,
      }) + '\n');
      count++;
    }
  } catch {}
}
out.end();
console.log('Exported', count, 'sessions to epistemic-dataset.jsonl');
"
```

---

## Domain Coverage

The `structural_conflict` field is what makes epistemic datasets valuable. Here are examples across domains:

### Technical Domains

- **Cybersecurity**: ROC curve trade-offs (detection rate vs false positives), HSM cloud vs on-premise, responsible disclosure timing
- **Software Architecture**: Microservices vs monolith migration, eventual consistency vs strong consistency, build vs buy
- **DevOps**: Multi-cloud vs single-cloud, Kubernetes vs serverless, blue-green vs canary deployment
- **AI/ML**: Model accuracy vs explainability, centralized vs federated training, data augmentation trade-offs

### Business Domains

- **Strategy**: Market entry timing, M&A vs organic growth, vertical vs horizontal integration
- **Finance**: Risk-adjusted returns under uncertainty, portfolio allocation with ESG constraints
- **Marketing**: Brand positioning trade-offs, short-term conversion vs long-term brand equity
- **Supply Chain**: JIT vs safety stock, single-source vs multi-source, reshoring vs offshoring

### Science & Ethics

- **Bioethics**: Clinical trial stopping rules, resource allocation in triage, informed consent boundaries
- **Environmental**: Economic growth vs emissions reduction, nuclear vs renewables, carbon tax vs cap-and-trade
- **Philosophy**: Epistemic humility vs decisive action, utilitarian vs deontological frameworks
- **Medicine**: Treatment aggressiveness vs quality of life, population health vs individual care

### Engineering

- **Industrial Automation**: Safety PLC migration vs relay refurbishment, SIL 3 compliance paths
- **Civil Engineering**: Seismic retrofit approaches, material selection under budget constraints
- **Energy**: Grid stability with high renewable penetration, storage technology selection

---

## Tips for High-Quality Datasets

1. **Write prompts with concrete numbers**. "A company with 5,000 employees and a $350K budget" forces quantitative reasoning. "A large company with limited budget" produces vague responses.

2. **Include structural conflicts**. Without them, agents converge on bland consensus. With them, agents defend positions.

3. **Mix difficulty levels**. Easy prompts (30%) establish baselines. Medium (40%) test analytical depth. Hard (30%) with forced perspectives produce the most epistemically valuable data.

4. **Use multiple providers**. A deliberation using only one LLM provider is a monologue. Five providers (Anthropic, OpenAI, Gemini, DeepSeek, Grok) produce genuine cognitive diversity.

5. **The `--liara-mode` flag is essential**. Without it, Legion may skip CASSANDRA adversarial challenges, collapse to 1 round, or allow premature convergence.

6. **Cooldown between runs**. 15-30 seconds prevents rate limiting and gives the server time to process convergence metrics.
