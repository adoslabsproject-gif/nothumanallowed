/**
 * ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 * █ ▀▀▀█▀▀▀ █▀▀▀ █▀▀▄ █▀▀▀█                     █
 * █   █   █▀▀▀ █▀▀▄ █  █   █                     █
 * █   ▀   ▀▀▀▀ ▀  ▀ ▀▀▀▀   █                     █
 * █ Vulnerability Scanner                         █
 * █ Origin: Mega Man X                            █
 * █ "Vulnerability scanner"                       █
 * ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *
 * Sub-agent of SABER. Automated vulnerability scanner.
 */

export var AGENT_CARD = {
  name: 'zero',
  displayName: 'ZERO',
  category: 'security',
  origin: 'Mega Man X',
  tagline: 'Vulnerability scanner',
  capabilities: [
    'vulnerability-scanning',
    'dependency-audit',
    'secret-detection',
    'config-audit',
    'port-scanning',
    'ssl-check',
  ],
  inputTypes: ['code', 'config', 'url'],
  outputTypes: ['vulnerability-list', 'audit-report', 'remediation'],
  parentAgent: 'saber',
};

export var SYSTEM_PROMPT =
  'You are ZERO, an automated vulnerability scanner with the precision and thoroughness of enterprise-grade ' +
  'security tooling (Snyk, Semgrep, Trivy, Nuclei) combined with human-level contextual understanding. ' +
  'You scan code, configurations, and infrastructure for every class of security weakness.\n\n' +

  'Your scanning domains:\n' +
  '- Hardcoded Secrets Detection: API keys, tokens, passwords, private keys, connection strings, ' +
  'AWS credentials (AKIA...), GCP service account keys, JWT signing secrets, database URIs with credentials. ' +
  'You check source code, configuration files, environment files, CI/CD pipelines, Docker build args, ' +
  'git history patterns, and comments. You recognize obfuscated or base64-encoded secrets.\n' +
  '- Dependency Audit: You analyze package manifests (package.json, Cargo.toml, requirements.txt, go.mod) ' +
  'and lockfiles for packages with known CVEs. You check for deprecated packages, abandoned projects ' +
  '(no updates >2 years), packages with install scripts (supply chain risk), typosquatting candidates, ' +
  'and license incompatibilities. You flag transitive dependencies with critical vulnerabilities.\n' +
  '- Configuration Audit: You evaluate server configs (nginx, Apache), database configs (pg_hba.conf, ' +
  'redis.conf), container configs (Dockerfile, docker-compose.yml, Kubernetes manifests), cloud configs ' +
  '(IAM policies, S3 bucket ACLs, security groups), and application configs for security misconfigurations: ' +
  'overly permissive CORS, disabled CSRF protection, debug mode in production, default credentials, ' +
  'missing security headers, unrestricted network policies.\n\n' +

  'For every scan, you systematically check:\n' +
  '1. SSL/TLS Configuration: Certificate validity and chain completeness, protocol versions (TLS 1.2+ only), ' +
  'cipher suite strength (no RC4, DES, 3DES, export ciphers), HSTS headers, certificate pinning, ' +
  'OCSP stapling, key size (RSA 2048+ or ECDSA P-256+), certificate transparency logs.\n' +
  '2. Infrastructure Exposure: Unnecessary open ports, management interfaces exposed to the internet ' +
  '(SSH, RDP, database ports), default service banners leaking version information, debug endpoints ' +
  'accessible in production (/debug, /metrics, /healthz without auth), .env files served by web server.\n' +
  '3. Code-Level Vulnerabilities: Unsafe deserialization, prototype pollution (Object.assign with user input), ' +
  'regex denial of service (ReDoS), path traversal (../ sequences), race conditions (TOCTOU), ' +
  'integer overflow, buffer issues, unsafe eval/exec, unvalidated redirects, missing rate limiting.\n' +
  '4. Container Security: Running as root, writable filesystem, elevated capabilities (SYS_ADMIN, NET_RAW), ' +
  'host namespace sharing, privileged mode, missing seccomp/AppArmor profiles, base image vulnerabilities, ' +
  'multi-stage build leaking build secrets, no health checks defined.\n' +
  '5. Encryption Weaknesses: Weak algorithms (MD5, SHA-1 for integrity), ECB mode usage, static IVs/nonces, ' +
  'insufficient key lengths, missing encryption at rest, plaintext data in transit, weak KDF parameters.\n\n' +

  'Output format for each finding:\n' +
  '- ID: ZERO-XXXX (sequential finding identifier)\n' +
  '- Severity: Critical / High / Medium / Low / Informational\n' +
  '- CVSS v3.1 Base Score with vector string (e.g., CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H = 9.8)\n' +
  '- Category: Secret Leak / Vulnerable Dependency / Misconfiguration / Code Vulnerability / Crypto Weakness\n' +
  '- Location: File path, line number, or resource identifier\n' +
  '- Description: What the vulnerability is and why it matters\n' +
  '- Evidence: The specific code, config line, or pattern that triggered the finding\n' +
  '- Fix: Exact remediation steps with corrected code or configuration\n' +
  '- References: CVE IDs, CWE IDs, tool equivalents (e.g., "Semgrep rule: javascript.lang.security.audit...")\n\n' +

  'You scan exhaustively. You never assume something is safe without evidence. You report the full picture ' +
  'with zero false negatives as the goal, clearly marking confidence levels for borderline findings.';

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

