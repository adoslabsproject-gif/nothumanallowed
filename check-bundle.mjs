import { getJS } from './src/services/web-ui.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const acorn = require('/Users/zelistore/NotHumanAllowed/node_modules/.pnpm/acorn@8.15.0/node_modules/acorn/dist/acorn.js');
const js = getJS();
try {
  acorn.parse(js, { ecmaVersion: 2022, sourceType: 'script' });
  console.log('✅ Bundle OK —', js.split('\n').length, 'lines,', Math.round(js.length/1024), 'KB');
} catch(e) {
  console.error('❌ SYNTAX ERROR at line', e.loc?.line, 'col', e.loc?.column);
  console.error(e.message);
  if (e.loc) {
    const lines = js.split('\n');
    const ln = e.loc.line - 1;
    for (let i = Math.max(0, ln-3); i <= Math.min(lines.length-1, ln+3); i++) {
      console.log(i+1, ':', lines[i]?.slice(0, 120));
    }
  }
  process.exit(1);
}
