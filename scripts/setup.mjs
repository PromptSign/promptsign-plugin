#!/usr/bin/env node
// Status and one-time setup for the PromptSign plugin.
//
//   node scripts/setup.mjs             report which verifier is active
//   node scripts/setup.mjs --install   install @promptsign/verify into this
//                                      plugin, for machines without the CLI
//
// The install is a separate, user-invoked step on purpose. A hook that reaches
// for the network on session start is exactly the behaviour a signing tool has
// no business exhibiting, so the hook never installs anything. It reports that
// it cannot verify and stops.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, STRICT, applyTrustEnv, binaryName, loadNapi } from './runtime.mjs';

const wantInstall = process.argv.includes('--install');
const out = [];

applyTrustEnv();

function probeBinary() {
  const r = spawnSync(binaryName(), ['trust', 'show'], { encoding: 'utf8' });
  if (r.error) return null;
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

if (wantInstall) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  out.push(`Installing @promptsign/verify into ${PLUGIN_ROOT} ...`);
  // shell:true on Windows because Node refuses to spawn .cmd/.bat directly
  // since the CVE-2024-27980 hardening. Every argument here is a literal.
  const r = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: PLUGIN_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.error) {
    out.push(`  FAILED: could not run ${npm} (${r.error.code}). Is Node/npm on PATH?`);
  } else if (r.status !== 0) {
    out.push(`  FAILED (exit ${r.status}):`);
    out.push(`  ${(r.stderr || r.stdout || '').trim().split('\n').slice(-8).join('\n  ')}`);
  } else {
    out.push('  done.');
  }
  out.push('');
}

const bin = probeBinary();
const napi = loadNapi();

out.push('PromptSign plugin status');
out.push(`  plugin root : ${PLUGIN_ROOT}`);
out.push(`  strict mode : ${STRICT ? 'on (failures block)' : 'off (failures warn)'}`);

if (bin && bin.status === 0) {
  out.push(`  verifier    : ${binaryName()} binary (tier 1: in-process, no Node startup)`);
} else if (napi) {
  out.push(`  verifier    : @promptsign/verify ${napi.coreVersion()} (tier 2: napi)`);
} else {
  out.push('  verifier    : NONE. Nothing is being verified.');
}

const trustDir = process.env.PROMPTSIGN_TRUST_DIR || '(promptsign default: ~/.promptsign/trust)';
const pinned = path.join(PLUGIN_ROOT, 'trust');
out.push(`  trust root  : ${trustDir}${trustDir === pinned ? ' (pinned, shipped with the plugin)' : ''}`);
if (bin && bin.status === 0) out.push(`  ${bin.output.split('\n').join('\n  ')}`);
else if (!fs.existsSync(path.join(pinned, 'fulcio.pem'))) {
  out.push('  WARNING: no pinned trust root in the plugin. Run `promptsign trust fetch`.');
}

if (!bin && !napi) {
  out.push('');
  out.push('To fix, either:');
  out.push('  1. install the promptsign CLI from https://promptsign.ai (recommended: it is');
  out.push('     the fastest, and it can sign as well as verify), or');
  out.push('  2. run this script with --install to fetch @promptsign/verify from npm.');
}

process.stdout.write(`${out.join('\n')}\n`);
process.exit(bin || napi ? 0 : 1);
