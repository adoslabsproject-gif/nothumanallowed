/**
 * Screen Capture + Vision — captures desktop screenshots for LLM analysis.
 *
 * macOS:  screencapture -x (native, silent)
 * Linux:  import -window root (ImageMagick) or gnome-screenshot or scrot
 * Windows (WSL): PowerShell screenshot via clip
 *
 * Returns base64 PNG for multimodal LLM input.
 * Zero npm dependencies.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SCREENSHOT_DIR = path.join(os.tmpdir(), 'nha-screenshots');

/**
 * Capture a screenshot of the desktop.
 * @param {object} options
 * @param {number} [options.monitor=1] - Monitor number (multi-monitor)
 * @param {boolean} [options.base64=true] - Return base64 instead of file path
 * @returns {{ ok: boolean, path?: string, base64?: string, error?: string, width?: number, height?: number }}
 */
export function captureScreen(options = {}) {
  const { monitor = 1, base64: returnBase64 = true } = options;
  const platform = os.platform();

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const filename = `screen-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);

  try {
    if (platform === 'darwin') {
      // macOS: native screencapture, -x = no sound
      const monitorFlag = monitor > 1 ? `-D ${monitor}` : '';
      execSync(`screencapture -x ${monitorFlag} "${filepath}"`, { timeout: 10_000 });
    } else if (platform === 'linux') {
      // Linux: try multiple tools in order of preference
      const tools = [
        { cmd: `gnome-screenshot -f "${filepath}"`, check: 'which gnome-screenshot' },
        { cmd: `scrot "${filepath}"`, check: 'which scrot' },
        { cmd: `import -window root "${filepath}"`, check: 'which import' },
        { cmd: `grim "${filepath}"`, check: 'which grim' }, // Wayland
      ];

      let captured = false;
      for (const tool of tools) {
        try {
          execSync(tool.check, { stdio: 'ignore' });
          execSync(tool.cmd, { timeout: 10_000 });
          captured = true;
          break;
        } catch { continue; }
      }

      if (!captured) {
        return { ok: false, error: 'No screenshot tool found. Install: sudo apt install scrot' };
      }
    } else if (platform === 'win32') {
      // Windows: PowerShell screenshot
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
        $bitmap.Save('${filepath.replace(/\\/g, '\\\\')}')
        $graphics.Dispose()
        $bitmap.Dispose()
      `.trim();
      execSync(`powershell -Command "${psScript}"`, { timeout: 15_000 });
    } else {
      return { ok: false, error: `Unsupported platform: ${platform}` };
    }

    if (!fs.existsSync(filepath)) {
      return { ok: false, error: 'Screenshot file not created' };
    }

    const stats = fs.statSync(filepath);
    if (stats.size < 100) {
      fs.rmSync(filepath, { force: true });
      return { ok: false, error: 'Screenshot file is empty' };
    }

    const result = { ok: true, path: filepath };

    if (returnBase64) {
      const buf = fs.readFileSync(filepath);
      // Resize if too large (>2MB) to save tokens
      if (buf.length > 2_000_000) {
        try {
          // Try to resize with sips (macOS) or convert (Linux)
          const resized = path.join(SCREENSHOT_DIR, `resized-${filename}`);
          if (platform === 'darwin') {
            execSync(`sips --resampleWidth 1280 "${filepath}" --out "${resized}"`, { stdio: 'ignore', timeout: 10_000 });
          } else {
            execSync(`convert "${filepath}" -resize 1280x "${resized}"`, { stdio: 'ignore', timeout: 10_000 });
          }
          if (fs.existsSync(resized)) {
            result.base64 = fs.readFileSync(resized).toString('base64');
            fs.rmSync(resized, { force: true });
          } else {
            result.base64 = buf.toString('base64');
          }
        } catch {
          result.base64 = buf.toString('base64');
        }
      } else {
        result.base64 = buf.toString('base64');
      }
    }

    // Clean up old screenshots (keep last 5)
    cleanupOldScreenshots();

    return result;
  } catch (err) {
    return { ok: false, error: `Screenshot failed: ${err.message}` };
  }
}

/**
 * Clean up old screenshot files, keeping only the 5 most recent.
 */
function cleanupOldScreenshots() {
  try {
    const files = fs.readdirSync(SCREENSHOT_DIR)
      .filter(f => f.startsWith('screen-') && f.endsWith('.png'))
      .map(f => ({ name: f, path: path.join(SCREENSHOT_DIR, f), mtime: fs.statSync(path.join(SCREENSHOT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    // Keep only last 5
    for (const file of files.slice(5)) {
      fs.rmSync(file.path, { force: true });
    }
  } catch { /* non-fatal */ }
}

/**
 * Check if screen capture is available on this platform.
 */
export function isScreenCaptureAvailable() {
  const platform = os.platform();
  if (platform === 'darwin') return true; // screencapture always available
  if (platform === 'win32') return true;  // PowerShell always available
  if (platform === 'linux') {
    const tools = ['gnome-screenshot', 'scrot', 'import', 'grim'];
    for (const tool of tools) {
      try {
        execSync(`which ${tool}`, { stdio: 'ignore' });
        return true;
      } catch { continue; }
    }
    return false;
  }
  return false;
}
