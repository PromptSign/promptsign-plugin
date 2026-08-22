#!/usr/bin/env node
// Check this plugin's pinned trust root against the canonical one in
// promptsign-core.
//
//   node scripts/check-trust-root.mjs
//
// Exit codes follow check.mjs: 0 in step, 1 could not reach core, 2 drifted.
// The two failures are deliberately distinct. A red build that means "GitHub
// was briefly unreachable" and a red build that means "this plugin is pinned to
// a trust root nobody is maintaining" call for completely different reactions.
// A single exit code would make the second one easy to wave away as the first.
//
// Why a copy exists here at all: promptsign-core owns the canonical root, but
// this plugin's tier 1 runs a standalone binary with no node_modules to read
// @promptsign/verify's copy from, so the files have to ship in the repository.
// See trust/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRUST_DIR = path.join(path.dirname(HERE), 'trust');

// Tracks main rather than a tag on purpose. A rotation landing in core should
// turn this red immediately, and that red build is the notification.
const CANONICAL_BASE = 'https://raw.githubusercontent.com/PromptSign/promptsign-core/main/trust';
const FILES = ['fulcio.pem', 'rekor.pub'];

const ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;
const BACKOFF_MS = [1_000, 3_000];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch one canonical file, retrying transient failures. Throws only when
 *  every attempt failed, with the last reason attached.
 *
 *  The timeout is an explicit controller rather than AbortSignal.timeout so that
 *  it can be cleared, because a timer left armed holds a libuv handle open. */
async function fetchCanonical(name) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${CANONICAL_BASE}/${name}`, {
        signal: ac.signal,
        headers: { accept: 'text/plain' },
      });
      // A 404 is not transient. It means the canonical layout moved and this
      // script is pointing at a path that no longer exists. Retrying nine more
      // seconds does not help. It is still an "unreachable" rather than a
      // drift, because no bytes were ever obtained to compare.
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      if (attempt < ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1]);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${name}: ${last?.message ?? last}`);
}

function unreachable(detail) {
  process.stderr.write(
    `PromptSign: could not reach the canonical trust root in promptsign-core.\n` +
      `  ${detail}\n` +
      `  ${CANONICAL_BASE}\n\n` +
      `This is NOT a drift finding. No comparison was made. Re-run the job.\n` +
      `If it keeps failing, check that promptsign-core still publishes its\n` +
      `canonical trust/ at the path above.\n`,
  );
  return 1;
}

function report(drifted) {
  process.stderr.write(`\nPromptSign: this plugin's trust root has DRIFTED from promptsign-core.\n\n`);
  for (const d of drifted) {
    process.stderr.write(`  trust/${d.name}\n`);
    process.stderr.write(`    here: ${d.local}\n`);
    process.stderr.write(`    core: ${d.canonical}\n`);
  }
  process.stderr.write(
    `\nThe root is owned by promptsign-core, not by this plugin. Do not edit these\n` +
      `files in place and do not copy over them. Rotation is append and never\n` +
      `replace. Replacing a CA or a log key invalidates every signature made\n` +
      `under it.\n\n` +
      `Rotate in promptsign-core, where trust/README.md has the procedure. Then\n` +
      `bring the change across:\n\n` +
      FILES.map((f) => `  curl -fsSL ${CANONICAL_BASE}/${f} -o trust/${f}`).join('\n') +
      `\n\nA change to either file is security-relevant. Give it its own commit, state\n` +
      `the new Rekor log id in the message, and bump the plugin version.\n`,
  );
  return 2;
}

async function main() {
  const canonical = {};
  for (const name of FILES) {
    try {
      canonical[name] = await fetchCanonical(name);
    } catch (e) {
      return unreachable(e.message);
    }
  }

  const drifted = [];
  for (const name of FILES) {
    const localPath = path.join(TRUST_DIR, name);
    const local = fs.existsSync(localPath) ? fs.readFileSync(localPath) : null;
    // Compared as bytes rather than as parsed PEM. The .gitattributes here
    // normalises the repository to LF, so this is portable, and a copy that
    // differs only in whitespace is still a copy someone edited in place.
    if (local && local.equals(canonical[name])) {
      process.stdout.write(`  ok   trust/${name}  ${sha256(local)}\n`);
      continue;
    }
    drifted.push({
      name,
      local: local ? sha256(local) : '(missing)',
      canonical: sha256(canonical[name]),
    });
  }

  if (drifted.length > 0) return report(drifted);

  process.stdout.write('trust root is in step with promptsign-core\n');
  return 0;
}

// Assigned rather than passed to process.exit. Calling process.exit while
// undici still holds a socket from fetch aborts the process inside libuv on
// Windows, which surfaces as an assertion failure and exit code 127 instead of
// the code this script meant to return.
process.exitCode = await main();
