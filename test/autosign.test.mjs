// Auto-signing (scripts/autosign.mjs) against a fake promptsign CLI. The fake
// keeps one signature per skill directory in a JSON file: who signed it and
// the SKILL.md bytes it covered. `verify --json` reports unsigned, changed or
// clean from that, and `sign --same-signer` refuses another identity's skill.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AUTOSIGN = path.join(ROOT, 'scripts', 'autosign.mjs');
const HOOK = path.join(ROOT, 'scripts', 'verify.mjs');

const FAKE_CLI = `import fs from 'node:fs';
import path from 'node:path';
const db = process.env.FAKE_SIGNATURES;
const load = () => (fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : {});
const body = (dir) => fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
const [cmd, ...rest] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify([cmd, ...rest]) + '\\n');
const dir = rest.find((a) => !a.startsWith('--'));
const sig = load()[dir];
if (cmd === 'verify') {
  const signed = Boolean(sig);
  const changed = signed && sig.body !== body(dir);
  console.log(JSON.stringify({
    target: dir, name: path.basename(dir), signed,
    identity: signed ? sig.identity : null,
    action: signed && !changed ? 'pass' : 'fail',
    findings: changed ? [{ level: 'error', message: 'modified: SKILL.md' }] : [],
  }));
  process.exit(signed && !changed ? 0 : 2);
}
if (cmd === 'sign') {
  const me = process.env.FAKE_IDENTITY;
  if (!me) { console.error('promptsign: no OIDC identity token, run \`promptsign login\` first'); process.exit(1); }
  if (rest.includes('--same-signer') && sig && sig.identity !== me) {
    console.error('promptsign: sign: ' + dir + ' is signed by ' + sig.identity + '; --same-signer keeps that signature (you sign as ' + me + ')');
    process.exit(1);
  }
  const all = load();
  all[dir] = { identity: me, body: body(dir) };
  fs.writeFileSync(db, JSON.stringify(all));
  console.log('signed skill "' + path.basename(dir) + '" (1 file) as ' + me + ' via https://dex.acme.example/auth');
  process.exit(0);
}
process.exit(1);
`;

let tmp;
let project;
let home;
let fake;
let signatures;
let calls;

