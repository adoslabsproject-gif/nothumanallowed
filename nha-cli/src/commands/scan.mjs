/**
 * nha scan <path> — Scan a project with SABER + ZERO agents.
 * Reads files, builds context, runs security + vulnerability analysis.
 * Zero server. Direct LLM calls with your API key.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config.mjs';
import { callAgent } from '../services/llm.mjs';
import { fail, info, ok, warn, C, G, Y, D, W, BOLD, NC, R } from '../ui.mjs';

const SCAN_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.php', '.c', '.cpp', '.h', '.cs', '.swift',
  '.sh', '.bash', '.zsh',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.env', '.env.example', '.env.local',
  '.sql', '.prisma', '.graphql',
  '.dockerfile', '.docker-compose.yml',
  '.tf', '.hcl',
  '.md', '.txt',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out',
  '__pycache__', '.venv', 'venv', 'vendor', 'target',
  '.cache', '.turbo', 'coverage', '.nyc_output',
]);

const MAX_FILE_SIZE = 100_000; // 100KB per file
const MAX_TOTAL_CHARS = 200_000; // 200KB total context

function scanDirectory(dirPath, files = [], depth = 0) {
  if (depth > 8) return files;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.env.example') continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scanDirectory(fullPath, files, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SCAN_EXTENSIONS.has(ext) || entry.name === 'Dockerfile' || entry.name === 'Makefile') {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size <= MAX_FILE_SIZE && stat.size > 0) {
              files.push({ path: fullPath, size: stat.size, ext });
            }
          } catch {}
        }
      }
    }
  } catch {}
  return files;
}

function buildProjectContext(projectPath, files) {
  let context = `Project: ${projectPath}\nFiles scanned: ${files.length}\n\n`;
  let totalChars = context.length;

  // Prioritize security-relevant files first
  const prioritized = files.sort((a, b) => {
    const securityFiles = ['.env', 'auth', 'login', 'password', 'secret', 'token', 'key', 'security', 'middleware'];
    const aScore = securityFiles.some(s => a.path.toLowerCase().includes(s)) ? 0 : 1;
    const bScore = securityFiles.some(s => b.path.toLowerCase().includes(s)) ? 0 : 1;
    return aScore - bScore;
  });

  for (const file of prioritized) {
    if (totalChars >= MAX_TOTAL_CHARS) break;
    try {
      const content = fs.readFileSync(file.path, 'utf-8');
      const relative = path.relative(projectPath, file.path);
      const entry = `\n--- ${relative} (${file.size} bytes) ---\n${content.slice(0, MAX_FILE_SIZE)}\n`;
      if (totalChars + entry.length > MAX_TOTAL_CHARS) {
        const remaining = MAX_TOTAL_CHARS - totalChars;
        context += entry.slice(0, remaining) + '\n[... truncated ...]\n';
        break;
      }
      context += entry;
      totalChars += entry.length;
    } catch {}
  }

  return context;
}

export async function cmdScan(args) {
  const projectPath = args[0] ? path.resolve(args[0]) : process.cwd();

  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    fail(`Not a directory: ${projectPath}`);
    process.exit(1);
  }

  const config = loadConfig();
  if (!config.llm.apiKey) {
    fail('No API key configured. Run: nha config set key YOUR_KEY');
    process.exit(1);
  }

  // Parse flags
  let agents = ['saber', 'zero'];
  let outputFile = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--agents' && args[i + 1]) { agents = args[++i].split(','); continue; }
    if (args[i] === '--output' && args[i + 1]) { outputFile = args[++i]; continue; }
    if (args[i] === '-o' && args[i + 1]) { outputFile = args[++i]; continue; }
  }

  console.log(`\n  ${BOLD}NHA Project Scanner${NC}`);
  console.log(`  ${D}Path: ${projectPath}${NC}\n`);

  // Scan files
  info('Scanning project files...');
  const files = scanDirectory(projectPath);
  ok(`Found ${files.length} scannable files`);

  if (files.length === 0) {
    warn('No source files found.');
    return;
  }

  // Show file breakdown
  const extCounts = {};
  for (const f of files) {
    extCounts[f.ext] = (extCounts[f.ext] || 0) + 1;
  }
  const breakdown = Object.entries(extCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  ${D}${breakdown.map(([e, c]) => `${e}: ${c}`).join(' | ')}${NC}\n`);

  // Build context
  info('Building project context...');
  const context = buildProjectContext(projectPath, files);
  ok(`Context: ${(context.length / 1024).toFixed(0)} KB from ${files.length} files`);

  // Run agents
  const results = {};
  for (const agentName of agents) {
    info(`Running ${agentName.toUpperCase()}...`);
    const startTime = Date.now();
    try {
      const result = await callAgent(config, agentName,
        `Perform a thorough analysis of this project. Focus on:\n` +
        `- Security vulnerabilities (OWASP Top 10, CWE references)\n` +
        `- Hardcoded secrets, API keys, passwords\n` +
        `- Dependency risks, outdated patterns\n` +
        `- Authentication/authorization issues\n` +
        `- Input validation, injection vectors\n` +
        `- Configuration security\n` +
        `- Code quality issues that impact security\n\n` +
        `PROJECT FILES:\n${context}`
      );
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      results[agentName] = result;
      ok(`${agentName.toUpperCase()} complete (${elapsed}s)`);
    } catch (e) {
      warn(`${agentName.toUpperCase()} failed: ${e.message}`);
      results[agentName] = `Error: ${e.message}`;
    }
  }

  // Display results
  console.log(`\n${'='.repeat(60)}`);
  for (const [agent, result] of Object.entries(results)) {
    console.log(`\n  ${BOLD}${C}${agent.toUpperCase()} REPORT${NC}\n`);
    console.log(result);
    console.log(`\n${'─'.repeat(60)}`);
  }

  // Save to file if requested
  if (outputFile) {
    const report = Object.entries(results)
      .map(([agent, result]) => `# ${agent.toUpperCase()} REPORT\n\n${result}`)
      .join('\n\n---\n\n');
    const header = `# NHA Security Scan Report\n\nProject: ${projectPath}\nDate: ${new Date().toISOString()}\nAgents: ${agents.join(', ')}\nFiles scanned: ${files.length}\n\n---\n\n`;
    fs.writeFileSync(outputFile, header + report, 'utf-8');
    ok(`Report saved to ${outputFile}`);
  }

  console.log('');
}
