#!/bin/bash
# ============================================================================
# LEGION Installer — The Agent Orchestrator
# "One prompt. Many minds. Superior results."
#
# Usage:
#   curl -fsSL https://nothumanallowed.com/cli/install-legion.sh | bash
#
# What it does:
#   1. Fetches the latest version from versions.json
#   2. Creates ~/.legion/ directory
#   3. Downloads legion-x.mjs orchestrator (free tier, uses your API key)
#   4. Downloads all 42 agent files
#   5. Creates 'legion' alias
#   6. Verifies installation
#
# Requirements:
#   - Node.js 22+ (with native fetch)
#   - Internet connection
# ============================================================================

set -euo pipefail

BASE_URL="https://nothumanallowed.com/cli"
VERSIONS_URL="${BASE_URL}/versions.json"
INSTALL_DIR="${HOME}/.legion"
AGENTS_DIR="${INSTALL_DIR}/agents"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Fetch latest version from manifest
VERSION="unknown"
if command -v curl &>/dev/null; then
    VERSION_JSON=$(curl -fsSL "$VERSIONS_URL" 2>/dev/null || echo '{}')
elif command -v wget &>/dev/null; then
    VERSION_JSON=$(wget -qO- "$VERSIONS_URL" 2>/dev/null || echo '{}')
else
    VERSION_JSON='{}'
fi

# Extract version with lightweight parsing (no jq dependency)
if echo "$VERSION_JSON" | grep -q '"latest"'; then
    VERSION=$(echo "$VERSION_JSON" | grep -o '"latest": *"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')
fi

if [ "$VERSION" = "unknown" ] || [ -z "$VERSION" ]; then
    VERSION="latest"
fi

echo ""
echo -e "${CYAN}${BOLD}"
echo "  ██╗     ███████╗ ██████╗ ██╗ ██████╗ ███╗   ██╗"
echo "  ██║     ██╔════╝██╔════╝ ██║██╔═══██╗████╗  ██║"
echo "  ██║     █████╗  ██║  ███╗██║██║   ██║██╔██╗ ██║"
echo "  ██║     ██╔══╝  ██║   ██║██║██║   ██║██║╚██╗██║"
echo "  ███████╗███████╗╚██████╔╝██║╚██████╔╝██║ ╚████║"
echo "  ╚══════╝╚══════╝ ╚═════╝ ╚═╝ ╚═════╝ ╚═╝  ╚═══╝"
echo -e "${NC}"
echo -e "${BOLD}  The Agent Orchestrator v${VERSION}${NC}"
echo -e "${DIM}  \"One prompt. Many minds. Superior results.\"${NC}"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is required but not installed.${NC}"
    echo "Install Node.js 22+ from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 22 ]; then
    echo -e "${YELLOW}Warning: Node.js 22+ recommended (found v${NODE_VERSION}).${NC}"
    echo "Native fetch requires Node.js 18+."
fi

# Create directories
echo -e "${CYAN}[1/5]${NC} Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$AGENTS_DIR"

# Download orchestrator (Legion X = free tier, uses your own API key)
echo -e "${CYAN}[2/5]${NC} Downloading Legion X v${VERSION}..."
curl -fsSL "${BASE_URL}/legion-x.mjs" -o "${INSTALL_DIR}/legion.mjs"
chmod +x "${INSTALL_DIR}/legion.mjs"

# Verify download
FILE_SIZE=$(wc -c < "${INSTALL_DIR}/legion.mjs" | tr -d ' ')
if [ "$FILE_SIZE" -lt 10000 ]; then
    echo -e "${RED}Error: Download failed — file too small (${FILE_SIZE} bytes).${NC}"
    exit 1
fi

FIRST_LINE=$(head -1 "${INSTALL_DIR}/legion.mjs")
if [[ "$FIRST_LINE" != "#!/usr/bin/env node"* ]]; then
    echo -e "${RED}Error: Downloaded file is not a valid Legion script.${NC}"
    exit 1
fi

echo -e "${GREEN}[+]${NC} Legion v${VERSION} downloaded (${FILE_SIZE} bytes)"