function skill(root, name, text = 'v1') {
  const dir = path.join(root, name);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n${text}\n`);
  return dir;
}

function signedBy(dir, identity) {
  const all = fs.existsSync(signatures) ? JSON.parse(fs.readFileSync(signatures, 'utf8')) : {};

  all[dir] = { identity, body: fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') };
  fs.writeFileSync(signatures, JSON.stringify(all));
}

function signer(dir) {
  return JSON.parse(fs.readFileSync(signatures, 'utf8'))[dir]?.identity;
}

function env(extra = {}) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PROJECT_DIR: project,
    HOME: home,
    USERPROFILE: home,
    PROMPTSIGN_AUTO_SIGN: '1',
    PROMPTSIGN_AUTO_SIGN_ROOTS: '',
    PROMPTSIGN_BIN: fake,
    FAKE_SIGNATURES: signatures,
    FAKE_CALLS: calls,
    FAKE_IDENTITY: 'alice@acme.example',
    ...extra,
  };
}

function postToolUse(file, extra = {}, tool = 'Write') {
  const r = spawnSync(process.execPath, [AUTOSIGN], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: file } }),
    encoding: 'utf8',
    env: env(extra),
  });
  const message = r.stdout.trim() ? JSON.parse(r.stdout).systemMessage : null;

  return { status: r.status, message };
}

function signCalls() {
  if (!fs.existsSync(calls)) return [];
  return fs
    .readFileSync(calls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter(([cmd]) => cmd === 'sign');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptsign-autosign-'));
  project = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fake = path.join(tmp, 'fake-promptsign.mjs');
  signatures = path.join(tmp, 'signatures.json');
  calls = path.join(tmp, 'calls.jsonl');
  fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(fake, FAKE_CLI);
});

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('PostToolUse', () => {
  test('signs a new skill Claude writes in the project', () => {
    const dir = skill(path.join(project, '.claude', 'skills'), 'mine');
    const r = postToolUse(path.join(dir, 'SKILL.md'));

    assert.equal(r.status, 0);
    assert.equal(signer(dir), 'alice@acme.example');
    assert.match(r.message, /signed skill mine as alice@acme\.example/);
    assert.deepEqual(signCalls()[0], ['sign', dir, '--same-signer']);
  });

  test('signs a skill in the user skills directory, from a path with dot segments', () => {
    const dir = skill(path.join(home, '.claude', 'skills'), 'personal');
    const r = postToolUse(path.join(dir, 'notes', '..', 'SKILL.md'));

    assert.equal(r.status, 0);
    assert.equal(signer(dir), 'alice@acme.example');
  });

  test('re-signs the user\'s own skill after an edit', () => {
    const dir = skill(path.join(project, '.claude', 'skills'), 'mine');

    signedBy(dir, 'alice@acme.example');
    fs.appendFileSync(path.join(dir, 'SKILL.md'), 'more\n');

    const r = postToolUse(path.join(dir, 'SKILL.md'), {}, 'Edit');

    assert.match(r.message, /signed skill mine/);
    assert.equal(signCalls().length, 1);
  });

  test('keeps another identity\'s signature and says so', () => {
    const dir = skill(path.join(project, '.claude', 'skills'), 'theirs');

    signedBy(dir, 'bob@vendor.example');
    fs.appendFileSync(path.join(dir, 'SKILL.md'), 'edited\n');

    const r = postToolUse(path.join(dir, 'SKILL.md'), {}, 'Edit');

    assert.equal(r.status, 0);
    assert.equal(signer(dir), 'bob@vendor.example');
    assert.match(r.message, /did not re-sign skill theirs: bob@vendor\.example signed it/);
  });

  test('skips a skill whose signature still matches', () => {
    const dir = skill(path.join(project, '.claude', 'skills'), 'same');

    signedBy(dir, 'alice@acme.example');

    const r = postToolUse(path.join(dir, 'SKILL.md'));

    assert.equal(r.message, null);
    assert.equal(signCalls().length, 0);
  });

  test('ignores files outside the roots and the signature files', () => {
    const outside = skill(path.join(tmp, 'elsewhere'), 'loose');
    const dir = skill(path.join(project, '.claude', 'skills'), 'mine');

    fs.mkdirSync(path.join(dir, '.promptsign'));
    assert.equal(postToolUse(path.join(outside, 'SKILL.md')).message, null);
    assert.equal(postToolUse(path.join(dir, '.promptsign', 'bundle.json')).message, null);
    assert.equal(postToolUse(path.join(project, 'README.md')).message, null);
    assert.equal(signCalls().length, 0);
  });

  test('does nothing unless PROMPTSIGN_AUTO_SIGN is on', () => {
    const dir = skill(path.join(project, '.claude', 'skills'), 'mine');
    const r = postToolUse(path.join(dir, 'SKILL.md'), { PROMPTSIGN_AUTO_SIGN: '' });

    assert.equal(r.message, null);
    assert.equal(fs.existsSync(calls), false);
  });

  test('PROMPTSIGN_AUTO_SIGN_ROOTS replaces the default roots', () => {
    const custom = skill(path.join(project, 'skills'), 'custom');
    const usual = skill(path.join(project, '.claude', 'skills'), 'usual');
    const extra = { PROMPTSIGN_AUTO_SIGN_ROOTS: 'skills' };

    assert.match(postToolUse(path.join(custom, 'SKILL.md'), extra).message, /signed skill custom/);
    assert.equal(postToolUse(path.join(usual, 'SKILL.md'), extra).message, null);
  });

  test('asks for a login when the CLI has no sign-in', () => {
    const dir = skill(path.join(project, '.claude', 'skills'), 'mine');
    const r = postToolUse(path.join(dir, 'SKILL.md'), { FAKE_IDENTITY: '' });

    assert.equal(r.status, 0);
    assert.match(r.message, /could not sign skill mine: .*promptsign login/);
  });

  test('says so when the CLI is missing', () => {
    const dir = skill(path.join(project, '.claude', 'skills'), 'mine');
    const r = postToolUse(path.join(dir, 'SKILL.md'), { PROMPTSIGN_BIN: '__promptsign_absent__' });

    assert.equal(r.status, 0);
    assert.match(r.message, /cannot run the promptsign CLI/);
  });
});

describe('SessionStart', () => {
  function sessionStart(extra = {}) {
    // The fake CLI does not speak `hook`, so verify.mjs falls through to a
    // napi module that does not exist and reports that no verifier is there.
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'SessionStart' }),
      encoding: 'utf8',
      env: env({ PROMPTSIGN_NAPI: path.join(tmp, 'absent.cjs'), PROMPTSIGN_HOME: tmp, ...extra }),
    });

    return { status: r.status, stdout: r.stdout || '' };
  }

  test('re-signs the user\'s changed skills and leaves the rest', () => {
    const skills = path.join(project, '.claude', 'skills');
    const mine = skill(skills, 'mine');
    const theirs = skill(skills, 'theirs');
    const fresh = skill(skills, 'fresh');
    const clean = skill(path.join(home, '.claude', 'skills'), 'clean');

    signedBy(mine, 'alice@acme.example');
    signedBy(theirs, 'bob@vendor.example');
    signedBy(clean, 'alice@acme.example');
    fs.appendFileSync(path.join(mine, 'SKILL.md'), 'edited in an editor\n');
    fs.appendFileSync(path.join(theirs, 'SKILL.md'), 'edited\n');

    const r = sessionStart();

    assert.equal(r.status, 0);
    assert.match(r.stdout, /PromptSign re-signed skill mine as alice@acme\.example\./);
    assert.doesNotMatch(r.stdout, /theirs|fresh|clean/);
    assert.equal(signer(mine), 'alice@acme.example');
    assert.equal(signer(theirs), 'bob@vendor.example');
    assert.equal(signer(fresh), undefined);
    assert.deepEqual(
      signCalls().map(([, dir]) => path.basename(dir)),
      ['mine', 'theirs'],
    );
  });

  test('stays out of the way when auto-signing is off', () => {
    const mine = skill(path.join(project, '.claude', 'skills'), 'mine');

    signedBy(mine, 'alice@acme.example');
    fs.appendFileSync(path.join(mine, 'SKILL.md'), 'edited\n');

    const r = sessionStart({ PROMPTSIGN_AUTO_SIGN: '' });

    assert.doesNotMatch(r.stdout, /re-signed/);
    assert.equal(fs.existsSync(calls), false);
  });
});
