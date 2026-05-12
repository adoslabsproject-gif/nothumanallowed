import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const acorn = require('/Users/zelistore/NotHumanAllowed/node_modules/.pnpm/acorn@8.15.0/node_modules/acorn/dist/acorn.js');

const assetsDir = path.join(__dirname, 'src/ui-dist/assets');
const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));

if (jsFiles.length === 0) {
  console.error('❌ No JS bundle found in src/ui-dist/assets/ — run pnpm build first');
  process.exit(1);
}

let allOk = true;
for (const f of jsFiles) {
  const js = fs.readFileSync(path.join(assetsDir, f), 'utf-8');
  try {
    acorn.parse(js, { ecmaVersion: 2022, sourceType: 'script' });
    console.log('✅ Bundle OK —', f, '—', js.split('\n').length, 'lines,', Math.round(js.length / 1024), 'KB');
  } catch (e) {
    console.error('❌ SYNTAX ERROR in', f, 'at line', e.loc?.line, 'col', e.loc?.column);
    console.error(e.message);
    if (e.loc) {
      const lines = js.split('\n');
      const ln = e.loc.line - 1;
      for (let i = Math.max(0, ln - 3); i <= Math.min(lines.length - 1, ln + 3); i++) {
        console.log(i + 1, ':', lines[i]?.slice(0, 120));
      }
    }
    allOk = false;
  }
}
if (!allOk) process.exit(1);
