/**
 * nha-api-tester — PIF Extension v2.2.0
 *
 * Generates and executes intelligent API test suites from OpenAPI specs or endpoint lists.
 * Uses FORGE agent for AI-powered test generation, result analysis, and mock server creation.
 *
 * @category devops
 * @version 2.2.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   // Local test generation
 *   import { parseOpenApiSpec, generateTestCases, validateResponse } from './extensions/nha-api-tester.mjs';
 *   const spec = parseOpenApiSpec(jsonString);
 *   const tests = generateTestCases(spec.endpoints);
 *
 * @example
 *   // Execute tests against a real URL
 *   import { parseOpenApiSpec, generateTestCases, executeTests } from './extensions/nha-api-tester.mjs';
 *   const spec = parseOpenApiSpec(jsonString);
 *   const tests = generateTestCases(spec.endpoints);
 *   const { results, summary } = await executeTests(tests, 'https://api.example.com', { concurrency: 5 });
 *
 * @example
 *   // AI-powered test generation
 *   import { aiGenerateTests, analyzeTestResults } from './extensions/nha-api-tester.mjs';
 *   const tests = await aiGenerateTests(specOrEndpoints, { depth: 'thorough', includeNegative: true });
 *
 * @example
 *   // CLI usage
 *   pif ext nha-api-tester --spec ./openapi.json --url http://localhost:3000 --depth thorough --concurrency 5 --delay 200
 *   pif ext nha-api-tester --command analyze --input ./test-results.json
 *   pif ext nha-api-tester --command mock --spec ./openapi.json --output ./mock-config.json
 */

const NHA_API = 'https://nothumanallowed.com/api/v1';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

const invokeAgentWithRetry = async (agentName, prompt, config = {}, maxRetries = 2) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await invokeAgent(agentName, prompt, config);
    if (result.ok) return result;
    if (attempt < maxRetries && (result.error?.includes('429') || result.error?.includes('timed out'))) {
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    return result;
  }
};

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
// Local pure functions
// ---------------------------------------------------------------------------

const parseOpenApiSpec = (input) => {
  const spec = typeof input === 'string' ? JSON.parse(input) : input;
  const title = spec.info?.title ?? 'Unknown API';
  const version = spec.info?.version ?? '0.0.0';
  let baseUrl = '';
  if (spec.servers && spec.servers.length > 0) baseUrl = spec.servers[0].url ?? '';

  const endpoints = [];
  const paths = spec.paths ?? {};

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const httpMethod = method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(httpMethod)) continue;

      const parameters = [];
      if (Array.isArray(methods.parameters)) {
        for (const p of methods.parameters) parameters.push({ name: p.name, in: p.in, required: p.required ?? false, schema: p.schema ?? {} });
      }
      if (Array.isArray(operation.parameters)) {
        for (const p of operation.parameters) parameters.push({ name: p.name, in: p.in, required: p.required ?? false, schema: p.schema ?? {} });
      }

      let requestBody = undefined;
      if (operation.requestBody) {
        const content = operation.requestBody.content ?? {};
        const jsonContent = content['application/json'];
        if (jsonContent) requestBody = { required: operation.requestBody.required ?? false, schema: jsonContent.schema ?? {} };
      }

      const responses = {};
      if (operation.responses) {
        for (const [statusCode, resp] of Object.entries(operation.responses)) {
          const respContent = resp.content ?? {};
          const jsonResp = respContent['application/json'];
          responses[statusCode] = { description: resp.description ?? '', schema: jsonResp?.schema ?? null };
        }
      }

      endpoints.push({ method: httpMethod, path, operationId: operation.operationId ?? null, summary: operation.summary ?? null, parameters, requestBody, responses });
    }
  }

  return { title, version, baseUrl, endpoints };
};

