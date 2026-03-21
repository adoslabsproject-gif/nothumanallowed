/**
 * nha-monitoring-setup — PIF Extension v2.1.0
 *
 * Design complete monitoring stacks with SLI/SLO definitions, Prometheus alerting rules,
 * Grafana dashboards, and incident runbooks. Uses HEIMDALL for monitoring strategy
 * and SAURON for root cause analysis.
 *
 * @category monitoring
 * @version 2.1.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   // Local rule generation
 *   import { parseSLI, calculateErrorBudget, generateAlertRule } from './extensions/nha-monitoring-setup.mjs';
 *   const budget = calculateErrorBudget(99.9, 99.85, 30);
 *   const rule = generateAlertRule({ name: 'HighLatency', expr: 'http_duration_seconds > 1', for: '5m' });
 *
 * @example
 *   // AI-powered monitoring design
 *   import { designMonitoring, analyzeIncident } from './extensions/nha-monitoring-setup.mjs';
 *   const setup = await designMonitoring('Node.js REST API with PostgreSQL', { tier: 'growth', stack: 'node' });
 *
 * @example
 *   // CLI usage
 *   pif ext nha-monitoring-setup --system "Node.js API with Redis and PostgreSQL" --tier growth --stack node
 *   pif ext nha-monitoring-setup --command incident --input ./logs.txt --metrics ./metrics.json
 *   pif ext nha-monitoring-setup --command optimize --input ./alerts.yml --false-positive-rate 0.15
 */

const NHA_API = 'https://nothumanallowed.com/api/v1';

const AGENT_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Common Grafana units for validation
// ---------------------------------------------------------------------------

const VALID_GRAFANA_UNITS = new Set([
  // Time
  'ns', 'µs', 'us', 'ms', 's', 'm', 'h', 'd',
  'dtdurationms', 'dtdurations', 'dthms', 'dtdhms', 'timeticks', 'clockms', 'clocks',
  // Throughput
  'ops', 'reqps', 'rps', 'wps', 'iops', 'opm', 'rpm', 'wpm',
  // Data / bytes
  'bytes', 'bits', 'kbytes', 'mbytes', 'gbytes', 'tbytes', 'pbytes',
  'decbytes', 'decbits', 'deckbytes', 'decmbytes', 'decgbytes', 'dectbytes', 'decpbytes',
  // Data rate
  'pps', 'Bps', 'KBs', 'MBs', 'GBs', 'TBs', 'PBs',
  'binBps', 'binKBs', 'binMBs', 'binGBs', 'binTBs', 'binPBs',
  'bps', 'Kbits', 'Mbits', 'Gbits', 'Tbits', 'Pbits',
  // Percent
  'percent', 'percentunit',
  // Misc
  'short', 'none', 'string', 'bool', 'bool_yes_no', 'bool_on_off',
  'locale', 'sci', 'hex', 'hex0x',
  // Currency
  'currencyUSD', 'currencyGBP', 'currencyEUR', 'currencyJPY',
  // Velocity / acceleration
  'velocityms', 'velocitykmh', 'velocitymph', 'velocityknot',
  'accMS2', 'accGS', 'accFTS2',
  // Temperature
  'celsius', 'fahrenheit', 'kelvin',
  // Humidity
  'humidity',
  // Pressure
  'pressurembar', 'pressurehpa', 'pressurehg', 'pressurepsi',
  // Energy / power
  'watt', 'kwatt', 'mwatt', 'voltamp', 'kvoltamp',
  'watth', 'kwatth', 'mwatth', 'joule', 'ev', 'amp', 'kamp', 'mamp',
  'volt', 'kvolt', 'mvolt', 'dBm', 'ohm', 'kohm', 'mohm',
  'farad', 'µfarad', 'nfarad', 'pfarad', 'ffarad',
  'henry', 'mhenry', 'µhenry',
  'lumens',
  // Frequency
  'hertz', 'khertz', 'mhertz', 'ghertz', 'thertz', 'rpm_frequency',
  // Concentration
  'ppm', 'conppb', 'conngm3', 'conµgm3', 'conmgm3',
  // Length
  'lengthm', 'lengthmm', 'lengthkm', 'lengthmi', 'lengthft', 'lengthin',
  // Area
  'areaM2', 'areaF2', 'areaMI2',
  // Mass / weight
  'massmg', 'massg', 'masskg', 'masst',
  // Flow
  'flowgps', 'flowcms', 'flowcfs', 'flowcfm', 'litreh', 'flowlpm', 'flowmlpm',
  // Angle
  'degree', 'radian', 'grad', 'arcmin', 'arcsec',
  // Radiation
  'radbq', 'radci', 'radgy', 'radrad', 'radsv', 'radmsv', 'radusv', 'radrem', 'radexph', 'radrem_h',
  // Concentration
  'conmgdL', 'conmmolL',
]);

// ---------------------------------------------------------------------------
// YAML special characters requiring quoting
// ---------------------------------------------------------------------------

