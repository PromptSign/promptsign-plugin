#!/usr/bin/env node
// Manual verification, for the /promptsign:verify skill and for humans.
//
//   node scripts/check.mjs <path>...        verify each target
//   node scripts/check.mjs --tree <root>... verify a whole tree
//
// Exit codes match the CLI: 0 pass, 1 verifier error, 2 verification failed.

import { spawnSync } from 'node:child_process';
import { applyTrustEnv, binaryName, formatResult, loadNapi } from './runtime.mjs';

const argv = process.argv.slice(2);
const tree = argv.includes('--tree');
const targets = argv.filter((a) => !a.startsWith('--'));

if (targets.length === 0) {
  process.stderr.write('usage: check.mjs [--tree] <path>...\n');
  process.exit(1);
}

applyTrustEnv();

// Tier 1: defer to the binary so its output is the canonical one.
const viaBin = spawnSync(binaryName(), [tree ? 'verify-tree' : 'verify', ...targets], {
  encoding: 'utf8',
});
if (!viaBin.error && viaBin.status !== null && viaBin.status < 3) {
  if (viaBin.stdout) process.stdout.write(viaBin.stdout);
  if (viaBin.stderr) process.stderr.write(viaBin.stderr);
  process.exit(viaBin.status);
}

const napi = loadNapi();
if (!napi) {
  process.stderr.write(
    'PromptSign: no verifier available. Run /promptsign:setup for the options.\n',
  );
  process.exit(1);
}

let results;
try {
  results = tree ? napi.verifyTree(targets) : targets.map((t) => napi.verify(t));
} catch (e) {
  process.stderr.write(`PromptSign: verifier error: ${e.message}\n`);
  process.exit(1);
}

for (const r of results) process.stdout.write(`${formatResult(r)}\n    at ${r.target}\n`);
process.exit(results.some((r) => r.action === 'fail') ? 2 : 0);
