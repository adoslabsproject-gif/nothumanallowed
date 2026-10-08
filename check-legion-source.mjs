/**
 * Release gate: the Legion X shipped in this package must be the one in the
 * NotHumanAllowed repository, where it is developed and tested.
 *
 * Nothing copies the files on its own: a fix made there and not brought here
 * would be published as if it were in. This compares legion-x.mjs and every
 * agent byte for byte and stops the release on the first difference.
 *
 * The source repository is taken from NHA_REPO, default ~/NotHumanAllowed.
 * On a machine without it the check cannot run: it says so and fails, unless
 * NHA_SKIP_SOURCE_CHECK=1 states that the release is made without it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, 'src', 'legion');
const repo = process.env.NHA_REPO || path.join(os.homedir(), 'NotHumanAllowed');
const source = path.join(repo, 'apps', 'web', 'public', 'cli');

if (!fs.existsSync(path.join(source, 'legion-x.mjs'))) {
  if (process.env.NHA_SKIP_SOURCE_CHECK === '1') {
    console.log('! Legion source not found at ' + source + ' — check skipped (NHA_SKIP_SOURCE_CHECK=1)');
    process.exit(0);
  }
  console.error('❌ Legion source not found at ' + source);
  console.error('   Set NHA_REPO to the NotHumanAllowed repository, or NHA_SKIP_SOURCE_CHECK=1 to release without the check.');
  process.exit(1);
}

const pairs = [['legion-x.mjs', 'legion-x.mjs']];
const shipped = fs.readdirSync(path.join(bundle, 'agents')).filter((f) => f.endsWith('.mjs'));
const developed = fs.readdirSync(path.join(source, 'agents')).filter((f) => f.endsWith('.mjs'));
for (const name of new Set([...shipped, ...developed])) pairs.push([path.join('agents', name), path.join('agents', name)]);

const different = [];
for (const [inBundle, inSource] of pairs) {
  const a = path.join(bundle, inBundle);
  const b = path.join(source, inSource);
  if (!fs.existsSync(a)) { different.push(inBundle + ' (missing from the package)'); continue; }
  if (!fs.existsSync(b)) { different.push(inBundle + ' (missing from the source)'); continue; }
  if (!fs.readFileSync(a).equals(fs.readFileSync(b))) different.push(inBundle);
}

if (different.length > 0) {
  console.error('❌ The bundled Legion X differs from ' + source + ':');
  for (const name of different) console.error('   ' + name);
  console.error('   Copy the files from the source, run the tests, then release.');
  process.exit(1);
}
console.log('✅ Legion X matches its source — legion-x.mjs + ' + (pairs.length - 1) + ' agents (' + source + ')');
