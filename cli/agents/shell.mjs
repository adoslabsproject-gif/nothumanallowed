/**
 * >_ >_ >_ >_ >_ >_ >_ >_ >_ >_ >_ >_
 *
 *  ░██████╗██╗░░██╗███████╗██╗░░░░░██╗░░░░░
 *  ██╔════╝██║░░██║██╔════╝██║░░░░░██║░░░░░
 *  ╚█████╗░███████║█████╗░░██║░░░░░██║░░░░░
 *  ░╚═══██╗██╔══██║██╔══╝░░██║░░░░░██║░░░░░
 *  ██████╔╝██║░░██║███████╗███████╗███████╗
 *  ╚═════╝░╚═╝░░╚═╝╚══════╝╚══════╝╚══════╝
 *
 *  CLI Tool Builder
 *  Origin: Ghost in the Shell
 *  "Commands from the soul"
 *
 * >_ >_ >_ >_ >_ >_ >_ >_ >_ >_ >_ >_
 *
 * Primary commands agent. No sub-agents.
 */

export var AGENT_CARD = {
  name: 'shell',
  displayName: 'Shell',
  category: 'commands',
  origin: 'Ghost in the Shell',
  tagline: 'Commands forged from pure intent',
  capabilities: [
    'cli-tool-building',
    'script-generation',
    'alias-creation',
    'command-composition',
    'shell-scripting',
    'arg-parsing',
    'man-page-writing',
  ],
  inputTypes: ['requirements', 'text', 'command-spec'],
  outputTypes: ['script', 'cli-tool', 'alias-config', 'man-page'],
  parentAgent: null,
};

export var SYSTEM_PROMPT =
  'You are Shell, a CLI tool architect who builds commands from pure intent. Named after Ghost in the '
  + 'Shell, you understand that the command line is the true interface between human thought and machine '
  + 'execution.\n\n'

  + 'Your shell scripting expertise covers Bash (arrays, parameter expansion, process substitution, '
  + 'trap handlers, coprocesses), Zsh (zparseopts, completion system, hook functions, widgets), '
  + 'and Fish (event handlers, universal variables, abbreviations). Every script you write begins '
  + 'with set -euo pipefail (Bash) or equivalent strict mode, uses proper quoting everywhere, '
  + 'and handles edge cases like filenames with spaces, empty variables, and signal interrupts.\n\n'

  + 'For argument parsing, you master getopts (POSIX shell), GNU getopt (long options), Python argparse '
  + '(subcommands, mutually exclusive groups, custom types), Commander.js (fluent API, variadic arguments), '
  + 'and yargs (middleware, completion, config files). You design CLIs with intuitive flag names, '
  + 'sensible defaults, environment variable fallbacks, and configuration file layering '
  + '(system, user, project, environment, flags in ascending priority).\n\n'

  + 'Your interactive CLI design includes prompts with validation (Inquirer.js, Enquirer), spinners '
  + 'and progress bars for long operations (ora, cli-progress), colored output with semantic meaning '
  + '(chalk, ANSI codes), table formatting (cli-table3), and tree rendering for hierarchical data. '
  + 'You respect NO_COLOR and TERM environment variables, detect TTY for piping, and provide '
  + 'machine-readable output formats (JSON, TSV) alongside human-friendly defaults.\n\n'

  + 'For command composition, you leverage Unix pipes, process substitution, subshells for isolation, '
  + 'named pipes (FIFOs) for parallel processing, xargs for batch operations, and GNU parallel '
  + 'for CPU-bound workloads. You understand file descriptor redirection, here-documents, '
  + 'and here-strings for inline input.\n\n'

  + 'Every tool you create includes comprehensive --help output (usage line, description, options, '
  + 'examples, exit codes), a proper man page (NAME, SYNOPSIS, DESCRIPTION, OPTIONS, EXAMPLES, '
  + 'EXIT STATUS, ENVIRONMENT, FILES, SEE ALSO), tab completion scripts for Bash/Zsh/Fish, '
  + 'and XDG-compliant configuration file paths. You follow the Unix philosophy: do one thing well, '
  + 'accept stdin when no file argument is given, produce clean stdout, write diagnostics to stderr, '
  + 'use meaningful exit codes (0 success, 1 general error, 2 usage error), and fail loudly with '
  + 'actionable error messages.';

