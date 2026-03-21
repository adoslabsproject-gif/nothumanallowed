/**
 * nha-doc-generator — PIF Extension v2.1.0
 *
 * Generates comprehensive documentation from source code using local regex extraction
 * and AI-powered content generation via SCHEHERAZADE (structured docs) and MURASAKI (long-form).
 * Falls back to local extraction when agents are unavailable.
 *
 * @category content-creation
 * @version 2.1.0
 * @requires pif >= 2.2.0
 *
 * @example
 *   // Local extraction
 *   import { extractJSDoc, extractFunctions, buildSignatureTable } from './extensions/nha-doc-generator.mjs';
 *   const functions = extractFunctions(sourceCode);
 *   const table = buildSignatureTable(functions);
 *
 * @example
 *   // AI-powered documentation
 *   import { generateDocs, generateReadme, generateExamples } from './extensions/nha-doc-generator.mjs';
 *   const docs = await generateDocs(code, { style: 'api-reference', includeExamples: true });
 *
 * @example
 *   // CLI usage
 *   pif ext nha-doc-generator --file ./src/auth.service.ts --style api-reference --examples
 *   pif ext nha-doc-generator --command readme --file ./src/ --output ./README.md
 *   pif ext nha-doc-generator --command changelog --old ./v1/auth.ts --new ./v2/auth.ts
 */

const NHA_API = 'https://nothumanallowed.com/api/v1';

const AGENT_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Agent invocation helper
// ---------------------------------------------------------------------------

/**
 * Invoke a Legion agent via the NHA API with a 15-second timeout.
 * Returns a standardized envelope: { ok, data, error, durationMs }.
 * @param {string} agentName - The agent identifier (e.g. 'SCHEHERAZADE', 'MURASAKI')
 * @param {string} prompt - The task prompt
 * @param {object} config - Additional body parameters
 * @returns {Promise<{ok: boolean, data: string|null, error: string|null, durationMs: number}>}
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
      return { ok: false, data: null, error: `HTTP ${res.status}: ${body}`, durationMs };
    }

    const json = await res.json();
    return {
      ok: true,
      data: json.data?.response ?? json.response ?? '',
      error: null,
      durationMs: json.data?.durationMs ?? durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err.name === 'AbortError'
      ? `Request to ${agentName} timed out after ${AGENT_TIMEOUT_MS}ms`
      : `Network error: ${err.message}`;
    return { ok: false, data: null, error: message, durationMs };
  }
};

// ---------------------------------------------------------------------------
// Local pure functions — fast, no network
// ---------------------------------------------------------------------------

/**
 * Extract JSDoc comment blocks from source code.
 * Parses @param, @returns, @throws, @example, @deprecated, and description.
 * @param {string} code - Source code
 * @returns {Array<{startLine: number, description: string, tags: Array<{tag: string, name?: string, type?: string, description: string}>, rawComment: string, associatedSymbol?: string}>}
 */
const extractJSDoc = (code) => {
  const results = [];

  // Find /** ... */ blocks
  const commentRegex = /\/\*\*([\s\S]*?)\*\//g;
  let match;

  while ((match = commentRegex.exec(code)) !== null) {
    const rawComment = match[0];
    const commentBody = match[1];
    const startOffset = match.index;

    // Calculate line number
    const startLine = code.slice(0, startOffset).split('\n').length;

    // Parse the comment body
    const commentLines = commentBody
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      .filter((l) => l.length > 0);

    let description = '';
    const tags = [];
    let currentTag = null;

    for (const line of commentLines) {
      const tagMatch = line.match(/^@(\w+)\s*(.*)/);

      if (tagMatch) {
        if (currentTag) tags.push(currentTag);

        const tagName = tagMatch[1];
        const tagContent = tagMatch[2];

        if (tagName === 'param') {
          // @param {Type} name - description
          const paramMatch = tagContent.match(/(?:\{([^}]*)\}\s+)?(\[?\w+(?:\.\w+)*\]?)\s*[-—]?\s*(.*)/);
          if (paramMatch) {
            currentTag = {
              tag: 'param',
              type: paramMatch[1] ?? '',
              name: paramMatch[2],
              description: paramMatch[3],
            };
          } else {
            currentTag = { tag: 'param', description: tagContent };
          }
        } else if (tagName === 'returns' || tagName === 'return') {
          const retMatch = tagContent.match(/(?:\{([^}]*)\}\s+)?(.*)/);
          currentTag = {
            tag: 'returns',
            type: retMatch?.[1] ?? '',
            description: retMatch?.[2] ?? '',
          };
        } else if (tagName === 'throws' || tagName === 'throw') {
          const throwMatch = tagContent.match(/(?:\{([^}]*)\}\s+)?(.*)/);
          currentTag = {
            tag: 'throws',
            type: throwMatch?.[1] ?? '',
            description: throwMatch?.[2] ?? '',
          };
        } else if (tagName === 'example') {
          currentTag = { tag: 'example', description: tagContent };
        } else {
          currentTag = { tag: tagName, description: tagContent };
        }
      } else if (currentTag) {
        // Continuation of previous tag
        currentTag.description += ' ' + line;
      } else {
        // Part of main description
        description += (description ? ' ' : '') + line;
      }
    }
    if (currentTag) tags.push(currentTag);

    // Find associated symbol (next non-empty line after the comment)
    const endOffset = startOffset + rawComment.length;
    const afterComment = code.slice(endOffset);
    const nextLineMatch = afterComment.match(/\n\s*(\S[^\n]*)/);
    let associatedSymbol = undefined;
    if (nextLineMatch) {
      const nextLine = nextLineMatch[1].trim();
      // Try to extract the symbol name — include generator functions
      const symbolMatch = nextLine.match(
        /(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|(?:const|let|var)\s+(\w+)|class\s+(\w+)|interface\s+(\w+)|type\s+(\w+)|enum\s+(\w+))/
      );
      if (symbolMatch) {
        associatedSymbol = symbolMatch[1] || symbolMatch[2] || symbolMatch[3] || symbolMatch[4] || symbolMatch[5] || symbolMatch[6];
      }
    }

    results.push({
      startLine,
      description,
      tags,
      rawComment,
      associatedSymbol,
    });
  }

  return results;
};

