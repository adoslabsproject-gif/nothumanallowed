/** Terminal colors and UI helpers — zero dependencies */

const c = (code) => `\x1b[${code}m`;
export const R = c('0;31'), G = c('0;32'), Y = c('1;33'), B = c('0;34');
export const C = c('0;36'), M = c('0;35'), W = c('1;37'), D = c('2');
export const BOLD = c('1'), NC = c('0');

export function banner() {
  console.log(`
${C}${BOLD}  ███╗   ██╗██╗  ██╗ █████╗
  ████╗  ██║██║  ██║██╔══██╗
  ██╔██╗ ██║███████║███████║
  ██║╚██╗██║██╔══██║██╔══██║
  ██║ ╚████║██║  ██║██║  ██║
  ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═╝${NC}
  ${D}NotHumanAllowed — 38 Specialized AI Agents${NC}
  ${D}"Your agents. Your machine. Your rules."${NC}
`);
}

export function info(msg) { console.log(`  ${C}▸${NC} ${msg}`); }
export function ok(msg) { console.log(`  ${G}✓${NC} ${msg}`); }
export function warn(msg) { console.log(`  ${Y}!${NC} ${msg}`); }
export function fail(msg) { console.error(`  ${R}✗${NC} ${msg}`); }

export function progress(current, total, label) {
  const pct = Math.round((current / total) * 100);
  const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
  process.stdout.write(`\r  ${D}[${bar}]${NC} ${pct}% ${label}  `);
  if (current === total) process.stdout.write('\n');
}
