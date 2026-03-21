/**
 * nha-code-reviewer — PIF Extension v2.1.0
 *
 * AI-powered code review combining SABER (security analysis) and PROMETHEUS (architecture review).
 * Includes local static analysis for anti-patterns, complexity, and diff parsing.
 *
 * @category security
 * @version 2.1.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   // Local analysis
 *   import { parseDiff, categorizeChanges, detectAntiPatterns } from './extensions/nha-code-reviewer.mjs';
 *   const changes = parseDiff(unifiedDiffString);
 *   const patterns = detectAntiPatterns(code);
 *
 * @example
 *   // AI-powered review
 *   import { reviewCode, reviewPR, suggestRefactoring } from './extensions/nha-code-reviewer.mjs';
 *   const review = await reviewCode(code, { focus: 'security', language: 'typescript' });
 *
 * @example
 *   // CLI usage
 *   pif ext nha-code-reviewer --file ./src/auth.ts --focus security
 *   pif ext nha-code-reviewer --diff ./changes.diff --format github-json
 *   pif ext nha-code-reviewer --command refactor --file ./legacy.js --goals "reduce complexity, improve testability"
 */

const NHA_API = 'https://nothumanallowed.com/api/v1';

/** @type {number} Fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Agent invocation helper
// ---------------------------------------------------------------------------

/**
 * Invoke a Legion agent via the NHA API.
 * Returns a standardized result envelope: { ok, data, error, durationMs }.
 * @param {string} agentName - The agent identifier (e.g. 'SABER', 'PROMETHEUS')
 * @param {string} prompt - The task prompt
 * @param {object} config - Additional body parameters
 * @returns {Promise<{ok: boolean, data: string, error: string, durationMs: number}>}
 */
