// Hook behaviour tests: node --test
//
// Tier 1 (the promptsign binary) is covered by the CLI's own suite, so what is
// tested here is what only exists in this repo: the runtime tiering, skill
// resolution, and the fail-open/fail-closed decisions.
//
// The tier-2 tests point PROMPTSIGN_NAPI at a stub module so the napi path is
// exercised without a published package or a native build. The stub lives in
// the temp directory rather than in node_modules, so these tests behave the
// same whether or not a real verifier is installed, and they never modify the
// working tree.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'scripts', 'verify.mjs');
const NO_BINARY = '__promptsign_absent__';

let tmp;
let stub;

// A stub whose verdict is whatever PROMPTSIGN_TEST_ACTION says, so each test
// can drive the pass / fail / throw branches.
const STUB = `'use strict';
const action = process.env.PROMPTSIGN_TEST_ACTION || 'pass';
function result(target) {
  if (action === 'throw') throw new Error('stub verifier exploded');
  return {
    target, name: path.basename(target), policySource: 'stub',
    identity: action === 'pass' ? 'tester@example.com' : null,
    keyid: null, signed: action === 'pass', action,
    findings: action === 'pass' ? [] : [{ level: 'error', message: 'stub says no' }],
  };
}
const path = require('node:path');
module.exports = {
  verify: (t) => result(t),
  verifyTree: (roots) => roots.map(result),
  coreVersion: () => '0.0.0-stub',
};
`;

function runHook(payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: ROOT,
      PROMPTSIGN_HOME: tmp,
      PROMPTSIGN_NAPI: stub,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptsign-plugin-'));
  fs.mkdirSync(path.join(tmp, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: fixture\n---\n\nbody\n',
  );
  // sessionStart()'s roots list falls back to os.homedir()/.claude when tmp has
  // nothing to verify, so without this fixture the SessionStart tests below
  // only pass by accident, on whatever machine happens to have a real
  // ~/.claude directory to fall through to.
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# fixture\n');

  stub = path.join(tmp, 'napi-stub.cjs');
  fs.writeFileSync(stub, STUB);
});

after(() => {
  // Only the temp directory, which holds the fixtures and the stub alike. An
  // earlier version deleted the repository's node_modules, which made a local
  // test run destroy an install it had not created.
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('runtime tiering', () => {
  test('an unusable binary falls through to the napi verifier', () => {
    const r = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'demo' } },
      {
        PROMPTSIGN_BIN: NO_BINARY,
        PROMPTSIGN_SKILL_ROOTS: path.join(tmp, 'skills'),
        PROMPTSIGN_TEST_ACTION: 'fail',
      },
    );
    assert.equal(r.status, 2, 'a failing verdict from tier 2 must block');
    assert.match(r.stderr, /signature verification FAILED for skill "demo"/);
    assert.match(r.stderr, /stub says no/);
  });

  test('a passing verdict does not block', () => {
    const r = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'demo' } },
      { PROMPTSIGN_BIN: NO_BINARY, PROMPTSIGN_SKILL_ROOTS: path.join(tmp, 'skills') },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });
});

describe('PreToolUse', () => {
  const env = () => ({
    PROMPTSIGN_BIN: NO_BINARY,
    PROMPTSIGN_SKILL_ROOTS: path.join(tmp, 'skills'),
    PROMPTSIGN_TEST_ACTION: 'fail',
  });

  test('ignores tools other than Skill', () => {
    const r = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      env(),
    );
    assert.equal(r.status, 0);
  });

  test('resolves a namespaced skill name by its last segment', () => {
    const r = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'somewhere:demo' } },
      env(),
    );
    assert.equal(r.status, 2);
  });

  test('an unresolvable skill is allowed by default and blocked under strict', () => {
    const open = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'nonexistent' } },
      env(),
    );
    assert.equal(open.status, 0);

    const strict = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'nonexistent' } },
      { ...env(), PROMPTSIGN_STRICT: '1' },
    );
    assert.equal(strict.status, 2);
    assert.match(strict.stderr, /could not locate skill/);
  });

  test('a broken verifier is allowed by default and blocked under strict', () => {
    const base = { ...env(), PROMPTSIGN_TEST_ACTION: 'throw' };
    assert.equal(
      runHook(
        { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'demo' } },
        base,
      ).status,
      0,
    );
    const strict = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'demo' } },
      { ...base, PROMPTSIGN_STRICT: '1' },
    );
    assert.equal(strict.status, 2);
    assert.match(strict.stderr, /verifier error/);
  });
});

