/**
 * Preloaded into every process under test (NODE_OPTIONS=--import). Each
 * outgoing request is written to the file named by NHA_TEST_NETWORK_LOG, and a
 * request to anything but the local stub model is refused before it leaves the
 * machine. The test suite never touches the real network.
 */

import fs from 'node:fs';

const logFile = process.env.NHA_TEST_NETWORK_LOG;
const allowedOrigin = process.env.NHA_TEST_ALLOWED_ORIGIN;
const realFetch = globalThis.fetch;

globalThis.fetch = async function guardedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const parsed = new URL(url);
  fs.appendFileSync(logFile, parsed.origin + parsed.pathname + '\n');
  if (parsed.origin !== allowedOrigin) {
    throw new Error('blocked by the test network guard: ' + url);
  }
  return realFetch(input, init);
};