const generateTestCases = (endpoints, depth = 'standard') => {
  const tests = [];
  let idCounter = 1;
  const makeId = () => `TC-${String(idCounter++).padStart(4, '0')}`;

  const generateSampleValue = (schema) => {
    if (!schema) return 'test-value';
    switch (schema.type) {
      case 'string':
        if (schema.format === 'email') return 'test@example.com';
        if (schema.format === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
        if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
        if (schema.format === 'uri') return 'https://example.com';
        if (schema.enum && schema.enum.length > 0) return schema.enum[0];
        if (schema.minLength) return 'x'.repeat(schema.minLength);
        return 'test-string';
      case 'integer': case 'number':
        if (schema.minimum !== undefined) return schema.minimum;
        if (schema.maximum !== undefined) return Math.floor(schema.maximum / 2);
        return schema.type === 'integer' ? 42 : 3.14;
      case 'boolean': return true;
      case 'array': return [generateSampleValue(schema.items)];
      case 'object': {
        const obj = {};
        if (schema.properties) { for (const [key, prop] of Object.entries(schema.properties)) obj[key] = generateSampleValue(prop); }
        return obj;
      }
      default: return 'test-value';
    }
  };

  const generateBoundaryValue = (schema) => {
    if (!schema) return '';
    switch (schema.type) {
      case 'string': {
        const results = [''];
        if (schema.maxLength) results.push('x'.repeat(schema.maxLength + 1));
        if (schema.minLength) results.push('x'.repeat(Math.max(0, schema.minLength - 1)));
        results.push('x'.repeat(10000));
        return results;
      }
      case 'integer': case 'number': {
        const results = [];
        if (schema.minimum !== undefined) results.push(schema.minimum - 1);
        if (schema.maximum !== undefined) results.push(schema.maximum + 1);
        results.push(0, -1, Number.MAX_SAFE_INTEGER);
        return results;
      }
      default: return [null, undefined, '', 0];
    }
  };

  for (const ep of endpoints) {
    const successStatuses = Object.keys(ep.responses ?? {}).filter((s) => s.startsWith('2'));
    const expectedSuccess = successStatuses.length > 0 ? Number(successStatuses[0]) : 200;

    tests.push({ id: makeId(), name: `${ep.method} ${ep.path} \u2014 happy path`, method: ep.method, path: ep.path, type: 'positive', headers: { 'Content-Type': 'application/json' }, queryParams: buildQueryParams(ep.parameters, generateSampleValue), body: ep.requestBody ? generateSampleValue(ep.requestBody.schema) : undefined, expectedStatus: expectedSuccess, expectedContentType: 'application/json', description: `Verify ${ep.method} ${ep.path} returns ${expectedSuccess} with valid input` });

    if (ep.requestBody?.required) {
      tests.push({ id: makeId(), name: `${ep.method} ${ep.path} \u2014 empty body`, method: ep.method, path: ep.path, type: 'negative', headers: { 'Content-Type': 'application/json' }, body: {}, expectedStatus: 400, description: `Verify ${ep.method} ${ep.path} rejects empty request body` });
    }

    if (ep.method !== 'GET' && ep.method !== 'DELETE') {
      tests.push({ id: makeId(), name: `${ep.method} ${ep.path} \u2014 invalid content-type`, method: ep.method, path: ep.path, type: 'negative', headers: { 'Content-Type': 'text/plain' }, body: 'not json', expectedStatus: 415, description: `Verify ${ep.method} ${ep.path} rejects non-JSON content type` });
    }

    const altMethod = ep.method === 'GET' ? 'DELETE' : 'GET';
    tests.push({ id: makeId(), name: `${altMethod} ${ep.path} \u2014 method not allowed`, method: altMethod, path: ep.path, type: 'negative', expectedStatus: 405, description: `Verify ${ep.path} rejects ${altMethod} if only ${ep.method} is defined` });

    if (depth === 'smoke') continue;

    tests.push({ id: makeId(), name: `${ep.method} ${ep.path} \u2014 no authorization`, method: ep.method, path: ep.path, type: 'security', headers: { 'Content-Type': 'application/json' }, body: ep.requestBody ? generateSampleValue(ep.requestBody.schema) : undefined, expectedStatus: 401, description: `Verify ${ep.method} ${ep.path} requires authentication` });

    const injectableParams = (ep.parameters ?? []).filter((p) => p.in === 'query' && p.schema?.type === 'string');
    if (injectableParams.length > 0) {
      tests.push({ id: makeId(), name: `${ep.method} ${ep.path} \u2014 SQL injection attempt`, method: ep.method, path: ep.path, type: 'security', queryParams: { [injectableParams[0].name]: "' OR '1'='1" }, expectedStatus: 400, description: `Verify ${ep.method} ${ep.path} rejects SQL injection payloads` });
    }

    if (depth === 'standard') continue;

    if (ep.requestBody?.schema?.properties) {
      for (const [fieldName, fieldSchema] of Object.entries(ep.requestBody.schema.properties)) {
        const boundaries = generateBoundaryValue(fieldSchema);
        if (Array.isArray(boundaries)) {
          for (const bv of boundaries.slice(0, 3)) {
            tests.push({ id: makeId(), name: `${ep.method} ${ep.path} \u2014 boundary: ${fieldName}=${JSON.stringify(bv)}`, method: ep.method, path: ep.path, type: 'boundary', headers: { 'Content-Type': 'application/json' }, body: { [fieldName]: bv }, expectedStatus: 400, description: `Verify ${ep.method} ${ep.path} handles boundary value for ${fieldName}` });
          }
        }
      }
    }

    if (ep.requestBody?.schema?.properties) {
      const stringFields = Object.entries(ep.requestBody.schema.properties).filter(([, s]) => s.type === 'string').map(([k]) => k);
      if (stringFields.length > 0) {
        const payload = {};
        for (const f of stringFields) payload[f] = '<script>alert(1)</script>';
        tests.push({ id: makeId(), name: `${ep.method} ${ep.path} \u2014 XSS payload`, method: ep.method, path: ep.path, type: 'security', headers: { 'Content-Type': 'application/json' }, body: payload, expectedStatus: 400, description: `Verify ${ep.method} ${ep.path} sanitizes or rejects XSS payloads` });
      }
    }
  }

  return tests;
};

const buildQueryParams = (parameters, valueGenerator) => {
  const queryParams = (parameters ?? []).filter((p) => p.in === 'query');
  if (queryParams.length === 0) return undefined;
  const result = {};
  for (const p of queryParams) result[p.name] = valueGenerator(p.schema);
  return result;
};

const validateResponse = (response, expected) => {
  const checks = [];

  const statusMatch = response.status === expected.expectedStatus;
  checks.push({ name: 'status-code', passed: statusMatch, detail: `Expected ${expected.expectedStatus}, got ${response.status}` });

  if (expected.expectedContentType) {
    const ct = (response.headers?.['content-type'] ?? '').toLowerCase();
    const ctMatch = ct.includes(expected.expectedContentType.toLowerCase());
    checks.push({ name: 'content-type', passed: ctMatch, detail: ctMatch ? `Content-Type contains "${expected.expectedContentType}"` : `Expected "${expected.expectedContentType}" in Content-Type, got "${ct}"` });
  }

  if (expected.expectedStatus >= 200 && expected.expectedStatus < 300) {
    const hasBody = response.body !== undefined && response.body !== null && response.body !== '';
    checks.push({ name: 'response-body', passed: hasBody, detail: hasBody ? 'Response body present' : 'Response body is empty' });

    if (expected.expectedContentType === 'application/json' && typeof response.body === 'string') {
      try {
        JSON.parse(response.body);
        checks.push({ name: 'json-valid', passed: true, detail: 'Response is valid JSON' });
      } catch {
        checks.push({ name: 'json-valid', passed: false, detail: 'Response is not valid JSON' });
      }
    }
  }

  if (response.latencyMs !== undefined) {
    const fast = response.latencyMs < 5000;
    checks.push({ name: 'latency', passed: fast, detail: fast ? `Response in ${response.latencyMs}ms` : `Slow response: ${response.latencyMs}ms (> 5000ms threshold)` });
  }

  return { passed: checks.every((c) => c.passed), checks };
};

const measureLatency = async (url, options = {}) => {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const body = await res.text();
    const latencyMs = Math.round(performance.now() - start);
    const headers = {};
    res.headers.forEach((value, key) => { headers[key] = value; });
    return { status: res.status, headers, body, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return { status: 0, headers: {}, body: '', latencyMs, error: err.name === 'AbortError' ? 'Request timed out' : err.message };
  }
};

const formatTestReport = (results, summary = null) => {
  const passed = results.filter((r) => r.validation.passed).length;
  const failed = results.length - passed;
  const latencies = results.map((r) => r.response?.latencyMs ?? 0).filter((l) => l > 0);
  const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p95 = summary?.p95LatencyMs ?? calculatePercentile(latencies, 95);
  const p99 = summary?.p99LatencyMs ?? calculatePercentile(latencies, 99);

  const lines = [
    '# API Test Report', '',
    `**Date**: ${new Date().toISOString()}`,
    `**Total Tests**: ${results.length}`,
    `**Passed**: ${passed}`,
    `**Failed**: ${failed}`,
    `**Pass Rate**: ${results.length > 0 ? ((passed / results.length) * 100).toFixed(1) : 0}%`,
    `**Avg Latency**: ${avgLatency}ms`,
    `**P95 Latency**: ${p95}ms`,
    `**P99 Latency**: ${p99}ms`, '',
  ];

  const byType = {};
  for (const r of results) {
    const type = r.test.type ?? 'unknown';
    if (!byType[type]) byType[type] = { passed: 0, failed: 0 };
    if (r.validation.passed) byType[type].passed++;
    else byType[type].failed++;
  }

  lines.push('## Summary by Type', '');
  lines.push('| Type | Passed | Failed | Total |');
  lines.push('| ---- | ------ | ------ | ----- |');
  for (const [type, counts] of Object.entries(byType)) {
    lines.push(`| ${type} | ${counts.passed} | ${counts.failed} | ${counts.passed + counts.failed} |`);
  }
  lines.push('');

  const failedTests = results.filter((r) => !r.validation.passed);
  if (failedTests.length > 0) {
    lines.push('## Failed Tests', '');
    for (const r of failedTests) {
      lines.push(`### ${r.test.id}: ${r.test.name}`);
      lines.push(`- **Description**: ${r.test.description}`);
      lines.push(`- **Expected Status**: ${r.test.expectedStatus}`);
      lines.push(`- **Actual Status**: ${r.response?.status ?? 'N/A'}`);
      lines.push(`- **Latency**: ${r.response?.latencyMs ?? 'N/A'}ms`);
      for (const check of r.validation.checks.filter((c) => !c.passed)) {
        lines.push(`- **[FAIL]** ${check.name}: ${check.detail}`);
      }
      lines.push('');
    }
  }

  const passedTests = results.filter((r) => r.validation.passed);
  if (passedTests.length > 0) {
    lines.push('## Passed Tests', '');
    for (const r of passedTests) {
      lines.push(`- **${r.test.id}**: ${r.test.name} (${r.response?.latencyMs ?? '?'}ms)`);
    }
    lines.push('');
  }

  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Percentile calculation
// ---------------------------------------------------------------------------

const calculatePercentile = (values, percentile) => {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return Math.round(sorted[lower]);
  const fraction = index - lower;
  return Math.round(sorted[lower] * (1 - fraction) + sorted[upper] * fraction);
};

// ---------------------------------------------------------------------------
// Test execution engine
// ---------------------------------------------------------------------------

const SAMPLE_PATH_VALUES = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  userId: '550e8400-e29b-41d4-a716-446655440001',
  postId: '550e8400-e29b-41d4-a716-446655440002',
  commentId: '550e8400-e29b-41d4-a716-446655440003',
  agentId: '550e8400-e29b-41d4-a716-446655440004',
  name: 'test-agent',
  slug: 'test-slug',
  submolt: 'test-submolt',
  submoltName: 'test-submolt',
  sessionId: '550e8400-e29b-41d4-a716-446655440005',
};

const resolvePathParameters = (path) => {
  return path.replace(/\{([^}]+)\}/g, (_, paramName) => {
    return SAMPLE_PATH_VALUES[paramName] ?? SAMPLE_PATH_VALUES.id;
  }).replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, paramName) => {
    return SAMPLE_PATH_VALUES[paramName] ?? SAMPLE_PATH_VALUES.id;
  });
};

