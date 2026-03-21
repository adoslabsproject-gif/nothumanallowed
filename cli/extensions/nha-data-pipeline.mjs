/**
 * nha-data-pipeline — PIF Extension v2.2.0
 *
 * Data transformation pipeline with CSV/JSON parsing, schema inference, validation,
 * and AI-powered transformation design via GLITCH and FLUX agents.
 *
 * @category data-processing
 * @version 2.2.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   // Local parsing and validation
 *   import { parseCSV, detectSchema, validateData } from './extensions/nha-data-pipeline.mjs';
 *   const data = parseCSV(csvString);
 *   const schema = detectSchema(data);
 *   const issues = validateData(data, schema);
 *
 * @example
 *   // AI-powered transformation
 *   import { aiTransform, suggestPipeline } from './extensions/nha-data-pipeline.mjs';
 *   const result = await aiTransform(data, 'normalize emails, split names into first/last');
 *
 * @example
 *   // CLI usage
 *   pif ext nha-data-pipeline --input ./data.csv --transform "normalize emails, remove duplicates" --output ./clean.json
 *   pif ext nha-data-pipeline --command suggest --input ./raw.json --desired ./expected.json
 *   pif ext nha-data-pipeline --command validate --input ./data.csv
 */

const NHA_API = 'https://nothumanallowed.com/api/v1';

/** Default fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 15_000;

/** Maximum retry attempts for agent invocation */
const MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff */
const BASE_BACKOFF_MS = 500;

// ---------------------------------------------------------------------------
// Agent invocation helper (with exponential backoff)
// ---------------------------------------------------------------------------

/**
 * Invoke a Legion agent via the NHA API with retry and exponential backoff.
 * Returns a standardized `{ ok, data, error, durationMs }` envelope.
 * @param {string} agentName - The agent identifier (e.g. 'GLITCH', 'FLUX')
 * @param {string} prompt - The task prompt
 * @param {object} config - Additional body parameters
 * @returns {Promise<{ok: boolean, data?: string, error?: string, durationMs: number}>}
 */
const invokeAgent = async (agentName, prompt, config = {}) => {
  const totalStart = Date.now();
  let lastError = '';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * BASE_BACKOFF_MS;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(`${NHA_API}/legion/agents/${agentName}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...config }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const elapsed = Date.now() - start;

      if (!res.ok) {
        const body = await res.text().catch(() => 'unknown error');
        lastError = `HTTP ${res.status}: ${body}`;
        // Retry on 5xx or 429 (rate limit)
        if (res.status >= 500 || res.status === 429) {
          continue;
        }
        // 4xx (except 429) is not retryable
        return { ok: false, data: undefined, error: lastError, durationMs: elapsed };
      }

      const json = await res.json();
      return {
        ok: true,
        data: json.data?.response ?? json.response ?? '',
        error: undefined,
        durationMs: json.data?.durationMs ?? elapsed,
      };
    } catch (err) {
      const elapsed = Date.now() - start;
      lastError = err.name === 'AbortError'
        ? `Request to ${agentName} timed out after ${FETCH_TIMEOUT_MS}ms`
        : `Network error: ${err.message}`;
      // Timeout and network errors are retryable
      if (attempt < MAX_RETRIES - 1) continue;
      return { ok: false, data: undefined, error: `${lastError} (after ${MAX_RETRIES} attempts)`, durationMs: elapsed };
    }
  }

  const totalElapsed = Date.now() - totalStart;
  return { ok: false, data: undefined, error: `${lastError} (after ${MAX_RETRIES} attempts)`, durationMs: totalElapsed };
};

// ---------------------------------------------------------------------------
// Local pure functions — fast, no network
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string into an array of objects. Handles:
 * - UTF-8 BOM stripping
 * - Quoted fields with commas inside
 * - Escaped quotes (double-quote escaping)
 * - Quote appearing mid-field (treated as literal character)
 * - Mixed CRLF / LF / CR line endings
 * - Empty fields
 * - Custom delimiters
 * - Column count validation (warns on mismatch)
 * - Empty trailing rows are filtered out
 * @param {string} csvText - Raw CSV text
 * @param {object} [options]
 * @param {string} [options.delimiter=',']
 * @param {boolean} [options.headers=true] - Whether first row contains headers
 * @param {boolean} [options.trimFields=true]
 * @returns {Array<object>|Array<Array<string>>} Array of objects (if headers) or arrays
 */
const parseCSV = (csvText, options = {}) => {
  const { delimiter = ',', headers: hasHeaders = true, trimFields = true } = options;
  const warnings = [];
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  // Strip UTF-8 BOM (byte sequence EF BB BF / character U+FEFF)
  let text = csvText;
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }

  // Normalize all line endings (CRLF, CR, LF) to LF
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote (double quote)
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i++;
        continue;
      }
      currentField += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      if (currentField.length === 0) {
        // Start of quoted field
        inQuotes = true;
        i++;
        continue;
      }
      // Quote appearing mid-field — treat as literal character
      currentField += ch;
      i++;
      continue;
    }

    if (ch === delimiter) {
      currentRow.push(trimFields ? currentField.trim() : currentField);
      currentField = '';
      i++;
      continue;
    }

    if (ch === '\n') {
      currentRow.push(trimFields ? currentField.trim() : currentField);
      currentField = '';
      // Filter empty trailing rows: skip if single empty-string field
      if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    currentField += ch;
    i++;
  }

  // Last field/row
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(trimFields ? currentField.trim() : currentField);
    if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
      rows.push(currentRow);
    }
  }

  if (!hasHeaders || rows.length === 0) return rows;

  const headerRow = rows[0];
  const headerCount = headerRow.length;
  const dataRows = rows.slice(1);

  // Validate column count and warn on mismatch
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r];
    if (row.length !== headerCount) {
      warnings.push(
        `Row ${r + 1}: expected ${headerCount} columns but got ${row.length}`
      );
    }
  }

  if (warnings.length > 0) {
    console.warn(`[parseCSV] Column count warnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 20)) {
      console.warn(`  ${w}`);
    }
    if (warnings.length > 20) {
      console.warn(`  ... and ${warnings.length - 20} more`);
    }
  }

  return dataRows.map((row) => {
    const obj = {};
    for (let j = 0; j < headerRow.length; j++) {
      obj[headerRow[j]] = j < row.length ? row[j] : '';
    }
    return obj;
  });
};

/**
 * Check if a string has balanced brackets and braces.
 * @param {string} str
 * @returns {boolean}
 */
