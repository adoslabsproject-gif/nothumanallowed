/**
 * Legion X inside the package: what is shipped, how the agents reach the
 * user's directory, and how the nha config becomes the config Legion reads.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGENTS, VERSION } from '../src/constants.mjs';
import { bundledLegionVersion, syncBundledAgents } from '../src/legion-bundle.mjs';
import { buildLegionConfig, legionReadiness } from '../src/legion-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'src', 'legion');

describe('what the package ships', () => {
  it('holds one file for each of the 38 agents, and nothing else', () => {
    const shipped = fs.readdirSync(path.join(BUNDLE, 'agents')).filter((f) => !f.startsWith('.')).sort();
    assert.equal(AGENTS.length, 38);
    assert.deepEqual(shipped, AGENTS.map((name) => `${name}.mjs`).sort());
  });

  it('ships a Legion X that states its version', () => {
    assert.match(bundledLegionVersion(), /^\d+\.\d+\.\d+$/);
    assert.equal(bundledLegionVersion(path.join(BUNDLE, 'no-such-file.mjs')), 'unknown');
  });

  it('ships nothing that calls the NHA API', () => {
    const files = [path.join(BUNDLE, 'legion-x.mjs'), ...AGENTS.map((name) => path.join(BUNDLE, 'agents', `${name}.mjs`))];
    const offenders = files.filter((file) => /nothumanallowed\.com\/api/.test(fs.readFileSync(file, 'utf-8')));
    assert.deepEqual(offenders.map((f) => path.basename(f)), []);
  });

  it('is published: the bundle sits under a directory listed in package.json "files"', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.files.includes('src/'));
  });

  it('states one version: the one in package.json is the one the command prints', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    assert.equal(VERSION, pkg.version);
  });
});

describe('agents copied to the user directory', () => {
  let dir;
  let options;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nha-agents-'));
    options = { targetDir: path.join(dir, 'agents'), stampFile: path.join(dir, 'agents', '.bundle-version'), version: '17.0.0' };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const agentFile = (name) => path.join(options.targetDir, `${name}.mjs`);

  it('copies every agent on a fresh install and records the version', () => {
    const result = syncBundledAgents(options);
    assert.deepEqual(result, { copied: 38, missing: [], reason: 'fresh' });
    assert.equal(fs.readFileSync(options.stampFile, 'utf-8').trim(), '17.0.0');
    assert.equal(
      fs.readFileSync(agentFile('saber'), 'utf-8'),
      fs.readFileSync(path.join(BUNDLE, 'agents', 'saber.mjs'), 'utf-8'),
    );
  });

  it('leaves the files alone when nothing changed, including an agent the user edited', () => {
    syncBundledAgents(options);
    fs.writeFileSync(agentFile('saber'), '// edited by the user\n');
    assert.deepEqual(syncBundledAgents(options), { copied: 0, missing: [], reason: 'up-to-date' });
    assert.equal(fs.readFileSync(agentFile('saber'), 'utf-8'), '// edited by the user\n');
  });

  it('restores only the agent that went missing', () => {
    syncBundledAgents(options);
    fs.writeFileSync(agentFile('saber'), '// edited by the user\n');
    fs.rmSync(agentFile('oracle'));
    assert.deepEqual(syncBundledAgents(options), { copied: 1, missing: [], reason: 'incomplete' });
    assert.ok(fs.existsSync(agentFile('oracle')));
    assert.equal(fs.readFileSync(agentFile('saber'), 'utf-8'), '// edited by the user\n');
  });

  it('replaces every agent when the package version changed', () => {
    syncBundledAgents(options);
    fs.writeFileSync(agentFile('saber'), '// agent of the previous version\n');
    const result = syncBundledAgents({ ...options, version: '17.0.1' });
    assert.deepEqual(result, { copied: 38, missing: [], reason: 'version' });
    assert.notEqual(fs.readFileSync(agentFile('saber'), 'utf-8'), '// agent of the previous version\n');
    assert.equal(fs.readFileSync(options.stampFile, 'utf-8').trim(), '17.0.1');
  });

  it('reports an agent the package does not contain and does not record the copy as done', () => {
    const result = syncBundledAgents({ ...options, agents: ['saber', 'ghost'] });
    assert.deepEqual(result, { copied: 1, missing: ['ghost'], reason: 'fresh' });
    assert.equal(fs.existsSync(options.stampFile), false);
  });
});

describe('nha config → Legion config', () => {
  const base = (llm, legion) => ({ llm: { provider: 'nha', apiKey: '', ...llm }, legion: legion || {} });

  it('writes the generic key under the name of its own provider, and under no other', () => {
    const out = buildLegionConfig(base({ provider: 'openai', apiKey: 'OPENAI-K' }));
    assert.equal(out.provider, 'openai');
    assert.equal(out.openaiApiKey, 'OPENAI-K');
    assert.equal(out.anthropicApiKey, '');
    assert.equal(out.llmApiKey, '');
  });

  it('uses the key names Legion reads, not the ones the nha config uses', () => {
    const out = buildLegionConfig(base({ provider: 'anthropic', apiKey: 'A', openaiKey: 'O', geminiKey: 'G', mistralKey: 'M' }));
    assert.deepEqual(
      [out.anthropicApiKey, out.openaiApiKey, out.geminiApiKey, out.mistralApiKey],
      ['A', 'O', 'G', 'M'],
    );
    assert.equal('openaiKey' in out, false);
  });

  it('does not hand Legion a provider it cannot deliberate with', () => {
    assert.equal(buildLegionConfig(base({ provider: 'nha' })).provider, '');
    assert.equal(buildLegionConfig(base({ provider: 'openrouter', apiKey: 'K' })).provider, '');
  });

  it('lets the provider chosen for deliberations win over the chat provider', () => {
    const out = buildLegionConfig(base({ provider: 'anthropic', apiKey: 'A' }, { provider: 'ollama', ollamaModel: 'qwen2.5:7b' }));
    assert.equal(out.provider, 'ollama');
    assert.equal(out.ollamaModel, 'qwen2.5:7b');
    // Local and cloud together: the cloud key is still handed over.
    assert.equal(out.anthropicApiKey, 'A');
  });

  it('hands over no cloud key at all when local-only is on', () => {
    const out = buildLegionConfig(base(
      { provider: 'anthropic', apiKey: 'A', openaiKey: 'O' },
      { provider: 'ollama', ollamaModel: 'qwen2.5:7b', localOnly: true },
    ));
    const keys = Object.entries(out).filter(([name]) => /ApiKey$/.test(name)).map(([, value]) => value);
    assert.deepEqual([...new Set(keys)], ['']);
    assert.equal(out.localOnly, true);
  });

  it('passes several local models and the optional settings through', () => {
    const out = buildLegionConfig(base({}, {
      provider: 'ollama', ollamaUrl: 'http://10.0.0.5:11434', ollamaModels: 'llama3.1,qwen2.5', ollamaEmbedModel: 'nomic-embed-text',
      orchestratorProvider: 'ollama:qwen2.5', economy: true, factCheck: false, crossReadingChars: 2000,
    }));
    assert.equal(out.ollamaUrl, 'http://10.0.0.5:11434');
    assert.equal(out.ollamaModels, 'llama3.1,qwen2.5');
    assert.equal(out.ollamaEmbedModel, 'nomic-embed-text');
    assert.equal(out.orchestratorProvider, 'ollama:qwen2.5');
    assert.equal(out.economy, true);
    assert.equal(out.factCheckEnabled, false);
    assert.equal(out.crossReadingChars, 2000);
  });
});

describe('can a deliberation start?', () => {
  const ready = (llm, legion, env) => legionReadiness(buildLegionConfig({ llm: { provider: 'nha', apiKey: '', ...llm }, legion: legion || {} }), env || {});

  it('says no on a fresh install: the default provider is not one Legion can use', () => {
    const result = ready({});
    assert.equal(result.ready, false);
    assert.match(result.reason, /No LLM provider is configured/);
  });

  it('says yes with a local model and no key', () => {
    assert.deepEqual(ready({}, { provider: 'ollama' }), { ready: true, providers: ['ollama'], reason: '' });
    assert.equal(ready({}, { ollamaModel: 'qwen2.5:7b' }).ready, true);
    assert.equal(ready({}, { provider: 'local-openai', localOpenaiUrl: 'http://localhost:1234/v1/chat/completions' }).ready, true);
  });

  it('says yes with a cloud key, given in the config or in the environment', () => {
    assert.deepEqual(ready({ provider: 'gemini', apiKey: 'G' }).providers, ['gemini']);
    assert.deepEqual(ready({}, {}, { MISTRAL_API_KEY: 'M' }).providers, ['mistral']);
  });

  it('says no when the chosen cloud provider has no key', () => {
    const result = ready({ provider: 'openai' });
    assert.equal(result.ready, false);
    assert.match(result.reason, /"openai" is selected but has no API key/);
  });

  it('says no to local-openai without its address', () => {
    assert.match(ready({}, { provider: 'local-openai' }).reason, /local-openai-url is not set/);
  });

  it('ignores cloud keys under local-only, and refuses a cloud provider', () => {
    assert.deepEqual(ready({ provider: 'anthropic', apiKey: 'A' }, { provider: 'ollama', localOnly: true }, { OPENAI_API_KEY: 'O' }).providers, ['ollama']);
    assert.match(ready({ provider: 'anthropic', apiKey: 'A' }, { localOnly: true }).reason, /local-only is on/);
  });

  it('names a provider that does not exist', () => {
    assert.match(ready({}, { provider: 'olama' }).reason, /"olama" is not a provider/);
  });
});
