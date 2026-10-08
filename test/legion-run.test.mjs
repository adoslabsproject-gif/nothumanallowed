/**
 * The real `nha` command, end to end, in an empty home directory.
 *
 * A stub answers as the local model and a network guard refuses every other
 * destination: the suite proves that installing and deliberating needs no
 * server, and shows exactly what the command still tries to reach.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startStubModel } from './fixtures/stub-model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NHA = path.join(ROOT, 'bin', 'nha');
const GUARD = path.join(ROOT, 'test', 'fixtures', 'network-guard.mjs');

const PROMPT = 'Compare session cookies and JWT for a banking app that serves two million customers ' +
  'across web and mobile, considering revocation, horizontal scaling, regulatory audit requirements, ' +
  'the cost of migration for the operations team and the impact on login latency.';

/** Everything the command may try to reach besides the model. All of it is refused here. */
const KNOWN_OUTSIDE_CALLS = [
  'https://nothumanallowed.com/api/v1/telemetry/ping',
  'https://nothumanallowed.com/cli/versions.json',
  'https://registry.npmjs.org/nothumanallowed/latest',
];

let home;
let stub;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nha-e2e-'));
  stub = await startStubModel();
});

afterEach(async () => {
  await stub.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

function nha(args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NHA, ...args], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        NODE_OPTIONS: '--import=' + GUARD,
        NHA_TEST_NETWORK_LOG: path.join(home, 'network.log'),
        NHA_TEST_ALLOWED_ORIGIN: stub.origin,
        ...(extraEnv || {}),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function network() {
  const logFile = path.join(home, 'network.log');
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean) : [];
}

const outside = () => [...new Set(network().filter((url) => !url.startsWith(stub.origin)))];
const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8);

