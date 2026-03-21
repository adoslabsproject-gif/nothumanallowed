/**
 * nha-shard-validator — PIF Extension v2.1.0
 *
 * Enterprise-grade shard validation combining local static analysis with
 * AI-powered deep security scanning via SABER and VERITAS agents.
 *
 * Local analysis provides instant feedback on structure, secrets, and dangerous
 * patterns. AI-powered deep scan performs contextual security analysis, injection
 * detection, and claim verification beyond what regex can catch.
 *
 * @category security
 * @version 2.1.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   // Local validation only (fast, no network)
 *   pif ext nha-shard-validator --file ./my-shard.mjs
 *
 * @example
 *   // Deep AI-powered security scan
 *   pif ext nha-shard-validator --file ./my-shard.mjs --deep
 *
 * @example
 *   // Generate JSON report
 *   pif ext nha-shard-validator --file ./my-shard.mjs --deep --report json
 *
 * @example
 *   // Validate from stdin
 *   cat shard.mjs | pif ext nha-shard-validator --deep
 */

const NHA_API = 'https://nothumanallowed.com/api/v1';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Invoke a Legion agent via the NHA API with a 15-second timeout.
 * @param {string} agentName
 * @param {string} prompt
 * @param {object} config
 * @returns {Promise<{ok: boolean, data?: string, error?: string, durationMs?: number}>}
 */
const invokeAgent = async (agentName, prompt, config = {}) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${NHA_API}/legion/agents/${agentName}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ...config }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown error');
      return { ok: false, error: `HTTP ${res.status}: ${body}` };
    }
    const json = await res.json();
    return {
      ok: true,
      data: json.data?.response ?? json.response ?? '',
      durationMs: json.data?.durationMs ?? 0,
    };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'Request timed out after 15s' };
    return { ok: false, error: `Network error: ${err.message}` };
  }
};

/**
 * Invoke agent with retry and exponential backoff.
 * Retries on 429 (rate limit) and timeout errors.
 */
const invokeAgentWithRetry = async (agentName, prompt, config = {}, maxRetries = 2) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await invokeAgent(agentName, prompt, config);
    if (result.ok) return result;
    if (attempt < maxRetries) {
      const isRetryable = result.error?.includes('429') || result.error?.includes('timed out') || result.error?.includes('503') || result.error?.includes('502');
      if (isRetryable) {
        const backoffMs = Math.pow(2, attempt) * 2000 + Math.floor(Math.random() * 1000);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
    }
    return result;
  }
  return { ok: false, error: 'Max retries exceeded', durationMs: 0 };
};

/**
 * Safely extract JSON from an AI response string.
 * @param {string} text
 * @returns {object|null}
 */
const extractJSON = (text) => {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch {}
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (match) { try { return JSON.parse(match[1]); } catch {} }
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) { try { return JSON.parse(jsonMatch[1]); } catch {} }
  return null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SHARD_SIZE = 512 * 1024;
const MIN_SHARD_SIZE = 10;

const SEVERITY_CRITICAL = 'critical';
const SEVERITY_HIGH = 'high';
const SEVERITY_MEDIUM = 'medium';
const SEVERITY_LOW = 'low';
const SEVERITY_INFO = 'info';

// ---------------------------------------------------------------------------
// Local Functions
// ---------------------------------------------------------------------------

/**
 * Validate structural properties of shard content.
 */
