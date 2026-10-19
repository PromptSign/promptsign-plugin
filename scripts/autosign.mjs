#!/usr/bin/env node
// Auto-signing for the skills a user writes. Off unless PROMPTSIGN_AUTO_SIGN=1,
// which Claude Code's managed settings can set for a whole fleet through `env`.
//
//   PostToolUse(Write|Edit|MultiEdit)  Claude wrote a file inside a skill under
//       an auto-sign root: sign that skill with `promptsign sign --same-signer`,
//       so it keeps running under a policy that enforces signatures.
//   SessionStart, called from verify.mjs before it verifies: re-sign the skills
//       under the roots that the user signed and then changed outside Claude.
//
// `--same-signer` keeps another identity's signature, so a skill someone else
// signed stays theirs and fails verification after an edit. An unsigned skill
// gets a signature only when Claude writes to it, never at SessionStart, so a
// skill that arrives unsigned from a clone or a download stays unsigned.
//
// Signing needs the promptsign binary and a sign-in (`promptsign login`). The
// CLI renews the sign-in without a browser where the organization's IdP issues
// refresh tokens.
//
// Config via env:
//   PROMPTSIGN_AUTO_SIGN=1      turn auto-signing on.
//   PROMPTSIGN_AUTO_SIGN_ROOTS  skill roots to sign under, path-delimiter
//                               separated, relative paths against the project.
//                               Default: ~/.claude/skills and
//                               <project>/.claude/skills.
//   PROMPTSIGN_BIN              explicit path to the promptsign binary. A .mjs
//                               or .js path runs under node, which the tests use.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { binaryName } from './runtime.mjs';

const INTEGRITY = /^(modified|missing file|unlisted file present): /;

export function autoSignEnabled() {
  return ['1', 'true'].includes((process.env.PROMPTSIGN_AUTO_SIGN || '').toLowerCase());
}

export function autoSignRoots(projectDir) {
  const listed = (process.env.PROMPTSIGN_AUTO_SIGN_ROOTS || '').split(path.delimiter).filter(Boolean);

  if (listed.length) return listed.map((r) => path.resolve(projectDir, r));
  return [path.join(os.homedir(), '.claude', 'skills'), path.join(projectDir, '.claude', 'skills')];
}

/** The skill directory under one of the roots that holds `file`, or null. */
export function skillDirFor(file, roots) {
  const abs = path.resolve(file);

  for (const root of roots) {
    const rel = path.relative(root, abs);

    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;

    const parts = rel.split(path.sep);

    // A skill is <root>/<name>/SKILL.md; its own signature files never count.
    if (parts.length < 2 || parts.includes('.promptsign')) return null;

    const dir = path.join(root, parts[0]);

    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

function cli(args) {
  const bin = binaryName();
  const [cmd, pre] = /\.[cm]?js$/i.test(bin) ? [process.execPath, [bin]] : [bin, []];

  return spawnSync(cmd, [...pre, ...args], { encoding: 'utf8', timeout: 50_000 });
}

/**
 * Where a skill stands against its signature: `unsigned`, `clean`, `changed`
 * (signed, files differ), `unverified` (a signature that names nobody), or
 * `error` when the binary is missing or its output did not parse.
 */
export function skillState(dir) {
  const r = cli(['verify', '--json', '--no-pin-updates', dir]);

  if (r.error) return { state: 'error', message: r.error.message };

  let result;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    return { state: 'error', message: (r.stderr || r.stdout || '').trim() };
  }
  if (!result.signed) return { state: 'unsigned' };
  if (!result.identity) return { state: 'unverified' };

  const changed = (result.findings || []).some((f) => INTEGRITY.test(f.message || ''));

  return { state: changed ? 'changed' : 'clean', identity: result.identity };
}

/** Signs a skill as the signed-in user, keeping any other identity's signature. */
export function signSkill(dir) {
  const r = cli(['sign', dir, '--same-signer']);

  if (r.error) return { ok: false, message: r.error.message };

  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const as = /\bas (\S+) via /.exec(r.stdout || '');

  return { ok: r.status === 0, identity: as?.[1], message: out.replace(/^promptsign: /gm, '') };
}

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Re-signs, as the user, each skill under the roots that a signature covers but
 * whose files changed since. Returns one line per skill it acted on, for the
 * session context. Another identity's skill fails `--same-signer` and stays as
 * it is; the verification report names it.
 */
export function resignChangedSkills(projectDir) {
  const lines = [];

  for (const root of autoSignRoots(projectDir)) {
    for (const dir of subdirs(root)) {
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;

      const st = skillState(dir);

      if (st.state === 'error') {
        lines.push(`PromptSign auto-sign is on but cannot run the promptsign CLI: ${st.message}`);
        return lines;
      }
      if (st.state !== 'changed') continue;

      const signed = signSkill(dir);

      if (signed.ok) {
        lines.push(`PromptSign re-signed skill ${path.basename(dir)} as ${signed.identity ?? st.identity}.`);
      } else if (!signed.message.includes('--same-signer keeps')) {
        lines.push(`PromptSign could not re-sign skill ${path.basename(dir)}: ${signed.message}`);
      }
    }
  }
  return lines;
}

/** PostToolUse: sign the skill Claude just wrote into. */
function postToolUse(input, projectDir) {
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;

  if (!file) return null;

  const dir = skillDirFor(path.resolve(projectDir, file), autoSignRoots(projectDir));

  if (!dir) return null;

  const name = path.basename(dir);
  const st = skillState(dir);

  if (st.state === 'error') {
    return `PromptSign auto-sign is on but cannot run the promptsign CLI: ${st.message}`;
  }
  if (st.state === 'clean') return null;
  if (st.state === 'unverified') {
    return `PromptSign left skill ${name} unsigned: its signature does not verify on this machine.`;
  }

  const signed = signSkill(dir);

  if (signed.ok) return `PromptSign signed skill ${name} as ${signed.identity ?? 'you'}.`;
  if (signed.message.includes('--same-signer keeps')) {
    return `PromptSign did not re-sign skill ${name}: ${st.identity} signed it, and the edit fails verification until they sign it again.`;
  }
  return `PromptSign could not sign skill ${name}: ${signed.message}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!autoSignEnabled()) process.exit(0);

  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const message = input.hook_event_name === 'PostToolUse' ? postToolUse(input, projectDir) : null;

  if (message) process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
  process.exit(0);
}