async function useLocalModel() {
  for (const [key, value] of [['legion-provider', 'ollama'], ['ollama-url', stub.origin], ['ollama-model', 'stub-model']]) {
    const result = await nha(['config', 'set', key, value]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
}

describe('first run', () => {
  it('installs Legion X and the 38 agents from the package, with the website unreachable', async () => {
    const started = Date.now();
    const result = await nha(['config', 'set', 'legion-provider', 'ollama']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    // An unreachable website must not keep the command hanging on a download timer.
    assert.ok(Date.now() - started < 10_000, 'first run took ' + (Date.now() - started) + 'ms');

    const agents = fs.readdirSync(path.join(home, '.nha', 'agents')).filter((f) => f.endsWith('.mjs'));
    assert.equal(agents.length, 38);
    assert.match(result.stdout, /38 agents installed/);
    assert.match(result.stdout, /Legion X v\d+\.\d+\.\d+ ready/);

    // Nothing of Legion is fetched: neither the orchestrator nor an agent.
    assert.deepEqual(network().filter((url) => /legion-x\.mjs|\/cli\/agents\//.test(url)), []);
    // PIF is the only thing still downloaded, and its absence is said, not fatal.
    assert.match(result.stdout, /PIF could not be downloaded/);
  });

  it('prints the version of the Legion X it ships', async () => {
    const result = await nha(['version']);
    assert.match(result.stdout, /^nha v17\.0\.0\nLegion X v\d+\.\d+\.\d+\n/);
  });
});

describe('nha run', () => {
  it('refuses to start without a provider, and says how to set a key or a local model', async () => {
    const result = await nha(['run', PROMPT]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /No LLM provider is configured for deliberations/);
    assert.match(result.stdout, /nha config set legion-provider ollama/);
    assert.match(result.stdout, /nha config set key/);
    assert.equal(stub.requests.length, 0);
  });

  it('completes a deliberation on a local model with no API key and no server', async () => {
    await useLocalModel();
    const result = await nha(['run', PROMPT, '--no-immersive']);
    assert.equal(result.code, 0, result.stdout.slice(-2000) + result.stderr);

    // The whole deliberation went to the local model.
    assert.ok(stub.requests.length > 20, 'requests to the model: ' + stub.requests.length);
    assert.ok(stub.requests.every((r) => r.model === 'stub-model'));
    assert.equal(stub.requests.filter((r) => r.system.includes('You are PROMETHEUS, the routing brain')).length, 1);
    assert.equal(stub.requests.filter((r) => r.system.includes('You are ATHENA')).length, 1);

    // Real deliberation: in round 2 an agent reads the round 1 positions of the others.
    const saberRound2 = stub.requests.find((r) => r.system.includes('You are SABER') && r.user.includes('--- TRIBUNAL CHALLENGE ---'));
    assert.ok(saberRound2, 'SABER took part in round 2');
    assert.ok(saberRound2.user.includes('ROUND1-ORACLE: server side sessions allow immediate revocation for a bank.'));

    // Nothing but the model was reached. What was attempted is the known list, and no deliberation endpoint.
    assert.deepEqual(outside().filter((url) => !KNOWN_OUTSIDE_CALLS.includes(url)), []);
    assert.deepEqual(network().filter((url) => url.includes('/geth')), []);

    // The deliberation is saved on disk.
    const saved = result.stdout.replace(/\x1b\[[0-9;]*m/g, '').match(/Session transcript saved to (\S+\.md)/);
    assert.ok(saved, 'the transcript path is printed');
    assert.ok(fs.readFileSync(saved[1], 'utf-8').includes('Use server side sessions with rotation.'));
  });

  it('keeps a deliberation on the machine under local-only, even with a cloud key configured and exported', async () => {
    await useLocalModel();
    for (const [key, value] of [['provider', 'anthropic'], ['key', 'CONFIGURED-CLOUD-KEY'], ['local-only', 'true']]) {
      assert.equal((await nha(['config', 'set', key, value])).code, 0);
    }
    const result = await nha(['run', PROMPT, '--no-immersive'], { ANTHROPIC_API_KEY: 'EXPORTED-CLOUD-KEY', OPENAI_API_KEY: 'EXPORTED-OPENAI-KEY' });
    assert.equal(result.code, 0, result.stdout.slice(-2000) + result.stderr);

    assert.ok(stub.requests.length > 20);
    assert.deepEqual(outside().filter((url) => !KNOWN_OUTSIDE_CALLS.includes(url)), []);

    const legionConfig = fs.readFileSync(path.join(home, '.nha', '.legion-config.json'), 'utf-8');
    assert.equal(legionConfig.includes('CONFIGURED-CLOUD-KEY'), false);
    assert.equal(JSON.parse(legionConfig).provider, 'ollama');
  });

  it('spreads the agents over cloud and local when both are configured and local-only is off', async () => {
    await useLocalModel();
    for (const [key, value] of [['provider', 'anthropic'], ['key', 'CONFIGURED-CLOUD-KEY']]) {
      assert.equal((await nha(['config', 'set', key, value])).code, 0);
    }
    await nha(['run', PROMPT, '--no-immersive']);
    // The guard refuses the cloud call: what matters is that it was attempted.
    assert.ok(outside().includes('https://api.anthropic.com/v1/messages'), outside().join(', '));
    assert.ok(stub.requests.length > 0);
  });
});

describe('configuration', () => {
  it('never prints a secret back and keeps the files readable by their owner only', async () => {
    const result = await nha(['config', 'set', 'gemini-key', 'AIzaSECRET-VALUE-123']);
    assert.equal(result.code, 0);
    assert.equal((result.stdout + result.stderr).includes('AIzaSECRET-VALUE-123'), false);
    assert.equal(mode(path.join(home, '.nha', 'config.json')), '600');

    await useLocalModel();
    await nha(['agents']);
    assert.equal(mode(path.join(home, '.nha', '.legion-config.json')), '600');
  });

  it('tightens a config file left world-readable by an older version', async () => {
    await nha(['config', 'set', 'legion-provider', 'ollama']);
    const file = path.join(home, '.nha', 'config.json');
    fs.chmodSync(file, 0o644);
    await nha(['config', 'set', 'ollama-model', 'stub-model']);
    assert.equal(mode(file), '600');
  });

  it('refuses the Legion config:set, whose value would be lost at the next run', async () => {
    const result = await nha(['config:set', 'ollama-model', 'x']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /nha config set <key> <value>/);
  });
});