const executeTests = async (tests, baseUrl, options = {}) => {
  const {
    concurrency = 3,
    delayMs = 100,
    retryOn5xx = true,
    maxRetries = 2,
  } = options;

  const normalizedBase = baseUrl.replace(/\/$/, '');
  const results = [];
  let activeCount = 0;
  let testIndex = 0;

  const executeOne = async (test) => {
    const resolvedPath = resolvePathParameters(test.path);
    let url = `${normalizedBase}${resolvedPath}`;

    if (test.queryParams) {
      const entries = Object.entries(test.queryParams).map(([k, v]) => [k, String(v)]);
      const qs = new URLSearchParams(entries).toString();
      if (qs) url += `?${qs}`;
    }

    const fetchOptions = {
      method: test.method,
      headers: test.headers,
      body: test.body !== undefined
        ? (typeof test.body === 'string' ? test.body : JSON.stringify(test.body))
        : undefined,
    };

    let response = null;
    let lastAttempt = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      lastAttempt = attempt;
      response = await measureLatency(url, fetchOptions);

      const is5xx = response.status >= 500 && response.status < 600;
      if (retryOn5xx && is5xx && attempt < maxRetries) {
        const backoff = Math.pow(2, attempt) * 500 + Math.random() * 250;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      break;
    }

    const validation = validateResponse(response, test);

    return {
      test,
      response,
      validation,
      retries: lastAttempt,
    };
  };

  return new Promise((resolve) => {
    const queue = [...tests];
    const totalTests = queue.length;

    if (totalTests === 0) {
      resolve({
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, avgLatencyMs: 0, p95LatencyMs: 0, p99LatencyMs: 0 },
      });
      return;
    }

    const processNext = () => {
      if (results.length === totalTests) {
        const latencies = results
          .map((r) => r.response?.latencyMs ?? 0)
          .filter((l) => l > 0);

        const passed = results.filter((r) => r.validation.passed).length;
        const failed = results.length - passed;
        const avgLatencyMs = latencies.length > 0
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : 0;

        resolve({
          results,
          summary: {
            total: totalTests,
            passed,
            failed,
            skipped: 0,
            avgLatencyMs,
            p95LatencyMs: calculatePercentile(latencies, 95),
            p99LatencyMs: calculatePercentile(latencies, 99),
          },
        });
        return;
      }

      while (activeCount < concurrency && testIndex < totalTests) {
        const test = queue[testIndex];
        testIndex++;
        activeCount++;

        const currentIndex = testIndex;

        executeOne(test).then((result) => {
          results.push(result);
          activeCount--;

          const icon = result.validation.passed ? '[PASS]' : '[FAIL]';
          const retryNote = result.retries > 0 ? ` (retries: ${result.retries})` : '';
          console.log(`  ${icon} ${result.test.id}: ${result.test.name} (${result.response?.latencyMs ?? '?'}ms)${retryNote}`);

          if (delayMs > 0 && testIndex < totalTests) {
            setTimeout(processNext, delayMs);
          } else {
            processNext();
          }
        });
      }
    };

    processNext();
  });
};

