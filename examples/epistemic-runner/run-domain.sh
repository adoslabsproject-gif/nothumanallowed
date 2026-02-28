#!/bin/bash
# ============================================================================
# Epistemic Deliberation Runner
# ============================================================================
#
# Runs Legion X deliberations from a domain prompt file and generates
# structured epistemic datasets (JSON + Markdown) in ~/.legion/sessions/
#
# Usage:
#   ./run-domain.sh <prompt-file.json> [options]
#
# Options:
#   --cooldown <sec>    Seconds between runs (default: 30)
#   --start <n>         Start from prompt N (0-indexed, default: 0)
#   --count <n>         Run only N prompts (default: all)
#   --difficulty <lvl>  Filter by difficulty: easy, medium, hard (default: all)
#   --dry-run           Preview prompts without running
#
# Examples:
#   ./run-domain.sh renewable-energy.json
#   ./run-domain.sh cybersecurity.json --cooldown 60 --count 5
#   ./run-domain.sh bioethics.json --difficulty hard --dry-run
#
# Output:
#   ~/.legion/sessions/YYYY-MM-DD_HH-MM_<sessionId>.json  (training data)
#   ~/.legion/sessions/YYYY-MM-DD_HH-MM_<sessionId>.md    (transcript)
#
# ============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
DIM='\033[2m'
RESET='\033[0m'

# Defaults
COOLDOWN=30
START_INDEX=0
MAX_COUNT=0
DIFFICULTY_FILTER=""
DRY_RUN=false
PROMPT_FILE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cooldown) COOLDOWN="$2"; shift 2 ;;
    --start) START_INDEX="$2"; shift 2 ;;
    --count) MAX_COUNT="$2"; shift 2 ;;
    --difficulty) DIFFICULTY_FILTER="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h)
      echo "Usage: $0 <prompt-file.json> [--cooldown N] [--start N] [--count N] [--difficulty easy|medium|hard] [--dry-run]"
      exit 0
      ;;
    *)
      if [ -z "$PROMPT_FILE" ]; then
        PROMPT_FILE="$1"
      else
        echo -e "${RED}Unknown argument: $1${RESET}"
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$PROMPT_FILE" ]; then
  echo -e "${RED}Error: prompt file required${RESET}"
  echo "Usage: $0 <prompt-file.json> [options]"
  exit 1
fi

if [ ! -f "$PROMPT_FILE" ]; then
  echo -e "${RED}Error: file not found: $PROMPT_FILE${RESET}"
  exit 1
fi

# Check Legion X is installed
LEGION_PATH="${HOME}/.legion/legion-x.mjs"
if [ ! -f "$LEGION_PATH" ]; then
  echo -e "${RED}Error: Legion X not found at $LEGION_PATH${RESET}"
  echo "Install: curl -fsSL https://nothumanallowed.com/cli/install-legion.sh | bash"
  exit 1
fi

# Parse domain metadata
DOMAIN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PROMPT_FILE','utf8')).domain)")
TOTAL_PROMPTS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PROMPT_FILE','utf8')).prompts.length)")

echo -e "${CYAN}============================================${RESET}"
echo -e "${CYAN}  Epistemic Deliberation Runner${RESET}"
echo -e "${CYAN}============================================${RESET}"
echo -e "  Domain:     ${GREEN}${DOMAIN}${RESET}"
echo -e "  Prompts:    ${TOTAL_PROMPTS}"
echo -e "  Cooldown:   ${COOLDOWN}s"
echo -e "  Difficulty: ${DIFFICULTY_FILTER:-all}"
if [ "$DRY_RUN" = true ]; then
  echo -e "  Mode:       ${YELLOW}DRY RUN${RESET}"
fi
echo -e "${CYAN}============================================${RESET}"
echo ""

# Build prompt indices (with optional difficulty filter)
INDICES=$(node -e "
const d = JSON.parse(require('fs').readFileSync('$PROMPT_FILE', 'utf8'));
const filter = '$DIFFICULTY_FILTER';
const start = $START_INDEX;
const max = $MAX_COUNT;
let indices = [];
for (let i = 0; i < d.prompts.length; i++) {
  if (filter && d.prompts[i].difficulty !== filter) continue;
  if (i < start) continue;
  indices.push(i);
  if (max > 0 && indices.length >= max) break;
}
console.log(indices.join(' '));
")

if [ -z "$INDICES" ]; then
  echo -e "${YELLOW}No prompts match the filter criteria.${RESET}"
  exit 0
fi

# Count
FILTERED_COUNT=$(echo "$INDICES" | wc -w | tr -d ' ')
echo -e "Running ${GREEN}${FILTERED_COUNT}${RESET} deliberations..."
echo ""

COMPLETED=0
FAILED=0
RUN_NUM=0

for IDX in $INDICES; do
  RUN_NUM=$((RUN_NUM + 1))

  # Extract prompt metadata
  PROMPT_TEXT=$(node -e "const d=JSON.parse(require('fs').readFileSync('$PROMPT_FILE','utf8'));console.log(d.prompts[$IDX].prompt)")
  DIFFICULTY=$(node -e "const d=JSON.parse(require('fs').readFileSync('$PROMPT_FILE','utf8'));console.log(d.prompts[$IDX].difficulty)")
  CONFLICT=$(node -e "const d=JSON.parse(require('fs').readFileSync('$PROMPT_FILE','utf8'));console.log((d.prompts[$IDX].conflict_type||[]).join(', '))")
  HAS_PERSPECTIVES=$(node -e "const d=JSON.parse(require('fs').readFileSync('$PROMPT_FILE','utf8'));console.log(d.prompts[$IDX].forced_perspectives?'yes':'no')")

  echo -e "${CYAN}[${RUN_NUM}/${FILTERED_COUNT}]${RESET} ${YELLOW}${DIFFICULTY}${RESET} | ${DIM}${CONFLICT}${RESET}${HAS_PERSPECTIVES:+ | perspectives: ${HAS_PERSPECTIVES}}"
  echo -e "  ${DIM}${PROMPT_TEXT:0:120}...${RESET}"

  if [ "$DRY_RUN" = true ]; then
    echo -e "  ${DIM}[dry-run — skipped]${RESET}"
    echo ""
    continue
  fi

  # Write prompt to temp file
  TMPFILE=$(mktemp /tmp/legion-epistemic-XXXXXX.txt)
  echo "$PROMPT_TEXT" > "$TMPFILE"

  # Run Legion X with liara-mode
  START_TIME=$(date +%s)

  if node "$LEGION_PATH" run --file "$TMPFILE" --liara-mode --no-scan 2>&1; then
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    echo -e "  ${GREEN}COMPLETED${RESET} (${DURATION}s)"
    COMPLETED=$((COMPLETED + 1))
  else
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    echo -e "  ${RED}FAILED${RESET} (${DURATION}s)"
    FAILED=$((FAILED + 1))
  fi

  rm -f "$TMPFILE"

  # Cooldown (skip after last prompt)
  if [ "$RUN_NUM" -lt "$FILTERED_COUNT" ]; then
    echo -e "  ${DIM}Cooldown ${COOLDOWN}s...${RESET}"
    sleep "$COOLDOWN"
  fi

  echo ""
done

echo -e "${CYAN}============================================${RESET}"
echo -e "  ${GREEN}Completed: ${COMPLETED}${RESET} | ${RED}Failed: ${FAILED}${RESET} | Total: ${FILTERED_COUNT}"
echo -e "  Sessions saved to: ${DIM}~/.legion/sessions/${RESET}"
echo -e "${CYAN}============================================${RESET}"