const YAML_SPECIAL_CHARS_RE = /[:#{}\[\],&*?|<>=!%@\\]/;

/**
 * Escape and quote a YAML value if it contains special characters.
 * @param {string} value - The raw YAML value
 * @returns {string} Safely quoted YAML value
 */
const yamlQuote = (value) => {
  if (typeof value !== 'string') return String(value);
  if (value === '') return '""';
  // Always quote if it contains YAML special chars, starts with -, or is a YAML boolean/null keyword
  const lower = value.toLowerCase();
  const yamlKeywords = ['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~'];
  if (
    YAML_SPECIAL_CHARS_RE.test(value) ||
    value.startsWith('-') ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    yamlKeywords.includes(lower)
  ) {
    // Use double quotes with escaping for backslash and double-quote
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
};

/**
 * Validate that an alert name matches Prometheus identifier pattern.
 * @param {string} name - Alert name
 * @returns {string} Sanitized alert name
 */
const sanitizeAlertName = (name) => {
  if (/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) return name;
  // Replace invalid characters with underscores, ensure starts with letter/underscore
  let sanitized = name.replace(/[^a-zA-Z0-9_:]/g, '_');
  if (!/^[a-zA-Z_:]/.test(sanitized)) sanitized = '_' + sanitized;
  return sanitized;
};

/**
 * Validate a Grafana unit string against known units.
 * @param {string|undefined} unit - The unit to validate
 * @returns {string|undefined} The unit if valid, undefined otherwise
 */
const validateGrafanaUnit = (unit) => {
  if (!unit) return undefined;
  if (VALID_GRAFANA_UNITS.has(unit)) return unit;
  // Try common aliases
  const aliases = { 'milliseconds': 'ms', 'seconds': 's', 'minutes': 'm', 'hours': 'h', 'days': 'd', 'percentage': 'percent', '%': 'percentunit' };
  if (aliases[unit]) return aliases[unit];
  return undefined;
};

// ---------------------------------------------------------------------------
// Agent invocation helper
// ---------------------------------------------------------------------------

/**
 * Invoke a Legion agent via the NHA API with a 15-second timeout.
 * @param {string} agentName - The agent identifier (e.g. 'HEIMDALL', 'SAURON')
 * @param {string} prompt - The task prompt
 * @param {object} config - Additional body parameters
 * @returns {Promise<{ok: boolean, data?: string, error?: string, durationMs: number}>}
 */
const invokeAgent = async (agentName, prompt, config = {}) => {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

    const res = await fetch(`${NHA_API}/legion/agents/${agentName}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ...config }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const durationMs = Date.now() - start;

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown error');
      return { ok: false, error: `HTTP ${res.status}: ${body}`, durationMs };
    }

    const json = await res.json();
    return {
      ok: true,
      data: json.data?.response ?? json.response ?? '',
      durationMs: json.data?.durationMs ?? durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err.name === 'AbortError'
      ? `Request to ${agentName} timed out after ${AGENT_TIMEOUT_MS}ms`
      : `Network error: ${err.message}`;
    return { ok: false, error: message, durationMs };
  }
};

// ---------------------------------------------------------------------------
// Local pure functions — fast, no network
// ---------------------------------------------------------------------------

/**
 * Parse an SLI definition string into a structured object.
 * Supports formats like:
 *   "latency:p99 < 200ms"
 *   "latency:p99.9 < 500ms"
 *   "availability >= 99.9%"
 *   "error_rate < 0.1%"
 *   "throughput:rps >= 1000"
 *   "success_ratio >= 0.999"
 *   "http_request_duration_seconds:p95 < 1s"
 * @param {string} sliString - SLI definition string
 * @returns {{ metric: string, qualifier?: string, operator: string, threshold: number, unit: string }}
 */
const parseSLI = (sliString) => {
  const trimmed = sliString.trim();

  // Pattern: metric[:qualifier] <operator> <threshold><unit>
  // metric: word chars, underscores, dots (compound metric names)
  // qualifier: word chars, dots (p99, p99.9, p95, rps, etc.)
  const match = trimmed.match(
    /^([\w.]+(?:_[\w.]+)*)(?::([\w.]+))?\s*(<=|>=|<|>|==|!=)\s*(-?\d+(?:\.\d+)?)\s*(%|ms|s|m|h|rps|qps|req\/s|MB|GB|KB)?$/i
  );

  if (!match) {
    // Fallback: try ratio format like "0.999" or simpler metric + value
    const ratioMatch = trimmed.match(/^([\w._]+)\s+(0\.\d+|\d+(?:\.\d+)?)\s*(%|ms|s)?$/i);
    if (ratioMatch) {
      return {
        metric: ratioMatch[1],
        operator: '>=',
        threshold: parseFloat(ratioMatch[2]),
        unit: ratioMatch[3] || '',
      };
    }
    return { metric: trimmed, operator: '>=', threshold: 0, unit: '' };
  }

  return {
    metric: match[1],
    ...(match[2] ? { qualifier: match[2] } : {}),
    operator: match[3],
    threshold: parseFloat(match[4]),
    unit: match[5] || '',
  };
};

/**
 * Calculate error budget given an SLO target and current performance.
 * @param {number} sloTarget - SLO target as percentage (e.g. 99.9)
 * @param {number} currentRate - Current success/availability rate as percentage (e.g. 99.85)
 * @param {number} windowDays - Window size in days (e.g. 30)
 * @returns {{ totalBudgetMinutes: number, consumedMinutes: number, remainingMinutes: number, consumedPercent: number, burnRate: number, projectedExhaustion: number|null, status: 'healthy'|'warning'|'critical'|'exhausted' }}
 */
const calculateErrorBudget = (sloTarget, currentRate, windowDays) => {
  const totalMinutes = windowDays * 24 * 60;
  const allowedErrorRate = (100 - sloTarget) / 100;
  const actualErrorRate = (100 - currentRate) / 100;

  const totalBudgetMinutes = Math.round(totalMinutes * allowedErrorRate * 100) / 100;
  const consumedMinutes = Math.round(totalMinutes * actualErrorRate * 100) / 100;
  const remainingMinutes = Math.round((totalBudgetMinutes - consumedMinutes) * 100) / 100;
  const consumedPercent = totalBudgetMinutes > 0
    ? Math.round((consumedMinutes / totalBudgetMinutes) * 10000) / 100
    : 100;

  // Burn rate: how fast are we consuming budget relative to expected
  const burnRate = allowedErrorRate > 0
    ? Math.round((actualErrorRate / allowedErrorRate) * 100) / 100
    : Infinity;

  // Project when budget exhausts (null if burn rate <= 1)
  let projectedExhaustion = null;
  if (burnRate > 1 && remainingMinutes > 0) {
    const remainingBudgetRate = remainingMinutes / totalMinutes;
    const consumptionRate = actualErrorRate - allowedErrorRate;
    if (consumptionRate > 0) {
      projectedExhaustion = Math.round((remainingBudgetRate / consumptionRate) * windowDays * 100) / 100;
    }
  }

  let status = 'healthy';
  if (consumedPercent >= 100) status = 'exhausted';
  else if (consumedPercent >= 80) status = 'critical';
  else if (consumedPercent >= 50) status = 'warning';

  return {
    totalBudgetMinutes,
    consumedMinutes,
    remainingMinutes,
    consumedPercent,
    burnRate,
    projectedExhaustion,
    status,
  };
};

/**
 * Generate a Prometheus alerting rule from parameters.
 * Validates alert name against Prometheus identifier pattern and properly quotes YAML values.
 * @param {object} params
 * @param {string} params.name - Alert name (PascalCase)
 * @param {string} params.expr - PromQL expression
 * @param {string} [params.for='5m'] - Duration before firing
 * @param {'critical'|'warning'|'info'} [params.severity='warning']
 * @param {string} [params.summary] - Alert summary template
 * @param {string} [params.description] - Alert description template
 * @param {string} [params.runbookUrl] - Link to runbook
 * @param {object} [params.labels] - Additional labels
 * @returns {string} YAML-formatted Prometheus alert rule
 */
const generateAlertRule = (params) => {
  const {
    name,
    expr,
    for: forDuration = '5m',
    severity = 'warning',
    summary,
    description,
    runbookUrl,
    labels = {},
  } = params;

  const safeName = sanitizeAlertName(name);
  const allLabels = { severity, ...labels };
  const annotations = {};
  if (summary) annotations.summary = summary;
  if (description) annotations.description = description;
  if (runbookUrl) annotations.runbook_url = runbookUrl;

  // PromQL expressions always need quoting in YAML (they contain special chars like {}, :, etc.)
  const quotedExpr = yamlQuote(expr);

  let yaml = `- alert: ${safeName}\n`;
  yaml += `  expr: ${quotedExpr}\n`;
  yaml += `  for: ${forDuration}\n`;

  yaml += `  labels:\n`;
  for (const [k, v] of Object.entries(allLabels)) {
    yaml += `    ${k}: ${yamlQuote(v)}\n`;
  }

  if (Object.keys(annotations).length > 0) {
    yaml += `  annotations:\n`;
    for (const [k, v] of Object.entries(annotations)) {
      yaml += `    ${k}: ${yamlQuote(v)}\n`;
    }
  }

  return yaml;
};

/**
 * Generate a Grafana JSON panel definition.
 * Supports timeseries, stat, gauge, table, heatmap, and logs panel types.
 * Validates unit against common Grafana units list.
 * @param {object} params
 * @param {string} params.title - Panel title
 * @param {'timeseries'|'stat'|'gauge'|'table'|'heatmap'|'logs'} [params.type='timeseries']
 * @param {Array<{expr: string, legendFormat?: string}>} params.targets - PromQL targets
 * @param {object} [params.gridPos] - { x, y, w, h }
 * @param {object} [params.thresholds] - { steps: [{value, color}] }
 * @param {string} [params.unit] - Grafana unit (e.g. 'ms', 'percentunit', 'short')
 * @returns {object} Grafana panel JSON
 */
const formatGrafanaPanel = (params) => {
  const {
    title,
    type = 'timeseries',
    targets,
    gridPos = { x: 0, y: 0, w: 12, h: 8 },
    thresholds,
    unit,
  } = params;

  const validatedUnit = validateGrafanaUnit(unit);

  // Ensure thresholds always have a base step with null value for the default color
  let resolvedThresholds = undefined;
  if (thresholds) {
    const steps = thresholds.steps ?? [
      { value: null, color: 'green' },
      { value: 80, color: 'yellow' },
      { value: 95, color: 'red' },
    ];
    // Ensure first step has value: null (base/default color)
    if (steps.length > 0 && steps[0].value !== null) {
      steps.unshift({ value: null, color: 'green' });
    }
    // Ensure every step has a color
    for (const step of steps) {
      if (!step.color) step.color = 'green';
    }
    resolvedThresholds = { mode: 'absolute', steps };
  }

  const panel = {
    title,
    type,
    gridPos,
    datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' },
    targets: targets.map((t, i) => ({
      expr: t.expr,
      legendFormat: t.legendFormat ?? '',
      refId: String.fromCharCode(65 + i), // A, B, C...
    })),
    fieldConfig: {
      defaults: {
        ...(validatedUnit ? { unit: validatedUnit } : {}),
        ...(resolvedThresholds ? { thresholds: resolvedThresholds } : {}),
      },
      overrides: [],
    },
    options: {},
  };

  // Type-specific options
  if (type === 'timeseries') {
    panel.options = {
      tooltip: { mode: 'multi', sort: 'desc' },
      legend: { displayMode: 'table', placement: 'bottom', calcs: ['mean', 'max', 'last'] },
    };
  } else if (type === 'stat') {
    panel.options = {
      reduceOptions: { calcs: ['lastNotNull'] },
      colorMode: 'background',
    };
  } else if (type === 'gauge') {
    panel.options = {
      reduceOptions: { calcs: ['lastNotNull'] },
      showThresholdLabels: false,
      showThresholdMarkers: true,
    };
  } else if (type === 'heatmap') {
    panel.options = {
      calculate: true,
      yAxis: { axisPlacement: 'left' },
      cellGap: 1,
      color: {
        mode: 'scheme',
        scheme: 'Oranges',
        steps: 128,
      },
      tooltip: { show: true, yHistogram: true },
    };
    // Heatmap uses specific data format
    panel.targets = targets.map((t, i) => ({
      expr: t.expr,
      legendFormat: t.legendFormat ?? '',
      refId: String.fromCharCode(65 + i),
      format: 'heatmap',
    }));
  } else if (type === 'logs') {
    panel.options = {
      showTime: true,
      showLabels: true,
      showCommonLabels: false,
      wrapLogMessage: true,
      prettifyLogMessage: false,
      enableLogDetails: true,
      sortOrder: 'Descending',
      dedupStrategy: 'none',
    };
    // Logs panels use loki datasource typically, but keep prometheus if that is what the user has
    panel.targets = targets.map((t, i) => ({
      expr: t.expr,
      legendFormat: t.legendFormat ?? '',
      refId: String.fromCharCode(65 + i),
    }));
  } else if (type === 'table') {
    panel.options = {
      showHeader: true,
      cellHeight: 'sm',
      footer: { show: false, reducer: ['sum'], fields: '' },
      sortBy: [],
    };
    panel.targets = targets.map((t, i) => ({
      expr: t.expr,
      legendFormat: t.legendFormat ?? '',
      refId: String.fromCharCode(65 + i),
      instant: true,
      format: 'table',
    }));
    // Table panels typically use transform to organize columns
    panel.transformations = [
      { id: 'organize', options: {} },
    ];
  }

  return panel;
};

/**
 * Generate a template-based incident runbook.
 * @param {object} params
 * @param {string} params.alertName - The triggering alert name
 * @param {string} params.severity - critical, warning, info
 * @param {string} params.description - What the alert means
 * @param {Array<string>} params.diagnosticSteps - Steps to diagnose the issue
 * @param {Array<string>} params.mitigationSteps - Steps to mitigate the issue
 * @param {Array<string>} [params.escalation] - Escalation contacts/procedures
 * @param {string} [params.relatedDashboard] - URL to related Grafana dashboard
 * @returns {string} Markdown runbook
 */
const generateRunbook = (params) => {
  const {
    alertName,
    severity,
    description,
    diagnosticSteps,
    mitigationSteps,
    escalation = [],
    relatedDashboard,
  } = params;

  const lines = [
    `# Runbook: ${alertName}`,
    '',
    `**Severity**: ${severity}`,
    `**Last Updated**: ${new Date().toISOString().split('T')[0]}`,
    '',
    '## Description',
    '',
    description,
    '',
    '## Diagnostic Steps',
    '',
  ];

  for (let i = 0; i < diagnosticSteps.length; i++) {
    lines.push(`${i + 1}. ${diagnosticSteps[i]}`);
  }

  lines.push('', '## Mitigation Steps', '');

  for (let i = 0; i < mitigationSteps.length; i++) {
    lines.push(`${i + 1}. ${mitigationSteps[i]}`);
  }

  if (escalation.length > 0) {
    lines.push('', '## Escalation', '');
    for (const e of escalation) {
      lines.push(`- ${e}`);
    }
  }

  if (relatedDashboard) {
    lines.push('', '## Related', '', `- [Dashboard](${relatedDashboard})`);
  }

  lines.push('', '## Post-Incident', '', '1. Document the root cause');
  lines.push('2. Update this runbook with any new learnings');
  lines.push('3. Create follow-up tickets for permanent fixes');
  lines.push('4. Schedule a blameless post-mortem if severity is critical');

  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Local fallback templates — used when agent API is unavailable
// ---------------------------------------------------------------------------

/**
 * Generate a basic monitoring setup from local templates only (no AI).
 * Used as fallback when HEIMDALL/SAURON API calls fail.
 * @param {string} systemDescription - Description of the system
 * @param {object} options
 * @param {'startup'|'growth'|'enterprise'} [options.tier='growth']
 * @param {'node'|'go'|'python'} [options.stack='node']
 * @returns {object} monitoring setup structure
 */
const generateLocalMonitoringFallback = (systemDescription, options = {}) => {
  const { tier = 'growth', stack = 'node' } = options;
  const desc = systemDescription.toLowerCase();

  const slis = [
    { name: 'Availability', type: 'availability', definition: 'sum(rate(http_requests_total{code!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))', sloTarget: '99.9%' },
    { name: 'Latency P99', type: 'latency', definition: 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))', sloTarget: '< 500ms' },
    { name: 'Error Rate', type: 'correctness', definition: 'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))', sloTarget: '< 0.1%' },
  ];

  if (tier !== 'startup') {
    slis.push(
      { name: 'Throughput', type: 'throughput', definition: 'sum(rate(http_requests_total[5m]))', sloTarget: '>= 100 rps' },
    );
  }

  const alerts = [
    { name: 'HighErrorRate', expr: 'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.01', for: '5m', severity: 'critical', summary: 'Error rate above 1%', description: 'The HTTP 5xx error rate has exceeded 1% for 5 minutes.' },
    { name: 'HighLatency', expr: 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 1', for: '5m', severity: 'warning', summary: 'P99 latency above 1s', description: 'The 99th percentile latency has exceeded 1 second for 5 minutes.' },
    { name: 'HighMemoryUsage', expr: 'process_resident_memory_bytes / 1024 / 1024 > 512', for: '10m', severity: 'warning', summary: 'Memory usage above 512MB', description: 'Process resident memory has exceeded 512MB for 10 minutes.' },
  ];

  if (desc.includes('postgres') || desc.includes('database') || desc.includes('db')) {
    alerts.push(
      { name: 'DatabaseConnectionPoolExhausted', expr: 'pg_stat_activity_count / pg_settings_max_connections > 0.8', for: '5m', severity: 'critical', summary: 'DB connections above 80%', description: 'PostgreSQL connection pool is above 80% capacity.' },
    );
  }

  if (desc.includes('redis') || desc.includes('cache')) {
    alerts.push(
      { name: 'RedisHighMemory', expr: 'redis_memory_used_bytes / redis_memory_max_bytes > 0.8', for: '5m', severity: 'warning', summary: 'Redis memory above 80%', description: 'Redis memory usage has exceeded 80% of max.' },
    );
  }

  const dashboards = [
    {
      title: `${stack.charAt(0).toUpperCase() + stack.slice(1)} Service Overview`,
      panels: [
        { title: 'Request Rate', type: 'timeseries', expr: 'sum(rate(http_requests_total[5m]))', unit: 'reqps' },
        { title: 'Error Rate', type: 'stat', expr: 'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))', unit: 'percentunit' },
        { title: 'P99 Latency', type: 'timeseries', expr: 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))', unit: 's' },
        { title: 'Memory Usage', type: 'gauge', expr: 'process_resident_memory_bytes', unit: 'bytes' },
      ],
    },
  ];

  const runbooks = alerts.map((a) => ({
    alert: a.name,
    severity: a.severity,
    description: a.description,
    diagnostic: ['Check service logs for errors', 'Review recent deployments', 'Check resource utilization dashboards'],
    mitigation: ['Scale up if resource-constrained', 'Rollback recent deployment if correlated', 'Restart service if unresponsive'],
  }));

  const recommendations = [
    'Set up PagerDuty or Opsgenie integration for critical alerts',
    'Implement distributed tracing with OpenTelemetry for request path visibility',
    'Add custom business metrics (e.g., orders/sec, signups/hour) alongside infrastructure metrics',
  ];

  if (tier === 'enterprise') {
    recommendations.push('Implement anomaly detection on key SLIs using recording rules and ML-based alerting');
    recommendations.push('Set up cross-region monitoring with federated Prometheus');
  }

  return { slis, alerts, dashboards, runbooks, recommendations };
};

// ---------------------------------------------------------------------------
// AI-powered functions — require network (with local fallback)
// ---------------------------------------------------------------------------

/**
 * Use HEIMDALL to design a complete monitoring setup for a system.
 * Falls back to local template generation if the API is unavailable.
 * @param {string} systemDescription - Description of the system to monitor
 * @param {object} [options]
 * @param {'startup'|'growth'|'enterprise'} [options.tier='growth']
 * @param {'node'|'go'|'python'} [options.stack='node']
 * @returns {Promise<{ok: boolean, monitoring?: object, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const designMonitoring = async (systemDescription, options = {}) => {
  const { tier = 'growth', stack = 'node' } = options;

  const tierGuidelines = {
    startup: 'Focus on the 3-5 most critical signals. Minimize alert count. Keep setup simple and low-maintenance.',
    growth: 'Comprehensive monitoring with SLI/SLO framework. Alert on symptoms not causes. Include capacity planning signals.',
    enterprise: 'Full observability stack. Distributed tracing. Anomaly detection. Multi-signal correlation. Compliance audit trails.',
  };

  const prompt = [
    `You are a senior SRE designing monitoring for a production system.`,
    ``,
    `System: ${systemDescription}`,
    `Tier: ${tier} — ${tierGuidelines[tier] ?? tierGuidelines.growth}`,
    `Stack: ${stack}`,
    ``,
    `Design a complete monitoring setup. Return ONLY valid JSON:`,
    `{`,
    `  "slis": [`,
    `    { "name": "<SLI name>", "type": "availability|latency|throughput|correctness|freshness", "definition": "<PromQL or description>", "sloTarget": "<target as string, e.g. 99.9%>" }`,
    `  ],`,
    `  "alerts": [`,
    `    { "name": "<PascalCase>", "expr": "<PromQL>", "for": "<duration>", "severity": "critical|warning", "summary": "<template>", "description": "<template>", "runbook": "<step-by-step>" }`,
    `  ],`,
    `  "dashboards": [`,
    `    { "title": "<dashboard title>", "panels": [`,
    `      { "title": "<panel>", "type": "timeseries|stat|gauge|table|heatmap|logs", "expr": "<PromQL>", "unit": "<grafana unit>" }`,
    `    ]}`,
    `  ],`,
    `  "runbooks": [`,
    `    { "alert": "<alert name>", "severity": "<severity>", "description": "<what it means>", "diagnostic": ["<step1>", "<step2>"], "mitigation": ["<step1>", "<step2>"] }`,
    `  ],`,
    `  "recommendations": ["<additional monitoring recommendations>"]`,
    `}`,
  ].join('\n');

  const result = await invokeAgent('HEIMDALL', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Local fallback: generate monitoring from templates
    const fallbackMonitoring = generateLocalMonitoringFallback(systemDescription, { tier, stack });
    return {
      ok: true,
      monitoring: fallbackMonitoring,
      durationMs: result.durationMs,
      fallback: true,
      error: `HEIMDALL unavailable (${result.error}), generated from local templates`,
    };
  }

  try {
    const jsonMatch = result.data.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const monitoring = JSON.parse(jsonMatch[0]);
      return { ok: true, monitoring, durationMs: result.durationMs };
    }
    return { ok: true, monitoring: null, raw: result.data, durationMs: result.durationMs };
  } catch {
    return { ok: true, monitoring: null, raw: result.data, durationMs: result.durationMs };
  }
};

/**
 * Use SAURON for root cause analysis from log and metric data.
 * Falls back to a structured template if the API is unavailable.
 * @param {string} logs - Log data (text)
 * @param {string|object} metrics - Metric data (text or JSON)
 * @returns {Promise<{ok: boolean, analysis?: string, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const analyzeIncident = async (logs, metrics) => {
  const metricsStr = typeof metrics === 'object' ? JSON.stringify(metrics, null, 2) : metrics;

  const prompt = [
    `You are a senior SRE performing root cause analysis on an incident.`,
    ``,
    `Analyze the following logs and metrics to determine:`,
    `1. **Root Cause**: What triggered the incident?`,
    `2. **Timeline**: Reconstruct the sequence of events`,
    `3. **Impact**: What was affected and how severely?`,
    `4. **Contributing Factors**: What made it worse or delayed detection?`,
    `5. **Immediate Fix**: What should be done right now?`,
    `6. **Permanent Fix**: What structural changes prevent recurrence?`,
    `7. **Detection Gap**: Why wasn't this caught earlier?`,
    ``,
    `--- LOGS ---`,
    logs.slice(0, 15000), // cap to avoid exceeding prompt limits
    ``,
    `--- METRICS ---`,
    metricsStr.slice(0, 10000),
  ].join('\n');

  const result = await invokeAgent('SAURON', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Local fallback: provide structured template with extracted log patterns
    const errorLines = logs.split('\n').filter((l) => /error|fail|exception|panic|fatal|timeout|refused/i.test(l)).slice(0, 20);
    const fallbackAnalysis = [
      '# Incident Analysis (Local Fallback)',
      '',
      '> SAURON agent was unavailable. This is a template-based analysis from log pattern extraction.',
      '',
      '## Extracted Error Patterns',
      '',
      errorLines.length > 0
        ? errorLines.map((l) => `- \`${l.trim().slice(0, 200)}\``).join('\n')
        : '_No obvious error patterns found in logs._',
      '',
      '## Recommended Diagnostic Steps',
      '',
      '1. Identify the first error timestamp and correlate with deployment/change events',
      '2. Check resource utilization (CPU, memory, disk, connections) around the incident window',
      '3. Review upstream dependency health (databases, caches, external APIs)',
      '4. Check for cascading failures or retry storms',
      '5. Verify configuration changes or feature flag toggles',
      '',
      '## Next Steps',
      '',
      '- Re-run this analysis when SAURON is available for AI-powered root cause detection',
      '- Collect additional metrics data for deeper correlation analysis',
    ].join('\n');

    return { ok: true, analysis: fallbackAnalysis, durationMs: result.durationMs, fallback: true };
  }

  return { ok: true, analysis: result.data, durationMs: result.durationMs };
};

/**
 * Use HEIMDALL to optimize alerting rules and reduce alert fatigue.
 * Falls back to basic recommendations if the API is unavailable.
 * @param {string|object} currentRules - Current alerting rules (YAML string or parsed object)
 * @param {number} falsePositiveRate - Current false positive rate (0-1)
 * @returns {Promise<{ok: boolean, optimized?: string, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const optimizeAlerts = async (currentRules, falsePositiveRate) => {
  const rulesStr = typeof currentRules === 'object' ? JSON.stringify(currentRules, null, 2) : currentRules;

  const prompt = [
    `You are a senior SRE optimizing alerting rules to reduce alert fatigue.`,
    ``,
    `Current false positive rate: ${(falsePositiveRate * 100).toFixed(1)}%`,
    ``,
    `Current Rules:`,
    rulesStr,
    ``,
    `Analyze and optimize:`,
    `1. **Noisy alerts**: Which alerts fire too often without actionable issues?`,
    `2. **Threshold tuning**: Suggest adjusted thresholds based on best practices`,
    `3. **Consolidation**: Which alerts can be merged into fewer, more meaningful ones?`,
    `4. **Missing alerts**: What critical conditions are NOT covered?`,
    `5. **Severity alignment**: Are severities correctly assigned?`,
    `6. **Duration tuning**: Which 'for' durations should be adjusted?`,
    `7. **Correlation**: Which alerts could use multi-signal conditions (AND/OR)?`,
    ``,
    `For each optimization, provide before/after rule definitions.`,
  ].join('\n');

  const result = await invokeAgent('HEIMDALL', prompt, { includeSubAgents: false });

  if (!result.ok) {
    const fallbackText = [
      '# Alert Optimization (Local Fallback)',
      '',
      '> HEIMDALL agent was unavailable. Showing generic best-practice recommendations.',
      '',
      `Current false positive rate: ${(falsePositiveRate * 100).toFixed(1)}%`,
      '',
      '## General Recommendations',
      '',
      '1. **Increase `for` durations**: Alerts with `for: 1m` or less often produce false positives. Consider 5m minimum for warnings, 2m for critical.',
      '2. **Use rate() over instant values**: Raw counter values are noisy. Prefer `rate()` or `increase()` over windows.',
      '3. **Multi-signal conditions**: Combine symptoms (e.g., high latency AND high error rate) to reduce noise.',
      '4. **Separate warning from critical**: Ensure warning alerts have longer `for` durations than critical ones.',
      '5. **Remove duplicate alerts**: Alerts on the same metric with different thresholds can often be consolidated.',
      '6. **Add inhibition rules**: Suppress downstream alerts when upstream is already firing.',
      '',
      '## Re-run with HEIMDALL',
      '',
      'When the agent is available, re-run this command for rule-specific before/after optimization.',
    ].join('\n');

    return { ok: true, optimized: fallbackText, durationMs: result.durationMs, fallback: true };
  }

  return { ok: true, optimized: result.data, durationMs: result.durationMs };
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI runner for the monitoring setup extension.
 * @param {object} args - Parsed CLI arguments
 * @param {string} [args.command] - Sub-command: 'design' (default), 'incident', 'optimize', 'budget'
 * @param {string} [args.system] - System description (for design)
 * @param {'startup'|'growth'|'enterprise'} [args.tier='growth']
 * @param {'node'|'go'|'python'} [args.stack='node']
 * @param {string} [args.output] - Output directory for generated files
 * @param {string} [args.input] - Input file path (for incident/optimize)
 * @param {string} [args.metrics] - Metrics file path (for incident)
 * @param {number} [args.falsePositiveRate] - Current false positive rate (for optimize)
 */
const run = async (args) => {
  const command = args.command || args._?.[0] || 'design';
  const fs = await import('node:fs/promises');
  const nodePath = await import('node:path');

  if (command === 'budget') {
    const target = parseFloat(args.target ?? args.slo ?? '99.9');
    const current = parseFloat(args.current ?? '99.85');
    const window = parseInt(args.window ?? '30', 10);

    const budget = calculateErrorBudget(target, current, window);

    console.log('Error Budget Report');
    console.log('===================');
    console.log(`SLO Target:     ${target}%`);
    console.log(`Current Rate:   ${current}%`);
    console.log(`Window:         ${window} days`);
    console.log('');
    console.log(`Total Budget:   ${budget.totalBudgetMinutes} minutes`);
    console.log(`Consumed:       ${budget.consumedMinutes} minutes (${budget.consumedPercent}%)`);
    console.log(`Remaining:      ${budget.remainingMinutes} minutes`);
    console.log(`Burn Rate:      ${budget.burnRate}x`);
    console.log(`Status:         ${budget.status.toUpperCase()}`);
    if (budget.projectedExhaustion !== null) {
      console.log(`Projected Exhaustion: ${budget.projectedExhaustion} days at current rate`);
    }
    return;
  }

  if (command === 'incident') {
    if (!args.input) {
      console.error('Error: --input is required (path to log file).');
      process.exit(1);
    }
    const logs = await fs.readFile(nodePath.resolve(args.input), 'utf-8');
    let metrics = '{}';
    if (args.metrics) {
      metrics = await fs.readFile(nodePath.resolve(args.metrics), 'utf-8');
    }

    console.log('Performing root cause analysis via SAURON...\n');
    const result = await analyzeIncident(logs, metrics);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.fallback) console.log('[fallback] SAURON unavailable, using local log extraction.\n');
    console.log(result.analysis);
    if (result.durationMs) console.log(`\n--- Analyzed in ${result.durationMs}ms ---`);
    return;
  }

  if (command === 'optimize') {
    if (!args.input) {
      console.error('Error: --input is required (path to alerting rules YAML/JSON).');
      process.exit(1);
    }
    const rules = await fs.readFile(nodePath.resolve(args.input), 'utf-8');
    const fpr = parseFloat(args.falsePositiveRate ?? args['false-positive-rate'] ?? '0.1');

    console.log(`Optimizing alerts (current FP rate: ${(fpr * 100).toFixed(1)}%) via HEIMDALL...\n`);
    const result = await optimizeAlerts(rules, fpr);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.fallback) console.log('[fallback] HEIMDALL unavailable, using generic recommendations.\n');
    console.log(result.optimized);
    if (result.durationMs) console.log(`\n--- Optimized in ${result.durationMs}ms ---`);
    return;
  }

  // Default: design
  if (!args.system) {
    console.error('Error: --system is required (description of the system to monitor).');
    process.exit(1);
  }

  const tier = args.tier || 'growth';
  const stack = args.stack || 'node';

  console.log(`Designing monitoring for "${args.system}" (tier: ${tier}, stack: ${stack}) via HEIMDALL...\n`);
  const result = await designMonitoring(args.system, { tier, stack });

  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  if (result.fallback) console.log('[fallback] HEIMDALL unavailable, generated from local templates.\n');

  if (!result.monitoring) {
    console.log(result.raw ?? 'No structured monitoring output received.');
    return;
  }

  const m = result.monitoring;

  // Display SLIs/SLOs
  if (m.slis && m.slis.length > 0) {
    console.log('SLI/SLO Definitions');
    console.log('====================');
    for (const sli of m.slis) {
      console.log(`  ${sli.name} (${sli.type}): ${sli.sloTarget}`);
      console.log(`    ${sli.definition}`);
    }
    console.log('');
  }

  // Display alerts
  if (m.alerts && m.alerts.length > 0) {
    console.log(`Alerting Rules (${m.alerts.length})`);
    console.log('=================');
    for (const alert of m.alerts) {
      console.log(`  [${alert.severity}] ${alert.name}: ${alert.summary ?? alert.expr}`);
    }
    console.log('');
  }

  // Display recommendations
  if (m.recommendations && m.recommendations.length > 0) {
    console.log('Recommendations');
    console.log('================');
    for (const rec of m.recommendations) {
      console.log(`  - ${rec}`);
    }
    console.log('');
  }

  // Write output files if directory specified
  if (args.output) {
    const outDir = nodePath.resolve(args.output);
    await fs.mkdir(outDir, { recursive: true });

    // Write Prometheus alert rules
    if (m.alerts && m.alerts.length > 0) {
      let alertYaml = 'groups:\n  - name: generated-alerts\n    rules:\n';
      for (const alert of m.alerts) {
        alertYaml += generateAlertRule({
          name: alert.name,
          expr: alert.expr,
          for: alert.for ?? '5m',
          severity: alert.severity,
          summary: alert.summary,
          description: alert.description,
          runbookUrl: alert.runbook ? `./runbooks/${alert.name}.md` : undefined,
        }).split('\n').map((l) => '    ' + l).join('\n') + '\n';
      }
      await fs.writeFile(nodePath.join(outDir, 'alerts.yml'), alertYaml, 'utf-8');
      console.log(`Written: ${outDir}/alerts.yml`);
    }

    // Write Grafana dashboards
    if (m.dashboards && m.dashboards.length > 0) {
      for (let di = 0; di < m.dashboards.length; di++) {
        const dashboard = m.dashboards[di];
        const panels = (dashboard.panels ?? []).map((p, pi) =>
          formatGrafanaPanel({
            title: p.title,
            type: p.type ?? 'timeseries',
            targets: [{ expr: p.expr, legendFormat: p.legendFormat ?? '' }],
            gridPos: { x: (pi % 2) * 12, y: Math.floor(pi / 2) * 8, w: 12, h: 8 },
            unit: p.unit,
          })
        );

        const grafanaDashboard = {
          dashboard: {
            title: dashboard.title,
            tags: ['generated', tier, stack],
            panels,
            time: { from: 'now-6h', to: 'now' },
            refresh: '30s',
          },
        };

        const filename = dashboard.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json';
        await fs.writeFile(
          nodePath.join(outDir, filename),
          JSON.stringify(grafanaDashboard, null, 2),
          'utf-8'
        );
        console.log(`Written: ${outDir}/${filename}`);
      }
    }

    // Write runbooks
    if (m.runbooks && m.runbooks.length > 0) {
      const runbookDir = nodePath.join(outDir, 'runbooks');
      await fs.mkdir(runbookDir, { recursive: true });

      for (const rb of m.runbooks) {
        const runbook = generateRunbook({
          alertName: rb.alert,
          severity: rb.severity,
          description: rb.description,
          diagnosticSteps: rb.diagnostic ?? [],
          mitigationSteps: rb.mitigation ?? [],
        });
        await fs.writeFile(
          nodePath.join(runbookDir, `${rb.alert}.md`),
          runbook,
          'utf-8'
        );
        console.log(`Written: ${outDir}/runbooks/${rb.alert}.md`);
      }
    }

    // Write full monitoring spec as JSON
    await fs.writeFile(
      nodePath.join(outDir, 'monitoring-spec.json'),
      JSON.stringify(m, null, 2),
      'utf-8'
    );
    console.log(`Written: ${outDir}/monitoring-spec.json`);
  }

  if (result.durationMs) console.log(`\n--- Designed in ${result.durationMs}ms ---`);
};