// ---------------------------------------------------------------------------
// AI-powered functions
// ---------------------------------------------------------------------------

const aiGenerateTests = async (specOrEndpoints, options = {}) => {
  const { depth = 'standard', includeNegative = true } = options;

  let specSummary;
  if (typeof specOrEndpoints === 'string') {
    try {
      const parsed = parseOpenApiSpec(specOrEndpoints);
      specSummary = JSON.stringify(parsed.endpoints.map((ep) => ({
        method: ep.method, path: ep.path, summary: ep.summary, parameters: ep.parameters, requestBody: ep.requestBody, responses: Object.keys(ep.responses ?? {}),
      })), null, 2);
    } catch {
      specSummary = specOrEndpoints;
    }
  } else if (Array.isArray(specOrEndpoints)) {
    specSummary = JSON.stringify(specOrEndpoints, null, 2);
  } else {
    specSummary = JSON.stringify(specOrEndpoints, null, 2);
  }

  const prompt = [
    `You are an expert API test engineer. Generate comprehensive test cases for the following API endpoints.`,
    ``,
    `Depth: ${depth}`,
    `Include negative tests: ${includeNegative}`,
    ``,
    `For each test case, return a JSON object with:`,
    `{ "id": "TC-XXXX", "name": "descriptive name", "method": "GET|POST|...", "path": "/...", "type": "positive|negative|boundary|security", "headers": {}, "queryParams": {}, "body": {}, "expectedStatus": 200, "description": "what this tests", "rationale": "why this matters" }`,
    ``,
    `Return ONLY a JSON array of test objects. No preamble.`,
    ``,
    `--- API ENDPOINTS ---`,
    specSummary,
  ].join('\n');

  const result = await invokeAgentWithRetry('FORGE', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback to local test generation
    let endpoints = [];
    try {
      if (typeof specOrEndpoints === 'string') {
        const parsed = parseOpenApiSpec(specOrEndpoints);
        endpoints = parsed.endpoints;
      } else if (Array.isArray(specOrEndpoints)) {
        endpoints = specOrEndpoints;
      }
    } catch {
      // Cannot parse
    }
    if (endpoints.length > 0) {
      const localTests = generateTestCases(endpoints, depth);
      return { ok: true, tests: localTests, durationMs: 0, fallback: true };
    }
    return { ok: false, error: result.error };
  }

  const parsed = extractJSON(result.data);
  if (Array.isArray(parsed)) {
    return { ok: true, tests: parsed, durationMs: result.durationMs };
  }
  if (parsed && Array.isArray(parsed.tests)) {
    return { ok: true, tests: parsed.tests, durationMs: result.durationMs };
  }

  return { ok: true, tests: [], analysis: result.data, durationMs: result.durationMs };
};