const hasBalancedBracketsAndBraces = (str) => {
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
    if (braces < 0 || brackets < 0) return false;
  }
  return braces === 0 && brackets === 0;
};

/**
 * Parse a JSON string with error recovery. Attempts:
 * 1. Standard JSON.parse
 * 2. JSONL (newline-delimited JSON) with CRLF handling and 5% error threshold
 * 3. Partial recovery (truncated JSON) with balanced-bracket validation, capped at 1000 iterations
 * @param {string} jsonText - Raw JSON text
 * @returns {{ data: any, format: 'json'|'jsonl'|'recovered', errors: string[] }}
 */
const parseJSON = (jsonText) => {
  const errors = [];

  // Attempt 1: standard parse
  try {
    const data = JSON.parse(jsonText);
    return { data, format: 'json', errors: [] };
  } catch (e) {
    errors.push(`Standard parse failed: ${e.message}`);
  }

  // Attempt 2: JSONL (one JSON object per line) — strip \r from each line for CRLF safety
  const lines = jsonText.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim().length > 0);
  if (lines.length > 1) {
    const objects = [];
    let jsonlErrors = 0;
    const errorThreshold = 0.05; // 5% threshold (tighter than previous 10%)
    for (let i = 0; i < lines.length; i++) {
      try {
        objects.push(JSON.parse(lines[i]));
      } catch {
        jsonlErrors++;
        if (jsonlErrors > lines.length * errorThreshold) break;
      }
    }
    if (objects.length > 0 && jsonlErrors <= lines.length * errorThreshold) {
      if (jsonlErrors > 0) {
        errors.push(`JSONL: ${jsonlErrors}/${lines.length} lines failed to parse`);
      }
      return { data: objects, format: 'jsonl', errors };
    }
  }

  // Attempt 3: Partial recovery — find the largest valid JSON prefix
  // Capped at 1000 iterations to prevent O(n^2) on large files
  const MAX_RECOVERY_ITERATIONS = 1000;
  let lastValid = null;
  let iterations = 0;
  for (let end = jsonText.length; end > 0 && iterations < MAX_RECOVERY_ITERATIONS; end--) {
    const ch = jsonText[end - 1];
    if (ch !== '}' && ch !== ']' && ch !== '"' && ch !== '\'' && !/\d/.test(ch) && ch !== 'e' && ch !== 'l' && ch !== 'u') {
      continue;
    }
    iterations++;
    const candidate = jsonText.slice(0, end);
    // Validate balanced brackets/braces before attempting expensive JSON.parse
    if (!hasBalancedBracketsAndBraces(candidate)) continue;
    try {
      lastValid = JSON.parse(candidate);
      errors.push(`Recovered ${end}/${jsonText.length} characters`);
      break;
    } catch { /* continue trying shorter prefixes */ }
  }

  if (lastValid !== null) {
    return { data: lastValid, format: 'recovered', errors };
  }

  return { data: null, format: 'json', errors: [...errors, 'Could not recover any valid JSON'] };
};

/**
 * Detect schema (column types) from a data sample.
 * @param {Array<object>} data - Array of row objects
 * @param {number} [sampleSize=100] - Number of rows to analyze
 * @returns {object} Map of field name to { type, nullable, unique, examples, format? }
 */
const detectSchema = (data, sampleSize = 100) => {
  if (!Array.isArray(data) || data.length === 0) return {};

  const sample = data.slice(0, sampleSize);
  const fields = {};

  // Collect all field names
  const allKeys = new Set();
  for (const row of sample) {
    for (const key of Object.keys(row)) allKeys.add(key);
  }

  for (const key of allKeys) {
    const values = sample.map((r) => r[key]);
    const nonNull = values.filter((v) => v !== null && v !== undefined && v !== '');
    const nullable = nonNull.length < values.length;
    const uniqueValues = new Set(nonNull.map(String));

    let detectedType = 'string';
    let format = null;

    if (nonNull.length > 0) {
      // Check if all values are numbers
      const allNumbers = nonNull.every((v) => !isNaN(Number(v)) && String(v).trim() !== '');
      const allIntegers = allNumbers && nonNull.every((v) => Number.isInteger(Number(v)));
      const allBooleans = nonNull.every((v) => ['true', 'false', '1', '0', 'yes', 'no'].includes(String(v).toLowerCase()));

      // Date patterns
      const isoDate = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/;
      const usDate = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
      const allDates = nonNull.every((v) => isoDate.test(String(v)) || usDate.test(String(v)));

      // Email pattern
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const allEmails = nonNull.every((v) => emailPattern.test(String(v)));

      // URL pattern
      const urlPattern = /^https?:\/\//;
      const allUrls = nonNull.every((v) => urlPattern.test(String(v)));

      // UUID pattern
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const allUuids = nonNull.every((v) => uuidPattern.test(String(v)));

      if (allBooleans) {
        detectedType = 'boolean';
      } else if (allIntegers) {
        detectedType = 'integer';
      } else if (allNumbers) {
        detectedType = 'number';
      } else if (allDates) {
        detectedType = 'string';
        format = 'date-time';
      } else if (allEmails) {
        detectedType = 'string';
        format = 'email';
      } else if (allUrls) {
        detectedType = 'string';
        format = 'uri';
      } else if (allUuids) {
        detectedType = 'string';
        format = 'uuid';
      }
    }

    fields[key] = {
      type: detectedType,
      nullable,
      unique: uniqueValues.size === nonNull.length && nonNull.length > 1,
      examples: Array.from(uniqueValues).slice(0, 5),
      ...(format ? { format } : {}),
    };
  }

  return fields;
};

/**
 * Validate data against a schema, checking for nulls, type mismatches, and outliers.
 * @param {Array<object>} data - Array of row objects
 * @param {object} schema - Schema from detectSchema()
 * @returns {{ valid: boolean, totalRows: number, issues: Array<{row: number, field: string, issue: string, value: any}>, summary: object }}
 */
