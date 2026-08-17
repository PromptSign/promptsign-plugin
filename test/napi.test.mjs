// Tier 2 against the real addon, not the stub.
//
// hook.test.mjs drives tier 2 through a stub so it can force pass, fail and
// throw. That leaves the shipped path untested: nothing there loads
// @promptsign/verify or runs a verdict the Rust core actually produced. This
// file covers that, so a core release that breaks the binding fails here rather
// than on a user's machine.
//
// The whole suite skips when the package is not installed, which is what CI's
// uninstalled job and a fresh clone both look like. The job that installs
// dependencies is the one that makes these run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadNapi } from '../scripts/runtime.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'scripts', 'verify.mjs');
const NO_BINARY = '__promptsign_absent__';

// Resolved once, before any test sets PROMPTSIGN_NAPI, so this is the installed
// package rather than anything a test points at.
const napi = loadNapi();

let tmp;

// Tier 1 is disabled and PROMPTSIGN_NAPI is left unset, so the hook has exactly
// one verifier available: the installed addon.
function runHook(payload, env = {}) {
  const clean = { ...process.env };
  delete clean.PROMPTSIGN_NAPI;

  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...clean,
      CLAUDE_PLUGIN_ROOT: ROOT,
      PROMPTSIGN_HOME: tmp,
      PROMPTSIGN_BIN: NO_BINARY,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('napi verifier (real addon)', { skip: napi ? false : 'no @promptsign/verify installed' }, () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptsign-napi-'));
    fs.mkdirSync(path.join(tmp, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: fixture\n---\n\nbody\n',
    );
    // An x-promptsign: line in a context-injected file is never a valid
    // signature, and the core reports its presence as a failure rather than
    // ignoring it. That gives these tests a genuine fail verdict from the real
    // verifier without needing a signing identity to produce one.
    fs.writeFileSync(
      path.join(tmp, 'CLAUDE.md'),
      '---\nx-promptsign: not-a-real-signature\n---\n\n# fixture\n',
    );
  });

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('exposes the surface the hook scripts call', () => {
    for (const fn of ['verify', 'verifyTree', 'coreVersion']) {
      assert.equal(typeof napi[fn], 'function', `${fn} must be callable`);
    }

    const version = napi.coreVersion();

    assert.match(version, /^\d+\.\d+\.\d+/, `coreVersion returned ${version}`);
    assert.notEqual(version, '0.0.0-stub', 'the stub resolved instead of the real package');
  });

  test('produces a real verdict on an unsigned directory', () => {
    const r = napi.verify(path.join(tmp, 'skills', 'demo'));

    assert.equal(r.signed, false);
    assert.equal(r.action, 'warn', 'unsigned is a warning under the default policy');
    assert.ok(r.findings.length > 0, 'an unsigned artifact must carry a finding');
  });

  test('SessionStart surfaces a real failure into context without blocking', () => {
    const r = runHook({ hook_event_name: 'SessionStart', cwd: tmp });

    assert.equal(r.status, 0, 'the default is fail-open');
    assert.doesNotMatch(r.stdout, /no verifier available/, 'the addon should have been found');
    assert.match(r.stdout, /x-promptsign marker/, 'the verdict must come from the real core');
  });

  test('SessionStart blocks the same failure under strict', () => {
    const r = runHook({ hook_event_name: 'SessionStart', cwd: tmp }, { PROMPTSIGN_STRICT: '1' });

    assert.equal(r.status, 2);
    assert.match(r.stderr, /x-promptsign marker/);
  });

  // Unsigned is a warning under the default policy, and strict mode escalates
  // unresolvable skills rather than unsigned ones, so this stays allowed. It is
  // here to pin the tiering: the addon ran, returned warn, and the hook let the
  // call through.
  test('PreToolUse allows an unsigned skill', () => {
    const r = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'demo' } },
      { PROMPTSIGN_SKILL_ROOTS: path.join(tmp, 'skills') },
    );

    assert.equal(r.status, 0);
  });
});
