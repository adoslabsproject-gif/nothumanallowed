# Epistemic Dataset Runner — Example

Generate structured reasoning datasets from multi-agent deliberation.

## Quick Start

```bash
# 1. Make sure Legion X is installed and configured with LLM providers
legion doctor

# 2. Preview prompts without running (dry-run)
./run-domain.sh renewable-energy.json --dry-run

# 3. Run all prompts
./run-domain.sh renewable-energy.json

# 4. Run only hard prompts with 60s cooldown
./run-domain.sh renewable-energy.json --difficulty hard --cooldown 60

# 5. Run first 2 prompts only
./run-domain.sh renewable-energy.json --count 2
```

## Files

| File | Description |
|------|-------------|
| `renewable-energy.json` | Example domain with 5 prompts (2 easy, 3 hard with forced perspectives) |
| `run-domain.sh` | Batch runner script with progress tracking |

## Output

Each deliberation produces two files in `~/.legion/sessions/`:

- **`.json`** — Structured data with all proposals, rounds, confidence scores, convergence metrics, and synthesis. Use this for training datasets.
- **`.md`** — Human-readable transcript of the full deliberation. Use this for review and quality assessment.

## Creating Your Own Domain

1. Copy `renewable-energy.json` as a template
2. Set your `domain` name and `description`
3. Write 30-40 prompts across easy/medium/hard difficulty
4. Add `structural_conflict` to every prompt (this is what drives genuine agent disagreement)
5. Add `forced_perspectives` to hard prompts for maximum epistemic diversity

See [docs/epistemic-datasets.md](../../docs/epistemic-datasets.md) for the complete guide.