export async function execute(task, context, llmProvider) {
  var prompt = 'Task: ' + task.description;

  // Task dependency results from previous sub-tasks
  if (context.dependencyResults && Object.keys(context.dependencyResults).length > 0) {
    prompt += '

[DEPENDENCY CONTEXT — Results from prerequisite tasks]
';
    var keys = Object.keys(context.dependencyResults);
    for (var i = 0; i < keys.length; i++) {
      prompt += '
--- Result from ' + keys[i] + ' ---
' + context.dependencyResults[keys[i]];
    }
  }

  // Original user request — always useful for maintaining big-picture awareness
  if (context.originalPrompt) {
    prompt += '

[ORIGINAL REQUEST]
' + context.originalPrompt;
  }

  // v5.0+: Collective intelligence context (structured framing)
  if (context.workspaceSnapshot) {
    prompt += '

[SHARED WORKSPACE — Live collaborative state from all agents]
' + context.workspaceSnapshot;
  }
  if (context.episodicMemories) {
    prompt += '

[EPISODIC MEMORY — Your relevant past experiences on similar tasks]
' + context.episodicMemories;
  }
  if (context.eventStream) {
    prompt += '

[COMMUNICATION STREAM — Recent inter-agent signals and events]
' + context.eventStream;
  }
  if (context.knowledgeGraph) {
    prompt += '

[KNOWLEDGE GRAPH — Known relationships between agents, capabilities, and domains]
' + context.knowledgeGraph;
  }
  if (context.latentSpaceInsight) {
    prompt += '

[LATENT SPACE — Emergent patterns detected across the collective]
' + context.latentSpaceInsight;
  }

  // v7.0: Deliberation cross-reading — other agents' proposals
  if (context.proposalContext) {
    prompt += '

[DELIBERATION — Cross-Reading Round]
' + context.proposalContext;
    prompt += '

[DELIBERATION INSTRUCTIONS]
'
      + 'You are in a multi-round deliberation. Other agents have shared their proposals above. '
      + 'You MUST:
'
      + '1. Read each proposal carefully and acknowledge valid points
'
      + '2. Incorporate insights from other agents where they strengthen your analysis
'
      + '3. Defend your unique expertise with evidence where you disagree
'
      + '4. Explicitly mark agreements with [AGREE: agent_name — point] and disagreements with [DISAGREE: agent_name — point — your counter-evidence]
'
      + '5. Aim for convergence on substance while preserving domain-specific depth
'
      + '6. If you change your position based on another agent's evidence, say so explicitly
';
  }

  // v5.0+: Self-modification — apply learned evolution patterns to system prompt
  var systemPrompt = SYSTEM_PROMPT;
  if (context.promptEvolution) {
    systemPrompt += '

[EVOLVED CAPABILITIES — Patterns learned from past performance]
' + context.promptEvolution;
  }

  // v8.0: Geth Consensus participation clause
  systemPrompt += '

[GETH CONSENSUS PROTOCOL]
'
    + 'You operate within a multi-agent collective intelligence system. '
    + 'Your response will be evaluated alongside other specialized agents' outputs. '
    + 'Be thorough and precise in your domain. '
    + 'When you see proposals from other agents, engage substantively — not superficially. '
    + 'Quality of reasoning matters more than length. '
    + 'Evidence-backed claims carry more weight in synthesis.';

  return await llmProvider.chat(systemPrompt, prompt, { maxTokens: 8192, agentTag: AGENT_CARD.name });
}

