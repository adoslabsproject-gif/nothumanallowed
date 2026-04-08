/** HTTP downloader with integrity verification — zero dependencies */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fail } from './ui.mjs';

/**
 * Download a file from URL to disk.
 * @param {string} url
 * @param {string} dest — absolute file path
 * @param {object} opts
 * @param {string} [opts.sha256] — expected hash (hex)
 * @param {number} [opts.timeout] — ms (default 30s)
 * @returns {Promise<boolean>}
 */
export async function download(url, dest, opts = {}) {
  const timeout = opts.timeout ?? 30_000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'nha-cli/1.0.0' },
    });
    clearTimeout(timer);

    if (!res.ok) {
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
    if (err.name === 'AbortError') {
      fail(`Timeout downloading ${path.basename(dest)}`);
    } else {
      fail(`Failed to download ${path.basename(dest)}: ${err.message}`);
    }
    return false;
  }
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