const invokeAgent = async (agentName, prompt, config = {}) => {
  const startMs = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(`${NHA_API}/legion/agents/${agentName}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ...config }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const durationMs = Date.now() - startMs;

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown error');
      return { ok: false, data: '', error: `HTTP ${res.status}: ${body}`, durationMs };
    }

    const json = await res.json();
    return {
      ok: true,
      data: json.data?.response ?? json.response ?? '',
      error: '',
      durationMs: json.data?.durationMs ?? durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const message = err.name === 'AbortError'
      ? `Request to ${agentName} timed out after ${FETCH_TIMEOUT_MS}ms`
      : `Network error: ${err.message}`;
    return { ok: false, data: '', error: message, durationMs };
  }
};

// ---------------------------------------------------------------------------
// Local pure functions — fast, no network
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff string into structured change objects.
 * Handles standard unified diff format (--- a/file, +++ b/file, @@ hunks).
 * Also detects binary diffs, file mode changes, renames, index headers, and
 * the "\ No newline at end of file" marker.
 * @param {string} diffText - Unified diff text
 * @returns {Array<{oldFile: string, newFile: string, hunks: Array<{oldStart: number, oldCount: number, newStart: number, newCount: number, lines: Array<{type: 'context'|'addition'|'deletion', content: string, oldLine?: number, newLine?: number}>}>, isBinary?: boolean, fileMode?: string, oldMode?: string, newMode?: string, renameFrom?: string, renameTo?: string, index?: string}>}
 */
const parseDiff = (diffText) => {
  const files = [];
  const lines = diffText.split('\n');
  let currentFile = null;
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // --- Binary diff markers ---
    if (line.startsWith('Binary files ') && line.includes(' differ')) {
      // Binary files a/image.png and b/image.png differ
      const binMatch = line.match(/^Binary files (.+?) and (.+?) differ$/);
      if (binMatch) {
        const oldFile = binMatch[1].replace(/^a\//, '');
        const newFile = binMatch[2].replace(/^b\//, '');
        files.push({ oldFile, newFile, hunks: [], isBinary: true });
        currentFile = null;
        currentHunk = null;
      }
      continue;
    }

    if (line === 'GIT binary patch') {
      if (currentFile) {
        currentFile.isBinary = true;
      }
      continue;
    }

    // --- diff --git header (start of a new file entry) ---
    if (line.startsWith('diff --git ')) {
      // Prepare a pending file entry; actual file names come from --- / +++
      // but we track metadata headers between diff --git and --- lines
      currentHunk = null;
      continue;
    }

    // --- File mode headers ---
    const newFileModeMatch = line.match(/^new file mode (\d+)$/);
    if (newFileModeMatch) {
      // Will be attached to the next file entry
      if (currentFile) {
        currentFile.fileMode = newFileModeMatch[1];
      } else {
        // Store temporarily, attach when file header is parsed
        if (!files._pendingMode) files._pendingMode = {};
        files._pendingMode.fileMode = newFileModeMatch[1];
      }
      continue;
    }

    const deletedFileModeMatch = line.match(/^deleted file mode (\d+)$/);
    if (deletedFileModeMatch) {
      if (!files._pendingMode) files._pendingMode = {};
      files._pendingMode.fileMode = deletedFileModeMatch[1];
      files._pendingMode.deleted = true;
      continue;
    }

    const oldModeMatch = line.match(/^old mode (\d+)$/);
    if (oldModeMatch) {
      if (!files._pendingMode) files._pendingMode = {};
      files._pendingMode.oldMode = oldModeMatch[1];
      continue;
    }

    const newModeMatch = line.match(/^new mode (\d+)$/);
    if (newModeMatch) {
      if (!files._pendingMode) files._pendingMode = {};
      files._pendingMode.newMode = newModeMatch[1];
      continue;
    }

    // --- Index header ---
    const indexMatch = line.match(/^index ([0-9a-f]+\.\.[0-9a-f]+(?:\s+\d+)?)$/);
    if (indexMatch) {
      if (!files._pendingMode) files._pendingMode = {};
      files._pendingMode.index = indexMatch[1];
      continue;
    }

    // --- Rename headers ---
    const renameFromMatch = line.match(/^rename from (.+)$/);
    if (renameFromMatch) {
      if (!files._pendingMode) files._pendingMode = {};
      files._pendingMode.renameFrom = renameFromMatch[1];
      continue;
    }

    const renameToMatch = line.match(/^rename to (.+)$/);
    if (renameToMatch) {
      if (!files._pendingMode) files._pendingMode = {};
      files._pendingMode.renameTo = renameToMatch[1];
      continue;
    }

    // --- File header: --- a/path or --- /dev/null ---
    if (line.startsWith('--- ')) {
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.startsWith('+++ ')) {
        const oldFile = line.slice(4).replace(/^a\//, '').replace(/\t.*$/, '');
        const newFile = nextLine.slice(4).replace(/^b\//, '').replace(/\t.*$/, '');
        currentFile = { oldFile, newFile, hunks: [] };

        // Apply any pending metadata
        if (files._pendingMode) {
          const pm = files._pendingMode;
          if (pm.fileMode) currentFile.fileMode = pm.fileMode;
          if (pm.oldMode) currentFile.oldMode = pm.oldMode;
          if (pm.newMode) currentFile.newMode = pm.newMode;
          if (pm.index) currentFile.index = pm.index;
          if (pm.renameFrom) currentFile.renameFrom = pm.renameFrom;
          if (pm.renameTo) currentFile.renameTo = pm.renameTo;
          delete files._pendingMode;
        }

        files.push(currentFile);
        i++; // skip the +++ line
        continue;
      }
    }

    // --- Hunk header: @@ -oldStart,oldCount +newStart,newCount @@ (tolerate whitespace) ---
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch && currentFile) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
      currentHunk = { oldStart, oldCount, newStart, newCount, lines: [] };
      currentFile.hunks.push(currentHunk);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    // --- "\ No newline at end of file" marker ---
    if (line.startsWith('\\ No newline at end of file') || line.startsWith('\\')) {
      // Informational marker — do not emit as a diff line, just skip
      continue;
    }

    // --- Diff lines within a hunk ---
    if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({
          type: 'addition',
          content: line.slice(1),
          newLine: newLine,
        });
        newLine++;
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({
          type: 'deletion',
          content: line.slice(1),
          oldLine: oldLine,
        });
        oldLine++;
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({
          type: 'context',
          content: line.startsWith(' ') ? line.slice(1) : line,
          oldLine: oldLine,
          newLine: newLine,
        });
        oldLine++;
        newLine++;
      }
    }
  }

  // Clean up internal bookkeeping property
  if (files._pendingMode) delete files._pendingMode;

  return files;
};

/**
 * Categorize changes from parsed diff into semantic groups.
 * @param {Array} parsedDiff - Output from parseDiff()
 * @returns {{ newFiles: string[], deletedFiles: string[], modifiedFiles: string[], renamedFiles: Array<{from: string, to: string}>, modifiedFunctions: Array<{file: string, name: string, type: 'added'|'modified'|'deleted'}>, configChanges: string[], stats: {additions: number, deletions: number, filesChanged: number} }}
 */
const categorizeChanges = (parsedDiff) => {
  const newFiles = [];
  const deletedFiles = [];
  const modifiedFiles = [];
  const renamedFiles = [];
  const modifiedFunctions = [];
  const configChanges = [];
  let additions = 0;
  let deletions = 0;

  const configPatterns = /\.(json|ya?ml|toml|ini|env|conf|cfg|config\.\w+)$/i;
  const functionPattern = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{|def\s+(\w+)|fn\s+(\w+))/;

  for (const file of parsedDiff) {
    // Count additions/deletions
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'addition') additions++;
        if (line.type === 'deletion') deletions++;
      }
    }

    // Categorize file type
    if (file.oldFile === '/dev/null' || file.oldFile === 'dev/null') {
      newFiles.push(file.newFile);
    } else if (file.newFile === '/dev/null' || file.newFile === 'dev/null') {
      deletedFiles.push(file.oldFile);
    } else if (file.renameFrom && file.renameTo) {
      renamedFiles.push({ from: file.renameFrom, to: file.renameTo });
    } else if (file.oldFile !== file.newFile) {
      renamedFiles.push({ from: file.oldFile, to: file.newFile });
    } else {
      modifiedFiles.push(file.newFile);
    }

    // Check for config file changes
    const targetFile = file.newFile !== '/dev/null' ? file.newFile : file.oldFile;
    if (configPatterns.test(targetFile)) {
      configChanges.push(targetFile);
    }

    // Find modified functions
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'context') continue;
        const match = line.content.match(functionPattern);
        if (match) {
          const name = match[1] || match[2] || match[3] || match[4] || match[5];
          if (name) {
            modifiedFunctions.push({
              file: targetFile,
              name,
              type: line.type === 'addition' ? 'added' : 'deleted',
            });
          }
        }
      }
    }
  }

  // Deduplicate and mark functions as 'modified' if both added and deleted
  const funcMap = new Map();
  for (const f of modifiedFunctions) {
    const key = `${f.file}:${f.name}`;
    const existing = funcMap.get(key);
    if (existing) {
      if (existing.type !== f.type) {
        funcMap.set(key, { ...f, type: 'modified' });
      }
    } else {
      funcMap.set(key, f);
    }
  }

  return {
    newFiles,
    deletedFiles,
    modifiedFiles,
    renamedFiles,
    modifiedFunctions: Array.from(funcMap.values()),
    configChanges,
    stats: {
      additions,
      deletions,
      filesChanged: parsedDiff.length,
    },
  };
};

/**
 * Calculate basic cyclomatic complexity of a code string by counting branches/loops.
 * Handles if/else if, for, while, switch/case, catch, ternary, logical &&/||, and ??.
 * @param {string} code - Source code
 * @returns {{ complexity: number, breakdown: Array<{construct: string, count: number}> }}
 */
const countComplexity = (code) => {
  // Remove string literals and comments to avoid false matches
  const cleaned = code
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '""');

  const constructs = [
    { construct: 'if', pattern: /\bif\s*\(/g },
    { construct: 'else if', pattern: /\belse\s+if\s*\(/g },
    { construct: 'for', pattern: /\bfor\s*\(/g },
    { construct: 'while', pattern: /\bwhile\s*\(/g },
    { construct: 'switch', pattern: /\bswitch\s*\(/g },
    { construct: 'case', pattern: /\bcase\s+/g },
    { construct: 'default', pattern: /\bdefault\s*:/g },
    { construct: 'catch', pattern: /\bcatch\s*\(/g },
    { construct: 'ternary', pattern: /\?[^?.]/g },
    { construct: '&&', pattern: /&&/g },
    { construct: '||', pattern: /\|\|/g },
    { construct: '??', pattern: /\?\?/g },
  ];

  let complexity = 1; // base complexity
  const breakdown = [];

  for (const { construct, pattern } of constructs) {
    const matches = cleaned.match(pattern);
    const count = matches ? matches.length : 0;
    if (count > 0) {
      complexity += count;
      breakdown.push({ construct, count });
    }
  }

  return { complexity, breakdown };
};

/**
 * Detect common anti-patterns using regex-based heuristics.
 * @param {string} code - Source code
 * @param {string} [filename=''] - Optional filename for context-aware checks
 * @returns {Array<{pattern: string, severity: 'critical'|'warning'|'suggestion', line: number, detail: string}>}
 */
const detectAntiPatterns = (code, filename = '') => {
  const issues = [];
  const lines = code.split('\n');
  const isProduction = !filename.match(/\.(test|spec|mock|fixture)\./i);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // God function detection: scan for function bodies > 100 lines
    const funcStart = line.match(/(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|(?:async\s+)?\w+\s*\([^)]*\)\s*\{)/);
    if (funcStart) {
      let braceDepth = 0;
      let funcLines = 0;
      let started = false;
      let funcBody = '';
      let hasAwait = false;
      let isAsync = /\basync\b/.test(line);
      for (let j = i; j < lines.length; j++) {
        const l = lines[j];
        funcBody += l + '\n';
        for (const ch of l) {
          if (ch === '{') { braceDepth++; started = true; }
          if (ch === '}') braceDepth--;
        }
        if (started) funcLines++;
        if (started && braceDepth === 0) break;
      }
      if (funcLines > 100) {
        issues.push({
          pattern: 'god-function',
          severity: 'warning',
          line: lineNum,
          detail: `Function body is ${funcLines} lines (threshold: 100). Consider breaking it into smaller functions.`,
        });
      }

      // Async without await
      if (isAsync) {
        hasAwait = /\bawait\b/.test(funcBody);
        if (!hasAwait) {
          issues.push({
            pattern: 'async-without-await',
            severity: 'warning',
            line: lineNum,
            detail: 'Async function never uses `await`. Remove `async` keyword or add awaited operations.',
          });
        }
      }
    }

    // Deep nesting detection
    const leadingWhitespace = line.match(/^(\s*)/)?.[1] ?? '';
    const indentLevel = leadingWhitespace.includes('\t')
      ? leadingWhitespace.split('\t').length - 1
      : Math.floor(leadingWhitespace.length / 2);
    if (indentLevel > 5 && line.trim().length > 0) {
      issues.push({
        pattern: 'deep-nesting',
        severity: 'warning',
        line: lineNum,
        detail: `Nesting depth ${indentLevel} (threshold: 5). Consider early returns or extracting helper functions.`,
      });
    }

    // Magic numbers (excluding common ones: 0, 1, 2, -1, 100)
    const magicMatch = line.match(/[^a-zA-Z_]\b(\d{3,})\b/);
    if (magicMatch && !line.match(/^\s*\/\//) && !line.match(/^\s*\*/) && !line.match(/const\s+\w+\s*=/) && !line.match(/port|timeout|max|min|limit|size|length|width|height|version/i)) {
      issues.push({
        pattern: 'magic-number',
        severity: 'suggestion',
        line: lineNum,
        detail: `Magic number ${magicMatch[1]} found. Consider extracting to a named constant.`,
      });
    }

    // console.log in production code
    if (isProduction && line.match(/\bconsole\.(log|debug|info)\s*\(/)) {
      issues.push({
        pattern: 'console-in-prod',
        severity: 'warning',
        line: lineNum,
        detail: 'console.log/debug/info found in production code. Use a structured logger instead.',
      });
    }

    // TODO/FIXME/HACK comments
    const todoMatch = line.match(/\/\/\s*(TODO|FIXME|HACK|XXX|TEMP)\b:?\s*(.*)/i);
    if (todoMatch) {
      issues.push({
        pattern: 'unresolved-comment',
        severity: 'suggestion',
        line: lineNum,
        detail: `${todoMatch[1].toUpperCase()}: ${todoMatch[2] || '(no description)'}`,
      });
    }

    // Empty catch blocks
    if (line.match(/catch\s*\([^)]*\)\s*\{\s*\}/)) {
      issues.push({
        pattern: 'empty-catch',
        severity: 'critical',
        line: lineNum,
        detail: 'Empty catch block swallows errors silently. At minimum, log the error.',
      });
    }

    // Unused catch variable — catch(e) { ... } where e is never referenced in the block
    const catchVarMatch = trimmed.match(/^catch\s*\(\s*(\w+)\s*\)\s*\{/);
    if (catchVarMatch) {
      const catchVar = catchVarMatch[1];
      // Scan forward in the catch block to see if the variable is used
      let catchBraceDepth = 0;
      let catchStarted = false;
      let varUsed = false;
      for (let j = i; j < lines.length; j++) {
        const l = lines[j];
        for (const ch of l) {
          if (ch === '{') { catchBraceDepth++; catchStarted = true; }
          if (ch === '}') catchBraceDepth--;
        }
        // Check lines after the catch declaration for variable usage
        if (j > i) {
          // Build a regex that checks for the variable name as a word boundary
          const varRegex = new RegExp(`\\b${catchVar}\\b`);
          if (varRegex.test(l)) {
            varUsed = true;
            break;
          }
        }
        if (catchStarted && catchBraceDepth === 0) break;
      }
      if (!varUsed) {
        issues.push({
          pattern: 'unused-catch-variable',
          severity: 'warning',
          line: lineNum,
          detail: `Catch variable \`${catchVar}\` is never used. Use \`catch (_)\` or handle the error.`,
        });
      }
    }

    // any type in TypeScript
    if (filename.match(/\.tsx?$/) && line.match(/:\s*any\b/) && !line.match(/\/\//)) {
      issues.push({
        pattern: 'typescript-any',
        severity: 'warning',
        line: lineNum,
        detail: 'Using `any` type defeats TypeScript safety. Use a specific type or `unknown`.',
      });
    }

    // Hardcoded secrets patterns
    if (line.match(/(?:password|secret|token|apikey|api_key)\s*[:=]\s*['"][^'"]{8,}/i) && !line.match(/example|placeholder|test|mock|sample/i)) {
      issues.push({
        pattern: 'hardcoded-secret',
        severity: 'critical',
        line: lineNum,
        detail: 'Potential hardcoded secret detected. Use environment variables or a secrets manager.',
      });
    }

    // eval() usage
    if (line.match(/\beval\s*\(/) && !line.match(/\/\//)) {
      issues.push({
        pattern: 'eval-usage',
        severity: 'critical',
        line: lineNum,
        detail: 'eval() is a security risk. Use safer alternatives (Function constructor, JSON.parse, etc.).',
      });
    }

    // var instead of const/let
    if (line.match(/\bvar\s+/) && !line.match(/\/\//)) {
      issues.push({
        pattern: 'var-usage',
        severity: 'suggestion',
        line: lineNum,
        detail: 'Use `const` or `let` instead of `var` to avoid hoisting issues.',
      });
    }

    // == instead of === (loose equality)
    // Match == but not === and not !== and not ===/!== that we already consumed
    if (line.match(/[^!=<>]==[^=]/) && !line.match(/\/\//)) {
      issues.push({
        pattern: 'loose-equality',
        severity: 'warning',
        line: lineNum,
        detail: 'Use `===` instead of `==` to avoid type coercion bugs.',
      });
    }

    // Global variable mutation (window.X = or global.X = or globalThis.X =)
    if (line.match(/\b(window|global|globalThis)\.\w+\s*=/) && !line.match(/\/\//)) {
      issues.push({
        pattern: 'global-mutation',
        severity: 'warning',
        line: lineNum,
        detail: 'Mutating global state is error-prone. Use module exports or dependency injection.',
      });
    }

    // Unreachable code after return/throw/continue/break
    if (trimmed.match(/^(return\b|throw\b|continue\b|break\b)/) && !trimmed.match(/\/\//)) {
      // Check if the next non-empty line within the same block is code (not a closing brace or comment)
      for (let j = i + 1; j < lines.length; j++) {
        const nextTrimmed = lines[j].trim();
        if (nextTrimmed === '' || nextTrimmed.startsWith('//') || nextTrimmed.startsWith('/*') || nextTrimmed.startsWith('*')) continue;
        if (nextTrimmed === '}' || nextTrimmed.startsWith('case ') || nextTrimmed === 'default:') break;
        // Found code after a terminal statement
        issues.push({
          pattern: 'unreachable-code',
          severity: 'warning',
          line: j + 1,
          detail: `Code after \`${trimmed.split(/\s/)[0]}\` is unreachable.`,
        });
        break;
      }
    }

    // Callback hell — 3+ levels of nested callbacks on a single line or scan nested patterns
    // Heuristic: line contains fn( ... fn( ... fn( pattern
    const callbackNesting = (line.match(/(?:function\s*\(|=>\s*\{|\(\s*\w+\s*\)\s*=>)/g) || []).length;
    if (callbackNesting >= 3) {
      issues.push({
        pattern: 'callback-hell',
        severity: 'warning',
        line: lineNum,
        detail: `${callbackNesting} nested callbacks detected on one line. Use async/await or extract named functions.`,
      });
    }

    // ReDoS — catastrophic backtracking patterns like (a+)+, (a|a)*b, (a*)*
    const regexLiteralMatch = line.match(/\/([^/\n]+)\/[gimsuy]*/g);
    if (regexLiteralMatch) {
      for (const reLiteral of regexLiteralMatch) {
        // Check for nested quantifiers: (pattern+)+, (pattern*)+, (pattern+)*, etc.
        if (reLiteral.match(/\([^)]*[+*]\)[+*]/) || reLiteral.match(/\([^)]*\|[^)]*\)[+*]/)) {
          issues.push({
            pattern: 'redos-risk',
            severity: 'critical',
            line: lineNum,
            detail: `Regex \`${reLiteral}\` has nested quantifiers risking catastrophic backtracking (ReDoS).`,
          });
        }
      }
    }
    // Also check new RegExp("...") patterns
    const regexpConstructor = line.match(/new\s+RegExp\(\s*['"`]([^'"`]+)['"`]/);
    if (regexpConstructor) {
      const pat = regexpConstructor[1];
      if (pat.match(/\([^)]*[+*]\)[+*]/) || pat.match(/\([^)]*\|[^)]*\)[+*]/)) {
        issues.push({
          pattern: 'redos-risk',
          severity: 'critical',
          line: lineNum,
          detail: `RegExp pattern \`${pat}\` has nested quantifiers risking catastrophic backtracking (ReDoS).`,
        });
      }
    }
  }

  // Callback hell — multi-line detection: count lines with increasing callback depth
  let consecutiveCallbackLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const hasCallback = lines[i].match(/(?:function\s*\(|=>\s*\{)/);
    if (hasCallback) {
      consecutiveCallbackLines++;
      if (consecutiveCallbackLines >= 3) {
        issues.push({
          pattern: 'callback-hell',
          severity: 'warning',
          line: i + 1,
          detail: `3+ consecutive lines with callback definitions. Use async/await or Promise chains.`,
        });
        consecutiveCallbackLines = 0; // reset to avoid duplicate warnings
      }
    } else {
      consecutiveCallbackLines = 0;
    }
  }

  return issues;
};

// ---------------------------------------------------------------------------
// AI-powered functions — require network, with local fallback
// ---------------------------------------------------------------------------

/**
 * Build a local-only review result from static analysis.
 * Used as fallback when API calls fail.
 * @param {string} code
 * @param {string} [filename='']
 * @returns {{summary: string, comments: Array<{severity: string, line?: number, category: string, message: string, suggestion?: string}>}}
 */
const buildLocalReview = (code, filename = '') => {
  const { complexity, breakdown } = countComplexity(code);
  const antiPatterns = detectAntiPatterns(code, filename);

  const comments = antiPatterns.map((p) => ({
    severity: p.severity,
    line: p.line,
    category: 'static-analysis',
    message: `[${p.pattern}] ${p.detail}`,
    suggestion: undefined,
  }));

  const summary = [
    `Local static analysis (AI agents unavailable).`,
    `Cyclomatic complexity: ${complexity}.`,
    breakdown.length > 0 ? `Breakdown: ${breakdown.map((b) => `${b.construct}(${b.count})`).join(', ')}.` : '',
    `Anti-patterns found: ${antiPatterns.length}.`,
    antiPatterns.filter((p) => p.severity === 'critical').length > 0
      ? `Critical issues: ${antiPatterns.filter((p) => p.severity === 'critical').length}.`
      : '',
  ].filter(Boolean).join(' ');

  return { summary, comments };
};

/**
 * Full code review using SABER for security and PROMETHEUS for architecture.
 * Returns structured comments with severity, line references, and suggestions.
 * Falls back to local-only analysis if API calls fail.
 * @param {string} codeOrDiff - Source code or diff
 * @param {object} [options]
 * @param {'security'|'architecture'|'all'} [options.focus='all']
 * @param {string} [options.language]
 * @param {string} [options.filename]
 * @returns {Promise<{ok: boolean, review?: {summary: string, comments: Array<{severity: string, line?: number, category: string, message: string, suggestion?: string}>}, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const reviewCode = async (codeOrDiff, options = {}) => {
  const { focus = 'all', language, filename = '' } = options;

  const langHint = language ? `Language: ${language}\n` : '';

  const prompt = [
    `You are a senior code reviewer performing a ${focus} review. Analyze the following code thoroughly.`,
    ``,
    langHint,
    `For each issue found, return a JSON object with:`,
    `{ "severity": "critical|warning|suggestion|nitpick", "line": <number or null>, "category": "<security|architecture|performance|style|correctness>", "message": "<what's wrong>", "suggestion": "<how to fix>" }`,
    ``,
    `Also provide an overall summary.`,
    ``,
    `Return ONLY valid JSON in this format:`,
    `{ "summary": "<overall assessment>", "comments": [ ... ] }`,
    ``,
    `--- CODE ---`,
    codeOrDiff,
  ].join('\n');

  // Use primary agent for the focus area
  const primaryAgent = focus === 'security' ? 'SABER' : focus === 'architecture' ? 'PROMETHEUS' : 'SABER';
  const result = await invokeAgent(primaryAgent, prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Fallback to local analysis
    const localReview = buildLocalReview(codeOrDiff, filename);
    return {
      ok: true,
      review: localReview,
      error: result.error,
      durationMs: result.durationMs,
      fallback: true,
    };
  }

  // If focus is 'all', also get architecture review
  let secondResult = null;
  if (focus === 'all') {
    const archPrompt = [
      `You are a senior architect reviewing code for design and structural quality.`,
      `Focus on: separation of concerns, SOLID principles, error handling patterns, testability, naming, modularity.`,
      ``,
      langHint,
      `Return ONLY a JSON array of comment objects:`,
      `[{ "severity": "critical|warning|suggestion|nitpick", "line": <number or null>, "category": "architecture", "message": "<issue>", "suggestion": "<fix>" }]`,
      ``,
      `--- CODE ---`,
      codeOrDiff,
    ].join('\n');
    secondResult = await invokeAgent('PROMETHEUS', archPrompt, { includeSubAgents: false });
  }

  try {
    const jsonMatch = result.data.match(/\{[\s\S]*\}/);
    let review = { summary: '', comments: [] };

    if (jsonMatch) {
      review = JSON.parse(jsonMatch[0]);
    } else {
      review.summary = result.data;
    }

    // Merge architecture comments
    if (secondResult?.ok) {
      const archMatch = secondResult.data.match(/\[[\s\S]*\]/);
      if (archMatch) {
        try {
          const archComments = JSON.parse(archMatch[0]);
          review.comments = [...(review.comments ?? []), ...archComments];
        } catch { /* ignore parse error for secondary */ }
      }
    }

    return {
      ok: true,
      review,
      durationMs: result.durationMs + (secondResult?.durationMs ?? 0),
    };
  } catch {
    return { ok: true, review: { summary: result.data, comments: [] }, durationMs: result.durationMs };
  }
};

/**
 * Review a PR diff with context, outputting GitHub-compatible review format.
 * When format is 'github-json', returns the exact GitHub Pull Request Review API shape:
 *   { body: string, event: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT', comments: [{ path, position, body }] }
 * Falls back to local-only analysis if API calls fail.
 * @param {string} diff - Unified diff string
 * @param {string} [context=''] - Additional context about the PR
 * @param {object} [options]
 * @param {'text'|'github-json'} [options.format='text']
 * @returns {Promise<{ok: boolean, comments?: Array<{path: string, line: number, body: string, severity: string}>, summary?: string, body?: string, event?: string, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const reviewPR = async (diff, context = '', options = {}) => {
  const { format = 'text' } = options;
  const parsed = parseDiff(diff);
  const categories = categorizeChanges(parsed);

  const prompt = [
    `You are a senior code reviewer performing a pull request review.`,
    ``,
    `PR Context: ${context || 'No additional context provided.'}`,
    ``,
    `Changes Summary:`,
    `- ${categories.stats.additions} additions, ${categories.stats.deletions} deletions across ${categories.stats.filesChanged} files`,
    `- New files: ${categories.newFiles.join(', ') || 'none'}`,
    `- Modified files: ${categories.modifiedFiles.join(', ') || 'none'}`,
    `- Deleted files: ${categories.deletedFiles.join(', ') || 'none'}`,
    `- Config changes: ${categories.configChanges.join(', ') || 'none'}`,
    `- Modified functions: ${categories.modifiedFunctions.map((f) => `${f.file}:${f.name} (${f.type})`).join(', ') || 'none'}`,
    ``,
    `For each issue, return a GitHub-compatible review comment:`,
    `{ "path": "file/path.ts", "line": <number>, "body": "**[severity]** message\\n\\nSuggestion: ...", "severity": "critical|warning|suggestion|nitpick" }`,
    ``,
    `Also provide an overall summary.`,
    ``,
    `Return ONLY valid JSON:`,
    `{ "summary": "<PR assessment>", "approved": <true|false>, "comments": [ ... ] }`,
    ``,
    `--- DIFF ---`,
    diff,
  ].join('\n');

  const result = await invokeAgent('SABER', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Fallback: return local analysis of added code in the diff
    const localComments = [];
    for (const file of parsed) {
      const addedCode = file.hunks
        .flatMap((h) => h.lines.filter((l) => l.type === 'addition').map((l) => l.content))
        .join('\n');
      if (addedCode.length > 0) {
        const patterns = detectAntiPatterns(addedCode, file.newFile);
        for (const p of patterns) {
          localComments.push({
            path: file.newFile,
            line: p.line,
            body: `**[${p.severity}]** [${p.pattern}] ${p.detail}`,
            severity: p.severity,
          });
        }
      }
    }

    const summaryText = `Local analysis (AI agents unavailable): ${localComments.length} issues found across ${categories.stats.filesChanged} files.`;

    if (format === 'github-json') {
      const hasCritical = localComments.some((c) => c.severity === 'critical');
      return {
        ok: true,
        body: summaryText,
        event: hasCritical ? 'REQUEST_CHANGES' : 'COMMENT',
        comments: localComments.map((c) => ({
          path: c.path,
          position: c.line,
          body: c.body,
        })),
        durationMs: result.durationMs,
        fallback: true,
      };
    }

    return {
      ok: true,
      comments: localComments,
      summary: summaryText,
      durationMs: result.durationMs,
      fallback: true,
    };
  }

  try {
    const jsonMatch = result.data.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const agentResult = JSON.parse(jsonMatch[0]);
      const comments = agentResult.comments ?? [];
      const summary = agentResult.summary ?? '';
      const approved = agentResult.approved ?? false;

      if (format === 'github-json') {
        // Map to exact GitHub Pull Request Review API format
        return {
          ok: true,
          body: summary,
          event: approved ? 'APPROVE' : 'REQUEST_CHANGES',
          comments: comments.map((c) => ({
            path: c.path ?? '',
            position: c.line ?? c.position ?? 1,
            body: c.body ?? `**[${c.severity ?? 'info'}]** ${c.message ?? ''}${c.suggestion ? `\n\nSuggestion: ${c.suggestion}` : ''}`,
          })),
          durationMs: result.durationMs,
        };
      }

      return {
        ok: true,
        comments,
        summary,
        approved,
        durationMs: result.durationMs,
      };
    }

    if (format === 'github-json') {
      return {
        ok: true,
        body: result.data,
        event: 'COMMENT',
        comments: [],
        durationMs: result.durationMs,
      };
    }

    return { ok: true, comments: [], summary: result.data, durationMs: result.durationMs };
  } catch {
    if (format === 'github-json') {
      return {
        ok: true,
        body: result.data,
        event: 'COMMENT',
        comments: [],
        durationMs: result.durationMs,
      };
    }
    return { ok: true, comments: [], summary: result.data, durationMs: result.durationMs };
  }
};

/**
 * Use PROMETHEUS to suggest architectural improvements for code.
 * Falls back to local-only analysis if API call fails.
 * @param {string} code - Source code to refactor
 * @param {string} goals - Natural language refactoring goals
 * @returns {Promise<{ok: boolean, suggestions?: string, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const suggestRefactoring = async (code, goals) => {
  const { complexity, breakdown } = countComplexity(code);
  const antiPatterns = detectAntiPatterns(code);

  const prompt = [
    `You are a senior architect suggesting refactoring improvements.`,
    ``,
    `Refactoring Goals: ${goals}`,
    ``,
    `Current Code Metrics:`,
    `- Cyclomatic Complexity: ${complexity}`,
    `- Anti-patterns detected: ${antiPatterns.length}`,
    antiPatterns.length > 0
      ? `- Top issues: ${antiPatterns.slice(0, 5).map((p) => `L${p.line}: ${p.pattern} (${p.severity})`).join(', ')}`
      : '',
    ``,
    `Provide:`,
    `1. Specific refactoring steps (ordered by priority)`,
    `2. Before/after code snippets for the most impactful changes`,
    `3. Expected improvements (complexity reduction, testability, maintainability)`,
    `4. Potential risks of the refactoring`,
    ``,
    `--- CODE ---`,
    code,
  ].join('\n');

  const result = await invokeAgent('PROMETHEUS', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Fallback to local suggestions
    const suggestions = [
      `Local analysis (AI agents unavailable):`,
      ``,
      `Cyclomatic Complexity: ${complexity}`,
      breakdown.length > 0 ? `Breakdown: ${breakdown.map((b) => `${b.construct}(${b.count})`).join(', ')}` : '',
      ``,
      `Anti-patterns found: ${antiPatterns.length}`,
      ...antiPatterns.slice(0, 20).map((p) => `  L${p.line} [${p.severity}] ${p.pattern}: ${p.detail}`),
      ``,
      `Refactoring goals: ${goals}`,
      ``,
      complexity > 20 ? `HIGH COMPLEXITY (${complexity}): Consider decomposing into smaller functions.` : '',
      antiPatterns.filter((p) => p.severity === 'critical').length > 0
        ? `CRITICAL ISSUES: ${antiPatterns.filter((p) => p.severity === 'critical').length} patterns require immediate attention.`
        : '',
    ].filter(Boolean).join('\n');

    return { ok: true, suggestions, durationMs: result.durationMs, fallback: true };
  }

  return { ok: true, suggestions: result.data, durationMs: result.durationMs };
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI runner for the code reviewer extension.
 * @param {object} args - Parsed CLI arguments
 * @param {string} [args.command] - Sub-command: 'review' (default), 'diff', 'refactor'
 * @param {string} [args.file] - Path to source file
 * @param {string} [args.diff] - Path to .diff file
 * @param {'security'|'architecture'|'all'} [args.focus='all']
 * @param {'text'|'github-json'} [args.format='text']
 * @param {string} [args.goals] - Refactoring goals (for refactor command)
 */
const run = async (args) => {
  const command = args.command || args._?.[0] || 'review';
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  if (command === 'refactor') {
    if (!args.file) {
      console.error('Error: --file is required for refactoring.');
      process.exit(1);
    }
    const code = await fs.readFile(path.resolve(args.file), 'utf-8');
    const goals = args.goals || 'improve readability, reduce complexity, improve testability';
    console.log(`Analyzing ${args.file} for refactoring via PROMETHEUS...\n`);
    const result = await suggestRefactoring(code, goals);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.fallback) console.log('[Fallback: local analysis only — AI agents unreachable]\n');
    console.log(result.suggestions);
    if (result.durationMs) console.log(`\n--- Analyzed in ${result.durationMs}ms ---`);
    return;
  }

  if (command === 'diff' || args.diff) {
    if (!args.diff) {
      console.error('Error: --diff is required (path to .diff file).');
      process.exit(1);
    }
    const diffContent = await fs.readFile(path.resolve(args.diff), 'utf-8');
    const format = args.format || 'text';

    // Local analysis first
    const parsed = parseDiff(diffContent);
    const categories = categorizeChanges(parsed);
    const localAntiPatterns = [];

    // Run anti-pattern detection on additions
    for (const file of parsed) {
      const addedCode = file.hunks
        .flatMap((h) => h.lines.filter((l) => l.type === 'addition').map((l) => l.content))
        .join('\n');
      if (addedCode.length > 0) {
        const patterns = detectAntiPatterns(addedCode, file.newFile);
        for (const p of patterns) {
          localAntiPatterns.push({ ...p, file: file.newFile });
        }
      }
    }

    console.log('PR Change Summary:');
    console.log(`  Files: ${categories.stats.filesChanged} (+${categories.stats.additions} -${categories.stats.deletions})`);
    if (categories.newFiles.length > 0) console.log(`  New: ${categories.newFiles.join(', ')}`);
    if (categories.deletedFiles.length > 0) console.log(`  Deleted: ${categories.deletedFiles.join(', ')}`);
    if (categories.configChanges.length > 0) console.log(`  Config: ${categories.configChanges.join(', ')}`);
    if (localAntiPatterns.length > 0) {
      console.log(`  Local anti-patterns: ${localAntiPatterns.length}`);
      for (const p of localAntiPatterns.slice(0, 10)) {
        console.log(`    [${p.severity}] ${p.file}:${p.line} — ${p.pattern}: ${p.detail}`);
      }
    }

    console.log('\nReviewing PR diff via SABER...\n');
    const result = await reviewPR(diffContent, args.context || '', { format });

    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    if (result.fallback) console.log('[Fallback: local analysis only — AI agents unreachable]\n');

    if (format === 'github-json') {
      // Output exact GitHub Pull Request Review API format
      console.log(JSON.stringify({
        body: result.body ?? result.summary ?? '',
        event: result.event ?? 'COMMENT',
        comments: result.comments ?? [],
      }, null, 2));
    } else {
      console.log(`Summary: ${result.summary ?? result.body ?? ''}\n`);
      const displayComments = result.comments ?? [];
      if (displayComments.length > 0) {
        console.log('Review Comments:');
        for (const c of displayComments) {
          console.log(`  [${(c.severity ?? 'INFO').toString().toUpperCase()}] ${c.path ?? ''}:${c.line ?? c.position ?? '?'}`);
          console.log(`    ${c.body ?? c.message ?? ''}`);
          console.log('');
        }
      }
    }
    if (result.durationMs) console.log(`--- Reviewed in ${result.durationMs}ms ---`);
    return;
  }

  // Default: review a file
  if (!args.file) {
    console.error('Error: --file is required (path to source file).');
    process.exit(1);
  }

  const code = await fs.readFile(path.resolve(args.file), 'utf-8');
  const focus = args.focus || 'all';
  const filename = path.basename(args.file);

  // Local analysis
  const { complexity, breakdown } = countComplexity(code);
  const antiPatterns = detectAntiPatterns(code, filename);

  console.log(`Local Analysis of ${filename}:`);
  console.log(`  Cyclomatic Complexity: ${complexity}`);
  if (breakdown.length > 0) {
    console.log(`  Breakdown: ${breakdown.map((b) => `${b.construct}(${b.count})`).join(', ')}`);
  }
  if (antiPatterns.length > 0) {
    console.log(`  Anti-patterns: ${antiPatterns.length}`);
    const bySeverity = { critical: 0, warning: 0, suggestion: 0 };
    for (const p of antiPatterns) bySeverity[p.severity] = (bySeverity[p.severity] ?? 0) + 1;
    console.log(`    Critical: ${bySeverity.critical}, Warning: ${bySeverity.warning}, Suggestion: ${bySeverity.suggestion}`);
  }

  console.log(`\nAI Review (focus: ${focus})...\n`);
  const result = await reviewCode(code, { focus, language: detectLanguage(filename), filename });

  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  if (result.fallback) console.log('[Fallback: local analysis only — AI agents unreachable]\n');

  const { review } = result;
  if (review.summary) console.log(`Summary: ${review.summary}\n`);

  if (review.comments && review.comments.length > 0) {
    // Sort by severity
    const severityOrder = { critical: 0, warning: 1, suggestion: 2, nitpick: 3 };
    const sorted = [...review.comments].sort(
      (a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4)
    );

    console.log('Review Comments:');
    for (const c of sorted) {
      const lineRef = c.line ? `:${c.line}` : '';
      console.log(`  [${(c.severity ?? 'info').toUpperCase()}] ${c.category ?? 'general'}${lineRef}`);
      console.log(`    ${c.message}`);
      if (c.suggestion) console.log(`    Fix: ${c.suggestion}`);
      console.log('');
    }
  }

  if (result.durationMs) console.log(`--- Reviewed in ${result.durationMs}ms ---`);
};

