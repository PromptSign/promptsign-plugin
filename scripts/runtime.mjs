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

/** Fail closed: unresolvable skills and verification failures block. Default is
 *  fail-open with warnings, because most of the ecosystem is still unsigned. */
export const STRICT = process.env.PROMPTSIGN_STRICT === '1';

/** The Sigstore roots this plugin pins, shipped as two text files so that a
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
 *  surface: { verify, verifyTree, verifyKeyless, policyShow, coreVersion }. */
export function loadNapi() {
  try {
    return require('@promptsign/verify');
  } catch {
    return null;
  }
}

/** One-line-per-finding rendering of a VerifyResult, for hook output. */
export function formatResult(r) {
  const head = `${r.action.toUpperCase()}  ${r.name || r.target}${r.version ? `@${r.version}` : ''}`;
  const who = r.signed && r.identity ? `  signer: ${r.identity}` : '  unsigned';
  const findings = (r.findings || [])
    .filter((f) => f.level !== 'info')
    .map((f) => `    - ${f.level}: ${f.message}`);
  return [head + who, ...findings].join('\n');
}

/** The failing part of a verify-tree run, or '' when everything passed. */
export function formatTreeReport(results) {
  return results
    .filter((r) => r.action === 'fail')
    .map((r) => `${formatResult(r)}\n    at ${r.target}`)
    .join('\n');
}