const validateData = (data, schema) => {
  const issues = [];

  // Collect numeric stats for outlier detection
  const numericStats = {};
  for (const [field, def] of Object.entries(schema)) {
    if (def.type === 'number' || def.type === 'integer') {
      const values = data
        .map((r) => Number(r[field]))
        .filter((v) => !isNaN(v));
      if (values.length > 0) {
        const sorted = [...values].sort((a, b) => a - b);
        const q1 = sorted[Math.floor(sorted.length * 0.25)];
        const q3 = sorted[Math.floor(sorted.length * 0.75)];
        const iqr = q3 - q1;
        numericStats[field] = {
          mean: values.reduce((s, v) => s + v, 0) / values.length,
          min: sorted[0],
          max: sorted[sorted.length - 1],
          q1,
          q3,
          iqr,
          lowerFence: q1 - 1.5 * iqr,
          upperFence: q3 + 1.5 * iqr,
        };
      }
    }
  }

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowNum = i + 1;

    for (const [field, def] of Object.entries(schema)) {
      const value = row[field];

      // Null check
      if (!def.nullable && (value === null || value === undefined || value === '')) {
        issues.push({ row: rowNum, field, issue: 'unexpected_null', value });
        continue;
      }

      if (value === null || value === undefined || value === '') continue;

      // Type mismatch
      if (def.type === 'integer' || def.type === 'number') {
        const num = Number(value);
        if (isNaN(num)) {
          issues.push({ row: rowNum, field, issue: 'type_mismatch', value });
          continue;
        }
        if (def.type === 'integer' && !Number.isInteger(num)) {
          issues.push({ row: rowNum, field, issue: 'expected_integer', value });
        }

        // Outlier detection using IQR
        const stats = numericStats[field];
        if (stats && (num < stats.lowerFence || num > stats.upperFence)) {
          issues.push({ row: rowNum, field, issue: 'outlier', value });
        }
      }

      if (def.type === 'boolean') {
        if (!['true', 'false', '1', '0', 'yes', 'no'].includes(String(value).toLowerCase())) {
          issues.push({ row: rowNum, field, issue: 'type_mismatch', value });
        }
      }

      // Format validation
      if (def.format === 'email') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
          issues.push({ row: rowNum, field, issue: 'invalid_email', value });
        }
      }
      if (def.format === 'uri') {
        if (!/^https?:\/\//.test(String(value))) {
          issues.push({ row: rowNum, field, issue: 'invalid_uri', value });
        }
      }
    }
  }

  // Build summary
  const issuesByType = {};
  const issuesByField = {};
  for (const issue of issues) {
    issuesByType[issue.issue] = (issuesByType[issue.issue] ?? 0) + 1;
    issuesByField[issue.field] = (issuesByField[issue.field] ?? 0) + 1;
  }

  return {
    valid: issues.length === 0,
    totalRows: data.length,
    issues: issues.slice(0, 500), // cap at 500 to avoid massive output
    summary: {
      totalIssues: issues.length,
      byType: issuesByType,
      byField: issuesByField,
      numericStats,
    },
  };
};

/**
 * Apply a common field-level transformation.
 * @param {any} value - The field value
 * @param {'lowercase'|'uppercase'|'trim'|'parseDate'|'parseNumber'|'parseBoolean'|'stripHtml'|'normalizeWhitespace'} transform
 * @returns {any}
 */
const transformField = (value, transform) => {
  if (value === null || value === undefined) return value;
  const str = String(value);

  switch (transform) {
    case 'lowercase':
      return str.toLowerCase();
    case 'uppercase':
      return str.toUpperCase();
    case 'trim':
      return str.trim();
    case 'parseDate': {
      const d = new Date(str);
      return isNaN(d.getTime()) ? value : d.toISOString();
    }
    case 'parseNumber': {
      const cleaned = str.replace(/[,$\s]/g, '');
      const num = Number(cleaned);
      return isNaN(num) ? value : num;
    }
    case 'parseBoolean': {
      const lower = str.toLowerCase().trim();
      if (['true', '1', 'yes', 'on'].includes(lower)) return true;
      if (['false', '0', 'no', 'off'].includes(lower)) return false;
      return value;
    }
    case 'stripHtml':
      return str.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    case 'normalizeWhitespace':
      return str.replace(/\s+/g, ' ').trim();
    default:
      return value;
  }
};

// ---------------------------------------------------------------------------
// Transformation spec engine — applies AI-returned specs locally
// ---------------------------------------------------------------------------

/**
 * Apply a structured transformation spec to data. The spec describes a sequence of
 * declarative steps that are executed sequentially on the dataset.
 *
 * Supported step types:
 *   rename   — Rename a field: { type: 'rename', from: 'old', to: 'new' }
 *   lowercase — Lowercase a field: { type: 'lowercase', field: 'email' }
 *   uppercase — Uppercase a field: { type: 'uppercase', field: 'code' }
 *   split    — Split a field into multiple: { type: 'split', field: 'name', delimiter: ' ', into: ['first', 'last'] }
 *   filter   — Keep rows where condition holds: { type: 'filter', field: 'email', condition: 'notNull' | 'notEmpty' | 'equals' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte', value?: any }
 *   deduplicate — Remove duplicate rows: { type: 'deduplicate', field: 'email' } (field = key field, or '*' for all fields)
 *   trim     — Trim whitespace: { type: 'trim', field: '*' | '<fieldName>' }
 *   default  — Set default for null/empty: { type: 'default', field: 'status', value: 'active' }
 *   map      — Transform field values: { type: 'map', field: 'date', format: 'iso' | 'number' | 'boolean' | 'stripHtml' | 'normalizeWhitespace' }
 *   merge    — Merge multiple fields: { type: 'merge', fields: ['first', 'last'], into: 'full_name', separator: ' ' }
 *   remove   — Remove a field: { type: 'remove', field: 'temp_col' }
 *
 * @param {Array<object>} data - The input data rows
 * @param {{ steps: Array<object> }} spec - The transformation spec with ordered steps
 * @returns {{ data: Array<object>, stepsApplied: string[], rowsBefore: number, rowsAfter: number }}
 */