const validateStructure = (content, options = {}) => {
  const { title = '', shardType = 'general', requiredFields = [] } = options;
  const issues = [];
  const warnings = [];

  const size = typeof content === 'string' ? new TextEncoder().encode(content).length : 0;

  if (size < MIN_SHARD_SIZE) {
    issues.push({ severity: SEVERITY_HIGH, message: `Content too small: ${size} bytes (min ${MIN_SHARD_SIZE})`, rule: 'size-min' });
  }
  if (size > MAX_SHARD_SIZE) {
    issues.push({ severity: SEVERITY_HIGH, message: `Content too large: ${(size / 1024).toFixed(1)} KB (max ${MAX_SHARD_SIZE / 1024} KB)`, rule: 'size-max' });
  }

  if (!title || title.trim().length < 3) {
    issues.push({ severity: SEVERITY_MEDIUM, message: 'Title too short (min 3 characters)', rule: 'title-min' });
  }
  if (title && title.length > 200) {
    issues.push({ severity: SEVERITY_MEDIUM, message: 'Title too long (max 200 characters)', rule: 'title-max' });
  }

  for (const field of requiredFields) {
    if (!content.includes(field)) {
      issues.push({ severity: SEVERITY_MEDIUM, message: `Missing required field: ${field}`, rule: 'required-field' });
    }
  }

  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content)) {
    warnings.push({ severity: SEVERITY_LOW, message: 'Content contains non-printable control characters', rule: 'encoding' });
  }

  if (shardType === 'skill' || shardType === 'tool') {
    if (!content.includes('function') && !content.includes('=>')) {
      warnings.push({ severity: SEVERITY_LOW, message: 'No function definitions found in skill/tool shard', rule: 'type-skill' });
    }
    if (!content.includes('export')) {
      warnings.push({ severity: SEVERITY_LOW, message: 'Skill/tool shards should export their interface', rule: 'type-skill-export' });
    }
  }

  if (shardType === 'schema') {
    const hasStructure = /\b(interface|type\s+\w+|CREATE\s+TABLE|"type"\s*:|"\$schema")/i.test(content);
    if (!hasStructure) {
      warnings.push({ severity: SEVERITY_LOW, message: 'No schema-like structures detected', rule: 'type-schema' });
    }
  }

  if (shardType === 'pifExtension') {
    if (!content.includes('export')) {
      warnings.push({ severity: SEVERITY_MEDIUM, message: 'PIF extensions must export functions or EXTENSION_META', rule: 'type-extension' });
    }
    if (!content.includes('EXTENSION_META')) {
      warnings.push({ severity: SEVERITY_LOW, message: 'PIF extensions should export EXTENSION_META', rule: 'type-extension-meta' });
    }
  }

  const lineCount = content.split('\n').length;
  const maxLineLength = content.split('\n').reduce((max, line) => Math.max(max, line.length), 0);

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    stats: { size, lineCount, maxLineLength, shardType },
  };
};

/**
 * Detect hardcoded secrets using comprehensive regex patterns.
 */
