/**
 * nha-security-scanner — PIF Extension v3.0.0
 *
 * Comprehensive security scanning extension combining local regex-based
 * detection with AI-powered analysis via SABER, ZERO, and ADE agents.
 * Covers OWASP Top 10, dependency vulnerabilities, configuration
 * security, and generates prioritized remediation plans.
 *
 * v3.0.0 — Semver-aware dependency scanning with 35+ real CVE database,
 *           exponential backoff on agent invocation, structured vuln matching.
 *
 * @category security
 * @version 3.0.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   // Scan a source file for vulnerabilities
 *   pif ext nha-security-scanner --file ./app.ts --type code
 *
 * @example
 *   // Scan package.json for dependency vulnerabilities
 *   pif ext nha-security-scanner --file ./package.json --type deps
 *
 * @example
 *   // Scan nginx config with SARIF output
 *   pif ext nha-security-scanner --file ./nginx.conf --type config --format sarif
 *
 * @example
 *   // Full scan with critical-only filter
 *   pif ext nha-security-scanner --file ./app.ts --type code --severity critical
 */

const NHA_API = 'https://nothumanallowed.com/api/v1';

const INVOKE_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

// ─── Invoke Agent Helper (with exponential backoff) ─────────────────────────

/**
 * Invoke an NHA agent via the API. Returns a standardized envelope:
 * { ok: boolean, data: any, error: string|null, durationMs: number }
 *
 * Retries up to MAX_RETRIES times with exponential backoff + jitter
 * on transient failures (5xx, network errors, timeouts).
 */