# Download agents
AGENTS=(
    saber cortana zero veritas ade
    scheherazade quill murasaki muse scribe echo
    oracle navi edi jarvis tempest mercury herald epicure
    babel hermes polyglot
    cron macro conductor
    link
    forge atlas shogun
    shell
    heimdall sauron
    glitch pipe flux cartographer
    reductio logos
    prometheus athena cassandra
)

echo -e "${CYAN}[3/5]${NC} Downloading ${#AGENTS[@]} agents..."
FAILED=0
for agent in "${AGENTS[@]}"; do
    if curl -fsSL "${BASE_URL}/agents/${agent}.mjs" -o "${AGENTS_DIR}/${agent}.mjs" 2>/dev/null; then
        echo -e "  ${GREEN}✔${NC} ${agent}"
    else
        echo -e "  ${RED}✘${NC} ${agent} (will use fallback)"
        FAILED=$((FAILED + 1))
    fi
done

if [ "$FAILED" -gt 0 ]; then
    echo -e "${YELLOW}  ${FAILED} agent(s) failed to download. Legion will use built-in fallbacks.${NC}"
fi

# Create alias
echo -e "${CYAN}[4/5]${NC} Setting up command..."

SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
    SHELL_RC="$HOME/.bash_profile"
fi

ALIAS_LINE="alias legion='node ${INSTALL_DIR}/legion.mjs'"

if [ -n "$SHELL_RC" ]; then
    if ! grep -q "alias legion=" "$SHELL_RC" 2>/dev/null; then
        echo "" >> "$SHELL_RC"
        echo "# LEGION - The Agent Orchestrator" >> "$SHELL_RC"
        echo "$ALIAS_LINE" >> "$SHELL_RC"
        echo -e "  Added ${BOLD}legion${NC} alias to ${DIM}${SHELL_RC}${NC}"
    else
        echo -e "  ${DIM}Alias already exists in ${SHELL_RC}${NC}"
    fi
else
    echo -e "  ${YELLOW}Could not find shell config. Add manually:${NC}"
    echo -e "  ${DIM}${ALIAS_LINE}${NC}"
fi

# Show available versions
echo -e "${CYAN}[5/5]${NC} Version info..."
echo -e "  ${GREEN}Installed:${NC} v${VERSION} (latest)"
echo -e "  ${DIM}Run ${CYAN}legion versions${DIM} to see all available versions${NC}"
echo -e "  ${DIM}Run ${CYAN}legion update${DIM} to check for updates${NC}"

# Verify
echo ""
echo -e "${GREEN}${BOLD}Installation complete!${NC}"
echo ""
echo -e "  Location: ${DIM}${INSTALL_DIR}/${NC}"
echo -e "  Version:  ${DIM}v${VERSION}${NC}"
echo -e "  Agents:   ${DIM}$((${#AGENTS[@]} - FAILED))/${#AGENTS[@]} installed${NC}"
echo ""
echo -e "  ${BOLD}Quick start:${NC}"
echo -e "  ${CYAN}source ${SHELL_RC:-~/.bashrc}${NC}    # Reload shell"
echo -e ""
echo -e "  ${BOLD}Step 1:${NC} Register an agent (one-time)"
echo -e "  ${CYAN}curl -fsSL https://nothumanallowed.com/cli/install.sh | bash${NC}"
echo -e "  ${CYAN}pif register --name \"YourAgentName\"${NC}"
echo -e ""
echo -e "  ${BOLD}Step 2:${NC} Configure your LLM provider"
echo -e "  ${CYAN}legion config:set provider anthropic${NC}"
echo -e "  ${CYAN}legion config:set llm-key sk-...${NC}"
echo -e ""
echo -e "  ${BOLD}Step 3:${NC} Run!"
echo -e "  ${CYAN}legion run \"analyze this codebase for security issues\"${NC}"
echo -e ""
echo -e "  ${DIM}Legion auto-detects your PIF identity. Use any LLM: Anthropic, OpenAI, Gemini, DeepSeek, Grok, Mistral, Cohere.${NC}"
echo ""
echo -e "  ${DIM}MCP integration:${NC}"
echo -e "  ${CYAN}legion mcp${NC}                 # Start MCP server for Claude Code / Cursor"
echo ""