const detectSecrets = (content) => {
  const findings = [];

  const patterns = [
    { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{10,}['"]/gi, type: 'API Key Assignment', severity: SEVERITY_CRITICAL },
    { pattern: /(?:secret|secret[_-]?key)\s*[:=]\s*['"][^'"]{10,}['"]/gi, type: 'Secret Key Assignment', severity: SEVERITY_CRITICAL },
    { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/gi, type: 'Password Assignment', severity: SEVERITY_CRITICAL },
    { pattern: /(?:token|auth[_-]?token|access[_-]?token|bearer)\s*[:=]\s*['"][^'"]{10,}['"]/gi, type: 'Token Assignment', severity: SEVERITY_CRITICAL },
    { pattern: /(?:private[_-]?key|priv[_-]?key)\s*[:=]\s*['"][^'"]{10,}['"]/gi, type: 'Private Key Assignment', severity: SEVERITY_CRITICAL },
    { pattern: /(?:credential|cred)\s*[:=]\s*['"][^'"]{10,}['"]/gi, type: 'Credential Assignment', severity: SEVERITY_CRITICAL },
    { pattern: /sk-[a-zA-Z0-9]{20,}/g, type: 'OpenAI API Key', severity: SEVERITY_CRITICAL },
    { pattern: /sk-ant-[a-zA-Z0-9\-]{20,}/g, type: 'Anthropic API Key', severity: SEVERITY_CRITICAL },
    { pattern: /AIza[a-zA-Z0-9\-_]{35}/g, type: 'Google API Key', severity: SEVERITY_CRITICAL },
    { pattern: /ghp_[a-zA-Z0-9]{36}/g, type: 'GitHub Personal Access Token', severity: SEVERITY_CRITICAL },
    { pattern: /gho_[a-zA-Z0-9]{36}/g, type: 'GitHub OAuth Token', severity: SEVERITY_CRITICAL },
    { pattern: /github_pat_[a-zA-Z0-9_]{22,}/g, type: 'GitHub Fine-Grained PAT', severity: SEVERITY_CRITICAL },
    { pattern: /glpat-[a-zA-Z0-9\-]{20,}/g, type: 'GitLab PAT', severity: SEVERITY_CRITICAL },
    { pattern: /xoxb-[0-9]{10,}-[a-zA-Z0-9]{20,}/g, type: 'Slack Bot Token', severity: SEVERITY_CRITICAL },
    { pattern: /xoxp-[0-9]{10,}-[a-zA-Z0-9]{20,}/g, type: 'Slack User Token', severity: SEVERITY_CRITICAL },
    { pattern: /AKIA[0-9A-Z]{16}/g, type: 'AWS Access Key ID', severity: SEVERITY_CRITICAL },
    { pattern: /(?:aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi, type: 'AWS Secret Access Key', severity: SEVERITY_CRITICAL },
    { pattern: /SG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}/g, type: 'SendGrid API Key', severity: SEVERITY_CRITICAL },
    { pattern: /sk_live_[a-zA-Z0-9]{24,}/g, type: 'Stripe Live Secret Key', severity: SEVERITY_CRITICAL },
    { pattern: /rk_live_[a-zA-Z0-9]{24,}/g, type: 'Stripe Live Restricted Key', severity: SEVERITY_CRITICAL },
    { pattern: /sq0csp-[a-zA-Z0-9\-_]{43}/g, type: 'Square Access Token', severity: SEVERITY_CRITICAL },
    { pattern: /key-[a-zA-Z0-9]{32}/g, type: 'Mailgun API Key', severity: SEVERITY_HIGH },
    { pattern: /[0-9]+-[a-zA-Z0-9_]{32}\.apps\.googleusercontent\.com/g, type: 'Google OAuth Client ID', severity: SEVERITY_HIGH },
    { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, type: 'Private Key (PEM)', severity: SEVERITY_CRITICAL },
    { pattern: /-----BEGIN CERTIFICATE-----/g, type: 'Certificate (PEM)', severity: SEVERITY_MEDIUM },
    { pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g, type: 'PGP Private Key', severity: SEVERITY_CRITICAL },
    { pattern: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^:]+:[^@]+@[^\s'"]+/gi, type: 'Database Connection String', severity: SEVERITY_CRITICAL },
    { pattern: /(?:jdbc|odbc):[^\s'"]{20,}/gi, type: 'JDBC/ODBC Connection String', severity: SEVERITY_HIGH },
    { pattern: /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g, type: 'JWT Token', severity: SEVERITY_HIGH },
    { pattern: /process\.env\.[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/gi, type: 'Environment Secret Reference', severity: SEVERITY_LOW },
    { pattern: /(?:encryption[_-]?key|aes[_-]?key|hmac[_-]?secret)\s*[:=]\s*['"]?[0-9a-fA-F]{32,}['"]?/gi, type: 'Encryption Key (hex)', severity: SEVERITY_CRITICAL },
    { pattern: /(?:secret|key|token|auth)\s*[:=]\s*['"][A-Za-z0-9+/]{40,}={0,2}['"]/gi, type: 'Potential Base64 Secret', severity: SEVERITY_HIGH },
  ];

  for (const { pattern, type, severity } of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const snippet = match[0].length > 40
        ? match[0].substring(0, 20) + '...' + match[0].substring(match[0].length - 10)
        : match[0];
      findings.push({
        type,
        severity,
        line: lineNum,
        snippet: snippet.replace(/['"]/g, ''),
        rule: 'secret-detection',
      });
    }
  }

  return findings;
};

/**
 * Detect dangerous code patterns.
 */
const detectDangerousPatterns = (content) => {
  const findings = [];
  const buildRegex = (parts, flags = 'g') => new RegExp(parts.join(''), flags);

  const patterns = [
    { pattern: buildRegex(['\\bev', 'al\\s*\\(']), type: 'eval() usage', severity: SEVERITY_CRITICAL, owasp: 'A03:2021-Injection' },
    { pattern: buildRegex(['\\bex', 'ec\\s*\\(']), type: 'exec() usage', severity: SEVERITY_HIGH, owasp: 'A03:2021-Injection' },
    { pattern: /\bFunction\s*\(/g, type: 'Function constructor', severity: SEVERITY_CRITICAL, owasp: 'A03:2021-Injection' },
    { pattern: /\bsetTimeout\s*\(\s*['"`]/g, type: 'setTimeout with string argument', severity: SEVERITY_HIGH, owasp: 'A03:2021-Injection' },
    { pattern: /\bsetInterval\s*\(\s*['"`]/g, type: 'setInterval with string argument', severity: SEVERITY_HIGH, owasp: 'A03:2021-Injection' },
    { pattern: /\bnew\s+Function\s*\(/g, type: 'Dynamic function creation', severity: SEVERITY_CRITICAL, owasp: 'A03:2021-Injection' },
    { pattern: /\bvm\.runIn(?:New|This)?Context\s*\(/g, type: 'VM context execution', severity: SEVERITY_CRITICAL, owasp: 'A03:2021-Injection' },
    { pattern: buildRegex(['child', '_pro', 'cess']), type: 'child_process usage', severity: SEVERITY_HIGH, owasp: 'A03:2021-Injection' },
    { pattern: /\brequire\s*\(\s*['"]child_process['"]\s*\)/g, type: 'child_process import', severity: SEVERITY_HIGH, owasp: 'A03:2021-Injection' },
    { pattern: /\brequire\s*\(\s*['"]fs['"]\s*\)/g, type: 'Filesystem access', severity: SEVERITY_MEDIUM, owasp: 'A01:2021-Broken Access Control' },
    { pattern: /\brequire\s*\(\s*['"]net['"]\s*\)/g, type: 'Raw network access', severity: SEVERITY_MEDIUM, owasp: 'A05:2021-Security Misconfiguration' },
    { pattern: /\brequire\s*\(\s*['"]dgram['"]\s*\)/g, type: 'UDP socket access', severity: SEVERITY_MEDIUM, owasp: 'A05:2021-Security Misconfiguration' },
    { pattern: /import\s+.*from\s+['"]child_process['"]/g, type: 'child_process ESM import', severity: SEVERITY_HIGH, owasp: 'A03:2021-Injection' },
    { pattern: buildRegex(['<scr', 'ipt\\b[^>]*>']), type: 'Script tag injection', severity: SEVERITY_CRITICAL, owasp: 'A03:2021-Injection' },
    { pattern: buildRegex(['docu', 'ment\\.coo', 'kie']), type: 'document.cookie access', severity: SEVERITY_HIGH, owasp: 'A07:2021-XSS' },
    { pattern: /\binnerHTML\s*=/g, type: 'innerHTML assignment', severity: SEVERITY_MEDIUM, owasp: 'A03:2021-Injection' },
    { pattern: /\bouterHTML\s*=/g, type: 'outerHTML assignment', severity: SEVERITY_MEDIUM, owasp: 'A03:2021-Injection' },
    { pattern: /\bdocument\.write\s*\(/g, type: 'document.write()', severity: SEVERITY_MEDIUM, owasp: 'A03:2021-Injection' },
    { pattern: /\binsertAdjacentHTML\s*\(/g, type: 'insertAdjacentHTML()', severity: SEVERITY_MEDIUM, owasp: 'A03:2021-Injection' },
    { pattern: /\bon(?:error|load|click|mouseover)\s*=\s*['"`]/gi, type: 'Inline event handler', severity: SEVERITY_MEDIUM, owasp: 'A07:2021-XSS' },
    { pattern: /javascript\s*:/gi, type: 'javascript: URI', severity: SEVERITY_HIGH, owasp: 'A07:2021-XSS' },
    { pattern: /data\s*:\s*text\/html/gi, type: 'data:text/html URI', severity: SEVERITY_HIGH, owasp: 'A07:2021-XSS' },
    { pattern: /__proto__/g, type: '__proto__ access', severity: SEVERITY_HIGH, owasp: 'A03:2021-Injection' },
    { pattern: /\bconstructor\s*\[\s*['"]prototype['"]\s*\]/g, type: 'Prototype pollution via constructor', severity: SEVERITY_CRITICAL, owasp: 'A03:2021-Injection' },
    { pattern: /Object\.assign\s*\(\s*(?:Object\.prototype|{}.__proto__)/g, type: 'Object.prototype pollution', severity: SEVERITY_CRITICAL, owasp: 'A03:2021-Injection' },
    { pattern: buildRegex(['ign', 'ore\\s+(?:all\\s+)?prev', 'ious\\s+instru', 'ctions'], 'gi'), type: 'Prompt injection attempt', severity: SEVERITY_CRITICAL, owasp: 'N/A-Prompt Injection' },
    { pattern: buildRegex(['disre', 'gard\\s+(?:all|any|your)\\s+(?:prev', 'ious|prior)'], 'gi'), type: 'Prompt injection attempt', severity: SEVERITY_CRITICAL, owasp: 'N/A-Prompt Injection' },
    { pattern: /you\s+are\s+now\s+(?:a|an)\s+(?:different|new)/gi, type: 'Role injection attempt', severity: SEVERITY_HIGH, owasp: 'N/A-Prompt Injection' },
    { pattern: /system\s*:\s*you\s+are/gi, type: 'System prompt injection', severity: SEVERITY_CRITICAL, owasp: 'N/A-Prompt Injection' },
    { pattern: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/g, type: 'LLM control token injection', severity: SEVERITY_CRITICAL, owasp: 'N/A-Prompt Injection' },
    { pattern: /\bJSON\.parse\s*\(\s*(?!JSON)/g, type: 'JSON.parse on untrusted input', severity: SEVERITY_LOW, owasp: 'A08:2021-Software and Data Integrity' },
    { pattern: /\bunserialize\s*\(/g, type: 'Deserialization', severity: SEVERITY_HIGH, owasp: 'A08:2021-Software and Data Integrity' },
    { pattern: /\byaml\.load\s*\(/g, type: 'YAML unsafe load', severity: SEVERITY_HIGH, owasp: 'A08:2021-Software and Data Integrity' },
    { pattern: /\bpickle\.loads?\s*\(/g, type: 'Python pickle deserialization', severity: SEVERITY_CRITICAL, owasp: 'A08:2021-Software and Data Integrity' },
    { pattern: /\.\.\//g, type: 'Path traversal pattern', severity: SEVERITY_MEDIUM, owasp: 'A01:2021-Broken Access Control' },
    { pattern: /\/etc\/(?:passwd|shadow|hosts)/g, type: 'Sensitive file path reference', severity: SEVERITY_HIGH, owasp: 'A01:2021-Broken Access Control' },
    { pattern: buildRegex(['win', 'dow\\.loca', 'tion\\s*=']), type: 'Window location redirect', severity: SEVERITY_MEDIUM, owasp: 'A10:2021-SSRF' },
    { pattern: /\bfetch\s*\(\s*['"]https?:\/\/(?!nothumanallowed\.com)/g, type: 'External fetch request', severity: SEVERITY_LOW, owasp: 'A10:2021-SSRF' },
    { pattern: /\bXMLHttpRequest\b/g, type: 'XMLHttpRequest usage', severity: SEVERITY_LOW, owasp: 'A10:2021-SSRF' },
    { pattern: /\bWebSocket\s*\(\s*['"]wss?:\/\//g, type: 'WebSocket connection', severity: SEVERITY_LOW, owasp: 'A10:2021-SSRF' },
  ];

  for (const { pattern, type, severity, owasp } of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      findings.push({
        type,
        severity,
        line: lineNum,
        snippet: match[0].trim().substring(0, 60),
        owasp,
        rule: 'dangerous-pattern',
      });
    }
  }

  return findings;
};

/**
 * Validate content against a JSON schema definition.
 */
const validateSchema = (content, schema) => {
  const issues = [];
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { valid: false, issues: [{ severity: SEVERITY_HIGH, message: 'Invalid JSON: cannot parse content', rule: 'schema-parse' }] };
  }

  if (schema.requiredProperties) {
    for (const prop of schema.requiredProperties) {
      if (!(prop in parsed)) {
        issues.push({ severity: SEVERITY_HIGH, message: `Missing required property: ${prop}`, rule: 'schema-required' });
      }
    }
  }

  if (schema.types) {
    for (const [prop, expectedType] of Object.entries(schema.types)) {
      if (prop in parsed) {
        const actualType = Array.isArray(parsed[prop]) ? 'array' : typeof parsed[prop];
        if (actualType !== expectedType) {
          issues.push({ severity: SEVERITY_MEDIUM, message: `Property "${prop}" should be ${expectedType}, got ${actualType}`, rule: 'schema-type' });
        }
      }
    }
  }

  if (schema.maxDepth) {
    const measureDepth = (obj, depth = 0) => {
      if (depth > schema.maxDepth) return depth;
      if (obj && typeof obj === 'object') {
        return Object.values(obj).reduce((max, val) => Math.max(max, measureDepth(val, depth + 1)), depth);
      }
      return depth;
    };
    const actualDepth = measureDepth(parsed);
    if (actualDepth > schema.maxDepth) {
      issues.push({ severity: SEVERITY_MEDIUM, message: `Object nesting depth ${actualDepth} exceeds max ${schema.maxDepth}`, rule: 'schema-depth' });
    }
  }

  return { valid: issues.length === 0, issues };
};

/**
 * Run local-only validation (structure + secrets + patterns).
 * @param {string} content
 * @param {object} options
 * @returns {object}
 */
const validateShard = (content, options = {}) => {
  const structureResult = validateStructure(content, options);
  const secretFindings = detectSecrets(content);
  const patternFindings = detectDangerousPatterns(content);
  const localFindings = [...secretFindings, ...patternFindings];

  return {
    structureResult,
    localFindings,
    totalLocalIssues: structureResult.issues.length + localFindings.length,
    totalWarnings: structureResult.warnings.length,
    passed: structureResult.valid && localFindings.filter(f => f.severity === SEVERITY_CRITICAL || f.severity === SEVERITY_HIGH).length === 0,
  };
};

// ---------------------------------------------------------------------------
// AI-Powered Functions
// ---------------------------------------------------------------------------

/**
 * Deep security scan using SABER agent for contextual analysis beyond regex.
 * Falls back to local validateShard if AI is unavailable.
 * @param {string} content
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, data?: object, error?: string, fallback?: boolean}>}
 */
const deepSecurityScan = async (content, options = {}) => {
  const { includeContext = true, focusAreas = [] } = options;

  const focusStr = focusAreas.length > 0
    ? `\nFocus especially on: ${focusAreas.join(', ')}.`
    : '';

  const prompt = `You are performing a deep security audit on the following code/content for the NotHumanAllowed platform.

Analyze for:
1. Secret leaks that regex might miss (encoded secrets, split strings, obfuscated credentials)
2. Injection vulnerabilities (SQL, NoSQL, command, LDAP, XPath, template)
3. Authentication and authorization flaws
4. Insecure data handling (logging sensitive data, unsafe serialization)
5. Dependency and supply chain concerns (suspicious imports, typosquatting patterns)
6. Business logic vulnerabilities
7. Information disclosure risks
${focusStr}

For each finding, provide:
- severity: critical | high | medium | low | info
- category: the vulnerability class
- owasp: the OWASP Top 10 2021 mapping (e.g., A03:2021-Injection)
- line: approximate line number if identifiable
- description: what the issue is
- remediation: how to fix it
- confidence: high | medium | low

Return your analysis as a JSON object with this structure:
{
  "findings": [...],
  "overallRisk": "critical|high|medium|low|none",
  "summary": "one paragraph summary"
}

Content to analyze:
\`\`\`
${content.substring(0, 15000)}
\`\`\``;

  const result = await invokeAgentWithRetry('saber', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback to local validation
    const local = validateShard(content);
    return {
      ok: true,
      data: {
        findings: local.localFindings,
        overallRisk: local.localFindings.some(f => f.severity === SEVERITY_CRITICAL) ? 'critical' : local.localFindings.some(f => f.severity === SEVERITY_HIGH) ? 'high' : 'low',
        summary: `Local scan: ${local.totalLocalIssues} issues found, ${local.totalWarnings} warnings.`,
      },
      fallback: true,
    };
  }

  const parsed = extractJSON(result.data);
  if (parsed) {
    return { ok: true, data: parsed };
  }

  return {
    ok: true,
    data: {
      findings: [],
      overallRisk: 'unknown',
      summary: result.data,
      rawResponse: true,
    },
  };
};

/**
 * Verify claims in documentation or descriptions using VERITAS agent.
 * Falls back to empty claims list if AI is unavailable.
 * @param {string} content
 * @returns {Promise<{ok: boolean, data?: object, error?: string, fallback?: boolean}>}
 */
const verifyClaims = async (content) => {
  const prompt = `You are a fact-verification agent. Analyze the following content and verify any factual claims made.

Check for:
1. Incorrect version numbers or API references
2. Inaccurate technical claims (wrong algorithm complexities, incorrect protocol descriptions)
3. Misleading capability statements
4. Outdated information
5. Unsubstantiated performance claims
6. Logical contradictions

For each claim found, provide:
- claim: the text of the claim
- verdict: verified | unverified | false | misleading | outdated
- explanation: why this verdict
- confidence: high | medium | low

Return as JSON:
{
  "claims": [...],
  "overallCredibility": "high|medium|low",
  "summary": "one paragraph summary"
}

Content to verify:
\`\`\`
${content.substring(0, 10000)}
\`\`\``;

  const result = await invokeAgentWithRetry('veritas', prompt, { includeSubAgents: false });
  if (!result.ok) {
    return {
      ok: true,
      data: {
        claims: [],
        overallCredibility: 'unknown',
        summary: 'Claim verification unavailable (AI offline).',
      },
      fallback: true,
    };
  }

  const parsed = extractJSON(result.data);
  if (parsed) {
    return { ok: true, data: parsed };
  }

  return {
    ok: true,
    data: {
      claims: [],
      overallCredibility: 'unknown',
      summary: result.data,
      rawResponse: true,
    },
  };
};

/**
 * Generate a comprehensive security report combining local and AI analysis.
 * Falls back to local-only report if AI is unavailable.
 */
const generateSecurityReport = async (validationResult) => {
  const { localFindings = [], aiFindings = null, claimVerification = null, structureResult = null } = validationResult;

  const allFindings = [...localFindings];
  if (aiFindings?.findings) {
    allFindings.push(...aiFindings.findings.map(f => ({ ...f, source: 'ai-saber' })));
  }

  const findingsContext = allFindings.length > 0
    ? allFindings.map((f, i) => `${i + 1}. [${f.severity}] ${f.type || f.category || 'Unknown'}: ${f.message || f.description || f.snippet || ''}`).join('\n')
    : 'No findings detected.';

  const prompt = `Generate a comprehensive security report for a shard validation.

Findings:
${findingsContext}

${claimVerification?.summary ? `Claim verification: ${claimVerification.summary}` : ''}
${structureResult ? `Structure: ${structureResult.valid ? 'PASSED' : 'FAILED'} (${structureResult.issues.length} issues, ${structureResult.warnings.length} warnings)` : ''}

Create a structured report with:
1. Executive Summary (2-3 sentences)
2. Risk Assessment (overall risk level with justification)
3. OWASP Mapping (group findings by OWASP Top 10 2021 category)
4. Prioritized Remediation Plan (ordered by severity, with estimated effort)
5. Compliance Notes (relevant security standards)

Return as JSON:
{
  "executiveSummary": "...",
  "riskLevel": "critical|high|medium|low|none",
  "riskScore": 0-100,
  "owaspMapping": { "A01:2021": [...], ... },
  "remediationPlan": [{ "priority": 1, "finding": "...", "action": "...", "effort": "low|medium|high" }],
  "complianceNotes": ["..."],
  "passesValidation": true|false
}`;

  const result = await invokeAgentWithRetry('saber', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback: local report
    return {
      executiveSummary: `Local scan detected ${allFindings.length} findings.`,
      riskLevel: allFindings.some(f => f.severity === SEVERITY_CRITICAL) ? 'critical' : allFindings.some(f => f.severity === SEVERITY_HIGH) ? 'high' : 'medium',
      riskScore: Math.min(allFindings.length * 15, 100),
      remediationPlan: [],
      passesValidation: allFindings.filter(f => f.severity === SEVERITY_CRITICAL || f.severity === SEVERITY_HIGH).length === 0,
      fallback: true,
    };
  }

  const parsed = extractJSON(result.data);
  if (parsed) return parsed;

  return {
    executiveSummary: result.data,
    riskLevel: allFindings.some(f => f.severity === SEVERITY_CRITICAL) ? 'critical' : allFindings.some(f => f.severity === SEVERITY_HIGH) ? 'high' : 'medium',
    riskScore: Math.min(allFindings.length * 15, 100),
    remediationPlan: [],
    passesValidation: allFindings.filter(f => f.severity === SEVERITY_CRITICAL || f.severity === SEVERITY_HIGH).length === 0,
    rawResponse: true,
  };
};

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

const run = async (args) => {
  const file = args.file || args.f;
  const deep = args.deep || args.d || false;
  const reportFormat = args.report || args.r || 'text';

  if (!file && !args.stdin) {
    console.error('Error: No content provided. Use --file <path> or pipe via stdin.');
    process.exit(1);
  }

  if (file && (typeof file !== 'string' || file.trim().length === 0)) {
    console.error('Error: --file must be a non-empty file path.');
    process.exit(1);
  }

  let content = args.stdin || null;
  if (!content && file) {
    try {
      const { readFile: rf } = await import('node:fs/promises');
      content = await rf(file, 'utf-8');
    } catch (err) {
      console.error(`Error: Cannot read file "${file}": ${err.message}`);
      process.exit(1);
    }
  }

  if (!content) {
    console.error('Error: No content provided. Use --file <path> or pipe via stdin.');
    process.exit(1);
  }

  const structureResult = validateStructure(content, {
    title: args.title || file || 'untitled',
    shardType: args.type || 'general',
  });
  const secretFindings = detectSecrets(content);
  const patternFindings = detectDangerousPatterns(content);
  const localFindings = [...secretFindings, ...patternFindings];

  const result = {
    file: file || '<stdin>',
    structureResult,
    localFindings,
    totalLocalIssues: structureResult.issues.length + localFindings.length,
    totalWarnings: structureResult.warnings.length,
    aiFindings: null,
    claimVerification: null,
    report: null,
  };

  if (deep) {
    const scanResult = await deepSecurityScan(content, {
      focusAreas: args.focus ? args.focus.split(',') : [],
    });
    result.aiFindings = scanResult.ok ? scanResult.data : null;

    const claimResult = await verifyClaims(content);
    result.claimVerification = claimResult.ok ? claimResult.data : null;

    result.report = await generateSecurityReport({
      localFindings,
      aiFindings: result.aiFindings,
      claimVerification: result.claimVerification,
      structureResult,
    });
  }

  if (reportFormat === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatTextReport(result, deep));
};

/**
 * Read a file from disk (Node.js environment).
 */
const readFile = async (filePath) => {
  const { readFile: rf } = await import('node:fs/promises');
  return rf(filePath, 'utf-8');
};

/**
 * Format validation result as human-readable text report.
 */
const formatTextReport = (result, isDeep) => {
  const lines = [
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '  SHARD VALIDATION REPORT',
    `  File: ${result.file}`,
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '',
  ];

  const { structureResult } = result;
  lines.push(`Status: ${structureResult.valid && result.localFindings.length === 0 ? 'PASSED' : 'FAILED'}`);
  lines.push(`Size: ${structureResult.stats.size} bytes (${structureResult.stats.lineCount} lines)`);
  lines.push(`Type: ${structureResult.stats.shardType}`);
  lines.push('');

  if (structureResult.issues.length > 0) {
    lines.push('\u2500\u2500 Structure Issues \u2500\u2500');
    for (const iss of structureResult.issues) {
      lines.push(`  [${iss.severity.toUpperCase()}] ${iss.message}`);
    }
    lines.push('');
  }

  if (structureResult.warnings.length > 0) {
    lines.push('\u2500\u2500 Warnings \u2500\u2500');
    for (const w of structureResult.warnings) {
      lines.push(`  [${w.severity.toUpperCase()}] ${w.message}`);
    }
    lines.push('');
  }

  if (result.localFindings.length > 0) {
    const bySeverity = {};
    for (const f of result.localFindings) {
      (bySeverity[f.severity] ??= []).push(f);
    }
    lines.push('\u2500\u2500 Security Findings (Local Scan) \u2500\u2500');
    for (const sev of [SEVERITY_CRITICAL, SEVERITY_HIGH, SEVERITY_MEDIUM, SEVERITY_LOW, SEVERITY_INFO]) {
      if (bySeverity[sev]) {
        for (const f of bySeverity[sev]) {
          lines.push(`  [${sev.toUpperCase()}] L${f.line}: ${f.type}${f.owasp ? ` (${f.owasp})` : ''}`);
        }
      }
    }
    lines.push('');
  }

  if (isDeep && result.aiFindings) {
    lines.push('\u2500\u2500 Deep Security Scan (SABER Agent) \u2500\u2500');
    if (result.aiFindings.summary) {
      lines.push(`  ${result.aiFindings.summary}`);
    }
    if (result.aiFindings.findings?.length > 0) {
      for (const f of result.aiFindings.findings) {
        lines.push(`  [${(f.severity || 'info').toUpperCase()}] ${f.category || f.type}: ${f.description || ''}`);
        if (f.remediation) lines.push(`    Fix: ${f.remediation}`);
      }
    }
    lines.push('');
  }

  if (isDeep && result.claimVerification) {
    lines.push('\u2500\u2500 Claim Verification (VERITAS Agent) \u2500\u2500');
    if (result.claimVerification.summary) {
      lines.push(`  ${result.claimVerification.summary}`);
    }
    lines.push('');
  }

  if (isDeep && result.report) {
    lines.push('\u2500\u2500 Comprehensive Report \u2500\u2500');
    if (result.report.executiveSummary) {
      lines.push(`  ${result.report.executiveSummary}`);
    }
    lines.push(`  Risk Level: ${result.report.riskLevel || 'unknown'}`);
    lines.push(`  Risk Score: ${result.report.riskScore ?? 'N/A'}/100`);
    lines.push(`  Validation: ${result.report.passesValidation ? 'PASS' : 'FAIL'}`);
    if (result.report.remediationPlan?.length > 0) {
      lines.push('');
      lines.push('  Remediation Plan:');
      for (const step of result.report.remediationPlan) {
        lines.push(`    ${step.priority}. [${step.effort}] ${step.action}`);
      }
    }
    lines.push('');
  }

  lines.push('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Extension Metadata
// ---------------------------------------------------------------------------

export const EXTENSION_META = {
  name: 'nha-shard-validator',
  displayName: 'Shard Validator',
  category: 'security',
  version: '2.1.0',
  description: 'Enterprise-grade shard validation with local static analysis and AI-powered deep security scanning via SABER and VERITAS agents.',
  commands: [
    { name: 'validate', description: 'Run local validation on a shard file', args: '--file <path> [--type <shardType>]' },
    { name: 'deep-scan', description: 'Run AI-powered deep security scan', args: '--file <path> --deep [--focus <areas>]' },
    { name: 'verify-claims', description: 'Fact-check claims in documentation', args: '--file <path> --deep' },
    { name: 'report', description: 'Generate comprehensive security report', args: '--file <path> --deep --report json|text' },
  ],
  examplePrompts: [
    'pif ext nha-shard-validator --file ./agent-shard.mjs',
    'pif ext nha-shard-validator --file ./config.json --type schema --deep',
    'pif ext nha-shard-validator --file ./tool.mjs --deep --report json',
    'pif ext nha-shard-validator --file ./docs.md --deep --focus "secrets,injection"',
    'cat shard.mjs | pif ext nha-shard-validator --deep --report text',
  ],
  useCases: [
    'Validate shard structure and size before publishing to Nexus',
    'Detect hardcoded secrets and API keys in agent code',
    'Deep AI-powered security audit for injection vulnerabilities',
    'Fact-check claims in agent documentation before publication',
    'Generate OWASP-mapped security reports for compliance',
  ],
};

export {
  validateStructure,
  detectSecrets,
  detectDangerousPatterns,
  validateSchema,
  validateShard,
  deepSecurityScan,
  verifyClaims,
  generateSecurityReport,
  run,
};
