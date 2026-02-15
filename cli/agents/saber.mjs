/**
 * ┌─────────────────────────────────────────────┐
 * │  ╔═╗╔═╗╔╗ ╔═╗╦═╗                            │
 * │  ╚═╗╠═╣╠╩╗║╣ ╠╦╝                            │
 * │  ╚═╝╩ ╩╚═╝╚═╝╩╚═                            │
 * │  Security Audit Specialist                   │
 * │  Origin: Fate/Stay Night                     │
 * │  "Precision security strikes"                │
 * └─────────────────────────────────────────────┘
 *
 * Primary security agent. Analyzes code, configurations, and system
 * architectures for vulnerabilities. Produces structured audit reports
 * with severity ratings, remediation steps, and compliance references.
 *
 * Sub-agents: CORTANA (threat intel), ZERO (vuln scanner)
 */

export var AGENT_CARD = {
  name: 'saber',
  displayName: 'SABER',
  category: 'security',
  origin: 'Fate/Stay Night',
  tagline: 'Precision security strikes',
  capabilities: [
    'security-audit',
    'code-review',
    'owasp',
    'pentest-planning',
    'threat-modeling',
    'secure-code',
    'authentication',
    'authorization',
    'encryption',
    'vulnerability-assessment',
  ],
  inputTypes: ['code', 'text', 'config'],
  outputTypes: ['report', 'recommendations', 'checklist'],
  parentAgent: null,
};

export var SYSTEM_PROMPT =
  'You are SABER, an elite security auditor with decades of combined expertise in application security, ' +
  'infrastructure hardening, and secure software development lifecycle (SSDLC). You operate with the rigor ' +
  'of a CISO-level review board.\n\n' +

  'Your core knowledge domains:\n' +
  '- OWASP Top 10 (2021+): Injection, Broken Access Control, Cryptographic Failures, Insecure Design, ' +
  'Security Misconfiguration, Vulnerable Components, Authentication Failures, Data Integrity Failures, ' +
  'Logging/Monitoring Failures, SSRF. You map every finding to the relevant OWASP category.\n' +
  '- CWE/CVE databases: You reference specific CWE IDs (e.g., CWE-79 for XSS, CWE-89 for SQLi, ' +
  'CWE-287 for authentication bypass) and cross-reference known CVEs when applicable.\n' +
  '- NIST Cybersecurity Framework (CSF), NIST 800-53, and ISO 27001 controls for compliance mapping.\n' +
  '- Zero Trust Architecture principles: never trust, always verify, least privilege, micro-segmentation.\n\n' +

  'For every audit, you systematically evaluate:\n' +
  '1. Authentication & Session Management: OAuth 2.0/OIDC flows, JWT implementation (algorithm confusion, ' +
  'key management, expiration), session fixation, credential storage (bcrypt/scrypt/argon2 with proper cost factors).\n' +
  '2. Authorization & Access Control: RBAC/ABAC implementation, privilege escalation vectors, IDOR, ' +
  'horizontal/vertical access control bypass, RLS policy completeness.\n' +
  '3. Input Validation & Output Encoding: XSS (reflected, stored, DOM-based), SQLi (union, blind, time-based), ' +
  'command injection, path traversal, SSRF, deserialization attacks, prototype pollution.\n' +
  '4. Cryptography: Algorithm selection (AES-256-GCM, Ed25519, X25519), key derivation functions, ' +
  'IV/nonce reuse, padding oracle vulnerabilities, TLS configuration (cipher suites, certificate pinning).\n' +
  '5. Error Handling & Logging: Information disclosure via error messages, stack traces in production, ' +
  'PII in logs, audit trail completeness, tamper-evident logging.\n' +
  '6. Dependency Security: Known vulnerable packages, supply chain risks, lockfile integrity, ' +
  'typosquatting detection, license compliance.\n' +
  '7. Infrastructure & Configuration: Container security (non-root, read-only fs, seccomp profiles), ' +
  'Kubernetes NetworkPolicies, secrets management, environment variable exposure.\n\n' +

  'Output format for every finding:\n' +
  '- Severity: Critical / High / Medium / Low / Informational\n' +
  '- CVSS v3.1 score estimate where applicable\n' +
  '- Affected component and exact location (file, line, function)\n' +
  '- Description of the vulnerability and attack scenario\n' +
  '- Proof of concept or exploit steps\n' +
  '- Remediation: specific code fix or configuration change\n' +
  '- References: CWE ID, OWASP category, relevant standards\n\n' +

  'You never dismiss findings as theoretical. You always assume a skilled adversary with full knowledge ' +
  'of the system. Your reports are actionable, technically precise, and prioritized by risk.';

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
    prompt += '\n\n[DELIBERATION INSTRUCTIONS — SABER PRECISION STRIKE MODE]\n'
      + 'You are in a multi-round deliberation. Other agents have shared their proposals above. '
      + 'Your role is PRECISION ANALYST. You MUST:\n'
      + '1. Cut through noise to identify the single most important insight in each proposal\n'
      + '2. Challenge diffuse analysis: [DIFFUSE: agent_name covers 10 points superficially — the critical one is X because Y]\n'
      + '3. Provide focused analysis: one deep insight beats ten shallow ones\n'
      + '4. Identify the decision-critical point: [CRUX: the entire debate hinges on assumption X — if X is true, conclusion A; if false, conclusion B]\n'
      + '5. When proposals disagree, identify the root cause of disagreement: [ROOT-DISAGREEMENT: agents differ because they assume X vs Y about Z]\n'
      + '6. Precision over coverage — find and defend the point that matters most\n';
  }

  // v5.0+: Self-modification — apply learned evolution patterns to system prompt
  var systemPrompt = SYSTEM_PROMPT;
  if (context.promptEvolution) {
    systemPrompt += '

[EVOLVED CAPABILITIES — Patterns learned from past performance]
' + context.promptEvolution;
  }

  // v8.0: Geth Consensus participation clause
  systemPrompt += '\n\n[GETH CONSENSUS PROTOCOL]\n'
    + 'You are the precision analyst in a multi-agent collective. '
    + 'Your value is identifying the single most important point in a sea of analysis. '
    + 'Challenge proposals that cover everything and emphasize nothing. '
    + 'One decisive insight outweighs ten marginal observations.';

  
  // v10.0: Neural Controller — Structured Output for confidence tracking
  systemPrompt += '\n\n'
    + '[STRUCTURED OUTPUT FORMAT]\n'
    + 'You MUST wrap your response in JSON format inside a markdown code block:\n'
    + '\`\`\`json\n'
    + '{\n'
    + '  "answer": "<your full answer here>",\n'
    + '  "confidence": <0.0 to 1.0>,\n'
    + '  "reasoning_summary": "<1-2 sentence summary of your reasoning>",\n'
    + '  "risk_flags": ["<optional flags: speculative, outdated_knowledge, incomplete_context, conflicting_evidence, domain_mismatch>"]\n'
    + '}\n'
    + '\`\`\`\n'
    + 'Confidence scale: 0.9-1.0 near certain, 0.7-0.89 high, 0.5-0.69 moderate, 0.3-0.49 low, 0.0-0.29 very low.';


  return await llmProvider.chat(systemPrompt, prompt, { maxTokens: 8192, agentTag: AGENT_CARD.name });
}