const analyzeTestResults = async (results) => {
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.validation.passed).length,
    failed: results.filter((r) => !r.validation.passed).length,
    byType: {},
    failures: results.filter((r) => !r.validation.passed).map((r) => ({
      test: r.test.name, type: r.test.type, expected: r.test.expectedStatus, actual: r.response?.status,
      failedChecks: r.validation.checks.filter((c) => !c.passed).map((c) => c.detail),
    })),
    latencyStats: {
      avg: results.length > 0 ? Math.round(results.reduce((s, r) => s + (r.response?.latencyMs ?? 0), 0) / results.length) : 0,
      max: results.length > 0 ? Math.max(...results.map((r) => r.response?.latencyMs ?? 0)) : 0,
      min: results.filter((r) => r.response?.latencyMs > 0).length > 0 ? Math.min(...results.filter((r) => r.response?.latencyMs > 0).map((r) => r.response.latencyMs)) : 0,
    },
  };

  for (const r of results) {
    const type = r.test.type ?? 'unknown';
    if (!summary.byType[type]) summary.byType[type] = { passed: 0, failed: 0 };
    if (r.validation.passed) summary.byType[type].passed++;
    else summary.byType[type].failed++;
  }

  const prompt = [
    `You are a senior QA engineer analyzing API test results. Provide a comprehensive analysis.`,
    `Include: 1. Overall assessment 2. Pattern analysis 3. Security concerns 4. Performance assessment 5. Recommendations 6. Additional tests needed`,
    ``,
    `--- TEST RESULTS SUMMARY ---`,
    JSON.stringify(summary, null, 2),
  ].join('\n');

  const result = await invokeAgentWithRetry('FORGE', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback: local analysis summary
    const failRate = summary.total > 0 ? ((summary.failed / summary.total) * 100).toFixed(1) : 0;
    const securityFails = (summary.byType.security?.failed || 0);
    const analysis = [
      `API Health: ${summary.passed}/${summary.total} tests passed (${failRate}% failure rate).`,
      `Latency: avg ${summary.latencyStats.avg}ms, max ${summary.latencyStats.max}ms.`,
      securityFails > 0 ? `SECURITY CONCERN: ${securityFails} security tests failed.` : 'No security test failures.',
      summary.failures.length > 0 ? `Failed tests: ${summary.failures.map(f => f.test).join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return { ok: true, analysis, fallback: true };
  }
  return { ok: true, analysis: result.data, durationMs: result.durationMs };
};

const generateMockServer = async (spec) => {
  const parsed = typeof spec === 'string' ? parseOpenApiSpec(spec) : spec;

  const endpointsSummary = (parsed.endpoints ?? []).map((ep) => ({
    method: ep.method, path: ep.path, parameters: ep.parameters, requestBody: ep.requestBody, responses: ep.responses,
  }));

  const prompt = [
    `You are an infrastructure engineer. Generate a complete mock server configuration for the following API.`,
    `The mock server should: 1. Return realistic sample data 2. Validate request bodies 3. Support configurable delays 4. Include error responses 5. Be in portable JSON format`,
    `Return ONLY valid JSON. No preamble.`,
    ``,
    `--- API ENDPOINTS ---`,
    JSON.stringify(endpointsSummary, null, 2),
  ].join('\n');

  const result = await invokeAgentWithRetry('FORGE', prompt, { includeSubAgents: false });
  if (!result.ok) {
    // Fallback: generate basic mock config locally
    const routes = (parsed.endpoints ?? []).map(ep => ({
      method: ep.method,
      path: ep.path,
      responses: { '200': { body: { status: 'ok', mock: true }, headers: { 'content-type': 'application/json' } } },
      delay: 0,
    }));
    return { ok: true, mockConfig: JSON.stringify({ routes }, null, 2), fallback: true };
  }
  return { ok: true, mockConfig: result.data, durationMs: result.durationMs };
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const run = async (args) => {
  const command = args.command || args._?.[0] || 'test';
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  if (command === 'mock') {
    if (!args.spec || (typeof args.spec === 'string' && args.spec.trim().length === 0)) {
      console.error('Error: --spec is required for mock generation (path to OpenAPI JSON file).');
      process.exit(1);
    }
    const specContent = await fs.readFile(path.resolve(args.spec), 'utf-8');
    console.log('Generating mock server configuration via FORGE...\n');
    const result = await generateMockServer(specContent);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.fallback) console.log('(AI unavailable \u2014 using local mock config)\n');
    if (args.output) {
      await fs.writeFile(path.resolve(args.output), result.mockConfig, 'utf-8');
      console.log(`Mock config written to ${args.output}`);
    } else {
      console.log(result.mockConfig);
    }
    if (result.durationMs) console.log(`\n--- Generated in ${result.durationMs}ms ---`);
    return;
  }

  if (command === 'analyze') {
    if (!args.input || (typeof args.input === 'string' && args.input.trim().length === 0)) {
      console.error('Error: --input is required for analysis (path to test results JSON).');
      process.exit(1);
    }
    const content = await fs.readFile(path.resolve(args.input), 'utf-8');
    const results = JSON.parse(content);
    console.log('Analyzing test results via FORGE...\n');
    const analysis = await analyzeTestResults(results);
    if (!analysis.ok) {
      console.error(`Error: ${analysis.error}`);
      process.exit(1);
    }
    if (analysis.fallback) console.log('(AI unavailable \u2014 showing local analysis)\n');
    console.log(analysis.analysis);
    if (analysis.durationMs) console.log(`\n--- Analyzed in ${analysis.durationMs}ms ---`);
    return;
  }

  // Default: test
  if (!args.spec || (typeof args.spec === 'string' && args.spec.trim().length === 0)) {
    console.error('Error: --spec is required (path to OpenAPI JSON file).');
    process.exit(1);
  }

  const specContent = await fs.readFile(path.resolve(args.spec), 'utf-8');
  const spec = parseOpenApiSpec(specContent);
  const depth = args.depth || 'standard';

  console.log(`Parsed spec: "${spec.title}" v${spec.version} \u2014 ${spec.endpoints.length} endpoints`);
  console.log(`Generating test cases (depth: ${depth})...\n`);

  const localTests = generateTestCases(spec.endpoints, depth);
  console.log(`Generated ${localTests.length} local test cases.`);

  console.log('Requesting AI-generated tests from FORGE...\n');
  const aiResult = await aiGenerateTests(specContent, { depth, includeNegative: true });
  const aiTests = aiResult.ok && aiResult.tests ? aiResult.tests : [];
  if (aiResult.fallback) console.log('(AI unavailable \u2014 using local tests only)');
  else console.log(`FORGE generated ${aiTests.length} additional test cases.`);

  const allTests = [...localTests, ...aiTests];

  if (args.url) {
    const baseUrl = args.url.replace(/\/$/, '');
    const concurrency = Number(args.concurrency) || 3;
    const delayMs = args.delay !== undefined ? Number(args.delay) : 100;

    console.log(`\nExecuting ${allTests.length} tests against ${baseUrl} (concurrency: ${concurrency}, delay: ${delayMs}ms)...\n`);

    const { results, summary } = await executeTests(allTests, baseUrl, {
      concurrency,
      delayMs,
      retryOn5xx: true,
      maxRetries: 2,
    });

    console.log(`\n--- Execution complete: ${summary.passed}/${summary.total} passed, avg ${summary.avgLatencyMs}ms, p95 ${summary.p95LatencyMs}ms, p99 ${summary.p99LatencyMs}ms ---\n`);

    const report = formatTestReport(results, summary);
    if (args.output) {
      await fs.writeFile(path.resolve(args.output), report, 'utf-8');
      console.log(`Report written to ${args.output}`);
      const jsonPath = args.output.replace(/\.[^.]+$/, '.json');
      await fs.writeFile(path.resolve(jsonPath), JSON.stringify({ results, summary }, null, 2), 'utf-8');
      console.log(`Raw results written to ${jsonPath}`);
    } else {
      console.log(report);
    }

    console.log('\nAnalyzing results via FORGE...\n');
    const analysis = await analyzeTestResults(results);
    if (analysis.ok) {
      if (analysis.fallback) console.log('(AI unavailable \u2014 showing local analysis)\n');
      console.log(analysis.analysis);
    }
  } else {
    console.log(`\nTest plan (${allTests.length} tests):\n`);
    for (const test of allTests) {
      console.log(`  ${test.id} [${test.type}] ${test.method} ${test.path} \u2014 ${test.description}`);
    }
    console.log('\nTo execute tests, add --url <base-url>');
  }
};

// ---------------------------------------------------------------------------
// Extension metadata
// ---------------------------------------------------------------------------

export const EXTENSION_META = {
  name: 'nha-api-tester',
  displayName: 'API Tester',
  category: 'devops',
  version: '2.2.0',
  description: 'Generate and execute intelligent API test suites from OpenAPI specs. Uses FORGE agent for AI-powered test generation, result analysis, and mock server creation with edge case coverage, boundary values, and security testing.',
  commands: [
    { name: 'test', description: 'Generate and optionally execute API tests from a spec', args: '--spec <path> [--url <base-url>] [--depth smoke|standard|thorough] [--concurrency <n>] [--delay <ms>] [--output <path>]' },
    { name: 'analyze', description: 'AI-analyze test results and suggest improvements', args: '--input <results.json>' },
    { name: 'mock', description: 'Generate a mock server configuration from an API spec', args: '--spec <path> [--output <path>]' },
  ],
  examplePrompts: [
    'Generate thorough API tests for my OpenAPI spec including security checks',
    'Run smoke tests against my staging server and report failures',
    'Analyze these test results and tell me what patterns you see in the failures',
    'Create a mock server config so I can test my frontend without the real API',
    'Generate boundary value tests for all string and integer parameters',
  ],
  useCases: [
    'Automated API regression testing from OpenAPI specifications',
    'Security testing including injection, auth bypass, and XSS detection',
    'Pre-deploy smoke tests for CI/CD pipelines',
    'Mock server generation for frontend development isolation',
    'Post-test analysis with AI-driven pattern detection and recommendations',
  ],
};

export {
  parseOpenApiSpec,
  generateTestCases,
  validateResponse,
  measureLatency,
  formatTestReport,
  calculatePercentile,
  executeTests,
  aiGenerateTests,
  analyzeTestResults,
  generateMockServer,
  run,
};