const applyTransformationSpec = (data, spec) => {
  if (!spec || !Array.isArray(spec.steps) || spec.steps.length === 0) {
    return { data, stepsApplied: [], rowsBefore: data.length, rowsAfter: data.length };
  }

  const rowsBefore = data.length;
  let rows = data.map((row) => ({ ...row }));
  const stepsApplied = [];

  for (const step of spec.steps) {
    const type = step.type;

    switch (type) {
      case 'rename': {
        const { from, to } = step;
        if (!from || !to) break;
        for (const row of rows) {
          if (from in row) {
            row[to] = row[from];
            delete row[from];
          }
        }
        stepsApplied.push(`rename: ${from} -> ${to}`);
        break;
      }

      case 'lowercase': {
        const targets = step.field === '*' ? Object.keys(rows[0] ?? {}) : [step.field];
        for (const row of rows) {
          for (const f of targets) {
            if (f in row && typeof row[f] === 'string') {
              row[f] = row[f].toLowerCase();
            }
          }
        }
        stepsApplied.push(`lowercase: ${step.field}`);
        break;
      }

      case 'uppercase': {
        const targets = step.field === '*' ? Object.keys(rows[0] ?? {}) : [step.field];
        for (const row of rows) {
          for (const f of targets) {
            if (f in row && typeof row[f] === 'string') {
              row[f] = row[f].toUpperCase();
            }
          }
        }
        stepsApplied.push(`uppercase: ${step.field}`);
        break;
      }

      case 'split': {
        const { field, delimiter = ' ', into } = step;
        if (!field || !Array.isArray(into) || into.length === 0) break;
        for (const row of rows) {
          if (field in row && row[field] !== null && row[field] !== undefined) {
            const parts = String(row[field]).split(delimiter);
            for (let idx = 0; idx < into.length; idx++) {
              row[into[idx]] = idx < parts.length ? parts[idx].trim() : '';
            }
            // If there are leftover parts beyond the `into` array, append them to the last field
            if (parts.length > into.length) {
              row[into[into.length - 1]] = parts.slice(into.length - 1).join(delimiter).trim();
            }
          }
        }
        stepsApplied.push(`split: ${field} -> [${into.join(', ')}]`);
        break;
      }

      case 'filter': {
        const { field, condition, value } = step;
        if (!field || !condition) break;
        const beforeCount = rows.length;
        rows = rows.filter((row) => {
          const v = row[field];
          switch (condition) {
            case 'notNull':
              return v !== null && v !== undefined;
            case 'notEmpty':
              return v !== null && v !== undefined && String(v).trim() !== '';
            case 'equals':
              return String(v) === String(value);
            case 'notEquals':
              return String(v) !== String(value);
            case 'contains':
              return v !== null && v !== undefined && String(v).includes(String(value));
            case 'gt':
              return Number(v) > Number(value);
            case 'lt':
              return Number(v) < Number(value);
            case 'gte':
              return Number(v) >= Number(value);
            case 'lte':
              return Number(v) <= Number(value);
            default:
              return true;
          }
        });
        stepsApplied.push(`filter: ${field} ${condition}${value !== undefined ? ' ' + value : ''} (${beforeCount} -> ${rows.length})`);
        break;
      }

      case 'deduplicate': {
        const keyField = step.field;
        const beforeCount = rows.length;
        const seen = new Set();
        rows = rows.filter((row) => {
          const key = keyField === '*'
            ? Object.values(row).map((v) => String(v ?? '')).join('|')
            : String(row[keyField] ?? '');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        stepsApplied.push(`deduplicate: ${keyField} (${beforeCount} -> ${rows.length})`);
        break;
      }

      case 'trim': {
        const targets = step.field === '*' ? Object.keys(rows[0] ?? {}) : [step.field];
        for (const row of rows) {
          for (const f of targets) {
            if (f in row && typeof row[f] === 'string') {
              row[f] = row[f].trim();
            }
          }
        }
        stepsApplied.push(`trim: ${step.field}`);
        break;
      }

      case 'default': {
        const { field, value } = step;
        if (!field) break;
        for (const row of rows) {
          if (row[field] === null || row[field] === undefined || row[field] === '') {
            row[field] = value;
          }
        }
        stepsApplied.push(`default: ${field} = ${JSON.stringify(value)}`);
        break;
      }

      case 'map': {
        const { field, format } = step;
        if (!field) break;
        const targets = field === '*' ? Object.keys(rows[0] ?? {}) : [field];
        const formatMap = {
          iso: 'parseDate',
          number: 'parseNumber',
          boolean: 'parseBoolean',
          stripHtml: 'stripHtml',
          normalizeWhitespace: 'normalizeWhitespace',
        };
        const transformName = formatMap[format];
        if (transformName) {
          for (const row of rows) {
            for (const f of targets) {
              if (f in row) {
                row[f] = transformField(row[f], transformName);
              }
            }
          }
        }
        stepsApplied.push(`map: ${field} -> ${format}`);
        break;
      }

      case 'merge': {
        const { fields: sourceFields, into, separator = ' ' } = step;
        if (!Array.isArray(sourceFields) || !into) break;
        for (const row of rows) {
          const parts = sourceFields.map((f) => row[f] ?? '').filter((v) => String(v).trim() !== '');
          row[into] = parts.join(separator);
        }
        stepsApplied.push(`merge: [${sourceFields.join(', ')}] -> ${into}`);
        break;
      }

      case 'remove': {
        const { field } = step;
        if (!field) break;
        for (const row of rows) {
          delete row[field];
        }
        stepsApplied.push(`remove: ${field}`);
        break;
      }

      default:
        stepsApplied.push(`skipped unknown step: ${type}`);
        break;
    }
  }

  return { data: rows, stepsApplied, rowsBefore, rowsAfter: rows.length };
};

// ---------------------------------------------------------------------------
// AI-powered functions — require network, with local fallback
// ---------------------------------------------------------------------------

/**
 * Use GLITCH to design and apply transformations based on natural language instructions.
 * The AI returns a transformation spec which is then executed locally on the full dataset.
 * Falls back to local-only transformations if the API is unreachable.
 * @param {Array<object>} data - Input data array
 * @param {string} instructions - Natural language transformation instructions
 * @param {object} [options]
 * @param {number} [options.sampleSize=20] - Rows to send to AI for analysis
 * @returns {Promise<{ok: boolean, transformed?: Array<object>, spec?: object, stepsApplied?: string[], error?: string, durationMs: number}>}
 */
const aiTransform = async (data, instructions, options = {}) => {
  const { sampleSize = 20 } = options;
  const sample = data.slice(0, sampleSize);
  const schema = detectSchema(data);

  const prompt = [
    `You are a data transformation engineer. Design transformations for the following dataset based on the instructions.`,
    ``,
    `Instructions: ${instructions}`,
    ``,
    `Detected Schema:`,
    JSON.stringify(schema, null, 2),
    ``,
    `Sample Data (${sample.length} of ${data.length} rows):`,
    JSON.stringify(sample, null, 2),
    ``,
    `Return ONLY valid JSON with this EXACT structure:`,
    `{`,
    `  "steps": [`,
    `    { "type": "rename", "from": "old_field", "to": "new_field" },`,
    `    { "type": "lowercase", "field": "email" },`,
    `    { "type": "uppercase", "field": "code" },`,
    `    { "type": "split", "field": "full_name", "delimiter": " ", "into": ["first_name", "last_name"] },`,
    `    { "type": "filter", "field": "email", "condition": "notEmpty" },`,
    `    { "type": "deduplicate", "field": "email" },`,
    `    { "type": "trim", "field": "*" },`,
    `    { "type": "default", "field": "status", "value": "active" },`,
    `    { "type": "map", "field": "created_at", "format": "iso" },`,
    `    { "type": "merge", "fields": ["first", "last"], "into": "name", "separator": " " },`,
    `    { "type": "remove", "field": "temp_col" }`,
    `  ]`,
    `}`,
    ``,
    `Available step types: rename, lowercase, uppercase, split, filter, deduplicate, trim, default, map, merge, remove`,
    `Filter conditions: notNull, notEmpty, equals, notEquals, contains, gt, lt, gte, lte`,
    `Map formats: iso (date), number, boolean, stripHtml, normalizeWhitespace`,
    `Use field: "*" to target all fields (for trim, lowercase, uppercase)`,
    ``,
    `Order steps logically: trim/clean first, then transform, then filter/deduplicate last.`,
  ].join('\n');

  const result = await invokeAgent('GLITCH', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Local fallback: attempt to interpret common instructions locally
    console.warn(`[aiTransform] API unavailable (${result.error}), applying local fallback...`);
    const fallback = applyLocalFallbackTransform(data, instructions, schema);
    return { ok: true, transformed: fallback.data, spec: fallback.spec, stepsApplied: fallback.stepsApplied, error: `AI unavailable — local fallback applied: ${result.error}`, durationMs: result.durationMs };
  }

  try {
    const jsonMatch = result.data.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // AI returned something but no parseable JSON — fall back to local
      console.warn('[aiTransform] AI response contained no valid JSON, applying local fallback...');
      const fallback = applyLocalFallbackTransform(data, instructions, schema);
      return { ok: true, transformed: fallback.data, spec: fallback.spec, stepsApplied: fallback.stepsApplied, error: 'AI response had no JSON — local fallback applied', durationMs: result.durationMs };
    }
    const rawSpec = JSON.parse(jsonMatch[0]);

    // Normalize: the AI might return the old format or the new steps format
    let spec;
    if (Array.isArray(rawSpec.steps)) {
      spec = rawSpec;
    } else {
      // Convert old format (transformations/removeDuplicates/filters) to steps format
      spec = convertLegacySpecToSteps(rawSpec, schema);
    }

    // Apply the spec locally on the full dataset
    const applied = applyTransformationSpec(data, spec);

    return {
      ok: true,
      transformed: applied.data,
      spec,
      stepsApplied: applied.stepsApplied,
      durationMs: result.durationMs,
    };
  } catch (parseErr) {
    // JSON parse failed — fall back to local
    console.warn(`[aiTransform] Failed to parse AI spec (${parseErr.message}), applying local fallback...`);
    const fallback = applyLocalFallbackTransform(data, instructions, schema);
    return { ok: true, transformed: fallback.data, spec: fallback.spec, stepsApplied: fallback.stepsApplied, error: `AI spec parse failed — local fallback applied: ${parseErr.message}`, durationMs: result.durationMs };
  }
};

/**
 * Convert the legacy AI response format (transformations/removeDuplicates/filters/newFields)
 * into the new declarative steps format.
 * @param {object} raw - Legacy spec object
 * @param {object} schema - Detected schema for wildcard resolution
 * @returns {{ steps: Array<object> }}
 */
const convertLegacySpecToSteps = (raw, schema) => {
  const steps = [];

  // Convert transformations
  if (Array.isArray(raw.transformations)) {
    for (const t of raw.transformations) {
      const operation = (t.operation ?? '').toLowerCase();
      const localOps = ['lowercase', 'uppercase', 'trim', 'stripHtml', 'normalizeWhitespace'];
      const mapOps = ['parseDate', 'parseNumber', 'parseBoolean'];

      if (localOps.includes(operation)) {
        steps.push({ type: operation, field: t.field ?? '*' });
      } else if (mapOps.includes(operation)) {
        const formatMap = { parseDate: 'iso', parseNumber: 'number', parseBoolean: 'boolean' };
        steps.push({ type: 'map', field: t.field ?? '*', format: formatMap[operation] });
      }
    }
  }

  // Convert newFields (split/merge heuristics)
  if (Array.isArray(raw.newFields)) {
    for (const nf of raw.newFields) {
      if (nf.derivedFrom && nf.name) {
        // Heuristic: if expression contains "split", treat as split
        const expr = (nf.expression ?? '').toLowerCase();
        if (expr.includes('split')) {
          // Already handled if the AI used proper steps; skip to avoid double-application
        }
      }
    }
  }

  // Convert removeDuplicates
  if (raw.removeDuplicates?.enabled) {
    const keyFields = raw.removeDuplicates.keyFields;
    const field = Array.isArray(keyFields) && keyFields.length === 1 ? keyFields[0] : '*';
    steps.push({ type: 'deduplicate', field });
  }

  // Convert filters
  if (Array.isArray(raw.filters)) {
    for (const f of raw.filters) {
      if (f.field && f.condition) {
        const conditionMap = {
          '!=': 'notEquals', '!==': 'notEquals', 'notNull': 'notNull', 'notEmpty': 'notEmpty',
          '==': 'equals', '===': 'equals', '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte',
          'contains': 'contains',
        };
        const condition = conditionMap[f.condition] ?? f.condition;
        steps.push({ type: 'filter', field: f.field, condition, value: f.value });
      }
    }
  }

  return { steps };
};

/**
 * Local fallback transformer — parses common instruction keywords and applies
 * deterministic transforms without AI. Returns steps-based spec for consistency.
 * @param {Array<object>} data
 * @param {string} instructions
 * @param {object} schema
 * @returns {{ data: Array<object>, spec: object, stepsApplied: string[] }}
 */
const applyLocalFallbackTransform = (data, instructions, schema) => {
  const lower = instructions.toLowerCase();
  const steps = [];

  // Detect trim
  if (lower.includes('trim')) {
    steps.push({ type: 'trim', field: '*' });
  }

  // Detect lowercase/normalize emails
  if (lower.includes('lowercase') || lower.includes('normalize email')) {
    const emailFields = Object.entries(schema)
      .filter(([, def]) => def.format === 'email')
      .map(([k]) => k);
    const targets = emailFields.length > 0 ? emailFields : Object.keys(schema);
    for (const f of targets) {
      steps.push({ type: 'lowercase', field: f });
    }
  }

  // Detect uppercase
  if (lower.includes('uppercase') && !lower.includes('lowercase')) {
    steps.push({ type: 'uppercase', field: '*' });
  }

  // Detect split name
  const splitMatch = lower.match(/split\s+(\w+)\s+into\s+(\w+)\s+(?:and\s+)?(\w+)/);
  if (splitMatch) {
    steps.push({ type: 'split', field: splitMatch[1], delimiter: ' ', into: [splitMatch[2], splitMatch[3]] });
  }

  // Detect deduplication
  if (lower.includes('dedup') || lower.includes('duplicate') || lower.includes('unique')) {
    // Try to find a specific field for dedup
    const emailFields = Object.entries(schema).filter(([, def]) => def.format === 'email').map(([k]) => k);
    const field = emailFields.length > 0 ? emailFields[0] : '*';
    steps.push({ type: 'deduplicate', field });
  }

  // Detect strip HTML
  if (lower.includes('strip html') || lower.includes('remove html') || lower.includes('clean html')) {
    steps.push({ type: 'map', field: '*', format: 'stripHtml' });
  }

  // Detect date normalization
  if (lower.includes('normalize date') || lower.includes('parse date') || lower.includes('iso date')) {
    const dateFields = Object.entries(schema).filter(([, def]) => def.format === 'date-time').map(([k]) => k);
    for (const f of dateFields.length > 0 ? dateFields : Object.keys(schema)) {
      steps.push({ type: 'map', field: f, format: 'iso' });
    }
  }

  // Detect default values
  const defaultMatch = lower.match(/default\s+(\w+)\s+(?:to|=)\s+["']?(\w+)["']?/);
  if (defaultMatch) {
    steps.push({ type: 'default', field: defaultMatch[1], value: defaultMatch[2] });
  }

  const spec = { steps, _fallback: true };
  const applied = applyTransformationSpec(data, spec);
  return { data: applied.data, spec, stepsApplied: applied.stepsApplied };
};

/**
 * Use FLUX to suggest a transformation pipeline given input and desired output examples.
 * Falls back to a local diff-based suggestion if API is unreachable.
 * @param {Array<object>} inputSample - Sample input rows
 * @param {Array<object>} desiredOutput - Desired output for those rows
 * @returns {Promise<{ok: boolean, pipeline?: string, error?: string, durationMs: number}>}
 */
const suggestPipeline = async (inputSample, desiredOutput) => {
  const inputSchema = detectSchema(inputSample);
  const outputSchema = detectSchema(desiredOutput);

  const prompt = [
    `You are a data pipeline architect. Given sample input and desired output, design a transformation pipeline.`,
    ``,
    `Input Schema: ${JSON.stringify(inputSchema, null, 2)}`,
    `Input Sample (${inputSample.length} rows): ${JSON.stringify(inputSample.slice(0, 10), null, 2)}`,
    ``,
    `Output Schema: ${JSON.stringify(outputSchema, null, 2)}`,
    `Desired Output (${desiredOutput.length} rows): ${JSON.stringify(desiredOutput.slice(0, 10), null, 2)}`,
    ``,
    `Design a step-by-step pipeline that transforms input into output. For each step:`,
    `1. Name the transformation`,
    `2. Describe what it does`,
    `3. Provide the logic (pseudocode or JS-like expression)`,
    `4. Show expected intermediate output`,
    ``,
    `Also identify:`,
    `- Fields that were renamed, split, merged, or removed`,
    `- Any data enrichment or derivation`,
    `- Filtering or deduplication applied`,
  ].join('\n');

  const result = await invokeAgent('FLUX', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Local fallback: compare schemas
    console.warn(`[suggestPipeline] API unavailable (${result.error}), returning local schema diff...`);
    const inputFields = new Set(Object.keys(inputSchema));
    const outputFields = new Set(Object.keys(outputSchema));
    const added = [...outputFields].filter((f) => !inputFields.has(f));
    const removed = [...inputFields].filter((f) => !outputFields.has(f));
    const kept = [...inputFields].filter((f) => outputFields.has(f));
    const lines = [
      `## Local Schema Diff (AI unavailable)`,
      ``,
      `Fields kept: ${kept.join(', ') || 'none'}`,
      `Fields removed: ${removed.join(', ') || 'none'}`,
      `Fields added: ${added.join(', ') || 'none'}`,
      ``,
      `Input rows: ${inputSample.length}, Output rows: ${desiredOutput.length}`,
      `Row count change: ${desiredOutput.length - inputSample.length >= 0 ? '+' : ''}${desiredOutput.length - inputSample.length}`,
      ``,
      `> Run again when the API is available for a full AI-powered pipeline suggestion.`,
    ];
    return { ok: true, pipeline: lines.join('\n'), error: `AI unavailable — local fallback: ${result.error}`, durationMs: result.durationMs };
  }

  return { ok: true, pipeline: result.data, durationMs: result.durationMs };
};

/**
 * Use GLITCH to validate a pipeline specification and identify data loss or corruption risks.
 * Falls back to local structural validation if API is unreachable.
 * @param {object} pipelineSpec - Pipeline specification object
 * @param {Array<object>} sampleData - Sample data to validate against
 * @returns {Promise<{ok: boolean, validation?: string, error?: string, durationMs: number}>}
 */
const validatePipeline = async (pipelineSpec, sampleData) => {
  const prompt = [
    `You are a data quality engineer. Validate this transformation pipeline for correctness, data loss, and corruption risks.`,
    ``,
    `Pipeline Specification:`,
    JSON.stringify(pipelineSpec, null, 2),
    ``,
    `Sample Data (${sampleData.length} rows):`,
    JSON.stringify(sampleData.slice(0, 15), null, 2),
    ``,
    `Check for:`,
    `1. Data loss (fields dropped without backup, rows filtered incorrectly)`,
    `2. Type corruption (string-to-number conversion losing precision)`,
    `3. Encoding issues (Unicode normalization, charset problems)`,
    `4. Order dependency (transformations that must run in a specific order)`,
    `5. Null handling (what happens to nulls at each step)`,
    `6. Edge cases (empty strings, zero values, very long strings)`,
    `7. Idempotency (can the pipeline be re-run safely?)`,
    ``,
    `Return a structured assessment with severity for each finding.`,
  ].join('\n');

  const result = await invokeAgent('GLITCH', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Local fallback: basic structural checks
    console.warn(`[validatePipeline] API unavailable (${result.error}), running local structural checks...`);
    const findings = [];
    if (pipelineSpec.transformations) {
      for (const t of pipelineSpec.transformations) {
        if (!t.field) findings.push(`[WARN] Transformation missing "field" property`);
        if (!t.operation) findings.push(`[WARN] Transformation missing "operation" property`);
      }
    }
    if (pipelineSpec.steps) {
      for (const s of pipelineSpec.steps) {
        if (!s.type) findings.push(`[WARN] Step missing "type" property`);
      }
    }
    if (pipelineSpec.removeDuplicates?.enabled && !pipelineSpec.removeDuplicates.keyFields?.length) {
      findings.push(`[INFO] Deduplication enabled but no keyFields specified — will use all fields`);
    }
    const validation = [
      `## Local Structural Validation (AI unavailable)`,
      ``,
      findings.length > 0 ? findings.join('\n') : 'No structural issues found.',
      ``,
      `Sample data rows: ${sampleData.length}`,
      `> Run again when the API is available for a full AI-powered validation.`,
    ].join('\n');
    return { ok: true, validation, error: `AI unavailable — local fallback: ${result.error}`, durationMs: result.durationMs };
  }

  return { ok: true, validation: result.data, durationMs: result.durationMs };
};

/**
 * Generate human-readable documentation for a pipeline specification.
 * Falls back to a local template if API is unreachable.
 * @param {object} pipelineSpec - Pipeline specification object
 * @returns {Promise<{ok: boolean, documentation?: string, error?: string, durationMs: number}>}
 */
const generateDocumentation = async (pipelineSpec) => {
  const prompt = [
    `You are a technical writer. Generate clear, comprehensive documentation for this data transformation pipeline.`,
    ``,
    `Pipeline Specification:`,
    JSON.stringify(pipelineSpec, null, 2),
    ``,
    `Include:`,
    `1. Pipeline Overview (purpose, input/output summary)`,
    `2. Step-by-step description of each transformation`,
    `3. Input schema requirements`,
    `4. Output schema definition`,
    `5. Error handling behavior`,
    `6. Example input/output pairs`,
    `7. Known limitations`,
    ``,
    `Format as clean Markdown.`,
  ].join('\n');

  const result = await invokeAgent('GLITCH', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Local fallback: generate a basic template from the spec
    console.warn(`[generateDocumentation] API unavailable (${result.error}), generating local template...`);
    const lines = [
      `# Pipeline Documentation (auto-generated, local fallback)`,
      ``,
      `## Specification`,
      ``,
      '```json',
      JSON.stringify(pipelineSpec, null, 2),
      '```',
      ``,
    ];
    if (pipelineSpec.steps) {
      lines.push(`## Steps (${pipelineSpec.steps.length})`, ``);
      for (const s of pipelineSpec.steps) {
        lines.push(`- **${s.type}**: ${s.field ?? s.from ?? ''}${s.to ? ' -> ' + s.to : ''}${s.format ? ' (' + s.format + ')' : ''}`);
      }
      lines.push(``);
    }
    if (pipelineSpec.transformations) {
      lines.push(`## Transformations (${pipelineSpec.transformations.length})`, ``);
      for (const t of pipelineSpec.transformations) {
        lines.push(`- **${t.field ?? '*'}**: ${t.operation ?? 'unknown'}${t.params ? ` (${JSON.stringify(t.params)})` : ''}`);
      }
      lines.push(``);
    }
    if (pipelineSpec.removeDuplicates?.enabled) {
      lines.push(`## Deduplication`, ``, `Key fields: ${pipelineSpec.removeDuplicates.keyFields?.join(', ') ?? 'all'}`, ``);
    }
    lines.push(`> Run again when the API is available for full AI-powered documentation.`);
    return { ok: true, documentation: lines.join('\n'), error: `AI unavailable — local fallback: ${result.error}`, durationMs: result.durationMs };
  }

  return { ok: true, documentation: result.data, durationMs: result.durationMs };
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI runner for the data pipeline extension.
 * @param {object} args - Parsed CLI arguments
 * @param {string} [args.command] - Sub-command: 'transform' (default), 'suggest', 'validate', 'doc'
 * @param {string} args.input - Path to input file (JSON or CSV)
 * @param {string} [args.transform] - Natural language transformation instructions
 * @param {string} [args.output] - Output file path
 * @param {boolean} [args.dryRun] - Preview transformations without writing
 * @param {string} [args.desired] - Path to desired output file (for suggest command)
 */
const run = async (args) => {
  const command = args.command || args._?.[0] || 'transform';
  const fs = await import('node:fs/promises');
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');

  if (!args.input) {
    console.error('Error: --input is required (path to JSON or CSV file).');
    process.exit(1);
  }

  const inputPath = nodePath.resolve(args.input);

  // Validate input file exists and is readable
  try {
    await fs.access(inputPath, nodeFs.constants.R_OK);
  } catch {
    console.error(`Error: Input file not found or not readable: ${inputPath}`);
    process.exit(1);
  }

  // Validate output directory exists if --output is specified
  if (args.output) {
    const outputDir = nodePath.dirname(nodePath.resolve(args.output));
    try {
      const stat = await fs.stat(outputDir);
      if (!stat.isDirectory()) {
        console.error(`Error: Output directory is not a directory: ${outputDir}`);
        process.exit(1);
      }
    } catch {
      console.error(`Error: Output directory does not exist: ${outputDir}`);
      process.exit(1);
    }
  }

  let inputContent;
  try {
    inputContent = await fs.readFile(inputPath, 'utf-8');
  } catch (err) {
    console.error(`Error: Could not read input file: ${err.message}`);
    process.exit(1);
  }

  const isCSV = inputPath.endsWith('.csv') || inputPath.endsWith('.tsv');

  let data;
  if (isCSV) {
    const delimiter = inputPath.endsWith('.tsv') ? '\t' : ',';
    try {
      data = parseCSV(inputContent, { delimiter });
    } catch (err) {
      console.error(`Error parsing CSV: ${err.message}`);
      console.error('Hint: Ensure the file is valid CSV with consistent delimiters and properly quoted fields.');
      process.exit(1);
    }
    if (!Array.isArray(data) || data.length === 0) {
      console.error('Error: CSV file is empty or contains only headers.');
      process.exit(1);
    }
    console.log(`Parsed CSV: ${data.length} rows`);
  } else {
    const parsed = parseJSON(inputContent);
    if (parsed.data === null) {
      console.error(`Error parsing JSON: ${parsed.errors.join(', ')}`);
      console.error('Hint: Ensure the file contains valid JSON or JSONL (one JSON object per line).');
      process.exit(1);
    }
    data = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    if (parsed.errors.length > 0) {
      console.log(`JSON parsed with recovery: ${parsed.errors.join(', ')}`);
    }
    console.log(`Parsed JSON: ${data.length} records`);
  }

  // Detect and display schema
  const schema = detectSchema(data);
  console.log(`Schema: ${Object.keys(schema).length} fields`);
  for (const [field, def] of Object.entries(schema)) {
    const extra = def.format ? ` (${def.format})` : '';
    const nullTag = def.nullable ? ', nullable' : '';
    const uniqueTag = def.unique ? ', unique' : '';
    console.log(`  ${field}: ${def.type}${extra}${nullTag}${uniqueTag}`);
  }

  if (command === 'validate') {
    const validation = validateData(data, schema);
    console.log(`\nValidation: ${validation.valid ? 'PASSED' : 'FAILED'}`);
    console.log(`Total issues: ${validation.summary.totalIssues}`);
    if (validation.summary.totalIssues > 0) {
      console.log('\nIssues by type:');
      for (const [type, count] of Object.entries(validation.summary.byType)) {
        console.log(`  ${type}: ${count}`);
      }
      console.log('\nIssues by field:');
      for (const [field, count] of Object.entries(validation.summary.byField)) {
        console.log(`  ${field}: ${count}`);
      }
      console.log('\nFirst 20 issues:');
      for (const issue of validation.issues.slice(0, 20)) {
        console.log(`  Row ${issue.row}, ${issue.field}: ${issue.issue} (value: ${JSON.stringify(issue.value)})`);
      }
    }
    return;
  }

  if (command === 'suggest') {
    if (!args.desired) {
      console.error('Error: --desired is required for suggest command (path to desired output file).');
      process.exit(1);
    }
    const desiredPath = nodePath.resolve(args.desired);
    try {
      await fs.access(desiredPath, nodeFs.constants.R_OK);
    } catch {
      console.error(`Error: Desired output file not found or not readable: ${desiredPath}`);
      process.exit(1);
    }
    const desiredContent = await fs.readFile(desiredPath, 'utf-8');
    const desiredParsed = desiredPath.endsWith('.csv')
      ? parseCSV(desiredContent)
      : parseJSON(desiredContent).data;
    const desiredData = Array.isArray(desiredParsed) ? desiredParsed : [desiredParsed];

    console.log(`\nSuggesting pipeline via FLUX (${data.length} input rows -> ${desiredData.length} output rows)...\n`);
    const result = await suggestPipeline(data, desiredData);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    console.log(result.pipeline);
    if (result.durationMs) console.log(`\n--- Suggested in ${result.durationMs}ms ---`);
    return;
  }

  if (command === 'doc') {
    const specContent = await fs.readFile(inputPath, 'utf-8');
    let spec;
    try {
      spec = JSON.parse(specContent);
    } catch (err) {
      console.error(`Error parsing pipeline spec JSON: ${err.message}`);
      console.error('Hint: The doc command expects a JSON pipeline specification file.');
      process.exit(1);
    }
    console.log('\nGenerating documentation via GLITCH...\n');
    const result = await generateDocumentation(spec);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (args.output) {
      await fs.writeFile(nodePath.resolve(args.output), result.documentation, 'utf-8');
      console.log(`Documentation written to ${args.output}`);
    } else {
      console.log(result.documentation);
    }
    return;
  }

  // Default: transform
  if (!args.transform) {
    console.error('Error: --transform is required (natural language transformation instructions).');
    process.exit(1);
  }

  const dryRun = args.dryRun === true || args.dryRun === 'true' || args['dry-run'] === true;

  console.log(`\nTransforming via GLITCH: "${args.transform}"...\n`);
  const result = await aiTransform(data, args.transform);

  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  console.log(`Transformation complete: ${data.length} -> ${result.transformed.length} rows`);

  if (result.stepsApplied && result.stepsApplied.length > 0) {
    console.log(`\nSteps applied (${result.stepsApplied.length}):`);
    for (const step of result.stepsApplied) {
      console.log(`  - ${step}`);
    }
  }

  if (result.spec) {
    if (result.spec._fallback) {
      console.log(`  [Local fallback mode — AI was unavailable]`);
    }
  }

  // Preview
  console.log(`\nPreview (first 5 rows):`);
  for (const row of result.transformed.slice(0, 5)) {
    console.log(`  ${JSON.stringify(row)}`);
  }

  if (dryRun) {
    console.log('\n[Dry run — no output written]');
    return;
  }

  if (args.output) {
    const outputPath = nodePath.resolve(args.output);
    const outputContent = JSON.stringify(result.transformed, null, 2);
    await fs.writeFile(outputPath, outputContent, 'utf-8');
    console.log(`\nOutput written to ${args.output} (${result.transformed.length} rows)`);
  }

  if (result.durationMs) console.log(`\n--- Transformed in ${result.durationMs}ms ---`);
};

// ---------------------------------------------------------------------------
// Extension metadata
// ---------------------------------------------------------------------------

export const EXTENSION_META = {
  name: 'nha-data-pipeline',
  displayName: 'Data Pipeline',
  category: 'data-processing',
  version: '2.2.0',
  description: 'Data transformation pipeline with CSV/JSON parsing, schema inference, validation, and AI-powered transformations via GLITCH (ETL) and FLUX (pipeline design). Handles quoted CSV fields, JSONL recovery, outlier detection, and natural language transform instructions with full local execution of AI-designed specs.',
  commands: [
    { name: 'transform', description: 'AI-transform data using natural language instructions', args: '--input <path> --transform <instructions> [--output <path>] [--dry-run]' },
    { name: 'validate', description: 'Validate data against inferred schema', args: '--input <path>' },
    { name: 'suggest', description: 'Suggest a transformation pipeline from input/output examples', args: '--input <path> --desired <path>' },
    { name: 'doc', description: 'Generate documentation for a pipeline spec', args: '--input <spec.json> [--output <path>]' },
  ],
  examplePrompts: [
    'Normalize all email addresses and remove duplicate rows from this CSV',
    'Split the full_name column into first_name and last_name',
    'Validate this dataset and show me all type mismatches and outliers',
    'Suggest a pipeline that transforms my raw CSV into this clean JSON format',
    'Generate documentation for my ETL pipeline specification',
  ],
  useCases: [
    'CSV/JSON data cleaning and normalization for ML training datasets',
    'Schema inference and data quality validation before ingestion',
    'Natural language-driven data transformations without writing code',
    'Pipeline design from input/output examples using AI',
    'Data pipeline documentation generation for team handoffs',
  ],
};

export {
  parseCSV,
  parseJSON,
  detectSchema,
  validateData,
  transformField,
  applyTransformationSpec,
  aiTransform,
  suggestPipeline,
  validatePipeline,
  generateDocumentation,
  run,
};