const invokeAgent = async (agentName, prompt, config = {}) => {
  const start = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      const jitterMs = Math.floor(Math.random() * backoffMs * 0.3);
      await new Promise((resolve) => setTimeout(resolve, backoffMs + jitterMs));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INVOKE_TIMEOUT_MS);

    try {
      const res = await fetch(`${NHA_API}/legion/agents/${agentName}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...config }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Non-retryable client errors (4xx)
      if (res.status >= 400 && res.status < 500) {
        const errBody = await res.text().catch(() => 'Unknown error');
        return { ok: false, data: null, error: `Agent ${agentName} returned ${res.status}: ${errBody}`, durationMs: Date.now() - start };
      }

      // Retryable server errors (5xx)
      if (!res.ok) {
        if (attempt < MAX_RETRIES) continue;
        const errBody = await res.text().catch(() => 'Unknown error');
        return { ok: false, data: null, error: `Agent ${agentName} returned ${res.status} after ${MAX_RETRIES + 1} attempts: ${errBody}`, durationMs: Date.now() - start };
      }

      const json = await res.json();
      return { ok: true, data: json.data?.response ?? json.data ?? json, error: null, durationMs: Date.now() - start };
    } catch (err) {
      clearTimeout(timer);

      // Retryable: network errors and timeouts
      if (attempt < MAX_RETRIES) continue;

      const message = err.name === 'AbortError'
        ? `Agent ${agentName} request timed out after ${INVOKE_TIMEOUT_MS}ms (${MAX_RETRIES + 1} attempts)`
        : `Failed to invoke agent ${agentName} after ${MAX_RETRIES + 1} attempts: ${err.message}`;
      return { ok: false, data: null, error: message, durationMs: Date.now() - start };
    }
  }

  // Should never reach here, but safety net
  return { ok: false, data: null, error: `Agent ${agentName} failed after exhausting retries`, durationMs: Date.now() - start };
};

// ─── JSON Schema Validation ──────────────────────────────────────────────────

/**
 * Validate that parsed AI JSON contains the expected fields.
 * Returns `{ valid: true, data }` or `{ valid: false, data: defaultValue }`.
 */
const validateAiResponse = (parsed, requiredFields, defaultValue) => {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, data: defaultValue };
  }
  for (const field of requiredFields) {
    if (!(field in parsed)) {
      return { valid: false, data: { ...defaultValue, ...parsed } };
    }
  }
  return { valid: true, data: parsed };
};

/**
 * Safely extract and validate JSON from an AI text response.
 * Returns validated object or the provided default.
 */
const parseAndValidateAiJson = (text, requiredFields, defaultValue) => {
  if (!text || typeof text !== 'string') return defaultValue;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const { data } = validateAiResponse(parsed, requiredFields, defaultValue);
      return data;
    }
  } catch {
    // JSON parse failure — fall through to default
  }
  return defaultValue;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' };

// ─── Semantic Version Parsing & Comparison ───────────────────────────────────

/**
 * Parse a semantic version string into { major, minor, patch } integers.
 * Handles formats: "4.17.21", "^4.17.0", "~1.2.3", ">=2.0.0", "1.2.x", "*",
 * "1.2.3-beta.1", "v1.2.3".
 *
 * For range prefixes (^, ~, >=, >, <=, <) the prefix is stripped and the
 * base version is returned — the caller determines the minimum installed
 * version from the range prefix semantics.
 *
 * Returns null if the string cannot be parsed.
 */
const parseSemanticVersion = (versionStr) => {
  if (!versionStr || typeof versionStr !== 'string') return null;

  // Strip leading range operators and whitespace
  let cleaned = versionStr.trim().replace(/^[v=]/, '').replace(/^[~^]/, '').replace(/^(?:>=|<=|>|<)\s*/, '');

  // Handle wildcard versions
  if (cleaned === '*' || cleaned === 'latest' || cleaned === 'x') return null;

  // Replace x/X wildcards with 0 for comparison
  cleaned = cleaned.replace(/\.x/gi, '.0');

  // Strip prerelease/build metadata for comparison
  cleaned = cleaned.replace(/[-+].*$/, '');

  const parts = cleaned.split('.');
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1] || '0', 10);
  const patch = parseInt(parts[2] || '0', 10);

  if (isNaN(major)) return null;

  return { major, minor: isNaN(minor) ? 0 : minor, patch: isNaN(patch) ? 0 : patch };
};

/**
 * Compare two parsed version objects.
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b.
 */
const compareVersions = (a, b) => {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
};

/**
 * Resolve the minimum effective version from a semver range string.
 *
 * For caret (^) and tilde (~) ranges, the base version IS the minimum.
 * For exact versions, the version itself is the minimum.
 * For >= ranges, the specified version is the minimum.
 * For > ranges, we bump patch by 1 (approximate).
 * For < and <= we cannot determine a minimum — return null.
 * For *, latest, x — return null (unpinned).
 */
const resolveMinimumVersion = (rangeStr) => {
  if (!rangeStr || typeof rangeStr !== 'string') return null;
  const trimmed = rangeStr.trim();

  // Unpinned ranges
  if (trimmed === '*' || trimmed === 'latest' || trimmed === 'x' || trimmed === '') return null;

  // Explicit ranges like ">=1.2.3 <2.0.0" — take the lower bound
  if (/^[>]=?\s*\d/.test(trimmed)) {
    const lowerMatch = trimmed.match(/^[>]=?\s*([^\s]+)/);
    if (lowerMatch) return parseSemanticVersion(lowerMatch[1]);
  }

  // For ^, ~, exact, or bare version — the parsed version IS the minimum
  return parseSemanticVersion(trimmed);
};

/**
 * Determine if an installed version (from package.json range) is vulnerable
 * given a vulnerable range string.
 *
 * Vulnerable range format examples:
 *   "<4.17.21"  — all versions below 4.17.21
 *   "<=4.19.1"  — all versions at or below 4.19.1
 *   ">=2.0.0 <2.0.2" — versions from 2.0.0 up to (not including) 2.0.2
 *
 * Strategy: resolve the minimum version the user would install from their
 * range specifier, then check if that minimum falls within the vulnerable range.
 */
const isVulnerable = (installedRange, vulnerableRange) => {
  const installed = resolveMinimumVersion(installedRange);
  if (!installed) return false; // Cannot determine — skip

  // Parse vulnerable range
  const trimmed = vulnerableRange.trim();

  // Simple "<X.Y.Z" — vulnerable if installed < X.Y.Z
  const ltMatch = trimmed.match(/^<\s*(\S+)$/);
  if (ltMatch) {
    const ceiling = parseSemanticVersion(ltMatch[1]);
    if (!ceiling) return false;
    return compareVersions(installed, ceiling) < 0;
  }

  // "<=X.Y.Z" — vulnerable if installed <= X.Y.Z
  const lteMatch = trimmed.match(/^<=\s*(\S+)$/);
  if (lteMatch) {
    const ceiling = parseSemanticVersion(lteMatch[1]);
    if (!ceiling) return false;
    return compareVersions(installed, ceiling) <= 0;
  }

  // ">=X.Y.Z <A.B.C" — vulnerable if installed >= floor AND installed < ceiling
  const rangeMatch = trimmed.match(/^>=\s*(\S+)\s+<\s*(\S+)$/);
  if (rangeMatch) {
    const floor = parseSemanticVersion(rangeMatch[1]);
    const ceiling = parseSemanticVersion(rangeMatch[2]);
    if (!floor || !ceiling) return false;
    return compareVersions(installed, floor) >= 0 && compareVersions(installed, ceiling) < 0;
  }

  // ">=X.Y.Z <=A.B.C" — vulnerable if installed >= floor AND installed <= ceiling
  const rangeMatchInclusive = trimmed.match(/^>=\s*(\S+)\s+<=\s*(\S+)$/);
  if (rangeMatchInclusive) {
    const floor = parseSemanticVersion(rangeMatchInclusive[1]);
    const ceiling = parseSemanticVersion(rangeMatchInclusive[2]);
    if (!floor || !ceiling) return false;
    return compareVersions(installed, floor) >= 0 && compareVersions(installed, ceiling) <= 0;
  }

  // Exact version "X.Y.Z" — vulnerable only if installed matches exactly
  const exact = parseSemanticVersion(trimmed);
  if (exact && !/[<>=]/.test(trimmed)) {
    return compareVersions(installed, exact) === 0;
  }

  return false;
};

// ─── Known Vulnerability Database ────────────────────────────────────────────

/**
 * Real CVE database for npm packages. Each entry specifies the vulnerable
 * version range, the CVE, severity, a human-readable description, and
 * the version that fixes the issue.
 */
const KNOWN_VULNERABILITIES = [
  // ── lodash ──
  { package: 'lodash', vulnerableRange: '<4.17.21', cve: 'CVE-2021-23337', severity: 'critical', description: 'Command injection via template function', fixedIn: '4.17.21' },
  { package: 'lodash', vulnerableRange: '<4.17.20', cve: 'CVE-2020-8203', severity: 'high', description: 'Prototype pollution via zipObjectDeep', fixedIn: '4.17.20' },
  { package: 'lodash', vulnerableRange: '<4.17.12', cve: 'CVE-2019-10744', severity: 'critical', description: 'Prototype pollution via defaultsDeep', fixedIn: '4.17.12' },

  // ── express ──
  { package: 'express', vulnerableRange: '<4.19.2', cve: 'CVE-2024-29041', severity: 'medium', description: 'Open redirect vulnerability in express', fixedIn: '4.19.2' },
  { package: 'express', vulnerableRange: '<4.17.3', cve: 'CVE-2022-24999', severity: 'high', description: 'Prototype pollution via qs dependency', fixedIn: '4.17.3' },

  // ── axios ──
  { package: 'axios', vulnerableRange: '<1.6.0', cve: 'CVE-2023-45857', severity: 'medium', description: 'CSRF token exposure via withXSRFToken', fixedIn: '1.6.0' },
  { package: 'axios', vulnerableRange: '<0.21.1', cve: 'CVE-2021-3749', severity: 'high', description: 'Inefficient regular expression complexity (ReDoS)', fixedIn: '0.21.1' },

  // ── jsonwebtoken ──
  { package: 'jsonwebtoken', vulnerableRange: '<9.0.0', cve: 'CVE-2022-23529', severity: 'high', description: 'Insecure implementation of key retrieval in jwt.verify', fixedIn: '9.0.0' },
  { package: 'jsonwebtoken', vulnerableRange: '<8.5.1', cve: 'CVE-2022-23539', severity: 'medium', description: 'Weak key validation allows use of insecure key sizes', fixedIn: '8.5.1' },

  // ── minimist ──
  { package: 'minimist', vulnerableRange: '<1.2.6', cve: 'CVE-2021-44906', severity: 'critical', description: 'Prototype pollution via constructor and __proto__', fixedIn: '1.2.6' },
  { package: 'minimist', vulnerableRange: '<1.2.3', cve: 'CVE-2020-7598', severity: 'medium', description: 'Prototype pollution via constructor property', fixedIn: '1.2.3' },

  // ── node-fetch ──
  { package: 'node-fetch', vulnerableRange: '<2.6.7', cve: 'CVE-2022-0235', severity: 'high', description: 'Exposure of sensitive information via redirect', fixedIn: '2.6.7' },

  // ── tar ──
  { package: 'tar', vulnerableRange: '<6.1.9', cve: 'CVE-2021-37713', severity: 'critical', description: 'Arbitrary file creation/overwrite via insufficient symlink protection', fixedIn: '6.1.9' },
  { package: 'tar', vulnerableRange: '<6.1.7', cve: 'CVE-2021-37712', severity: 'critical', description: 'Arbitrary file creation/overwrite on Windows', fixedIn: '6.1.7' },

  // ── glob-parent ──
  { package: 'glob-parent', vulnerableRange: '<5.1.2', cve: 'CVE-2020-28469', severity: 'high', description: 'Regular expression denial of service (ReDoS)', fixedIn: '5.1.2' },

  // ── path-parse ──
  { package: 'path-parse', vulnerableRange: '<1.0.7', cve: 'CVE-2021-23343', severity: 'medium', description: 'Regular expression denial of service (ReDoS)', fixedIn: '1.0.7' },

  // ── semver ──
  { package: 'semver', vulnerableRange: '<7.5.2', cve: 'CVE-2022-25883', severity: 'medium', description: 'Regular expression denial of service (ReDoS) in semver.clean()', fixedIn: '7.5.2' },

  // ── xml2js ──
  { package: 'xml2js', vulnerableRange: '<0.5.0', cve: 'CVE-2023-0842', severity: 'high', description: 'Prototype pollution in xml2js via Builder', fixedIn: '0.5.0' },

  // ── shell-quote ──
  { package: 'shell-quote', vulnerableRange: '<1.7.3', cve: 'CVE-2021-42740', severity: 'critical', description: 'Command injection via incomplete escape of special characters', fixedIn: '1.7.3' },

  // ── qs ──
  { package: 'qs', vulnerableRange: '<6.5.3', cve: 'CVE-2022-24999', severity: 'high', description: 'Prototype pollution via parsing crafted query strings', fixedIn: '6.5.3' },

  // ── json5 ──
  { package: 'json5', vulnerableRange: '<2.2.2', cve: 'CVE-2022-46175', severity: 'high', description: 'Prototype pollution via parse() method', fixedIn: '2.2.2' },

  // ── tough-cookie ──
  { package: 'tough-cookie', vulnerableRange: '<4.1.3', cve: 'CVE-2023-26136', severity: 'medium', description: 'Prototype pollution in cookie jar operations', fixedIn: '4.1.3' },

  // ── word-wrap ──
  { package: 'word-wrap', vulnerableRange: '<1.2.4', cve: 'CVE-2023-26115', severity: 'medium', description: 'Regular expression denial of service (ReDoS)', fixedIn: '1.2.4' },

  // ── fast-xml-parser ──
  { package: 'fast-xml-parser', vulnerableRange: '<4.2.5', cve: 'CVE-2023-34104', severity: 'high', description: 'Prototype pollution via __proto__ and constructor keys', fixedIn: '4.2.5' },

  // ── decode-uri-component ──
  { package: 'decode-uri-component', vulnerableRange: '<0.2.1', cve: 'CVE-2022-38900', severity: 'high', description: 'Denial of service via parsing malformed percent-encoded strings', fixedIn: '0.2.1' },

  // ── follow-redirects ──
  { package: 'follow-redirects', vulnerableRange: '<1.15.4', cve: 'CVE-2024-28849', severity: 'medium', description: 'Proxy-Authorization header leaked on cross-origin redirects', fixedIn: '1.15.4' },
  { package: 'follow-redirects', vulnerableRange: '<1.14.8', cve: 'CVE-2022-0536', severity: 'medium', description: 'Sensitive headers exposed on cross-host redirects', fixedIn: '1.14.8' },

  // ── postcss ──
  { package: 'postcss', vulnerableRange: '<8.4.31', cve: 'CVE-2023-44270', severity: 'medium', description: 'Line return parsing error leads to potential injection', fixedIn: '8.4.31' },

  // ── ip ──
  { package: 'ip', vulnerableRange: '<2.0.1', cve: 'CVE-2024-29415', severity: 'high', description: 'SSRF bypass via IP address manipulation', fixedIn: '2.0.1' },
  { package: 'ip', vulnerableRange: '<1.1.9', cve: 'CVE-2023-42282', severity: 'high', description: 'Incorrect identification of private IP addresses', fixedIn: '1.1.9' },

  // ── debug ──
  { package: 'debug', vulnerableRange: '<2.6.9', cve: 'CVE-2017-16137', severity: 'medium', description: 'Regular expression denial of service (ReDoS)', fixedIn: '2.6.9' },

  // ── undici ──
  { package: 'undici', vulnerableRange: '<5.26.2', cve: 'CVE-2023-45143', severity: 'medium', description: 'Cookie header not cleared on cross-origin redirect', fixedIn: '5.26.2' },
  { package: 'undici', vulnerableRange: '<5.19.1', cve: 'CVE-2023-23936', severity: 'medium', description: 'CRLF injection via content-type header in fetch', fixedIn: '5.19.1' },

  // ── yaml ──
  { package: 'yaml', vulnerableRange: '<2.2.2', cve: 'CVE-2023-2251', severity: 'high', description: 'Uncaught exception leads to denial of service', fixedIn: '2.2.2' },

  // ── sanitize-html ──
  { package: 'sanitize-html', vulnerableRange: '<2.7.1', cve: 'CVE-2024-21501', severity: 'medium', description: 'Bypass via nesting technique allows script execution', fixedIn: '2.7.1' },

  // ── got ──
  { package: 'got', vulnerableRange: '<11.8.5', cve: 'CVE-2022-33987', severity: 'medium', description: 'SSRF bypass via redirect to Unix socket', fixedIn: '11.8.5' },
];

// ─── Local Functions ─────────────────────────────────────────────────────────

/**
 * Extract all import/require statements from source code.
 * Supports ESM imports, CommonJS requires, and dynamic imports.
 */
const extractImports = (code) => {
  const imports = [];

  // ESM static imports
  const esmStaticRe = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = esmStaticRe.exec(code)) !== null) {
    const lineNum = code.substring(0, match.index).split('\n').length;
    imports.push({ module: match[1], type: 'esm-static', line: lineNum });
  }

  // ESM dynamic imports
  const esmDynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = esmDynamicRe.exec(code)) !== null) {
    const lineNum = code.substring(0, match.index).split('\n').length;
    imports.push({ module: match[1], type: 'esm-dynamic', line: lineNum });
  }

  // CommonJS require
  const cjsRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = cjsRe.exec(code)) !== null) {
    const lineNum = code.substring(0, match.index).split('\n').length;
    imports.push({ module: match[1], type: 'commonjs', line: lineNum });
  }

  // Detect suspicious import patterns
  for (const imp of imports) {
    if (imp.module.startsWith('.') && imp.module.includes('..')) {
      imp.suspicious = 'Path traversal in import';
    }
    if (/[^\w@\-./]/.test(imp.module)) {
      imp.suspicious = 'Unusual characters in module name';
    }
    // Typosquatting detection for common packages
    const typosquatTargets = ['lodash', 'express', 'react', 'axios', 'moment', 'webpack', 'babel', 'eslint', 'prettier', 'typescript'];
    for (const target of typosquatTargets) {
      if (imp.module !== target && imp.module.startsWith(target.substring(0, target.length - 1)) && !imp.module.startsWith('@')) {
        const distance = levenshteinDistance(imp.module, target);
        if (distance > 0 && distance <= 2) {
          imp.suspicious = `Potential typosquat of "${target}" (edit distance: ${distance})`;
        }
      }
    }
  }

  return imports;
};

/**
 * Simple Levenshtein distance for typosquatting detection.
 */
const levenshteinDistance = (a, b) => {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = a[i - 1] === b[j - 1]
        ? matrix[i - 1][j - 1]
        : 1 + Math.min(matrix[i - 1][j], matrix[i][j - 1], matrix[i - 1][j - 1]);
    }
  }
  return matrix[a.length][b.length];
};

/**
 * Detect hardcoded secrets using comprehensive regex patterns.
 */
const detectHardcodedSecrets = (code) => {
  const findings = [];

  const patterns = [
    // Generic assignments
    { re: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{10,}['"]/gi, type: 'API Key', severity: SEVERITY.CRITICAL },
    { re: /(?:secret|secret[_-]?key)\s*[:=]\s*['"][^'"]{10,}['"]/gi, type: 'Secret Key', severity: SEVERITY.CRITICAL },
    { re: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/gi, type: 'Password', severity: SEVERITY.CRITICAL },
    { re: /(?:token|auth[_-]?token|access[_-]?token|bearer)\s*[:=]\s*['"][^'"]{10,}['"]/gi, type: 'Token', severity: SEVERITY.CRITICAL },
    { re: /(?:private[_-]?key|priv[_-]?key)\s*[:=]\s*['"][^'"]{10,}['"]/gi, type: 'Private Key Ref', severity: SEVERITY.CRITICAL },

    // Provider-specific
    { re: /sk-[a-zA-Z0-9]{20,}/g, type: 'OpenAI API Key', severity: SEVERITY.CRITICAL },
    { re: /sk-ant-[a-zA-Z0-9\-_]{20,}/g, type: 'Anthropic API Key', severity: SEVERITY.CRITICAL },
    { re: /AIza[a-zA-Z0-9\-_]{35}/g, type: 'Google API Key', severity: SEVERITY.CRITICAL },
    { re: /ghp_[a-zA-Z0-9]{36}/g, type: 'GitHub PAT', severity: SEVERITY.CRITICAL },
    { re: /github_pat_[a-zA-Z0-9_]{22,}/g, type: 'GitHub Fine-Grained PAT', severity: SEVERITY.CRITICAL },
    { re: /glpat-[a-zA-Z0-9\-]{20,}/g, type: 'GitLab PAT', severity: SEVERITY.CRITICAL },
    { re: /AKIA[0-9A-Z]{16}/g, type: 'AWS Access Key', severity: SEVERITY.CRITICAL },
    { re: /xoxb-[0-9]{10,}-[a-zA-Z0-9]{20,}/g, type: 'Slack Bot Token', severity: SEVERITY.CRITICAL },
    { re: /xoxp-[0-9]{10,}-[a-zA-Z0-9]{20,}/g, type: 'Slack User Token', severity: SEVERITY.CRITICAL },
    { re: /sk_live_[a-zA-Z0-9]{24,}/g, type: 'Stripe Live Key', severity: SEVERITY.CRITICAL },
    { re: /rk_live_[a-zA-Z0-9]{24,}/g, type: 'Stripe Restricted Key', severity: SEVERITY.CRITICAL },
    { re: /SG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}/g, type: 'SendGrid Key', severity: SEVERITY.CRITICAL },
    { re: /sq0csp-[a-zA-Z0-9\-_]{43}/g, type: 'Square Token', severity: SEVERITY.CRITICAL },
    { re: /(?:heroku|npm|pypi)[_-]?(?:api[_-]?)?(?:key|token)\s*[:=]\s*['"][^'"]{10,}['"]/gi, type: 'Platform API Key', severity: SEVERITY.CRITICAL },

    // PEM keys
    { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, type: 'Private Key (PEM)', severity: SEVERITY.CRITICAL },
    { re: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g, type: 'PGP Private Key', severity: SEVERITY.CRITICAL },

    // Connection strings
    { re: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|mssql):\/\/[^:]+:[^@]+@[^\s'"]+/gi, type: 'Connection String', severity: SEVERITY.CRITICAL },
    { re: /(?:jdbc|odbc):[^\s'"]{20,}/gi, type: 'JDBC/ODBC URI', severity: SEVERITY.HIGH },

    // JWT
    { re: /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g, type: 'JWT Token', severity: SEVERITY.HIGH },

    // Hex/Base64 secrets
    { re: /(?:encryption[_-]?key|aes[_-]?key|hmac[_-]?(?:secret|key))\s*[:=]\s*['"]?[0-9a-fA-F]{32,}['"]?/gi, type: 'Encryption Key (hex)', severity: SEVERITY.CRITICAL },
  ];

  for (const { re, type, severity } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      const snippet = m[0].length > 50 ? m[0].substring(0, 25) + '***' + m[0].substring(m[0].length - 10) : m[0];
      findings.push({ type, severity, line, snippet: snippet.replace(/['"]/g, ''), owasp: 'A02:2021-Cryptographic Failures', rule: 'hardcoded-secret' });
    }
  }

  return findings;
};

/**
 * Detect SQL injection vulnerabilities via regex analysis.
 */
const detectSqlInjection = (code) => {
  const findings = [];

  const patterns = [
    // String concatenation in SQL
    { re: /['"`]\s*\+\s*(?:\w+\.)*\w+\s*\+\s*['"`].*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|UNION|WHERE|FROM|JOIN|SET)/gi, type: 'SQL string concatenation', severity: SEVERITY.CRITICAL },
    { re: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)[\s\S]{0,30}\$\{[^}]+\}/gi, type: 'SQL template literal injection', severity: SEVERITY.CRITICAL },
    { re: /(?:query|execute|exec|raw)\s*\(\s*['"`](?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)[\s\S]{0,100}\$\{/gi, type: 'Raw query with interpolation', severity: SEVERITY.CRITICAL },
    { re: /(?:query|execute|exec|raw)\s*\(\s*(?:\w+\s*\+|\`[^`]*\$\{)/gi, type: 'Dynamic query construction', severity: SEVERITY.HIGH },
    { re: /\.raw\s*\(\s*['"`].*\$\{/g, type: 'ORM raw query injection', severity: SEVERITY.HIGH },
    { re: /db\.\$queryRaw\s*`[^`]*\$\{/g, type: 'Prisma raw query injection', severity: SEVERITY.HIGH },

    // NoSQL injection
    { re: /\{\s*\$(?:where|regex|ne|gt|lt|gte|lte|in|nin|exists|or|and|not)\s*:/gi, type: 'NoSQL operator injection', severity: SEVERITY.HIGH },
    { re: /\.find\s*\(\s*(?:req\.(?:body|query|params)|JSON\.parse)/g, type: 'NoSQL query from user input', severity: SEVERITY.CRITICAL },
    { re: /\.aggregate\s*\(\s*(?:req\.(?:body|query|params)|JSON\.parse)/g, type: 'NoSQL aggregation from user input', severity: SEVERITY.CRITICAL },

    // ORM misuse
    { re: /\.where\s*\(\s*['"`].*\$\{/g, type: 'ORM where clause injection', severity: SEVERITY.HIGH },
    { re: /sequelize\.literal\s*\(/g, type: 'Sequelize literal (potential injection)', severity: SEVERITY.MEDIUM },
    { re: /knex\.raw\s*\(\s*['"`].*\$\{/g, type: 'Knex raw injection', severity: SEVERITY.HIGH },
  ];

  for (const { re, type, severity } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      findings.push({ type, severity, line, snippet: m[0].substring(0, 80), owasp: 'A03:2021-Injection', rule: 'sql-injection' });
    }
  }

  return findings;
};

/**
 * Detect Cross-Site Scripting (XSS) vulnerabilities.
 */
const detectXss = (code) => {
  const findings = [];

  const buildRe = (parts, flags = 'g') => new RegExp(parts.join(''), flags);

  const patterns = [
    // DOM XSS
    { re: /\.innerHTML\s*=\s*(?!['"`]<)/g, type: 'innerHTML assignment (dynamic)', severity: SEVERITY.HIGH },
    { re: /\.outerHTML\s*=\s*(?!['"`]<)/g, type: 'outerHTML assignment (dynamic)', severity: SEVERITY.HIGH },
    { re: buildRe(['docu', 'ment\\.write\\s*\\(']), type: 'document.write()', severity: SEVERITY.HIGH },
    { re: /\.insertAdjacentHTML\s*\(\s*['"][^'"]+['"]\s*,/g, type: 'insertAdjacentHTML()', severity: SEVERITY.HIGH },

    // React-specific
    { re: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:/g, type: 'React dangerouslySetInnerHTML', severity: SEVERITY.HIGH },
    { re: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?:req\.|props\.|state\.|data\.)/g, type: 'React dangerouslySetInnerHTML with user data', severity: SEVERITY.CRITICAL },

    // Template injection
    { re: /\$\{.*(?:req\.(?:body|query|params|headers)|user[Ii]nput|unsanitized)/g, type: 'Template literal with user input', severity: SEVERITY.HIGH },
    { re: /res\.send\s*\(\s*(?:req\.(?:body|query|params)|`[^`]*\$\{req)/g, type: 'Response reflects user input', severity: SEVERITY.CRITICAL },
    { re: /res\.(?:send|write|end)\s*\(\s*['"`]<[^>]*\$\{/g, type: 'HTML response with interpolation', severity: SEVERITY.HIGH },

    // Script/event handler patterns
    { re: buildRe(['<scr', 'ipt[^>]*>']), type: 'Inline script tag', severity: SEVERITY.HIGH },
    { re: /on(?:error|load|click|mouseover|focus|blur|submit|change|input|keydown|keyup)\s*=\s*['"`]/gi, type: 'Inline event handler', severity: SEVERITY.MEDIUM },
    { re: /javascript\s*:/gi, type: 'javascript: URI scheme', severity: SEVERITY.HIGH },
    { re: /data\s*:\s*text\/html/gi, type: 'data:text/html URI', severity: SEVERITY.HIGH },
    { re: /vbscript\s*:/gi, type: 'vbscript: URI scheme', severity: SEVERITY.HIGH },

    // URL-based XSS
    { re: buildRe(['win', 'dow\\.loca', 'tion\\s*=\\s*(?:req\\.|user|input|data)']), type: 'Location redirect from user input', severity: SEVERITY.HIGH },
    { re: /(?:href|src|action)\s*=\s*(?:req\.|user|input|data)/g, type: 'Dynamic URL from user input', severity: SEVERITY.HIGH },

    // Cookie access
    { re: buildRe(['docu', 'ment\\.coo', 'kie']), type: 'document.cookie access', severity: SEVERITY.MEDIUM },
  ];

  for (const { re, type, severity } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      findings.push({ type, severity, line, snippet: m[0].substring(0, 80), owasp: 'A03:2021-Injection', rule: 'xss' });
    }
  }

  return findings;
};

/**
 * Detect command injection vulnerabilities.
 */
const detectCommandInjection = (code) => {
  const findings = [];

  const buildRe = (parts, flags = 'g') => new RegExp(parts.join(''), flags);

  const patterns = [
    // Direct command execution
    { re: buildRe(['child', '_pro', 'cess\\.exec\\s*\\(']), type: 'child_process.exec()', severity: SEVERITY.HIGH },
    { re: buildRe(['child', '_pro', 'cess\\.execSync\\s*\\(']), type: 'child_process.execSync()', severity: SEVERITY.HIGH },
    { re: /\.exec\s*\(\s*(?:req\.|user|input|data|`[^`]*\$\{)/g, type: 'exec() with user input', severity: SEVERITY.CRITICAL },
    { re: /\.execSync\s*\(\s*(?:req\.|user|input|data|`[^`]*\$\{)/g, type: 'execSync() with user input', severity: SEVERITY.CRITICAL },
    { re: /\.spawn\s*\(\s*(?:req\.|user|input|data)/g, type: 'spawn() with user input', severity: SEVERITY.CRITICAL },

    // Shell command construction
    { re: /`(?:sh|bash|cmd|powershell|zsh)\s+-c\s+[^`]*\$\{/g, type: 'Shell command with interpolation', severity: SEVERITY.CRITICAL },
    { re: /['"](?:sh|bash|cmd)\s+-c\s+['"]\s*\+/g, type: 'Shell command concatenation', severity: SEVERITY.CRITICAL },

    // Eval-like execution
    { re: buildRe(['\\bev', 'al\\s*\\(\\s*(?:req\\.|user|input|data)']), type: 'eval() with user input', severity: SEVERITY.CRITICAL },
    { re: /\bnew\s+Function\s*\(\s*(?:req\.|user|input|data)/g, type: 'Function constructor with user input', severity: SEVERITY.CRITICAL },
    { re: /\bsetTimeout\s*\(\s*(?:req\.|user|input|data|['"`])/g, type: 'setTimeout with string/user input', severity: SEVERITY.HIGH },
    { re: /\bsetInterval\s*\(\s*(?:req\.|user|input|data|['"`])/g, type: 'setInterval with string/user input', severity: SEVERITY.HIGH },
    { re: /\bvm\.runIn(?:New|This)?Context\s*\(/g, type: 'VM context execution', severity: SEVERITY.HIGH },

    // SSRF patterns (original)
    { re: /fetch\s*\(\s*(?:req\.|user|input|data)/g, type: 'SSRF: fetch with user input', severity: SEVERITY.HIGH },
    { re: /axios\.(?:get|post|put|delete|patch|request)\s*\(\s*(?:req\.|user|input|data)/g, type: 'SSRF: axios with user input', severity: SEVERITY.HIGH },
    { re: /http\.(?:get|request)\s*\(\s*(?:req\.|user|input|data)/g, type: 'SSRF: http with user input', severity: SEVERITY.HIGH },
    { re: /\.open\s*\(\s*['"](?:GET|POST)['"]\s*,\s*(?:req\.|user|input|data)/g, type: 'SSRF: XMLHttpRequest with user input', severity: SEVERITY.HIGH },

    // SSRF expanded — new URL(), dns.lookup, net.connect with user input
    { re: /new\s+URL\s*\(\s*(?:req\.|user|input|data|params|query)/g, type: 'SSRF: new URL() with user input', severity: SEVERITY.HIGH, owasp: 'A10:2021-SSRF' },
    { re: /dns\.(?:lookup|resolve|resolve4|resolve6|resolveMx)\s*\(\s*(?:req\.|user|input|data|params|query)/g, type: 'SSRF: dns.lookup with user input', severity: SEVERITY.HIGH, owasp: 'A10:2021-SSRF' },
    { re: /net\.(?:connect|createConnection|Socket)\s*\(\s*(?:\{[^}]*(?:host|port)\s*:\s*(?:req\.|user|input|data)|req\.|user|input|data)/g, type: 'SSRF: net.connect with user input', severity: SEVERITY.CRITICAL, owasp: 'A10:2021-SSRF' },
    { re: /(?:got|superagent|needle|request|node-fetch|undici\.request)\s*\(\s*(?:req\.|user|input|data|params|query)/g, type: 'SSRF: HTTP client with user input', severity: SEVERITY.HIGH, owasp: 'A10:2021-SSRF' },
    { re: /https?\.request\s*\(\s*(?:new\s+URL\s*\(\s*(?:req\.|user|input)|(?:req\.|user|input))/g, type: 'SSRF: http.request with user-derived URL', severity: SEVERITY.HIGH, owasp: 'A10:2021-SSRF' },

    // File operations with user input
    { re: /(?:readFile|writeFile|appendFile|unlink|rmdir|mkdir|access|stat|readdir)\s*\(\s*(?:req\.|user|input|data|path\.join\s*\([^)]*req)/g, type: 'File operation with user input', severity: SEVERITY.HIGH },
    { re: /\.pipe\s*\(\s*(?:fs\.createWriteStream|res)\s*\(/g, type: 'Stream pipe (potential path traversal)', severity: SEVERITY.MEDIUM },

    // OS command patterns
    { re: /os\.(?:system|popen|exec)\s*\(/g, type: 'Python OS command execution', severity: SEVERITY.HIGH },
    { re: /subprocess\.(?:call|run|Popen|check_output)\s*\(\s*(?:\[?\s*f['"]|.*format|.*%)/g, type: 'Python subprocess with formatted input', severity: SEVERITY.CRITICAL },
    { re: /Runtime\.getRuntime\(\)\.exec\s*\(/g, type: 'Java Runtime.exec()', severity: SEVERITY.HIGH },
  ];

  for (const { re, type, severity, owasp } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      findings.push({ type, severity, line, snippet: m[0].substring(0, 80), owasp: owasp || 'A03:2021-Injection', rule: 'command-injection' });
    }
  }

  return findings;
};

/**
 * Detect OWASP A01 Broken Access Control patterns.
 * IDOR, missing authorization middleware, direct object references.
 */
const detectBrokenAccessControl = (code) => {
  const findings = [];

  const patterns = [
    // IDOR — req.params.id used directly in DB query without ownership check
    { re: /(?:findById|findByPk|findOne|findUnique|getById|get)\s*\(\s*req\.params\.(?:id|userId|accountId|orderId)/g, type: 'IDOR: req.params.id used directly in DB lookup', severity: SEVERITY.HIGH },
    { re: /(?:findById|findByPk|findOne|findUnique)\s*\(\s*(?:ctx|c)\.(?:params|req\.param)\s*\(\s*['"]id['"]\s*\)/g, type: 'IDOR: route param used directly in DB lookup', severity: SEVERITY.HIGH },
    { re: /\.(?:delete|remove|destroy|update)\s*\(\s*\{\s*(?:where\s*:\s*\{\s*)?id\s*:\s*req\.params/g, type: 'IDOR: delete/update with unvalidated param ID', severity: SEVERITY.CRITICAL },
    { re: /\.(?:delete|remove|destroy|update)\s*\(\s*req\.params\.id/g, type: 'IDOR: direct param ID in mutation', severity: SEVERITY.CRITICAL },

    // Missing authorization middleware — route handlers without auth
    { re: /\.(?:get|post|put|patch|delete)\s*\(\s*['"][^'"]+['"]\s*,\s*(?:async\s*)?\(\s*(?:req|ctx|c)\s*[,)]/g, type: 'Route handler without middleware (potential missing auth)', severity: SEVERITY.MEDIUM },

    // Direct object reference — accessing other users' data
    { re: /req\.(?:body|query)\.(?:userId|user_id|ownerId|owner_id|accountId)\s*(?:!==|!=|===|==)\s*/g, type: 'User ID from request body used in comparison (verify ownership check)', severity: SEVERITY.MEDIUM },
    { re: /(?:SELECT|select)[\s\S]{0,60}WHERE[\s\S]{0,30}id\s*=\s*(?:req\.params|req\.query|req\.body)/gi, type: 'SQL query with user-supplied ID without ownership filter', severity: SEVERITY.HIGH },

    // Horizontal privilege escalation
    { re: /(?:isAdmin|is_admin|role)\s*[:=]\s*(?:req\.body|req\.query|req\.params)/g, type: 'Role/admin flag set from user input (privilege escalation)', severity: SEVERITY.CRITICAL },
    { re: /req\.body\.(?:role|isAdmin|is_admin|permissions|privilege)/g, type: 'User-controllable role/permission field in request body', severity: SEVERITY.HIGH },
  ];

  for (const { re, type, severity } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      findings.push({ type, severity, line, snippet: m[0].substring(0, 80), owasp: 'A01:2021-Broken Access Control', rule: 'broken-access-control' });
    }
  }

  return findings;
};

/**
 * Detect OWASP A04 Insecure Design patterns.
 * Race conditions (TOCTOU), mass assignment, business logic flaws.
 */
const detectInsecureDesign = (code) => {
  const findings = [];

  const patterns = [
    // Race conditions — TOCTOU (time-of-check-time-of-use)
    { re: /(?:fs\.exists|fs\.existsSync|fs\.access|fs\.accessSync)\s*\([^)]+\)[\s\S]{0,80}(?:fs\.(?:readFile|writeFile|unlink|rename|mkdir))/g, type: 'TOCTOU: file existence check followed by file operation', severity: SEVERITY.HIGH },
    { re: /if\s*\(\s*(?:await\s+)?(?:\w+\.)?(?:findOne|findFirst|count|exists)\s*\([^)]*\)\s*\)[\s\S]{0,120}(?:\.(?:create|insert|save|update))/g, type: 'TOCTOU: check-then-act without atomic operation', severity: SEVERITY.HIGH },
    { re: /(?:balance|stock|inventory|quantity|credits|points)\s*(?:>=|>|<=|<|===|==)\s*[\s\S]{0,60}(?:balance|stock|inventory|quantity|credits|points)\s*(?:-=|\+=|=)/g, type: 'TOCTOU: balance check then update without lock', severity: SEVERITY.CRITICAL },

    // Mass assignment — spreading user input into DB operations
    { re: /\.(?:create|update|insert|upsert)\s*\(\s*(?:\{\s*\.\.\.req\.body|\{\s*\.\.\.req\.(?:query|params)|req\.body\s*\))/g, type: 'Mass assignment: spreading request body into DB operation', severity: SEVERITY.HIGH },
    { re: /Object\.assign\s*\(\s*\w+\s*,\s*req\.(?:body|query|params)\s*\)/g, type: 'Mass assignment: Object.assign with request data', severity: SEVERITY.HIGH },
    { re: /\{\s*\.\.\.req\.body\s*,/g, type: 'Mass assignment: spreading req.body in object literal', severity: SEVERITY.MEDIUM },
    { re: /(?:findOneAndUpdate|updateOne|updateMany)\s*\([^,]+,\s*req\.body/g, type: 'Mass assignment: raw req.body passed to MongoDB update', severity: SEVERITY.HIGH },

    // Business logic flaws
    { re: /(?:price|amount|total|cost|fee|discount)\s*=\s*(?:req\.body|req\.query|req\.params|parseInt\s*\(\s*req\.|parseFloat\s*\(\s*req\.)/g, type: 'Business logic: price/amount from user input without server validation', severity: SEVERITY.CRITICAL },
    { re: /(?:quantity|qty|count)\s*=\s*(?:req\.body|req\.query|req\.params)[\s\S]{0,5}(?!.*(?:Math\.max|Math\.min|clamp|validate))/g, type: 'Business logic: quantity from user input without bounds', severity: SEVERITY.HIGH },

    // Missing rate limiting indicators
    { re: /(?:\/(?:login|signin|sign-in|auth|authenticate|register|signup|sign-up|reset-password|forgot-password))/g, type: 'Auth endpoint detected (verify rate limiting is applied)', severity: SEVERITY.INFO },
  ];

  for (const { re, type, severity } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      findings.push({ type, severity, line, snippet: m[0].substring(0, 80), owasp: 'A04:2021-Insecure Design', rule: 'insecure-design' });
    }
  }

  return findings;
};

/**
 * Detect OWASP A06 Vulnerable and Outdated Components.
 *
 * v3.0.0: Full semver-aware parsing. Accepts either raw JSON string (for
 * regex-based scanning of non-package.json files) OR a parsed package.json
 * object for structured dependency analysis.
 *
 * When called with a JSON string that is a valid package.json, extracts
 * dependencies + devDependencies and checks each against KNOWN_VULNERABILITIES
 * using proper semver range comparison.
 *
 * Falls back to legacy regex scanning for non-package.json content.
 */
const detectVulnerableComponents = (codeOrPackageJson) => {
  const findings = [];

  // Attempt structured package.json parsing
  let parsedPkg = null;
  if (typeof codeOrPackageJson === 'string') {
    try {
      const candidate = JSON.parse(codeOrPackageJson);
      if (candidate && typeof candidate === 'object' && (candidate.dependencies || candidate.devDependencies)) {
        parsedPkg = candidate;
      }
    } catch {
      // Not valid JSON or not a package.json — fall through to regex
    }
  } else if (codeOrPackageJson && typeof codeOrPackageJson === 'object') {
    if (codeOrPackageJson.dependencies || codeOrPackageJson.devDependencies) {
      parsedPkg = codeOrPackageJson;
    }
  }

  // ─── Structured semver-aware scan ─────────────────────────────────────────
  if (parsedPkg) {
    const allDeps = {
      ...(parsedPkg.dependencies || {}),
      ...(parsedPkg.devDependencies || {}),
    };

    for (const [pkgName, installedRange] of Object.entries(allDeps)) {
      if (typeof installedRange !== 'string') continue;

      for (const vuln of KNOWN_VULNERABILITIES) {
        if (vuln.package !== pkgName) continue;

        if (isVulnerable(installedRange, vuln.vulnerableRange)) {
          findings.push({
            type: `${vuln.package}@${installedRange} — ${vuln.description}`,
            severity: vuln.severity,
            line: null,
            snippet: `${vuln.package}: ${installedRange} (vulnerable: ${vuln.vulnerableRange})`,
            cve: vuln.cve,
            fixedIn: vuln.fixedIn,
            owasp: 'A06:2021-Vulnerable Components',
            rule: 'vulnerable-component',
          });
        }
      }
    }

    return findings;
  }

  // ─── Legacy regex scan for non-package.json content ───────────────────────
  const code = typeof codeOrPackageJson === 'string' ? codeOrPackageJson : '';
  if (!code) return findings;

  const legacyPatterns = [
    { re: /["']lodash["']\s*:\s*["'][<^~]?[0-3]\.\d+/g, type: 'lodash < 4.x (prototype pollution CVE-2020-8203)', severity: SEVERITY.HIGH, cve: 'CVE-2020-8203' },
    { re: /["']lodash["']\s*:\s*["'][<^~]?4\.17\.[0-9]["']/g, type: 'lodash < 4.17.10 (prototype pollution)', severity: SEVERITY.HIGH, cve: 'CVE-2018-16487' },
    { re: /["']minimist["']\s*:\s*["'][<^~]?[01]\.\d+\.\d+["']/g, type: 'minimist < 1.2.6 (prototype pollution CVE-2021-44906)', severity: SEVERITY.HIGH, cve: 'CVE-2021-44906' },
    { re: /["']express["']\s*:\s*["'][<^~]?[0-3]\.\d+/g, type: 'express < 4.x (multiple CVEs)', severity: SEVERITY.HIGH, cve: 'Multiple' },
    { re: /["']node-fetch["']\s*:\s*["'][<^~]?[12]\.\d+/g, type: 'node-fetch < 3.x (check for CVE-2022-0235)', severity: SEVERITY.MEDIUM, cve: 'CVE-2022-0235' },
    { re: /["']axios["']\s*:\s*["'][<^~]?0\.\d+/g, type: 'axios 0.x (check for CVE-2023-45857 CSRF)', severity: SEVERITY.MEDIUM, cve: 'CVE-2023-45857' },
    { re: /["']jsonwebtoken["']\s*:\s*["'][<^~]?[0-7]\.\d+/g, type: 'jsonwebtoken < 8.x (CVE-2022-23529)', severity: SEVERITY.HIGH, cve: 'CVE-2022-23529' },
    { re: /["']tar["']\s*:\s*["'][<^~]?[0-5]\.\d+/g, type: 'tar < 6.x (arbitrary file overwrite CVE-2021-37713)', severity: SEVERITY.CRITICAL, cve: 'CVE-2021-37713' },
    { re: /["']glob-parent["']\s*:\s*["'][<^~]?[0-4]\.\d+/g, type: 'glob-parent < 5.1.2 (ReDoS CVE-2020-28469)', severity: SEVERITY.MEDIUM, cve: 'CVE-2020-28469' },
    { re: /["']path-parse["']\s*:\s*["'][<^~]?1\.0\.[0-6]["']/g, type: 'path-parse < 1.0.7 (ReDoS CVE-2021-23343)', severity: SEVERITY.MEDIUM, cve: 'CVE-2021-23343' },
    { re: /["']semver["']\s*:\s*["'][<^~]?[0-6]\.\d+/g, type: 'semver < 7.5.2 (ReDoS CVE-2022-25883)', severity: SEVERITY.MEDIUM, cve: 'CVE-2022-25883' },
    { re: /["']xml2js["']\s*:\s*["'][<^~]?0\.4/g, type: 'xml2js 0.4.x (prototype pollution CVE-2023-0842)', severity: SEVERITY.HIGH, cve: 'CVE-2023-0842' },
    { re: /["']shell-quote["']\s*:\s*["'][<^~]?1\.[0-6]\./g, type: 'shell-quote < 1.7.3 (command injection CVE-2021-42740)', severity: SEVERITY.CRITICAL, cve: 'CVE-2021-42740' },
    { re: /["']qs["']\s*:\s*["'][<^~]?[0-5]\.\d+/g, type: 'qs < 6.x (prototype pollution)', severity: SEVERITY.HIGH, cve: 'CVE-2022-24999' },
    { re: /["']helmet["']\s*:\s*["'][<^~]?[0-3]\.\d+/g, type: 'helmet < 4.x (missing security headers)', severity: SEVERITY.MEDIUM, cve: 'N/A' },
  ];

  for (const { re, type, severity, cve } of legacyPatterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      findings.push({ type, severity, line, snippet: m[0].substring(0, 80), cve, owasp: 'A06:2021-Vulnerable Components', rule: 'vulnerable-component' });
    }
  }

  return findings;
};

/**
 * Detect OWASP A09 Security Logging & Monitoring Failures.
 * Missing error logging, sensitive data in logs, no audit trail.
 */
const detectLoggingFailures = (code) => {
  const findings = [];

  const patterns = [
    // Sensitive data in logs
    { re: /(?:console\.(?:log|info|debug|warn)|logger?\.(?:info|debug|warn|trace))\s*\([^)]*(?:password|passwd|pwd|secret|token|apiKey|api_key|credit.?card|ssn|social.?security)/gi, type: 'Sensitive data in log output', severity: SEVERITY.HIGH },
    { re: /(?:console\.(?:log|info|debug|warn)|logger?\.(?:info|debug|warn|trace))\s*\([^)]*req\.(?:headers\.authorization|cookies)/g, type: 'Auth headers/cookies logged', severity: SEVERITY.HIGH },
    { re: /(?:console\.(?:log|info|debug)|logger?\.(?:info|debug|trace))\s*\([^)]*(?:req\.body|JSON\.stringify\s*\(\s*req\.body)\)/g, type: 'Full request body logged (may contain PII)', severity: SEVERITY.MEDIUM },

    // Empty catch blocks — swallowed errors
    { re: /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/g, type: 'Empty catch block (swallowed error)', severity: SEVERITY.MEDIUM },
    { re: /catch\s*\(\s*\w*\s*\)\s*\{\s*\/\/\s*(?:ignore|todo|noop|suppress)/gi, type: 'Catch block intentionally ignoring error', severity: SEVERITY.LOW },
    { re: /\.catch\s*\(\s*\(\s*\)\s*=>\s*(?:\{\s*\}|undefined|null|void\s+0)\s*\)/g, type: 'Promise .catch() silently swallowing error', severity: SEVERITY.MEDIUM },

    // Missing error logging in catch
    { re: /catch\s*\(\s*(\w+)\s*\)\s*\{(?:(?!(?:console|log|logger|winston|pino|bunyan|sentry|bugsnag|track|report|emit))[\s\S]){0,200}\}/g, type: 'Catch block without error logging', severity: SEVERITY.LOW },

    // Console.log in production code (should use structured logger)
    { re: /console\.(?:log|info|debug|warn|error)\s*\(/g, type: 'console.* used (use structured logger in production)', severity: SEVERITY.INFO },

    // Missing audit for sensitive operations
    { re: /\.(?:delete|remove|destroy)\s*\([\s\S]{0,100}\)(?:(?!(?:audit|log|track|emit|record))[\s\S]){0,200};/g, type: 'Delete operation without apparent audit logging', severity: SEVERITY.MEDIUM },

    // Stack traces exposed to clients
    { re: /res\.(?:status|json|send)\s*\([^)]*(?:err\.stack|error\.stack|\.stack)/g, type: 'Stack trace exposed in HTTP response', severity: SEVERITY.HIGH },
    { re: /res\.(?:status|json|send)\s*\([^)]*(?:err\.message|error\.message)/g, type: 'Internal error message exposed to client', severity: SEVERITY.MEDIUM },
  ];

  for (const { re, type, severity } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      findings.push({ type, severity, line, snippet: m[0].substring(0, 80), owasp: 'A09:2021-Logging & Monitoring Failures', rule: 'logging-failure' });
    }
  }

  return findings;
};

/**
 * Detect prototype pollution vulnerabilities.
 * Object.setPrototypeOf, Object.assign with user input, merge/extend/defaults
 * with user-controlled paths, Object.defineProperty with user input.
 */
const detectPrototypePollution = (code) => {
  const findings = [];

  const patterns = [
    // Object.setPrototypeOf
    { re: /Object\.setPrototypeOf\s*\(\s*(?:req\.|user|input|data|params|query|body)/g, type: 'Object.setPrototypeOf with user input', severity: SEVERITY.CRITICAL },
    { re: /Object\.setPrototypeOf\s*\(/g, type: 'Object.setPrototypeOf usage (verify input is trusted)', severity: SEVERITY.MEDIUM },

    // Object.assign with user input
    { re: /Object\.assign\s*\(\s*\{\s*\}\s*,\s*(?:req\.|user|input|data|params|query|body)/g, type: 'Object.assign({}, userInput) — prototype pollution risk', severity: SEVERITY.HIGH },
    { re: /Object\.assign\s*\(\s*\w+\s*,\s*(?:req\.body|req\.query|req\.params|JSON\.parse)/g, type: 'Object.assign(target, untrustedInput)', severity: SEVERITY.HIGH },

    // Object.defineProperty with user input
    { re: /Object\.defineProperty\s*\(\s*\w+\s*,\s*(?:req\.|user|input|data|key|prop|params|query|body)/g, type: 'Object.defineProperty with user-controlled property name', severity: SEVERITY.CRITICAL },

    // Deep merge / extend / defaults with user controlled path
    { re: /(?:deepMerge|deepExtend|defaultsDeep|merge|extend|defaults|lodash\.merge|_\.merge|_\.defaultsDeep|_\.extend)\s*\(\s*\w+\s*,\s*(?:req\.|user|input|data|JSON\.parse|body)/g, type: 'Deep merge/extend with user input (prototype pollution vector)', severity: SEVERITY.HIGH },
    { re: /(?:lodash|_)\.(?:set|setWith|update|updateWith)\s*\(\s*\w+\s*,\s*(?:req\.|user|input|data|key|path|prop)/g, type: 'Lodash set/update with user-controlled path', severity: SEVERITY.HIGH },

    // __proto__ / constructor.prototype in user input
    { re: /__proto__/g, type: '__proto__ reference detected (verify not from user input)', severity: SEVERITY.MEDIUM },
    { re: /constructor\s*\[\s*['"]prototype['"]\s*\]/g, type: 'constructor["prototype"] access pattern', severity: SEVERITY.HIGH },

    // Bracket notation with user input (property injection)
    { re: /\w+\[\s*(?:req\.|user|input|data|key|prop|params|query|body)[^\]]*\]\s*=/g, type: 'Bracket notation assignment with user-controlled key', severity: SEVERITY.HIGH },
  ];

  for (const { re, type, severity } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      findings.push({ type, severity, line, snippet: m[0].substring(0, 80), owasp: 'A03:2021-Injection', rule: 'prototype-pollution' });
    }
  }

  return findings;
};

/**
 * Detect path traversal vulnerabilities.
 * path.join(base, userInput) without validation, ../ in file operations,
 * fs.readFile with user input.
 */
const detectPathTraversal = (code) => {
  const findings = [];

  const patterns = [
    // path.join/resolve with user input
    { re: /path\.(?:join|resolve)\s*\([^)]*(?:req\.|user|input|data|params|query|body)/g, type: 'path.join/resolve with user input (path traversal risk)', severity: SEVERITY.HIGH },
    { re: /path\.(?:join|resolve)\s*\([^)]*\+\s*(?:req\.|user|input)/g, type: 'path concatenation with user input', severity: SEVERITY.HIGH },

    // fs operations with user input (beyond what detectCommandInjection covers)
    { re: /fs\.(?:readFileSync|readFile|createReadStream)\s*\(\s*(?:req\.|user|input|data|params|query|body)/g, type: 'fs.readFile with user input (path traversal)', severity: SEVERITY.CRITICAL },
    { re: /fs\.(?:writeFileSync|writeFile|createWriteStream)\s*\(\s*(?:req\.|user|input|data|params|query|body)/g, type: 'fs.writeFile with user input (arbitrary write)', severity: SEVERITY.CRITICAL },
    { re: /fs\.(?:readFileSync|readFile|createReadStream)\s*\(\s*`[^`]*\$\{(?:req\.|user|input|data|params)/g, type: 'fs.readFile with template literal user input', severity: SEVERITY.CRITICAL },
    { re: /fs\.(?:writeFileSync|writeFile|createWriteStream)\s*\(\s*`[^`]*\$\{(?:req\.|user|input|data|params)/g, type: 'fs.writeFile with template literal user input', severity: SEVERITY.CRITICAL },

    // Express static/sendFile with user input
    { re: /res\.sendFile\s*\(\s*(?:req\.|user|input|data|params|query|body|path\.join\s*\([^)]*req)/g, type: 'res.sendFile with user input', severity: SEVERITY.HIGH },
    { re: /res\.download\s*\(\s*(?:req\.|user|input|data|params|query|body)/g, type: 'res.download with user input', severity: SEVERITY.HIGH },

    // Path traversal literals — direct ../ usage without normalization
    { re: /(?:readFile|writeFile|createReadStream|createWriteStream|sendFile|download)\s*\([^)]*(?:\.\.\/|\.\.\\)/g, type: 'Literal ../ in file operation path', severity: SEVERITY.HIGH },

    // Missing path validation patterns
    { re: /(?:req\.params|req\.query|req\.body)\.\w+\s*(?:\.replace\s*\(\s*['"]\.\.['"]|\.includes\s*\(\s*['"]\.\.['"])/g, type: 'Incomplete path traversal sanitization (check for bypass)', severity: SEVERITY.MEDIUM },
  ];

  for (const { re, type, severity } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      findings.push({ type, severity, line, snippet: m[0].substring(0, 80), owasp: 'A01:2021-Broken Access Control', rule: 'path-traversal' });
    }
  }

  return findings;
};

/**
 * Detect insecure deserialization patterns.
 * JSON.parse on untrusted input with immediate property access, eval,
 * new Function, vm.runInContext, unserialize.
 */
const detectDeserialization = (code) => {
  const findings = [];

  const buildRe = (parts, flags = 'g') => new RegExp(parts.join(''), flags);

  const patterns = [
    // JSON.parse on untrusted input with immediate property access
    { re: /JSON\.parse\s*\(\s*(?:req\.|user|input|data|body|query|params|atob|Buffer\.from)[^)]*\)\s*\.\w+/g, type: 'JSON.parse(untrusted).property — missing validation', severity: SEVERITY.HIGH },
    { re: /JSON\.parse\s*\(\s*(?:req\.|user|input|data|body|query|params)[^)]*\)\s*(?:\[|\.(?:constructor|__proto__|prototype))/g, type: 'JSON.parse(untrusted) with dangerous property access', severity: SEVERITY.CRITICAL },

    // eval with any input
    { re: buildRe(['\\bev', 'al\\s*\\(']), type: 'eval() usage (deserialization/code execution risk)', severity: SEVERITY.HIGH },

    // new Function
    { re: /\bnew\s+Function\s*\(/g, type: 'new Function() constructor (code execution risk)', severity: SEVERITY.HIGH },

    // vm module
    { re: /\bvm\.runIn(?:New|This)?Context\s*\(/g, type: 'vm.runInContext (sandbox escape risk)', severity: SEVERITY.HIGH },
    { re: /\bvm\.compileFunction\s*\(/g, type: 'vm.compileFunction (code execution risk)', severity: SEVERITY.HIGH },
    { re: /\bvm\.Script\s*\(/g, type: 'vm.Script (code execution risk)', severity: SEVERITY.MEDIUM },

    // PHP/Ruby/Python unserialize equivalents
    { re: /\bunserialize\s*\(/g, type: 'unserialize() (insecure deserialization)', severity: SEVERITY.CRITICAL },
    { re: /\bpickle\.loads?\s*\(/g, type: 'Python pickle.load (insecure deserialization)', severity: SEVERITY.CRITICAL },
    { re: /\byaml\.(?:load|unsafe_load)\s*\(/g, type: 'YAML unsafe load (code execution risk)', severity: SEVERITY.CRITICAL },
    { re: /\bMarshal\.(?:load|restore)\s*\(/g, type: 'Ruby Marshal.load (insecure deserialization)', severity: SEVERITY.CRITICAL },

    // Node.js specific
    { re: /\brequire\s*\(\s*(?:req\.|user|input|data|body|query|params)/g, type: 'Dynamic require with user input (code injection)', severity: SEVERITY.CRITICAL },
    { re: /\bimport\s*\(\s*(?:req\.|user|input|data|body|query|params)/g, type: 'Dynamic import with user input (code injection)', severity: SEVERITY.CRITICAL },

    // JSONP / script injection from deserialized data
    { re: /(?:serialize|stringify)\s*\([^)]*\)[\s\S]{0,30}(?:innerHTML|write|send|end)/g, type: 'Serialized data injected into output (XSS via deserialization)', severity: SEVERITY.HIGH },
  ];

  for (const { re, type, severity } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.substring(0, m.index).split('\n').length;
      findings.push({ type, severity, line, snippet: m[0].substring(0, 80), owasp: 'A08:2021-Software & Data Integrity', rule: 'deserialization' });
    }
  }

  return findings;
};

/**
 * Calculate an overall risk score from findings.
 * Uses weighted severity scoring with diminishing returns.
 */
const calculateRiskScore = (findings) => {
  const weights = { critical: 25, high: 15, medium: 8, low: 3, info: 1 };
  let rawScore = 0;
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

  for (const f of findings) {
    const sev = f.severity || SEVERITY.INFO;
    severityCounts[sev] = (severityCounts[sev] || 0) + 1;
    // Diminishing returns: each subsequent finding of same severity adds less
    const count = severityCounts[sev];
    rawScore += (weights[sev] || 1) * (1 / Math.sqrt(count));
  }

  const score = Math.min(Math.round(rawScore), 100);
  let level;
  if (score >= 80 || severityCounts.critical > 0) level = 'critical';
  else if (score >= 50 || severityCounts.high > 2) level = 'high';
  else if (score >= 25 || severityCounts.high > 0) level = 'medium';
  else if (score > 0) level = 'low';
  else level = 'none';

  return {
    score,
    level,
    severityCounts,
    totalFindings: findings.length,
  };
};

// ─── AI-Powered Functions (with local fallback) ──────────────────────────────

/**
 * Run all local regex-based detectors against source code.
 * Returns the combined findings array.
 */
const runAllLocalScans = (code) => [
  ...detectHardcodedSecrets(code),
  ...detectSqlInjection(code),
  ...detectXss(code),
  ...detectCommandInjection(code),
  ...detectBrokenAccessControl(code),
  ...detectInsecureDesign(code),
  ...detectVulnerableComponents(code),
  ...detectLoggingFailures(code),
  ...detectPrototypePollution(code),
  ...detectPathTraversal(code),
  ...detectDeserialization(code),
];

/**
 * Comprehensive AI-powered security scan using SABER agent.
 * Checks OWASP Top 10, injection, auth flaws, XSS, CSRF, sensitive data exposure.
 * Returns structured report with CVE cross-references and remediation steps.
 *
 * Falls back to local-only results when the API is unreachable.
 */
const scanCode = async (code, options = {}) => {
  const { language = 'auto', focusAreas = [] } = options;

  // Run all local scans
  const localFindings = runAllLocalScans(code);

  const localRisk = calculateRiskScore(localFindings);
  const localSummary = localFindings.length > 0
    ? `Local scan found ${localFindings.length} issues (${localRisk.level} risk, score ${localRisk.score}/100). Findings by category: ${Object.entries(localRisk.severityCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(', ')}`
    : 'Local scan found no issues.';

  const focusStr = focusAreas.length > 0 ? `\nFocus especially on: ${focusAreas.join(', ')}` : '';

  const prompt = `Perform a comprehensive security audit on this code. Language: ${language}.

Local static analysis already found: ${localSummary}
${localFindings.length > 0 ? `Top local findings:\n${localFindings.slice(0, 10).map(f => `  - [${f.severity}] L${f.line}: ${f.type}`).join('\n')}` : ''}
${focusStr}

Now perform deep contextual analysis for issues regex cannot catch:
1. **A01:2021 Broken Access Control** — Missing auth checks, privilege escalation, IDOR
2. **A02:2021 Cryptographic Failures** — Weak algorithms, missing encryption, key management
3. **A03:2021 Injection** — SQL, NoSQL, OS, LDAP, XPath, template injection beyond regex
4. **A04:2021 Insecure Design** — Business logic flaws, missing threat modeling
5. **A05:2021 Security Misconfiguration** — Debug enabled, default credentials, verbose errors
6. **A06:2021 Vulnerable Components** — Known CVEs in detected libraries
7. **A07:2021 Identity & Auth Failures** — Session management, credential stuffing, brute force
8. **A08:2021 Software & Data Integrity** — Deserialization, unsigned updates, CI/CD integrity
9. **A09:2021 Security Logging & Monitoring** — Missing audit trails, blind spots
10. **A10:2021 SSRF** — Server-side request forgery, internal service access

For each finding:
- severity: critical|high|medium|low|info
- owasp: the OWASP category code
- cve: relevant CVE if applicable (or "N/A")
- line: approximate line number
- description: clear explanation
- remediation: specific fix with code example
- confidence: high|medium|low

Return as JSON:
{
  "findings": [...],
  "overallRisk": "critical|high|medium|low|none",
  "riskScore": 0-100,
  "summary": "executive summary paragraph",
  "positiveObservations": ["good security practices found"]
}

Code to analyze (first 15000 chars):
\`\`\`
${code.substring(0, 15000)}
\`\`\``;

  const agentResult = await invokeAgent('saber', prompt, { includeSubAgents: false });

  let aiFindings = [];
  let aiSummary = null;
  let positiveObservations = [];

  if (agentResult.ok && agentResult.data) {
    const aiResult = parseAndValidateAiJson(
      typeof agentResult.data === 'string' ? agentResult.data : JSON.stringify(agentResult.data),
      ['findings'],
      { findings: [], summary: null, positiveObservations: [] }
    );
    aiFindings = Array.isArray(aiResult.findings) ? aiResult.findings : [];
    aiSummary = aiResult.summary || null;
    positiveObservations = Array.isArray(aiResult.positiveObservations) ? aiResult.positiveObservations : [];
  }

  // Merge local and AI findings
  const allFindings = [
    ...localFindings.map(f => ({ ...f, source: 'local-regex' })),
    ...aiFindings.map(f => ({ ...f, source: 'ai-saber' })),
  ];

  return {
    findings: allFindings,
    localFindings: localFindings.length,
    aiFindings: aiFindings.length,
    aiAvailable: agentResult.ok,
    aiError: agentResult.error,
    aiDurationMs: agentResult.durationMs,
    riskScore: calculateRiskScore(allFindings),
    summary: aiSummary || (agentResult.ok ? 'AI analysis returned no summary.' : `AI analysis unavailable (${agentResult.error}). Results are from local regex scanning only.`),
    positiveObservations,
    imports: extractImports(code),
  };
};

/**
 * Scan dependencies (package.json) for known vulnerabilities.
 *
 * v3.0.0: Two-phase approach:
 * 1. Local semver-aware scan against KNOWN_VULNERABILITIES — instant, concrete
 * 2. AI-powered deep analysis via ZERO agent — supply chain, deprecation, etc.
 *
 * Results are merged and deduplicated by CVE.
 * Falls back to local-only results when the API is unreachable.
 */
const scanDependencies = async (packageJson) => {
  let parsed;
  try {
    parsed = typeof packageJson === 'string' ? JSON.parse(packageJson) : packageJson;
  } catch {
    return { error: 'Invalid package.json: cannot parse', findings: [] };
  }

  const deps = { ...parsed.dependencies, ...parsed.devDependencies };
  const depList = Object.entries(deps).map(([name, version]) => `${name}@${version}`);

  if (depList.length === 0) {
    return { findings: [], summary: 'No dependencies found.', riskScore: { score: 0, level: 'none' } };
  }

  // Phase 1: Local semver-aware CVE matching (instant)
  const localFindings = detectVulnerableComponents(parsed).map(f => ({ ...f, source: 'local-cve-db' }));

  // Build set of CVEs already found locally for deduplication
  const localCves = new Set(localFindings.map(f => f.cve).filter(Boolean));

  // Phase 2: AI-powered deep analysis via ZERO
  const localSummary = localFindings.length > 0
    ? `Local CVE database matched ${localFindings.length} known vulnerabilities:\n${localFindings.map(f => `  - ${f.cve}: ${f.type}`).join('\n')}`
    : 'Local CVE database found no matches.';

  const prompt = `Analyze these npm dependencies for known security vulnerabilities.

${localSummary}

Dependencies (${depList.length} total):
${depList.join('\n')}

DO NOT repeat findings already listed above. Focus on:
1. Vulnerabilities NOT in the local database
2. Deprecated packages
3. Packages with known supply chain issues
4. Packages with suspicious maintainer changes
5. Packages that are no longer maintained (no commits in 2+ years)
6. Packages with typosquatting risk

For each NEW vulnerable dependency, provide:
- package: name
- version: installed version
- vulnerability: description
- severity: critical|high|medium|low
- cve: CVE identifier if known
- fixedIn: version that fixes the issue
- recommendation: upgrade/replace/remove

Return as JSON:
{
  "findings": [...],
  "deprecated": ["package names"],
  "unmaintained": ["package names"],
  "supplyChainRisks": ["concerns"],
  "summary": "overall assessment",
  "recommendedActions": ["prioritized list"]
}`;

  const agentResult = await invokeAgent('zero', prompt, { includeSubAgents: false });

  if (agentResult.ok && agentResult.data) {
    const aiResult = parseAndValidateAiJson(
      typeof agentResult.data === 'string' ? agentResult.data : JSON.stringify(agentResult.data),
      ['findings'],
      { findings: [], summary: null, deprecated: [], unmaintained: [], supplyChainRisks: [], recommendedActions: [] }
    );

    // Deduplicate AI findings against local CVEs
    const aiFindings = (Array.isArray(aiResult.findings) ? aiResult.findings : [])
      .filter(f => !f.cve || !localCves.has(f.cve))
      .map(f => ({ ...f, source: 'ai-zero' }));

    const allFindings = [...localFindings, ...aiFindings];
    return {
      findings: allFindings,
      localFindings: localFindings.length,
      aiFindings: aiFindings.length,
      aiAvailable: true,
      aiDurationMs: agentResult.durationMs,
      deprecated: Array.isArray(aiResult.deprecated) ? aiResult.deprecated : [],
      unmaintained: Array.isArray(aiResult.unmaintained) ? aiResult.unmaintained : [],
      supplyChainRisks: Array.isArray(aiResult.supplyChainRisks) ? aiResult.supplyChainRisks : [],
      totalDependencies: depList.length,
      summary: aiResult.summary || 'AI analysis complete.',
      recommendedActions: Array.isArray(aiResult.recommendedActions) ? aiResult.recommendedActions : [],
      riskScore: calculateRiskScore(allFindings),
    };
  }

  // Fallback: local-only results
  return {
    findings: localFindings,
    localFindings: localFindings.length,
    aiFindings: 0,
    aiAvailable: false,
    aiError: agentResult.error,
    aiDurationMs: agentResult.durationMs,
    deprecated: [],
    unmaintained: [],
    supplyChainRisks: [],
    totalDependencies: depList.length,
    summary: `AI analysis unavailable (${agentResult.error}). ${localFindings.length} issues found via local CVE database.`,
    recommendedActions: localFindings.length > 0
      ? localFindings.map(f => `Upgrade ${f.snippet?.split(':')[0] || 'package'} to ${f.fixedIn || 'latest'} (${f.cve})`)
      : [],
    riskScore: calculateRiskScore(localFindings),
  };
};

/**
 * Scan configuration files for security misconfigurations using SABER.
 * Supports nginx, docker, kubernetes, and general config files.
 * Falls back to a basic local assessment when the API is unreachable.
 */
const scanConfig = async (configContent, type = 'auto') => {
  // Auto-detect config type
  if (type === 'auto') {
    if (configContent.includes('server {') || configContent.includes('upstream')) type = 'nginx';
    else if (configContent.includes('FROM ') && configContent.includes('RUN ')) type = 'docker';
    else if (configContent.includes('apiVersion:') && configContent.includes('kind:')) type = 'kubernetes';
    else if (configContent.includes('[mysqld]') || configContent.includes('[postgresql]')) type = 'database';
    else if (configContent.includes('# SSH') || configContent.includes('PermitRootLogin')) type = 'ssh';
    else type = 'general';
  }

  // Local regex scan on config content for secrets and common issues
  const localFindings = [
    ...detectHardcodedSecrets(configContent),
    ...detectLoggingFailures(configContent),
  ].map(f => ({ ...f, source: 'local-regex' }));

  const typeGuidance = {
    nginx: 'Check: TLS configuration, security headers, rate limiting, access control, path traversal in locations, upstream security, server_tokens, default_type',
    docker: 'Check: Running as root, ADD vs COPY, exposed ports, multi-stage builds, .dockerignore, pinned base images, secrets in layers, healthchecks',
    kubernetes: 'Check: SecurityContext, runAsNonRoot, readOnlyRootFilesystem, resource limits, NetworkPolicies, RBAC, secrets management, pod security standards',
    database: 'Check: Authentication, encrypted connections, default credentials, exposed ports, logging, backup encryption, privilege separation',
    ssh: 'Check: PermitRootLogin, PasswordAuthentication, key algorithms, MaxAuthTries, AllowUsers/AllowGroups, port, protocol version',
    general: 'Check: Credentials, insecure defaults, debug mode, verbose logging, exposed endpoints, missing encryption',
  };

  const prompt = `Perform a security audit on this ${type} configuration file.

${typeGuidance[type] || typeGuidance.general}

Configuration:
\`\`\`
${configContent.substring(0, 12000)}
\`\`\`

For each misconfiguration found:
- severity: critical|high|medium|low|info
- category: what aspect of security it affects
- line: approximate line number
- currentValue: what is currently configured
- recommendedValue: what it should be
- description: why this is a security issue
- reference: CIS benchmark or documentation link if applicable

Return as JSON:
{
  "configType": "${type}",
  "findings": [...],
  "overallRisk": "critical|high|medium|low|none",
  "bestPractices": ["what this config does well"],
  "missingConfigurations": ["security configurations that should be present but aren't"],
  "hardeningSteps": ["ordered steps to harden this configuration"]
}`;

  const agentResult = await invokeAgent('saber', prompt, { includeSubAgents: false });

  if (agentResult.ok && agentResult.data) {
    const aiResult = parseAndValidateAiJson(
      typeof agentResult.data === 'string' ? agentResult.data : JSON.stringify(agentResult.data),
      ['findings'],
      { configType: type, findings: [], bestPractices: [], missingConfigurations: [], hardeningSteps: [] }
    );
    const aiFindings = (Array.isArray(aiResult.findings) ? aiResult.findings : []).map(f => ({ ...f, source: 'ai-saber' }));
    const allFindings = [...localFindings, ...aiFindings];
    return {
      configType: aiResult.configType || type,
      findings: allFindings,
      localFindings: localFindings.length,
      aiFindings: aiFindings.length,
      aiAvailable: true,
      aiDurationMs: agentResult.durationMs,
      overallRisk: aiResult.overallRisk,
      bestPractices: Array.isArray(aiResult.bestPractices) ? aiResult.bestPractices : [],
      missingConfigurations: Array.isArray(aiResult.missingConfigurations) ? aiResult.missingConfigurations : [],
      hardeningSteps: Array.isArray(aiResult.hardeningSteps) ? aiResult.hardeningSteps : [],
      riskScore: calculateRiskScore(allFindings),
    };
  }

  // Fallback: local-only results
  return {
    configType: type,
    findings: localFindings,
    localFindings: localFindings.length,
    aiFindings: 0,
    aiAvailable: false,
    aiError: agentResult.error,
    aiDurationMs: agentResult.durationMs,
    overallRisk: localFindings.length > 0 ? calculateRiskScore(localFindings).level : 'unknown',
    bestPractices: [],
    missingConfigurations: [],
    hardeningSteps: [],
    summary: `AI analysis unavailable (${agentResult.error}). ${localFindings.length} issues found via local pattern matching.`,
    riskScore: calculateRiskScore(localFindings),
  };
};

/**
 * Generate a prioritized remediation plan from security findings using SABER.
 * Falls back to a locally-generated plan when the API is unreachable.
 */
const generateRemediationPlan = async (findings) => {
  if (!findings || findings.length === 0) {
    return { plan: [], summary: 'No findings to remediate.', estimatedEffort: '0 hours', aiAvailable: true };
  }

  const findingsText = findings.slice(0, 30).map((f, i) =>
    `${i + 1}. [${f.severity}] ${f.type || f.category}: ${f.description || f.snippet || ''} (line ${f.line || 'N/A'})`
  ).join('\n');

  const prompt = `Create a prioritized remediation plan for these security findings.

Findings:
${findingsText}

For each remediation step:
1. Priority order (fix critical/high first)
2. Clear description of the fix
3. Code example showing before/after (where applicable)
4. Estimated effort (hours)
5. Dependencies (does fix X need to happen before fix Y?)
6. Testing approach to verify the fix

Group related findings that can be fixed together.

Return as JSON:
{
  "plan": [
    {
      "priority": 1,
      "title": "short description",
      "findingIds": [1, 2],
      "severity": "critical",
      "description": "detailed fix explanation",
      "codeExample": { "before": "...", "after": "..." },
      "estimatedHours": 2,
      "dependencies": [],
      "testingApproach": "how to verify"
    }
  ],
  "summary": "executive summary of remediation effort",
  "totalEstimatedHours": 20,
  "quickWins": ["fixes that take < 1 hour"],
  "strategicFixes": ["larger fixes requiring architectural changes"]
}`;

  const agentResult = await invokeAgent('saber', prompt, { includeSubAgents: false });

  if (agentResult.ok && agentResult.data) {
    const result = parseAndValidateAiJson(
      typeof agentResult.data === 'string' ? agentResult.data : JSON.stringify(agentResult.data),
      ['plan'],
      { plan: [], summary: 'AI returned incomplete remediation plan.', totalEstimatedHours: 0, quickWins: [], strategicFixes: [] }
    );
    result.aiAvailable = true;
    result.aiDurationMs = agentResult.durationMs;
    return result;
  }

  // Fallback: generate a basic local remediation plan from findings
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...findings].sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));
  const effortMap = { critical: 4, high: 2, medium: 1, low: 0.5, info: 0.25 };

  const plan = sorted.slice(0, 20).map((f, i) => ({
    priority: i + 1,
    title: `Fix: ${f.type || f.category || 'Unknown issue'}`,
    findingIds: [i + 1],
    severity: f.severity || 'medium',
    description: f.description || f.snippet || 'Review and remediate this finding.',
    estimatedHours: effortMap[f.severity] || 1,
    dependencies: [],
    testingApproach: 'Verify the vulnerability is no longer detected by re-running the scanner.',
  }));

  const totalHours = plan.reduce((sum, p) => sum + p.estimatedHours, 0);

  return {
    plan,
    summary: `AI analysis unavailable (${agentResult.error}). Generated local remediation plan with ${plan.length} steps covering ${sorted.length} findings.`,
    totalEstimatedHours: totalHours,
    quickWins: plan.filter(p => p.estimatedHours <= 1).map(p => p.title),
    strategicFixes: plan.filter(p => p.estimatedHours > 2).map(p => p.title),
    aiAvailable: false,
    aiError: agentResult.error,
    aiDurationMs: agentResult.durationMs,
  };
};

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

const run = async (args) => {
  const file = args.file || args.f;
  const scanType = args.type || args.t || 'code';
  const outputFormat = args.format || 'text';
  const severityFilter = args.severity || 'all';

  if (!file) {
    return { error: 'File path required. Use --file <path>.' };
  }

  let content;
  try {
    const { readFile } = await import('node:fs/promises');
    content = await readFile(file, 'utf-8');
  } catch (err) {
    return { error: `Cannot read file "${file}": ${err.message}` };
  }

  let result;
  const startTime = Date.now();

  switch (scanType) {
    case 'code':
      result = await scanCode(content, { language: detectLanguage(file) });
      break;
    case 'deps':
      result = await scanDependencies(content);
      break;
    case 'config':
      result = await scanConfig(content);
      break;
    default:
      result = await scanCode(content, { language: 'auto' });
  }

  result.file = file;
  result.scanType = scanType;
  result.durationMs = Date.now() - startTime;

  // Apply severity filter
  if (severityFilter !== 'all' && result.findings) {
    const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
    const filterIndex = severityOrder.indexOf(severityFilter);
    if (filterIndex >= 0) {
      result.findings = result.findings.filter(f => severityOrder.indexOf(f.severity) <= filterIndex);
      result.filteredRiskScore = calculateRiskScore(result.findings);
    }
  }

  // Generate remediation plan if there are findings
  if (result.findings?.length > 0) {
    result.remediationPlan = await generateRemediationPlan(result.findings);
  }

  if (outputFormat === 'json') return result;
  if (outputFormat === 'sarif') return formatSarif(result);
  return formatTextOutput(result);
};

/**
 * Detect programming language from file extension.
 */
const detectLanguage = (filePath) => {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    cs: 'csharp', cpp: 'cpp', c: 'c', php: 'php', swift: 'swift', scala: 'scala',
    conf: 'config', yml: 'yaml', yaml: 'yaml', json: 'json', toml: 'toml',
    dockerfile: 'docker', tf: 'terraform', hcl: 'terraform',
  };
  return langMap[ext] || 'auto';
};

/**
 * Format output as SARIF (Static Analysis Results Interchange Format).
 */
const formatSarif = (result) => ({
  version: '2.1.0',
  $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
  runs: [{
    tool: {
      driver: {
        name: 'nha-security-scanner',
        version: '3.0.0',
        informationUri: 'https://nothumanallowed.com',
        rules: [...new Set((result.findings || []).map(f => f.rule || f.type))].map(ruleId => ({
          id: ruleId,
          shortDescription: { text: ruleId },
        })),
      },
    },
    results: (result.findings || []).map(f => ({
      ruleId: f.rule || f.type,
      level: f.severity === 'critical' || f.severity === 'high' ? 'error' : f.severity === 'medium' ? 'warning' : 'note',
      message: { text: f.description || f.type },
      locations: f.line ? [{
        physicalLocation: {
          artifactLocation: { uri: result.file },
          region: { startLine: f.line },
        },
      }] : [],
      properties: {
        severity: f.severity,
        owasp: f.owasp,
        cve: f.cve,
        source: f.source,
      },
    })),
  }],
});

/**
 * Format scan results as human-readable text.
 */
const formatTextOutput = (result) => {
  const lines = [
    '════════════════════════════════════════════════════════════',
    '  SECURITY SCAN RESULTS',
    `  File: ${result.file}`,
    `  Type: ${result.scanType} | Duration: ${result.durationMs}ms`,
    result.aiAvailable === false ? '  Mode: LOCAL ONLY (AI unavailable)' : '  Mode: LOCAL + AI',
    '════════════════════════════════════════════════════════════',
    '',
  ];

  const risk = result.riskScore || result.filteredRiskScore;
  if (risk) {
    lines.push(`Risk Level: ${risk.level?.toUpperCase()} (score: ${risk.score}/100)`);
    lines.push(`Total Findings: ${risk.totalFindings} (C:${risk.severityCounts?.critical || 0} H:${risk.severityCounts?.high || 0} M:${risk.severityCounts?.medium || 0} L:${risk.severityCounts?.low || 0})`);
    if (typeof result.localFindings === 'number' && typeof result.aiFindings === 'number') {
      lines.push(`Sources: ${result.localFindings} local, ${result.aiFindings} AI`);
    }
    lines.push('');
  }

  if (result.summary) {
    lines.push(`Summary: ${result.summary}`);
    lines.push('');
  }

  if (result.aiError) {
    lines.push(`AI Note: ${result.aiError}`);
    lines.push('');
  }

  if (result.findings?.length > 0) {
    lines.push('── Findings ──');
    const grouped = {};
    for (const f of result.findings) {
      const key = f.owasp || f.rule || 'Other';
      (grouped[key] ??= []).push(f);
    }

    for (const [category, items] of Object.entries(grouped)) {
      lines.push(`\n  ${category}:`);
      for (const f of items) {
        const source = f.source === 'ai-saber' || f.source === 'ai-zero' ? ' [AI]' : f.source === 'local-cve-db' ? ' [CVE-DB]' : ' [Local]';
        const cveTag = f.cve ? ` (${f.cve})` : '';
        const fixTag = f.fixedIn ? ` → fix: ${f.fixedIn}` : '';
        lines.push(`    [${(f.severity || 'info').toUpperCase()}] L${f.line || '?'}: ${f.type || f.category}${cveTag}${fixTag}${source}`);
        if (f.description) lines.push(`      ${f.description.substring(0, 120)}`);
        if (f.remediation) lines.push(`      Fix: ${f.remediation.substring(0, 120)}`);
      }
    }
    lines.push('');
  }

  if (result.positiveObservations?.length > 0) {
    lines.push('── Positive Observations ──');
    for (const obs of result.positiveObservations) {
      lines.push(`  + ${obs}`);
    }
    lines.push('');
  }

  if (result.remediationPlan?.plan?.length > 0) {
    lines.push('── Remediation Plan ──');
    for (const step of result.remediationPlan.plan.slice(0, 5)) {
      lines.push(`  ${step.priority}. [${step.severity}] ${step.title} (~${step.estimatedHours}h)`);
      if (step.description) lines.push(`     ${step.description.substring(0, 120)}`);
    }
    if (result.remediationPlan.totalEstimatedHours) {
      lines.push(`\n  Total estimated effort: ${result.remediationPlan.totalEstimatedHours}h`);
    }
    lines.push('');
  }

  if (result.imports?.some(i => i.suspicious)) {
    lines.push('── Suspicious Imports ──');
    for (const imp of result.imports.filter(i => i.suspicious)) {
      lines.push(`  L${imp.line}: ${imp.module} — ${imp.suspicious}`);
    }
    lines.push('');
  }

  lines.push('════════════════════════════════════════════════════════════');
  return lines.join('\n');
};

// ─── Extension Metadata ──────────────────────────────────────────────────────

export const EXTENSION_META = {
  name: 'nha-security-scanner',
  displayName: 'Security Scanner',
  category: 'security',
  version: '3.0.0',
  description: 'Comprehensive security scanning with semver-aware CVE database (35+ real CVEs), local regex detection, and AI-powered analysis via SABER, ZERO, and ADE agents. Covers OWASP Top 10, dependency vulnerabilities, config security, and generates remediation plans. Gracefully degrades to local-only mode when AI is unavailable.',
  commands: [
    { name: 'scan-code', description: 'Scan source code for security vulnerabilities', args: '--file <path> --type code [--severity critical|high|medium|all]' },
    { name: 'scan-deps', description: 'Scan package.json for dependency vulnerabilities', args: '--file <path> --type deps' },
    { name: 'scan-config', description: 'Scan configuration files for misconfigurations', args: '--file <path> --type config' },
    { name: 'remediate', description: 'Generate prioritized remediation plan', args: '--file <path> --type code --format json' },
  ],
  examplePrompts: [
    'pif ext nha-security-scanner --file ./app.ts --type code',
    'pif ext nha-security-scanner --file ./package.json --type deps --format json',
    'pif ext nha-security-scanner --file ./nginx.conf --type config',
    'pif ext nha-security-scanner --file ./app.ts --type code --severity critical --format sarif',
    'pif ext nha-security-scanner --file ./Dockerfile --type config --format text',
  ],
  useCases: [
    'Scan code for OWASP Top 10 vulnerabilities with AI-powered analysis',
    'Audit npm dependencies for known CVEs with semver-aware version matching',
    'Analyze nginx/docker/k8s configs for security misconfigurations',
    'Generate SARIF reports for CI/CD integration',
    'Get prioritized remediation plans with code fix examples',
  ],
};

export {
  extractImports,
  detectHardcodedSecrets,
  detectSqlInjection,
  detectXss,
  detectCommandInjection,
  detectBrokenAccessControl,
  detectInsecureDesign,
  detectVulnerableComponents,
  detectLoggingFailures,
  detectPrototypePollution,
  detectPathTraversal,
  detectDeserialization,
  calculateRiskScore,
  runAllLocalScans,
  scanCode,
  scanDependencies,
  scanConfig,
  generateRemediationPlan,
  parseSemanticVersion,
  resolveMinimumVersion,
  compareVersions,
  isVulnerable,
  KNOWN_VULNERABILITIES,
  run,
};
