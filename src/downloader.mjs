/** HTTP downloader with integrity verification — zero dependencies */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fail } from './ui.mjs';

/**
 * Download a file from URL to disk, with automatic retry on transient errors.
 *
 * Retries on: timeouts, DNS failures, ECONNRESET, 5xx responses. Backs off
 * exponentially (1s, 3s, 9s). Never retries on 4xx (semantic errors).
 *
 * @param {string} url
 * @param {string} dest — absolute file path
 * @param {object} opts
 * @param {string} [opts.sha256]    — expected hash (hex)
 * @param {number} [opts.timeout]   — ms per attempt (default 30s)
 * @param {number} [opts.retries]   — total attempts (default 3)
 * @returns {Promise<boolean>}
 */
export async function download(url, dest, opts = {}) {
  const timeout = opts.timeout ?? 30_000;
  const maxAttempts = Math.max(1, opts.retries ?? 3);
  const { VERSION } = await import('./constants.mjs').catch(() => ({ VERSION: 'dev' }));

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': `nha-cli/${VERSION}` },
      });
      clearTimeout(timer);

      if (!res.ok) {
        // 5xx → retry; 4xx → permanent failure, no retry
        if (res.status >= 500 && attempt < maxAttempts) {
          await _delay(_backoff(attempt));
          continue;
        }
        fail(`HTTP ${res.status} downloading ${path.basename(dest)}`);
        return false;
      }

      const buffer = Buffer.from(await res.arrayBuffer());

      if (opts.sha256) {
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        if (hash !== opts.sha256) {
          fail(`Integrity check failed for ${path.basename(dest)}`);
          fail(`  Expected: ${opts.sha256}`);
          fail(`  Got:      ${hash}`);
          return false;
        }
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
      return true;
    } catch (err) {
      lastErr = err;
      const transient = err.name === 'AbortError'
        || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|UND_ERR/i.test(err.message || '');
      if (transient && attempt < maxAttempts) {
        await _delay(_backoff(attempt));
        continue;
      }
      break;
    }
  }
  if (lastErr) {
    if (lastErr.name === 'AbortError') fail(`Timeout downloading ${path.basename(dest)} after ${maxAttempts} attempts`);
    else fail(`Failed to download ${path.basename(dest)}: ${lastErr.message}`);
  }
  return false;
}

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function _backoff(attempt) {
  // 1s, 3s, 9s — capped at 30s
  return Math.min(30_000, 1000 * Math.pow(3, attempt - 1));
}

/**
 * Download multiple files in parallel with concurrency limit.
 * @param {Array<{url: string, dest: string, sha256?: string}>} tasks
 * @param {number} concurrency
 * @param {function} [onProgress] — (completed, total) => void
 * @returns {Promise<{ok: number, failed: number}>}
 */
export async function downloadBatch(tasks, concurrency = 6, onProgress) {
  let completed = 0;
  let failed = 0;
  let i = 0;

  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++];
      const success = await download(task.url, task.dest, { sha256: task.sha256 });
      if (success) completed++;
      else failed++;
      onProgress?.(completed + failed, tasks.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);

  return { ok: completed, failed };
}