describe('plugin-provided skills', () => {
  // A skill installed through a marketplace lives under neither the project's
  // nor the user's skills/ root. Without this path, PROMPTSIGN_STRICT=1 blocks
  // every plugin skill on the machine, including PromptSign's own. homedir()
  // reads USERPROFILE on Windows and HOME elsewhere, so both are set here.
  function withFakeHome(layout, run) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptsign-home-'));
    try {
      fs.mkdirSync(path.join(home, layout), { recursive: true });
      fs.writeFileSync(
        path.join(home, layout, 'SKILL.md'),
        '---\nname: mktdemo\ndescription: fixture\n---\n\nbody\n',
      );
      run({ HOME: home, USERPROFILE: home });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  const marketplaces = path.join('.claude', 'plugins', 'marketplaces');
  const call = (skill, env) =>
    runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill }, cwd: tmp },
      { PROMPTSIGN_BIN: NO_BINARY, PROMPTSIGN_TEST_ACTION: 'fail', ...env },
    );

  test('resolves a plugin published from a marketplace root', () => {
    withFakeHome(path.join(marketplaces, 'promptsign', 'skills', 'mktdemo'), (env) => {
      const r = call('mktdemo', env);
      assert.equal(r.status, 2, 'a plugin skill must be verified like any other');
      assert.match(r.stderr, /signature verification FAILED for skill "mktdemo"/);
    });
  });

  test('resolves a plugin inside a marketplace monorepo', () => {
    withFakeHome(
      path.join(marketplaces, 'acme', 'plugins', 'tools', 'skills', 'mktdemo'),
      (env) => {
        assert.equal(call('mktdemo', env).status, 2);
      },
    );
  });

  test('resolves a plugin under a marketplace external_plugins/', () => {
    withFakeHome(
      path.join(marketplaces, 'acme', 'external_plugins', 'telegram', 'skills', 'mktdemo'),
      (env) => {
        assert.equal(call('mktdemo', env).status, 2);
      },
    );
  });

  test('resolves a namespaced plugin skill by its last segment', () => {
    withFakeHome(path.join(marketplaces, 'promptsign', 'skills', 'mktdemo'), (env) => {
      assert.equal(call('promptsign:mktdemo', env).status, 2);
    });
  });

  test('does not search more than one level under plugins/', () => {
    withFakeHome(
      path.join(marketplaces, 'acme', 'plugins', 'group', 'tools', 'skills', 'mktdemo'),
      (env) => {
        assert.equal(call('mktdemo', env).status, 0, 'too deep to be a plugin skill');
        assert.equal(call('mktdemo', { ...env, PROMPTSIGN_STRICT: '1' }).status, 2);
      },
    );
  });
});

describe('installed plugin skills', () => {
  // A plugin skill runs from its install path under plugins/cache/, which
  // installed_plugins.json records exactly. The marketplace checkout beside it
  // is a separate copy that moves on its own, so verifying that one would
  // verify bytes other than the ones about to run. A plugin installed without
  // any checkout, which is common, would not resolve at all.
  function makeSkill(dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: mktdemo\ndescription: fixture\n---\n\nbody\n',
    );
    return dir;
  }

  function withHome(run) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptsign-home-'));
    try {
      run(home, { HOME: home, USERPROFILE: home });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  const installDir = (home) =>
    path.join(home, '.claude', 'plugins', 'cache', 'demo', 'demo', '1.0.0');
  const checkoutDir = (home) =>
    path.join(home, '.claude', 'plugins', 'marketplaces', 'demo', 'skills', 'mktdemo');

  function writeManifest(home, body) {
    const dir = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installed_plugins.json'), body);
  }

  const call = (skill, env) =>
    runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill }, cwd: tmp },
      { PROMPTSIGN_BIN: NO_BINARY, PROMPTSIGN_TEST_ACTION: 'fail', ...env },
    );

  test('resolves a plugin that has no marketplace checkout', () => {
    withHome((home, env) => {
      const install = installDir(home);
      makeSkill(path.join(install, 'skills', 'mktdemo'));
      writeManifest(
        home,
        JSON.stringify({ plugins: { 'demo@demo-market': [{ installPath: install }] } }),
      );

      const r = call('demo:mktdemo', env);
      assert.equal(r.status, 2, 'an installed plugin skill must be verified like any other');
      assert.ok(r.stderr.includes(install), r.stderr);
    });
  });

  test('verifies the installed copy, not the marketplace checkout', () => {
    withHome((home, env) => {
      const install = installDir(home);
      const checkout = checkoutDir(home);
      makeSkill(path.join(install, 'skills', 'mktdemo'));
      makeSkill(checkout);
      writeManifest(
        home,
        JSON.stringify({ plugins: { 'demo@demo-market': [{ installPath: install }] } }),
      );

      const r = call('demo:mktdemo', env);
      assert.equal(r.status, 2);
      assert.ok(r.stderr.includes(install), r.stderr);
      assert.ok(!r.stderr.includes(checkout), 'the checkout is not the copy that runs');
    });
  });

  test('falls back to the marketplace checkout when the manifest is unreadable', () => {
    withHome((home, env) => {
      const checkout = checkoutDir(home);
      makeSkill(checkout);
      writeManifest(home, '{not json');

      const r = call('demo:mktdemo', env);
      assert.equal(r.status, 2);
      assert.ok(r.stderr.includes(checkout), r.stderr);
    });
  });
});

describe('SessionStart', () => {
  test('reports failures into context without blocking', () => {
    const r = runHook(
      { hook_event_name: 'SessionStart', cwd: tmp },
      { PROMPTSIGN_BIN: NO_BINARY, PROMPTSIGN_TEST_ACTION: 'fail' },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /FAILED verification/);
  });

  test('blocks under strict', () => {
    const r = runHook(
      { hook_event_name: 'SessionStart', cwd: tmp },
      { PROMPTSIGN_BIN: NO_BINARY, PROMPTSIGN_TEST_ACTION: 'fail', PROMPTSIGN_STRICT: '1' },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /failed signature verification/);
  });

  test('says so when no verifier is available at all', () => {
    // Both tiers have to miss: no binary, and an override that resolves to
    // nothing. loadNapi() returns null rather than throwing, so the hook takes
    // its "neither tier is installed" path.
    const r = runHook(
      { hook_event_name: 'SessionStart', cwd: tmp },
      { PROMPTSIGN_BIN: NO_BINARY, PROMPTSIGN_NAPI: path.join(tmp, 'absent.cjs') },
    );

    assert.equal(r.status, 0);
    assert.match(r.stdout, /no verifier available/);
  });
});