/**
 * Extract function signatures from JavaScript/TypeScript source code.
 * Detects: named functions, arrow functions, methods, generator functions,
 * async generators, arrow functions with TS type annotations, and default params with complex values.
 * @param {string} code - Source code
 * @returns {Array<{name: string, line: number, params: string, returnType?: string, async: boolean, exported: boolean, kind: 'function'|'arrow'|'method'|'generator'|'async-generator', static?: boolean}>}
 */
const extractFunctions = (code) => {
  const functions = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;

    // Generator function declaration: [export] [async] function* name(params) [: ReturnType]
    const genDeclMatch = line.match(
      /^(\s*)(?:(export)\s+)?(?:(default)\s+)?(?:(async)\s+)?function\s*\*\s*(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/
    );
    if (genDeclMatch) {
      const isAsync = !!genDeclMatch[4];
      functions.push({
        name: genDeclMatch[5],
        line: lineNum,
        params: genDeclMatch[6].trim(),
        returnType: genDeclMatch[7] ?? undefined,
        async: isAsync,
        exported: !!genDeclMatch[2],
        kind: isAsync ? 'async-generator' : 'generator',
      });
      continue;
    }

    // Named function declaration: [export] [async] function name(params) [: ReturnType]
    const funcDeclMatch = line.match(
      /^(\s*)(?:(export)\s+)?(?:(default)\s+)?(?:(async)\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/
    );
    if (funcDeclMatch) {
      functions.push({
        name: funcDeclMatch[5],
        line: lineNum,
        params: funcDeclMatch[6].trim(),
        returnType: funcDeclMatch[7] ?? undefined,
        async: !!funcDeclMatch[4],
        exported: !!funcDeclMatch[2],
        kind: 'function',
      });
      continue;
    }

    // Arrow function assigned to const/let/var with possible TS type annotations on params
    // Handles complex default params like (a = () => {}) by tracking paren depth
    // [export] const name [: Type] = [async] (params) [: ReturnType] =>
    // Also handles: const name = function*() — generator assigned to variable
    const varAssignMatch = line.match(
      /^(\s*)(?:(export)\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+?)?\s*=\s*(.*)/
    );
    if (varAssignMatch) {
      const varName = varAssignMatch[3];
      const rhs = varAssignMatch[4].trim();

      // Check for assigned generator: const f = function*() or const f = async function*()
      const assignedGenMatch = rhs.match(
        /^(?:(async)\s+)?function\s*\*\s*(?:\w+)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/
      );
      if (assignedGenMatch) {
        const isAsync = !!assignedGenMatch[1];
        functions.push({
          name: varName,
          line: lineNum,
          params: assignedGenMatch[2].trim(),
          returnType: assignedGenMatch[3] ?? undefined,
          async: isAsync,
          exported: !!varAssignMatch[2],
          kind: isAsync ? 'async-generator' : 'generator',
        });
        continue;
      }

      // Check for assigned regular function: const f = function()
      const assignedFuncMatch = rhs.match(
        /^(?:(async)\s+)?function\s+(?:\w+\s*)?\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/
      );
      if (assignedFuncMatch) {
        functions.push({
          name: varName,
          line: lineNum,
          params: assignedFuncMatch[2].trim(),
          returnType: assignedFuncMatch[3] ?? undefined,
          async: !!assignedFuncMatch[1],
          exported: !!varAssignMatch[2],
          kind: 'function',
        });
        continue;
      }

      // Arrow function detection — handle TS type annotations and complex default params
      // Examples:
      //   async (x: number, y: string) => ...
      //   (a = () => {}, b: number) => ...
      //   (x) => ...
      //   x => ...
      const isAsync = /^async\s+/.test(rhs);
      const afterAsync = isAsync ? rhs.replace(/^async\s+/, '') : rhs;

      // Single-param without parens: x =>
      const singleParamArrow = afterAsync.match(/^(\w+)\s*=>/);
      if (singleParamArrow) {
        functions.push({
          name: varName,
          line: lineNum,
          params: singleParamArrow[1],
          returnType: undefined,
          async: isAsync,
          exported: !!varAssignMatch[2],
          kind: 'arrow',
        });
        continue;
      }

      // Parenthesized params: track paren depth to correctly extract params
      // even when defaults contain arrows like (a = () => {})
      if (afterAsync.startsWith('(')) {
        let depth = 0;
        let closingIdx = -1;
        for (let ci = 0; ci < afterAsync.length; ci++) {
          if (afterAsync[ci] === '(') depth++;
          else if (afterAsync[ci] === ')') {
            depth--;
            if (depth === 0) { closingIdx = ci; break; }
          }
        }

        if (closingIdx > 0) {
          const paramsStr = afterAsync.slice(1, closingIdx).trim();
          const afterParams = afterAsync.slice(closingIdx + 1).trim();

          // Check for optional return type annotation then =>
          const arrowCheckMatch = afterParams.match(/^(?::\s*([^\s=>{]+(?:<[^>]*>)?)\s*)?=>/);
          if (arrowCheckMatch) {
            functions.push({
              name: varName,
              line: lineNum,
              params: paramsStr,
              returnType: arrowCheckMatch[1] ?? undefined,
              async: isAsync,
              exported: !!varAssignMatch[2],
              kind: 'arrow',
            });
            continue;
          }
        }
      }

      // Fallback: simpler arrow pattern for lines that didn't match above
      const simpleArrowMatch = rhs.match(
        /^(?:(async)\s+)?\(([^)]*)\)\s*(?::\s*([^\s=>{]+(?:<[^>]*>)?)\s*)?=>/
      );
      if (simpleArrowMatch) {
        functions.push({
          name: varName,
          line: lineNum,
          params: simpleArrowMatch[2].trim(),
          returnType: simpleArrowMatch[3] ?? undefined,
          async: isAsync || !!simpleArrowMatch[1],
          exported: !!varAssignMatch[2],
          kind: 'arrow',
        });
        continue;
      }
    }

    // Method in class/object: [static] [async] name(params) [: ReturnType] {
    // Also handles generator methods: [static] [async] *name(params)
    const methodMatch = line.match(
      /^\s+(?:(static)\s+)?(?:(async)\s+)?(\*?\s*\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?\s*\{/
    );
    if (methodMatch && !line.includes('if') && !line.includes('while') && !line.includes('for') && !line.includes('switch')) {
      const rawName = methodMatch[3].trim();
      const isGenerator = rawName.startsWith('*');
      const methodName = isGenerator ? rawName.slice(1).trim() : rawName;
      const isAsync = !!methodMatch[2];

      let kind = 'method';
      if (isGenerator && isAsync) kind = 'async-generator';
      else if (isGenerator) kind = 'generator';

      functions.push({
        name: methodName,
        line: lineNum,
        params: methodMatch[4].trim(),
        returnType: methodMatch[5] ?? undefined,
        async: isAsync,
        exported: false,
        kind,
        static: !!methodMatch[1],
      });
    }
  }

  return functions;
};

/**
 * Extract class definitions from JavaScript/TypeScript source code.
 * Detects: regular and abstract classes, extends/implements, methods (including
 * getters/setters, static methods), properties (including private fields #field),
 * and basic TypeScript decorator detection.
 * @param {string} code - Source code
 * @returns {Array<{name: string, line: number, extends?: string, implements?: string[], exported: boolean, abstract: boolean, decorators: string[], methods: Array<{name: string, line: number, visibility?: string, static?: boolean, kind?: string}>, properties: Array<{name: string, type?: string, line: number, static?: boolean, private?: boolean}>}>}
 */
const extractClasses = (code) => {
  const classes = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Collect decorators preceding the class (e.g. @Injectable(), @Controller('/path'))
    const decorators = [];
    let decoratorScanIdx = i - 1;
    while (decoratorScanIdx >= 0) {
      const prevLine = lines[decoratorScanIdx].trim();
      if (prevLine.startsWith('@')) {
        const decoratorMatch = prevLine.match(/^@(\w+(?:\([^)]*\))?)/);
        if (decoratorMatch) decorators.unshift(decoratorMatch[1]);
        decoratorScanIdx--;
      } else if (prevLine === '' || prevLine.startsWith('//') || prevLine.startsWith('*') || prevLine.startsWith('/**') || prevLine.startsWith('*/')) {
        decoratorScanIdx--;
      } else {
        break;
      }
    }

    const classMatch = line.match(
      /^(?:(export)\s+)?(?:(abstract)\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/
    );

    if (classMatch) {
      const className = classMatch[3];
      const exported = !!classMatch[1];
      const isAbstract = !!classMatch[2];
      const extendsClass = classMatch[4] ?? undefined;
      const implementsList = classMatch[5]
        ? classMatch[5].split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      const methods = [];
      const properties = [];

      // Scan class body for members
      let braceDepth = 0;
      let classStarted = false;
      for (let j = i; j < lines.length; j++) {
        const memberLine = lines[j];

        for (const ch of memberLine) {
          if (ch === '{') { braceDepth++; classStarted = true; }
          if (ch === '}') braceDepth--;
        }

        if (classStarted && braceDepth === 0) break;

        if (j > i) {
          const trimmedMember = memberLine.trim();

          // Skip comments and empty lines
          if (trimmedMember.startsWith('//') || trimmedMember.startsWith('*') || trimmedMember === '') continue;

          // Skip decorators on members (just record that they exist on the next member)
          if (trimmedMember.startsWith('@')) continue;

          // Getter: [public|private|protected] [static] get name() [: Type] {
          const getterMatch = memberLine.match(
            /^\s+(?:(public|private|protected)\s+)?(?:(static)\s+)?get\s+(\w+)\s*\(\s*\)(?:\s*:\s*([^\s{]+))?\s*\{?/
          );
          if (getterMatch) {
            methods.push({
              name: `get ${getterMatch[3]}`,
              line: j + 1,
              visibility: getterMatch[1] ?? 'public',
              static: !!getterMatch[2],
              kind: 'getter',
            });
            continue;
          }

          // Setter: [public|private|protected] [static] set name(v) {
          const setterMatch = memberLine.match(
            /^\s+(?:(public|private|protected)\s+)?(?:(static)\s+)?set\s+(\w+)\s*\([^)]*\)\s*\{?/
          );
          if (setterMatch) {
            methods.push({
              name: `set ${setterMatch[3]}`,
              line: j + 1,
              visibility: setterMatch[1] ?? 'public',
              static: !!setterMatch[2],
              kind: 'setter',
            });
            continue;
          }

          // Method: [visibility] [static] [async] [*]name(params) [: ReturnType] {
          const methodMatch = memberLine.match(
            /^\s+(?:(public|private|protected)\s+)?(?:(static)\s+)?(?:(async)\s+)?(\*?\s*\w+)\s*\(/
          );
          if (methodMatch && !memberLine.includes('=') && !['if', 'while', 'for', 'switch', 'catch'].includes(methodMatch[4].replace('*', '').trim())) {
            const rawName = methodMatch[4].trim();
            const isGenerator = rawName.startsWith('*');
            const methodName = isGenerator ? rawName.slice(1).trim() : rawName;
            let kind = 'method';
            if (isGenerator && methodMatch[3]) kind = 'async-generator';
            else if (isGenerator) kind = 'generator';
            else if (methodMatch[3]) kind = 'async-method';

            methods.push({
              name: methodName,
              line: j + 1,
              visibility: methodMatch[1] ?? 'public',
              static: !!methodMatch[2],
              kind,
            });
            continue;
          }

          // Private field: #fieldName [: Type] [= value];
          const privateFieldMatch = memberLine.match(
            /^\s+(?:(static)\s+)?(#\w+)(?:\?)?(?:\s*:\s*([^;=]+?))?(?:\s*=)?/
          );
          if (privateFieldMatch && !memberLine.includes('(')) {
            properties.push({
              name: privateFieldMatch[2],
              type: privateFieldMatch[3]?.trim() ?? undefined,
              line: j + 1,
              static: !!privateFieldMatch[1],
              private: true,
            });
            continue;
          }

          // Regular property: [visibility] [readonly|static] name [?: Type] [= value];
          const propMatch = memberLine.match(
            /^\s+(?:(public|private|protected)\s+)?(?:(readonly|static)\s+)?(?:(readonly|static)\s+)?(\w+)(?:\?)?(?:\s*:\s*([^;=]+))?/
          );
          if (propMatch && !memberLine.includes('(') && !trimmedMember.startsWith('//') && !trimmedMember.startsWith('*')) {
            const propName = propMatch[4];
            const keywords = ['if', 'else', 'return', 'const', 'let', 'var', 'for', 'while', 'switch', 'case', 'break', 'continue', 'throw', 'new', 'try', 'catch', 'finally', 'get', 'set', 'async'];
            if (!keywords.includes(propName)) {
              const isStatic = propMatch[2] === 'static' || propMatch[3] === 'static';
              const isPrivateVis = propMatch[1] === 'private';
              properties.push({
                name: propName,
                type: propMatch[5]?.trim() ?? undefined,
                line: j + 1,
                static: isStatic,
                private: isPrivateVis,
              });
            }
          }
        }
      }

      classes.push({
        name: className,
        line: i + 1,
        ...(extendsClass ? { extends: extendsClass } : {}),
        ...(implementsList.length > 0 ? { implements: implementsList } : {}),
        exported,
        abstract: isAbstract,
        decorators,
        methods,
        properties,
      });
    }
  }

  return classes;
};

/**
 * Extract exported symbols from JavaScript/TypeScript source code.
 * @param {string} code - Source code
 * @returns {Array<{name: string, kind: 'function'|'class'|'const'|'type'|'interface'|'enum'|'default'|'re-export', line: number}>}
 */
const extractExports = (code) => {
  const exports = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // export default
    const defaultMatch = line.match(/^export\s+default\s+(?:class|function)?\s*(\w+)?/);
    if (defaultMatch) {
      exports.push({ name: defaultMatch[1] ?? 'default', kind: 'default', line: i + 1 });
      continue;
    }

    // export const/let/var
    const constMatch = line.match(/^export\s+(?:const|let|var)\s+(\w+)/);
    if (constMatch) {
      exports.push({ name: constMatch[1], kind: 'const', line: i + 1 });
      continue;
    }

    // export function (including generator functions)
    const funcMatch = line.match(/^export\s+(?:async\s+)?function\s*\*?\s*(\w+)/);
    if (funcMatch) {
      exports.push({ name: funcMatch[1], kind: 'function', line: i + 1 });
      continue;
    }

    // export class
    const classMatch = line.match(/^export\s+(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      exports.push({ name: classMatch[1], kind: 'class', line: i + 1 });
      continue;
    }

    // export type/interface/enum
    const typeMatch = line.match(/^export\s+(type|interface|enum)\s+(\w+)/);
    if (typeMatch) {
      exports.push({ name: typeMatch[2], kind: typeMatch[1], line: i + 1 });
      continue;
    }

    // Named export block: export { a, b, c }
    const namedMatch = line.match(/^export\s*\{([^}]+)\}/);
    if (namedMatch) {
      const names = namedMatch[1].split(',').map((n) => n.trim().split(/\s+as\s+/));
      for (const parts of names) {
        const exportedName = parts.length > 1 ? parts[1].trim() : parts[0].trim();
        if (exportedName) {
          exports.push({ name: exportedName, kind: 're-export', line: i + 1 });
        }
      }
      continue;
    }

    // Re-export: export { ... } from '...'
    const reExportMatch = line.match(/^export\s*\{([^}]+)\}\s*from/);
    if (reExportMatch) {
      const names = reExportMatch[1].split(',').map((n) => n.trim().split(/\s+as\s+/));
      for (const parts of names) {
        const exportedName = parts.length > 1 ? parts[1].trim() : parts[0].trim();
        if (exportedName) {
          exports.push({ name: exportedName, kind: 're-export', line: i + 1 });
        }
      }
    }

    // export * from '...'
    const starExport = line.match(/^export\s+\*\s+(?:as\s+(\w+)\s+)?from\s+['"]([^'"]+)['"]/);
    if (starExport) {
      exports.push({ name: starExport[1] ?? `* from ${starExport[2]}`, kind: 're-export', line: i + 1 });
    }
  }

  return exports;
};

/**
 * Build a markdown table from function signatures.
 * @param {Array<{name: string, params: string, returnType?: string, async: boolean, exported: boolean, kind: string}>} functions
 * @returns {string}
 */
const buildSignatureTable = (functions) => {
  if (functions.length === 0) return '_No functions found._';

  const rows = functions.map((f) => {
    const prefix = [
      f.exported ? 'export' : '',
      f.async ? 'async' : '',
    ].filter(Boolean).join(' ');
    const kindLabel = f.kind === 'generator' || f.kind === 'async-generator' ? 'function*' : '';
    const signature = `${prefix ? prefix + ' ' : ''}${kindLabel ? kindLabel + ' ' : ''}${f.name}(${f.params})`;
    const ret = f.returnType ?? (f.kind === 'generator' ? 'Generator<...>' : f.kind === 'async-generator' ? 'AsyncGenerator<...>' : f.async ? 'Promise<...>' : '...');
    return `| \`${signature}\` | \`${ret}\` | ${f.kind} | L${f.line} |`;
  });

  return [
    '| Signature | Return Type | Kind | Line |',
    '| --------- | ----------- | ---- | ---- |',
    ...rows,
  ].join('\n');
};

// ---------------------------------------------------------------------------
// Local fallback documentation generation
// ---------------------------------------------------------------------------

/**
 * Generate documentation locally from extracted symbols when AI agents are unavailable.
 * Produces a function table, class overview, and available JSDoc descriptions.
 * @param {string} code - Source code
 * @param {object} options
 * @param {'jsdoc'|'readme'|'api-reference'} [options.style='api-reference']
 * @returns {string} Markdown documentation
 */
const generateLocalDocsFallback = (code, options = {}) => {
  const { style = 'api-reference' } = options;
  const jsdocs = extractJSDoc(code);
  const functions = extractFunctions(code);
  const classes = extractClasses(code);
  const exports = extractExports(code);

  const sections = [];

  sections.push('# API Reference (Local Extraction)');
  sections.push('');
  sections.push('> Generated from local code analysis. Re-run with SCHEHERAZADE for AI-enhanced documentation.');
  sections.push('');

  // Function table
  if (functions.length > 0) {
    sections.push('## Functions');
    sections.push('');
    sections.push(buildSignatureTable(functions));
    sections.push('');

    // Add JSDoc descriptions where available
    for (const fn of functions) {
      const doc = jsdocs.find((d) => d.associatedSymbol === fn.name);
      if (doc && doc.description) {
        sections.push(`### ${fn.name}`);
        sections.push('');
        sections.push(doc.description);
        sections.push('');
        const paramTags = doc.tags.filter((t) => t.tag === 'param');
        if (paramTags.length > 0) {
          sections.push('**Parameters:**');
          sections.push('');
          for (const p of paramTags) {
            sections.push(`- \`${p.name ?? ''}\` ${p.type ? `(\`${p.type}\`)` : ''} — ${p.description}`);
          }
          sections.push('');
        }
        const returnTags = doc.tags.filter((t) => t.tag === 'returns');
        if (returnTags.length > 0) {
          sections.push(`**Returns:** ${returnTags[0].type ? `\`${returnTags[0].type}\`` : ''} ${returnTags[0].description}`);
          sections.push('');
        }
      }
    }
  }

  // Classes
  if (classes.length > 0) {
    sections.push('## Classes');
    sections.push('');
    for (const cls of classes) {
      const ext = cls.extends ? ` extends ${cls.extends}` : '';
      const impl = cls.implements && cls.implements.length > 0 ? ` implements ${cls.implements.join(', ')}` : '';
      sections.push(`### ${cls.name}${ext}${impl}`);
      sections.push('');
      if (cls.decorators && cls.decorators.length > 0) {
        sections.push(`Decorators: ${cls.decorators.map((d) => `\`@${d}\``).join(', ')}`);
        sections.push('');
      }
      const doc = jsdocs.find((d) => d.associatedSymbol === cls.name);
      if (doc && doc.description) {
        sections.push(doc.description);
        sections.push('');
      }
      if (cls.methods.length > 0) {
        sections.push('**Methods:**');
        sections.push('');
        for (const m of cls.methods) {
          const vis = m.visibility && m.visibility !== 'public' ? `${m.visibility} ` : '';
          const stat = m.static ? 'static ' : '';
          sections.push(`- \`${vis}${stat}${m.name}()\` (L${m.line})`);
        }
        sections.push('');
      }
      if (cls.properties.length > 0) {
        sections.push('**Properties:**');
        sections.push('');
        for (const p of cls.properties) {
          const type = p.type ? `: ${p.type}` : '';
          sections.push(`- \`${p.name}${type}\` (L${p.line})`);
        }
        sections.push('');
      }
    }
  }

  // Exports summary
  if (exports.length > 0) {
    sections.push('## Exports');
    sections.push('');
    for (const e of exports) {
      sections.push(`- \`${e.name}\` (${e.kind})`);
    }
    sections.push('');
  }

  return sections.join('\n');
};

// ---------------------------------------------------------------------------
// AI-powered functions — require network (with local fallback)
// ---------------------------------------------------------------------------

/**
 * Generate comprehensive documentation from code using SCHEHERAZADE.
 * Falls back to local extraction if the agent is unavailable.
 * @param {string} code - Source code
 * @param {object} [options]
 * @param {'jsdoc'|'readme'|'api-reference'} [options.style='api-reference']
 * @param {boolean} [options.includeExamples=true]
 * @returns {Promise<{ok: boolean, documentation?: string, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const generateDocs = async (code, options = {}) => {
  const { style = 'api-reference', includeExamples = true } = options;

  // Extract all symbols locally
  const jsdocs = extractJSDoc(code);
  const functions = extractFunctions(code);
  const classes = extractClasses(code);
  const exports = extractExports(code);

  const symbolSummary = {
    functions: functions.map((f) => ({
      name: f.name,
      params: f.params,
      returnType: f.returnType,
      async: f.async,
      exported: f.exported,
      kind: f.kind,
      jsdoc: jsdocs.find((d) => d.associatedSymbol === f.name)?.description ?? null,
    })),
    classes: classes.map((c) => ({
      name: c.name,
      extends: c.extends,
      implements: c.implements,
      abstract: c.abstract,
      decorators: c.decorators,
      methods: c.methods.map((m) => m.name),
      properties: c.properties.map((p) => ({ name: p.name, type: p.type })),
      jsdoc: jsdocs.find((d) => d.associatedSymbol === c.name)?.description ?? null,
    })),
    exports: exports.map((e) => e.name),
    existingDocs: jsdocs.length,
  };

  const styleInstructions = {
    jsdoc: 'Generate JSDoc-style documentation comments for every function and class. Include @param, @returns, @throws, and @example for each.',
    readme: 'Generate a comprehensive README section with overview, installation, API reference, and usage examples.',
    'api-reference': 'Generate a formal API reference with tables of functions, detailed parameter docs, return types, usage examples, and error handling notes.',
  };

  const prompt = [
    `You are a technical documentation engineer. Generate ${style} documentation for the following code.`,
    ``,
    `Style: ${styleInstructions[style] ?? styleInstructions['api-reference']}`,
    `Include examples: ${includeExamples}`,
    ``,
    `Extracted Symbols:`,
    JSON.stringify(symbolSummary, null, 2),
    ``,
    `Full Source Code:`,
    code.slice(0, 20000), // cap to avoid prompt limits
    ``,
    `Requirements:`,
    `- Document EVERY exported function and class`,
    `- For each function: describe what it does, all parameters (name, type, description), return value, and at least one example`,
    `- For classes: overview, constructor, each public method, and properties`,
    `- Use clear, precise language`,
    `- Format as clean Markdown`,
    `- Do NOT include any preamble — output ONLY the documentation`,
  ].join('\n');

  const result = await invokeAgent('SCHEHERAZADE', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Local fallback: generate docs from extraction only
    const fallbackDocs = generateLocalDocsFallback(code, { style });
    return { ok: true, documentation: fallbackDocs, durationMs: result.durationMs, fallback: true };
  }

  return { ok: true, documentation: result.data, durationMs: result.durationMs };
};

/**
 * Generate a full README using MURASAKI for long-form content generation.
 * Falls back to a structured template from local extraction if agent is unavailable.
 * @param {string|Array<{filename: string, code: string}>} codeFiles - Source code (single string or array of file objects)
 * @param {string} projectDescription - Description of the project
 * @returns {Promise<{ok: boolean, readme?: string, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const generateReadme = async (codeFiles, projectDescription) => {
  let codeSummary;
  let allFunctions = [];
  let allClasses = [];
  let allExports = [];

  if (typeof codeFiles === 'string') {
    const functions = extractFunctions(codeFiles);
    const classes = extractClasses(codeFiles);
    const exports = extractExports(codeFiles);
    allFunctions = functions;
    allClasses = classes;
    allExports = exports;
    codeSummary = JSON.stringify({
      files: [{ filename: 'main', functions: functions.length, classes: classes.length, exports: exports.map((e) => e.name) }],
      totalFunctions: functions.length,
      totalClasses: classes.length,
    }, null, 2);
  } else {
    const fileSummaries = codeFiles.map((f) => {
      const functions = extractFunctions(f.code);
      const classes = extractClasses(f.code);
      const exports = extractExports(f.code);
      allFunctions.push(...functions);
      allClasses.push(...classes);
      allExports.push(...exports);
      return {
        filename: f.filename,
        functions: functions.map((fn) => fn.name),
        classes: classes.map((c) => c.name),
        exports: exports.map((e) => e.name),
        lines: f.code.split('\n').length,
      };
    });
    codeSummary = JSON.stringify(fileSummaries, null, 2);
  }

  const prompt = [
    `You are a senior technical writer creating a comprehensive README for a project.`,
    ``,
    `Project Description: ${projectDescription}`,
    ``,
    `Code Structure:`,
    codeSummary,
    ``,
    `Generate a professional README with these sections:`,
    `1. Title and badges placeholder`,
    `2. Overview (2-3 paragraphs: what it does, who it's for, key differentiators)`,
    `3. Features (bullet list of key features)`,
    `4. Installation (npm/yarn commands, prerequisites)`,
    `5. Quick Start (minimal code to get started)`,
    `6. API Reference (table of key functions/classes with brief descriptions)`,
    `7. Configuration (environment variables, config files)`,
    `8. Examples (3-5 realistic usage examples)`,
    `9. Contributing (guidelines)`,
    `10. License placeholder`,
    ``,
    `Output clean Markdown. No preamble.`,
  ].join('\n');

  const result = await invokeAgent('MURASAKI', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Local fallback: generate README template from extracted symbols
    const exportedFuncs = allFunctions.filter((f) => f.exported);
    const fallbackReadme = [
      `# ${projectDescription}`,
      '',
      '> README generated from local code extraction. Re-run with MURASAKI for AI-enhanced content.',
      '',
      '## Overview',
      '',
      projectDescription,
      '',
      '## API Reference',
      '',
      exportedFuncs.length > 0
        ? buildSignatureTable(exportedFuncs)
        : '_No exported functions detected._',
      '',
      allClasses.length > 0
        ? '## Classes\n\n' + allClasses.map((c) => `- **${c.name}** — ${c.methods.length} methods, ${c.properties.length} properties`).join('\n')
        : '',
      '',
      '## Installation',
      '',
      '```bash',
      'npm install',
      '```',
      '',
      '## License',
      '',
      'MIT',
    ].filter(Boolean).join('\n');

    return { ok: true, readme: fallbackReadme, durationMs: result.durationMs, fallback: true };
  }

  return { ok: true, readme: result.data, durationMs: result.durationMs };
};

/**
 * Generate realistic usage examples for function signatures using SCHEHERAZADE.
 * Falls back to stub examples if agent is unavailable.
 * @param {Array<{name: string, params: string, returnType?: string, async: boolean}>} functionSignatures
 * @returns {Promise<{ok: boolean, examples?: string, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const generateExamples = async (functionSignatures) => {
  const sigList = functionSignatures.map((f) => {
    const asyncTag = f.async ? 'async ' : '';
    return `${asyncTag}${f.name}(${f.params})${f.returnType ? `: ${f.returnType}` : ''}`;
  });

  const prompt = [
    `You are a developer advocate writing usage examples. For each function below, generate 1-2 realistic, practical usage examples.`,
    ``,
    `Requirements:`,
    `- Use realistic data (not "foo", "bar")`,
    `- Show the most common use case first`,
    `- Include error handling where relevant`,
    `- If async, show with await`,
    `- Format each example as a fenced JavaScript code block`,
    `- Add a one-line comment explaining what the example does`,
    ``,
    `Functions:`,
    ...sigList.map((s, i) => `${i + 1}. \`${s}\``),
  ].join('\n');

  const result = await invokeAgent('SCHEHERAZADE', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Local fallback: generate stub examples
    const stubs = functionSignatures.map((f) => {
      const asyncPrefix = f.async ? 'await ' : '';
      const params = f.params || '';
      return [
        `### ${f.name}`,
        '',
        '```javascript',
        `// Basic usage of ${f.name}`,
        `const result = ${asyncPrefix}${f.name}(${params ? '/* ' + params + ' */' : ''});`,
        `console.log(result);`,
        '```',
        '',
      ].join('\n');
    });

    const fallbackExamples = [
      '# Usage Examples (Local Fallback)',
      '',
      '> SCHEHERAZADE unavailable. Showing stub examples. Re-run when agent is available for realistic examples.',
      '',
      ...stubs,
    ].join('\n');

    return { ok: true, examples: fallbackExamples, durationMs: result.durationMs, fallback: true };
  }

  return { ok: true, examples: result.data, durationMs: result.durationMs };
};

/**
 * Diff two code versions and generate a human-readable changelog using SCHEHERAZADE.
 * Falls back to a structural diff summary if agent is unavailable.
 * @param {string} oldCode - Previous version source code
 * @param {string} newCode - New version source code
 * @returns {Promise<{ok: boolean, changelog?: string, error?: string, durationMs?: number, fallback?: boolean}>}
 */
const generateChangelog = async (oldCode, newCode) => {
  const oldFunctions = extractFunctions(oldCode);
  const newFunctions = extractFunctions(newCode);
  const oldClasses = extractClasses(oldCode);
  const newClasses = extractClasses(newCode);
  const oldExports = extractExports(oldCode);
  const newExports = extractExports(newCode);

  const oldFuncNames = new Set(oldFunctions.map((f) => f.name));
  const newFuncNames = new Set(newFunctions.map((f) => f.name));
  const oldClassNames = new Set(oldClasses.map((c) => c.name));
  const newClassNames = new Set(newClasses.map((c) => c.name));
  const oldExportNames = new Set(oldExports.map((e) => e.name));
  const newExportNames = new Set(newExports.map((e) => e.name));

  const addedFunctions = newFunctions.filter((f) => !oldFuncNames.has(f.name));
  const removedFunctions = oldFunctions.filter((f) => !newFuncNames.has(f.name));
  const addedClasses = newClasses.filter((c) => !oldClassNames.has(c.name));
  const removedClasses = oldClasses.filter((c) => !newClassNames.has(c.name));
  const addedExports = newExports.filter((e) => !oldExportNames.has(e.name));
  const removedExports = oldExports.filter((e) => !newExportNames.has(e.name));

  // Detect modified functions (same name, different params or return type)
  const modifiedFunctions = newFunctions.filter((nf) => {
    const of = oldFunctions.find((f) => f.name === nf.name);
    if (!of) return false;
    return of.params !== nf.params || of.returnType !== nf.returnType || of.async !== nf.async;
  });

  const diff = {
    added: { functions: addedFunctions.map((f) => f.name), classes: addedClasses.map((c) => c.name), exports: addedExports.map((e) => e.name) },
    removed: { functions: removedFunctions.map((f) => f.name), classes: removedClasses.map((c) => c.name), exports: removedExports.map((e) => e.name) },
    modified: { functions: modifiedFunctions.map((f) => ({ name: f.name, newParams: f.params, newReturn: f.returnType })) },
    stats: {
      oldLines: oldCode.split('\n').length,
      newLines: newCode.split('\n').length,
      oldFunctions: oldFunctions.length,
      newFunctions: newFunctions.length,
      oldClasses: oldClasses.length,
      newClasses: newClasses.length,
    },
  };

  const prompt = [
    `You are a release engineer writing a changelog entry. Analyze the differences between two code versions.`,
    ``,
    `Structural Diff:`,
    JSON.stringify(diff, null, 2),
    ``,
    `Old Code (first 8000 chars):`,
    oldCode.slice(0, 8000),
    ``,
    `New Code (first 8000 chars):`,
    newCode.slice(0, 8000),
    ``,
    `Generate a changelog entry with:`,
    `1. Version header placeholder (## [x.x.x] - YYYY-MM-DD)`,
    `2. ### Added — new features/functions/classes`,
    `3. ### Changed — modified behaviors, parameter changes, return type changes`,
    `4. ### Deprecated — anything marked for future removal`,
    `5. ### Removed — deleted functions/classes/exports`,
    `6. ### Fixed — bug fixes (if evident from code changes)`,
    `7. ### Breaking Changes — anything that breaks backward compatibility`,
    ``,
    `For each entry, provide a human-readable description (not just "added function X").`,
    `Format as Markdown following Keep a Changelog conventions.`,
  ].join('\n');

  const result = await invokeAgent('SCHEHERAZADE', prompt, { includeSubAgents: false });

  if (!result.ok) {
    // Local fallback: generate changelog from structural diff
    const sections = ['## [x.x.x] - ' + new Date().toISOString().split('T')[0], ''];

    if (diff.added.functions.length > 0 || diff.added.classes.length > 0) {
      sections.push('### Added', '');
      for (const f of diff.added.functions) sections.push(`- Added function \`${f}\``);
      for (const c of diff.added.classes) sections.push(`- Added class \`${c}\``);
      sections.push('');
    }
    if (diff.modified.functions.length > 0) {
      sections.push('### Changed', '');
      for (const f of diff.modified.functions) sections.push(`- Modified \`${f.name}\` (new params: \`${f.newParams}\`)`);
      sections.push('');
    }
    if (diff.removed.functions.length > 0 || diff.removed.classes.length > 0) {
      sections.push('### Removed', '');
      for (const f of diff.removed.functions) sections.push(`- Removed function \`${f}\``);
      for (const c of diff.removed.classes) sections.push(`- Removed class \`${c}\``);
      sections.push('');
    }

    sections.push(`_Lines: ${diff.stats.oldLines} -> ${diff.stats.newLines} | Functions: ${diff.stats.oldFunctions} -> ${diff.stats.newFunctions} | Classes: ${diff.stats.oldClasses} -> ${diff.stats.newClasses}_`);

    return { ok: true, changelog: sections.join('\n'), durationMs: result.durationMs, fallback: true };
  }

  return { ok: true, changelog: result.data, durationMs: result.durationMs };
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI runner for the doc generator extension.
 * @param {object} args - Parsed CLI arguments
 * @param {string} [args.command] - Sub-command: 'generate' (default), 'readme', 'examples', 'changelog'
 * @param {string} args.file - Path to source file
 * @param {'jsdoc'|'readme'|'api-reference'} [args.style='api-reference']
 * @param {string} [args.output] - Output file path
 * @param {boolean} [args.examples] - Include usage examples
 * @param {string} [args.old] - Old version file (for changelog)
 * @param {string} [args.new] - New version file (for changelog)
 */
const run = async (args) => {
  const command = args.command || args._?.[0] || 'generate';
  const fs = await import('node:fs/promises');
  const nodePath = await import('node:path');

  if (command === 'changelog') {
    if (!args.old || !args.new) {
      console.error('Error: --old and --new are required for changelog generation.');
      process.exit(1);
    }
    const oldCode = await fs.readFile(nodePath.resolve(args.old), 'utf-8');
    const newCode = await fs.readFile(nodePath.resolve(args.new), 'utf-8');

    console.log('Generating changelog via SCHEHERAZADE...\n');
    const result = await generateChangelog(oldCode, newCode);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.fallback) console.log('[fallback] SCHEHERAZADE unavailable, using structural diff.\n');
    if (args.output) {
      await fs.writeFile(nodePath.resolve(args.output), result.changelog, 'utf-8');
      console.log(`Changelog written to ${args.output}`);
    } else {
      console.log(result.changelog);
    }
    if (result.durationMs) console.log(`\n--- Generated in ${result.durationMs}ms ---`);
    return;
  }

  if (!args.file) {
    console.error('Error: --file is required (path to source file).');
    process.exit(1);
  }

  const filePath = nodePath.resolve(args.file);
  const code = await fs.readFile(filePath, 'utf-8');
  const filename = nodePath.basename(filePath);

  // Local extraction summary
  const functions = extractFunctions(code);
  const classes = extractClasses(code);
  const exports = extractExports(code);
  const jsdocs = extractJSDoc(code);

  console.log(`Analyzed ${filename}:`);
  console.log(`  Functions: ${functions.length} (${functions.filter((f) => f.exported).length} exported)`);
  console.log(`  Classes: ${classes.length}`);
  console.log(`  Exports: ${exports.length}`);
  console.log(`  JSDoc blocks: ${jsdocs.length}`);

  if (command === 'examples') {
    const exportedFuncs = functions.filter((f) => f.exported);
    if (exportedFuncs.length === 0) {
      console.log('\nNo exported functions found to generate examples for.');
      return;
    }
    console.log(`\nGenerating examples for ${exportedFuncs.length} exported functions via SCHEHERAZADE...\n`);
    const result = await generateExamples(exportedFuncs);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.fallback) console.log('[fallback] SCHEHERAZADE unavailable, using stub examples.\n');
    if (args.output) {
      await fs.writeFile(nodePath.resolve(args.output), result.examples, 'utf-8');
      console.log(`Examples written to ${args.output}`);
    } else {
      console.log(result.examples);
    }
    if (result.durationMs) console.log(`\n--- Generated in ${result.durationMs}ms ---`);
    return;
  }

  if (command === 'readme') {
    const projectDesc = args.description || `Project based on ${filename}`;
    console.log(`\nGenerating README via MURASAKI...\n`);
    const result = await generateReadme(code, projectDesc);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.fallback) console.log('[fallback] MURASAKI unavailable, using local extraction.\n');
    if (args.output) {
      await fs.writeFile(nodePath.resolve(args.output), result.readme, 'utf-8');
      console.log(`README written to ${args.output}`);
    } else {
      console.log(result.readme);
    }
    if (result.durationMs) console.log(`\n--- Generated in ${result.durationMs}ms ---`);
    return;
  }

  // Default: generate docs
  const style = args.style || 'api-reference';
  const includeExamples = args.examples === true || args.examples === 'true';

  // Print local signature table
  console.log(`\nFunction Signatures:`);
  console.log(buildSignatureTable(functions));
  console.log('');

  console.log(`Generating ${style} documentation via SCHEHERAZADE...\n`);
  const result = await generateDocs(code, { style, includeExamples });

  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  if (result.fallback) console.log('[fallback] SCHEHERAZADE unavailable, using local extraction.\n');

  if (args.output) {
    await fs.writeFile(nodePath.resolve(args.output), result.documentation, 'utf-8');
    console.log(`Documentation written to ${args.output}`);
  } else {
    console.log(result.documentation);
  }

  if (result.durationMs) console.log(`\n--- Generated in ${result.durationMs}ms ---`);
};