// ---------------------------------------------------------------------------
// Extension metadata
// ---------------------------------------------------------------------------

export const EXTENSION_META = {
  name: 'nha-monitoring-setup',
  displayName: 'Monitoring Setup',
  category: 'monitoring',
  version: '2.1.0',
  description: 'Design complete monitoring stacks with SLI/SLO definitions, Prometheus alerting rules, Grafana dashboards, and incident runbooks. Uses HEIMDALL for monitoring strategy and SAURON for root cause analysis. Falls back to local templates when agents are unavailable.',
  commands: [
    { name: 'design', description: 'Design a complete monitoring setup for a system', args: '--system <description> [--tier startup|growth|enterprise] [--stack node|go|python] [--output <dir>]' },
    { name: 'incident', description: 'Root cause analysis from logs and metrics', args: '--input <logs.txt> [--metrics <metrics.json>]' },
    { name: 'optimize', description: 'Optimize alerting rules to reduce false positives', args: '--input <alerts.yml> [--false-positive-rate <0-1>]' },
    { name: 'budget', description: 'Calculate error budget from SLO and current rate', args: '--target <99.9> --current <99.85> [--window <30>]' },
  ],
  examplePrompts: [
    'Design monitoring for a Node.js REST API with PostgreSQL and Redis at growth tier',
    'Analyze these production logs and metrics to find the root cause of the outage',
    'Optimize our alerting rules to bring false positive rate below 5%',
    'Calculate error budget for 99.95% SLO with current 99.92% availability over 30 days',
    'Generate Grafana dashboards and Prometheus alerts for our microservices architecture',
  ],
  useCases: [
    'Bootstrapping monitoring for new services with SLI/SLO best practices',
    'Post-incident root cause analysis with AI-driven log/metric correlation',
    'Alert fatigue reduction through threshold optimization and consolidation',
    'Error budget tracking and burn rate projections for SLO compliance',
    'Generating Grafana dashboards and Prometheus rules from system descriptions',
  ],
};

export {
  parseSLI,
  calculateErrorBudget,
  generateAlertRule,
  formatGrafanaPanel,
  generateRunbook,
  generateLocalMonitoringFallback,
  designMonitoring,
  analyzeIncident,
  optimizeAlerts,
  sanitizeAlertName,
  validateGrafanaUnit,
  yamlQuote,
  run,
};
