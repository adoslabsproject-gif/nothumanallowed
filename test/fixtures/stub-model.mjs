/**
 * A local model that speaks the Ollama chat API and answers from a script.
 * What it says is decided by the prompt it receives, so a full deliberation
 * can run in a test, and every request it got can be inspected afterwards.
 */

import http from 'node:http';

const AGENTS = ['SABER', 'ORACLE', 'HERALD', 'FORGE', 'LOGOS', 'JARVIS'];

const TASKS = [
  { id: 't1', description: 'Assess revocation and theft risk of each option', capability: 'security-audit', dependsOn: [], priority: 1, relevantFiles: [] },
  { id: 't2', description: 'Estimate login latency and scaling cost of each option', capability: 'data-analysis', dependsOn: [], priority: 2, relevantFiles: [] },
  { id: 't3', description: 'Describe the migration work for the operations team', capability: 'documentation', dependsOn: [], priority: 3, relevantFiles: [] },
];

function answerFor(system, user) {
  if (system.includes('You are LEGION TaskDecomposer') || system.includes('task decomposition engine')) {
    return JSON.stringify({ tasks: TASKS });
  }
  if (system.includes('You are PROMETHEUS, the routing brain')) {
    return JSON.stringify({
      agents: AGENTS.map((name) => ({ name, provider: 'ollama', focus: 'angle of ' + name })),
      rounds: 2, cassandra: true, athena: true, complexity: 'medium',
    });
  }
  if (user.includes('[TRIBUNAL MODE — MANDATORY ADVERSARIAL ANALYSIS]')) {
    return JSON.stringify({
      answer: AGENTS.map((name) => (
        '=== CHALLENGE: ' + name + ' ===\n[WEAKNESS]: the position of ' + name + ' assumes no token theft\n' +
        '[FAILURE-SCENARIO]: a stolen token stays valid for hours\n=== END CHALLENGE: ' + name + ' ==='
      )).join('\n'),
      confidence: 0.9, reasoning_summary: 'adversarial review', risk_flags: [],
    });
  }
  if (system.includes('fact-checking reviewer')) {
    return JSON.stringify({ claims: [{ claim: 'JWT cannot be revoked', agents: ['FORGE'], status: 'doubtful', note: 'a deny list revokes them' }] });
  }
  if (system.includes('You are the Geth Consensus Synthesizer')) {
    return '## Recommendation\nUse server side sessions with rotation.\n\n## Deliberation Notes\nRevocation decided it.';
  }
  if (system.includes('You are ATHENA')) {
    return '{"verdict":"PASS","omissions":[],"droppedObjections":[],"recommendation":""}';
  }
  if (system.includes('calibrated quality evaluator')) {
    return system.includes('SINGLE AGENT') ? '{"score": 0.6, "reasoning": "solid but narrow"}' : '{"score": 0.84, "reasoning": "complete and well argued"}';
  }
  const name = (system.match(/You are ([A-Z]+)/) || [])[1] || 'AGENT';
  const round = user.includes('--- TRIBUNAL CHALLENGE ---') ? 2 : 1;
  return JSON.stringify({
    answer: round === 1
      ? 'ROUND1-' + name + ': server side sessions allow immediate revocation for a bank.'
      : 'ROUND2-' + name + ': [WEAKNESS] [ACCEPT]: theft is possible, so tokens rotate on every request and bind to the device.',
    confidence: 0.8, reasoning_summary: 'position of ' + name, risk_flags: [],
  });
}

/**
 * Start the stub. Resolves with its origin, the list of requests it received
 * (filled as they arrive) and a function to stop it.
 */
export async function startStubModel() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      const system = payload.messages[0].content;
      const user = payload.messages[1].content;
      requests.push({ path: req.url, model: payload.model, system, user });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: { content: answerFor(system, user) }, prompt_eval_count: 50, eval_count: 80 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    requests,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