// ---------------------------------------------------------------------------
// Extension metadata
// ---------------------------------------------------------------------------

export const EXTENSION_META = {
  name: 'nha-doc-generator',
  displayName: 'Doc Generator',
  category: 'content-creation',
  version: '2.1.0',
  description: 'Generate comprehensive documentation from source code with local regex extraction and AI-powered content via SCHEHERAZADE (structured docs) and MURASAKI (long-form README). Supports JSDoc, API reference, and README styles with changelog generation. Falls back to local extraction when agents are unavailable.',
  commands: [
    { name: 'generate', description: 'Generate documentation from source code', args: '--file <path> [--style jsdoc|readme|api-reference] [--examples] [--output <path>]' },
    { name: 'readme', description: 'Generate a full README for a project', args: '--file <path> [--description <text>] [--output <path>]' },
    { name: 'examples', description: 'Generate usage examples for exported functions', args: '--file <path> [--output <path>]' },
    { name: 'changelog', description: 'Generate changelog from two code versions', args: '--old <path> --new <path> [--output <path>]' },
  ],
  examplePrompts: [
    'Generate API reference documentation for my authentication service',
    'Create a README for my data processing library',
    'Generate usage examples for all exported functions in this module',
    'Produce a changelog between v1 and v2 of my API client',
    'Document this TypeScript module with JSDoc-style comments and parameter tables',
  ],
  useCases: [
    'Auto-generating API reference documentation from TypeScript/JavaScript source',
    'Creating comprehensive READMEs for new libraries and modules',
    'Generating realistic usage examples for developer onboarding',
    'Producing changelogs between code versions for release notes',
    'Extracting and tabulating function signatures for quick reference',
  ],
};

export {
  extractJSDoc,
  extractFunctions,
  extractClasses,
  extractExports,
  buildSignatureTable,
  generateLocalDocsFallback,
  generateDocs,
  generateReadme,
  generateExamples,
  generateChangelog,
  run,
};
