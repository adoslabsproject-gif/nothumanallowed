/**
 * The hosted free model can be switched off. The server then answers 200 with
 * a canned assistant message marked `__liara_unavailable`. The client must not
 * pass that off as an answer: it says the model is offline and how to set
 * another one.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { callLLMVision, callNHA, HOSTED_OFFLINE_MESSAGE, streamSSE } from '../src/services/llm.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const CANNED = '⚠️ Liara is temporarily out of service. Please try again in a few minutes.';

function answerWith(body, contentType) {
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': contentType } });
}

describe('hosted free model switched off', () => {
  it('turns the canned answer into an error that says what to set', async () => {
    answerWith(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: CANNED }, finish_reason: 'stop' }],
      __liara_unavailable: true,
    }), 'application/json');

    await assert.rejects(
      () => callNHA('nha-free-tier', null, 'system', 'hello'),
      (err) => {
        assert.equal(err.__hosted_offline, true);
        assert.equal(err.message, HOSTED_OFFLINE_MESSAGE);
        assert.match(err.message, /nha config set provider/);
        assert.match(err.message, /nha config set legion-provider ollama/);
        assert.equal(err.message.includes('try again in a few minutes'), false);
        return true;
      },
    );
  });

  it('does the same when the answer is streamed', async () => {
    const chunk = { choices: [{ index: 0, delta: { role: 'assistant', content: CANNED } }], __liara_unavailable: true };
    const res = new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { status: 200 });
    await assert.rejects(() => streamSSE(res, 'openai'), (err) => err.__hosted_offline === true);
  });

  it('does not send an image to the hosted model: vision there is gone', async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response('{}', { status: 200 }); };
    await assert.rejects(
      () => callLLMVision({ llm: { provider: 'nha' } }, 'system', 'what is this?', { base64: 'AAAA', mimeType: 'image/png' }),
      (err) => err.__hosted_offline === true && /nha config set provider/.test(err.message),
    );
    assert.equal(requests, 0);
  });

  it('still returns a real answer when the model is on', async () => {
    answerWith(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there.' } }] }), 'application/json');
    assert.equal(await callNHA('nha-free-tier', null, 'system', 'hello'), 'Hello there.');
  });
});