/**
 * Detect programming language from filename extension.
 * @param {string} filename
 * @returns {string}
 */
const detectLanguage = (filename) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    swift: 'swift', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    php: 'php', sh: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
  };
  return map[ext] ?? ext ?? 'unknown';
};

// ---------------------------------------------------------------------------
// Extension metadata
// ---------------------------------------------------------------------------

export const EXTENSION_META = {
  name: 'nha-code-reviewer',
  displayName: 'Code Reviewer',
  category: 'security',
  version: '2.1.0',
  description: 'AI-powered code review combining SABER (security) and PROMETHEUS (architecture). Includes local static analysis for anti-patterns, cyclomatic complexity, and unified diff parsing with structured review output. Falls back to local analysis when AI agents are unavailable.',
  commands: [
    { name: 'review', description: 'Full AI code review of a source file', args: '--file <path> [--focus security|architecture|all]' },
    { name: 'diff', description: 'Review a PR diff with change categorization', args: '--diff <path> [--format text|github-json] [--context <description>]' },
    { name: 'refactor', description: 'Get AI-powered refactoring suggestions', args: '--file <path> [--goals <description>]' },
  ],
  examplePrompts: [
    'Review my authentication module for security vulnerabilities',
    'Analyze this PR diff and flag any breaking changes',
    'Check this TypeScript file for anti-patterns and complexity issues',
    'Suggest refactoring for this legacy module to improve testability',
    'Give me a GitHub-compatible review of this diff with line comments',
  ],
  useCases: [
    'Security-focused code review before merging PRs',
    'Automated anti-pattern detection in CI/CD pipelines',
    'Architectural review of new modules and refactored code',
    'Complexity analysis to identify functions needing decomposition',
    'Pre-commit review for hardcoded secrets and unsafe patterns',
  ],
};

export {
  parseDiff,
  categorizeChanges,
  countComplexity,
  detectAntiPatterns,
  detectLanguage,
  reviewCode,
  reviewPR,
  suggestRefactoring,
  run,
};
