'use strict';

// Scan the staged tree, not ignored local credentials. Never print matching values.
const { execFileSync } = require('node:child_process');
const { inspect } = require('./secret-rules');
const git = args => execFileSync('git', ['-c', `safe.directory=${process.cwd().replace(/\\/g, '/')}`, ...args],
  { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
let failures = 0;
for (const file of files) {
  const content = git(['show', `:${file}`]);
  const reasons = inspect(file, content);
  if (reasons.length) {
    failures++;
    console.error(`${file}: ${reasons.join('; ')} (contents hidden)`);
  }
}
if (failures) {
  console.error(`Secret check failed for ${failures} file(s). Remove credentials before committing.`);
  process.exitCode = 1;
} else console.log(`Secret check passed for ${files.length} staged/tracked files. Historical commits require a separate full-history scan.`);
