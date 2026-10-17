// Shared runtime resolution for the PromptSign plugin.
//
// Verification can run two ways, and this module is the single place that
// decides which is available:
//
//   Tier 1: the `promptsign` binary. Its `hook` subcommand already implements
//           every event in-process (~8 ms, no Node runtime involved), so when
//           a binary is present the hook script just hands stdin to it.
//   Tier 2: @promptsign/verify, the napi binding around the same Rust core.
//           For a marketplace install, Claude Code installs this into the
//           plugin's own node_modules automatically, because package.json and
//           package-lock.json both ship in the repo and neither the package
//           nor its platform binaries carry an install script for
//           `--ignore-scripts` to skip. /promptsign:setup --install exists as
//           the fallback for that automatic step: it's the only path when
//           developing with `claude --plugin-dir`. It's also a way to recover
//           when the automatic install silently fails or times out.
//
// Neither tier is vendored: there are no binaries in git, the CLI ships from
// promptsign.ai, and the napi package is installed from npm at plugin-install
// time rather than committed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** The plugin's install directory. Claude Code sets CLAUDE_PLUGIN_ROOT; the
 *  fallback keeps the scripts runnable directly for development. */
export const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT ||
  path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let strict;

/** Whether hooks fail closed, and why: `{ on, why }`. Strict mode makes
 *  unresolvable skills and verifier failures block. PROMPTSIGN_STRICT=1 turns
 *  it on, and so does `strict: true` in the machine's managed policy or the
 *  user's policy (spec/04), which only the verifier can read: the napi binding
 *  when installed, else the binary's `policy show`. Off by default, because
 *  most of the ecosystem is still unsigned. */
export function strictState() {
  if (strict) return strict;
  if (process.env.PROMPTSIGN_STRICT === '1') {
    strict = { on: true, why: 'PROMPTSIGN_STRICT=1' };
    return strict;
  }

  const napi = loadNapi();

  if (napi?.strictMode) {
    let on = false;

    try {
      on = napi.strictMode();
    } catch {
      // A verifier that cannot read the policy cannot say it is strict.
    }
    strict = { on, why: on ? 'managed or user policy' : null };
    return strict;
  }

  const shown = spawnSync(binaryName(), ['policy', 'show'], { encoding: 'utf8' });
  const line = shown.status === 0 ? /^# strict: on \((.+)\)$/m.exec(shown.stdout ?? '') : null;

  strict = { on: Boolean(line), why: line ? line[1] : null };
  return strict;
}

/** True when hooks fail closed (see strictState). */
export function strictMode() {
  return strictState().on;
}

/** The Sigstore roots this plugin pins, shipped as files in trust/ so that a
 *  fresh install verifies offline without a `promptsign trust fetch` first.
 *
 *  Deliberately does not override an operator's own configuration: an explicit
 *  PROMPTSIGN_TRUST_DIR, or a PROMPTSIGN_HOME pointing at a private trust root,
 *  both win. Only an otherwise-unconfigured machine gets the pinned copy.
 */
export function applyTrustEnv() {
  if (process.env.PROMPTSIGN_TRUST_DIR || process.env.PROMPTSIGN_HOME) return process.env;
  const dir = path.join(PLUGIN_ROOT, 'trust');
  if (fs.existsSync(path.join(dir, 'fulcio.pem')) && fs.existsSync(path.join(dir, 'rekor.pub'))) {
    process.env.PROMPTSIGN_TRUST_DIR = dir;
  }
  return process.env;
}

/** The binary to try for tier 1. A bare name is resolved through PATH by the
 *  OS (including PATHEXT on Windows); PROMPTSIGN_BIN takes an explicit path. */
export function binaryName() {
  return process.env.PROMPTSIGN_BIN || 'promptsign';
}

/** Tier 2, or null if it was never installed. Returns the module's public
 *  surface: verify, verifyTree, verifyKeyless, policyShow, policyLayers,
 *  strictMode, trustRoot, trustRoots, logDecisions and coreVersion. Versions
 *  before 0.7.0 lack the last few, so callers check before using them.
 *
 *  PROMPTSIGN_NAPI names a module file to load instead of the installed
 *  package, mirroring what PROMPTSIGN_BIN does for tier 1. The tests use it to
 *  drive the tier-2 branches from a stub without touching node_modules, so they
 *  behave the same whether or not a real verifier is installed. Anyone able to
 *  set it can already point PROMPTSIGN_BIN at a binary that approves
 *  everything, so it grants no capability the environment did not already have.
 *  A relative value resolves against the working directory rather than against
 *  this file. */
export function loadNapi() {
  const override = process.env.PROMPTSIGN_NAPI;

  try {
    return require(override ? path.resolve(override) : '@promptsign/verify');
  } catch {
    return null;
  }
}

/** One-line-per-finding rendering of a VerifyResult, for hook output. */
export function formatResult(r) {
  const head = `${r.action.toUpperCase()}  ${r.name || r.target}${r.version ? `@${r.version}` : ''}`;
  // A signature that is present but did not verify (an untrusted root, say)
  // is not the same as no signature, and the findings say which it was.
  const signer = !r.signed ? '  unsigned' : r.identity ? `  signer: ${r.identity}` : '  signature not verified';
  const via = [r.format === 'oms' ? 'OMS signature' : null, r.root ? `root ${r.root}` : null].filter(Boolean);
  const who = via.length ? `${signer} (${via.join(', ')})` : signer;
  // Approvals of the exact bytes (spec/09) that a policy rule asked for.
  const approvers = (r.approvals || []).map((a) =>
    a.root && a.root !== 'sigstore-public' ? `${a.identity} (root ${a.root})` : a.identity,
  );
  const approved = approvers.length ? [`    approved by ${approvers.join(', ')}`] : [];
  const findings = (r.findings || [])
    .filter((f) => f.level !== 'info')
    .map((f) => `    - ${f.level}: ${f.message}`);
  return [head + who, ...approved, ...findings].join('\n');
}

/** The failing part of a verify-tree run, or '' when everything passed. */
export function formatTreeReport(results) {
  return results
    .filter((r) => r.action === 'fail')
    .map((r) => `${formatResult(r)}\n    at ${r.target}`)
    .join('\n');
}
