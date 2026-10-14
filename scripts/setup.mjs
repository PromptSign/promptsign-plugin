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
import { PLUGIN_ROOT, applyTrustEnv, binaryName, loadNapi, strictState } from './runtime.mjs';

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

const strict = strictState();

out.push('PromptSign plugin status');
out.push(`  plugin root : ${PLUGIN_ROOT}`);
out.push(
  `  strict mode : ${strict.on ? `on (failures block; set by ${strict.why})` : 'off (failures warn)'}`,
);

if (bin && bin.status === 0) {
  out.push(`  verifier    : ${binaryName()} binary (tier 1: in-process, no Node startup)`);
} else if (napi) {
  out.push(`  verifier    : @promptsign/verify ${napi.coreVersion()} (tier 2: napi)`);
} else {
  out.push('  verifier    : NONE. Nothing is being verified.');
}

// The policy layers in evaluation order: the machine's managed policy, the
// user's, the project's. Later ones can only tighten the first (spec/04).
function policyLayers() {
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (napi?.policyLayers) {
    try {
      return napi.policyLayers(dir).map((l) => `${l.layer}  ${l.source}`);
    } catch (e) {
      return [`(could not read the policies: ${e.message})`];
    }
  }
  if (bin && bin.status === 0) {
    const r = spawnSync(binaryName(), ['policy', 'show'], { encoding: 'utf8', cwd: dir });
    const headers = (r.stdout || '').split('\n').filter((l) => /^# .*polic/.test(l));

    if (r.status === 0) return headers.map((l) => l.replace(/^# /, ''));
  }
  return null;
}

const layers = policyLayers();

if (layers) out.push(`  policies    : ${layers.join('\n                ')}`);

// The trust root keyless verification uses, and the reason. The napi binding
// accounts for the managed layer; without it, the environment decides.
const pinned = path.join(PLUGIN_ROOT, 'trust');

if (napi?.trustRoot) {
  const { dir, source } = napi.trustRoot();
  const why = {
    managed: "the machine's managed trust directory",
    lock_env: 'the managed policy sets lock_env, so the environment is ignored',
    PROMPTSIGN_TRUST_DIR: 'PROMPTSIGN_TRUST_DIR',
    PROMPTSIGN_HOME: 'PROMPTSIGN_HOME',
    bundled: 'shipped with @promptsign/verify',
    'promptsign-home-default': 'promptsign default',
  }[source];

  out.push(
    `  trust root  : ${dir} (${dir === pinned ? 'pinned, shipped with the plugin' : (why ?? source)})`,
  );
} else {
  const trustDir = process.env.PROMPTSIGN_TRUST_DIR || '(promptsign default: ~/.promptsign/trust)';

  out.push(`  trust root  : ${trustDir}${trustDir === pinned ? ' (pinned, shipped with the plugin)' : ''}`);
}
if (bin && bin.status === 0) out.push(`  ${bin.output.split('\n').join('\n  ')}`);
else if (!fs.existsSync(path.join(pinned, 'fulcio.pem'))) {
  out.push('  WARNING: no pinned trust root in the plugin. Run `promptsign trust fetch`.');
}

// Every root a signature may chain to: the pinned public root, then any the
// user added with `promptsign trust add`. Nothing else is trusted by default,
// so a publisher signing with its own CA (OMS certificate mode) verifies only
// after its CA is added here.
function trustRoots() {
  if (napi?.trustRoots) {
    try {
      return napi.trustRoots().map((r) => `${r.name}  ${r.kind}  ${r.subject}`);
    } catch (e) {
      return [`(could not read the trust roots: ${e.message})`];
    }
  }
  if (bin && bin.status === 0) {
    const r = spawnSync(binaryName(), ['trust', 'list'], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim().split('\n').filter(Boolean);
  }
  return null;
}

const roots = trustRoots();

if (roots) {
  out.push(`  trust roots : ${roots.length ? roots.join('\n                ') : '(none)'}`);
  out.push('                add a publisher CA with: promptsign trust add <name> --ca <ca.pem>');
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
