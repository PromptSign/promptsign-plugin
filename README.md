# PromptSign for Claude Code

Verifies signatures on the instruction files Claude Code loads: `CLAUDE.md`,
skills, and agent definitions. It also blocks a skill whose bundle no longer
matches what was signed.

Signing and verification are [Sigstore](https://sigstore.dev) keyless: the same
infrastructure behind npm provenance and PyPI attestations. There is no key to
store, lose, or rotate. Verification runs offline against a trust root
pinned in this repo. Nothing phones home, ever.

## See it work

[![A signed skill is tampered with after install, and verification catches it](https://promptsign.ai/media/promptsign-demo-v1.gif?c=plugin-readme)](https://promptsign.ai/posts/what-signing-proves?c=plugin-readme)

A signed skill, tampered with after install and caught twice, then the objection
everyone raises: what stops the attacker signing their own copy? 2 minutes, silent
and captioned. 
[The write-up](https://promptsign.ai/posts/what-signing-proves?c=plugin-readme) and
the repository it runs against:
[PromptSign/tell-a-joke](https://github.com/PromptSign/tell-a-joke).

The image is hosted on promptsign.ai rather than committed here, so installing
this plugin does not pull video's megabytes along with it.

## Install

```
/plugin marketplace add PromptSign/promptsign-plugin
/plugin install promptsign@promptsign
```

That's it for most setups: installing from a marketplace also installs
`@promptsign/verify` automatically, so a verifier is ready as soon as the
plugin is. Confirm it landed, or install one by hand if it didn't, with:

```
/promptsign:setup
```

It reports whether a verifier is present and how to get one if not. See
[Runtime](#runtime).

## What the plugin does

| Hook | When | Behaviour |
|---|---|---|
| `SessionStart` | before work starts | verify-tree over the project, `CLAUDE.md`/`AGENTS.md`, and `~/.claude`; failures are injected into session context |
| `PreToolUse` (`Skill`) | before a skill runs | re-verify that skill's bundle; a failure exits 2, which blocks the call and tells the model why |

Fail-open by default: most of the ecosystem is unsigned today, and a plugin that
blocked every unsigned file would be uninstalled within an hour. Blocking
unsigned files is a [policy](#policy) decision: use the rule `"action":
"enforce"` once your own files are signed.

`PROMPTSIGN_STRICT=1` environment variable is a narrower lever. It leaves
unsigned files alone but makes failures fail closed: a SessionStart failure ends
the session instead of being reported into it, and a skill that cannot be
located on disk, or whose verifier errors out, is blocked rather than allowed.

> **Caveat, by design:** skill frontmatter *descriptions* enter model context at
> session start, before `PreToolUse` can fire. `SessionStart` and install-time
> verification are the primary controls; `PreToolUse` is defense in depth.

Also included: `/promptsign:verify <path>` for checking any skill, plugin, or
directory by hand.

## Runtime

Verification needs the Rust verifier, and this plugin ships neither a binary
(policy: binaries come from promptsign.ai, not from git) nor a vendored
`node_modules`. So the hooks resolve a verifier at run time, in this order:

1. **The `promptsign` binary** on `PATH`, or at `PROMPTSIGN_BIN`. Its `hook`
   subcommand does all of the above natively in ~8 ms with no Node startup, so
   when it is present the hook script simply hands it the event. Get it from
   <https://promptsign.ai>.
2. **`@promptsign/verify`**, the same Rust core as a native Node addon.
   Installing from a marketplace, Claude Code installs it into this plugin's
   own `node_modules` automatically, since the repo ships a `package.json` and
   a lockfile. Run `/promptsign:setup` (no flags) to confirm this landed. If it
   didn't, most often because you loaded the plugin with `claude --plugin-dir`
   rather than through a marketplace, or the automatic install failed quietly.
   `/promptsign:setup --install` installs it by hand.
3. **Neither.** The plugin says so once at session start and verifies nothing.
   It does not install anything behind your back beyond the automatic step
   above, which is Claude Code's own plugin-install behavior, not this
   plugin's.

## Policy

Policy decides *which* signatures count. A valid signature on its own proves
little, because an attacker can validly sign their own skill. The policy file
says which identities may sign which names, and what happens when they don't.

You need no policy file to start. With none present, this is the built-in
default:

```json
{
  "schema": "promptsign/policy/v1",
  "default": "warn",
  "rules": [
    { "pattern": "*", "action": "warn", "tofu": true }
  ]
}
```

Every artifact matches, nothing is required of the signer, problems are reported
rather than enforced, and the first signer seen for a name is remembered and
required from then on. That last flag, `tofu`, is what does the real work on day
one.

To write your own, the first of these that exists wins:

| Location | Scope |
|---|---|
| `PROMPTSIGN_POLICY` | One shell session or CI job. |
| `.promptsign/policy.json` | The project being verified. Check it in, and a team shares one policy. |
| `~/.promptsign/policy.json` | Every project on the machine. |

With the `promptsign` binary installed, write one out and confirm which is in
effect. `init` refuses to overwrite an existing file:

```bash
promptsign policy init            # ./.promptsign/policy.json
promptsign policy init --global   # ~/.promptsign/policy.json
promptsign policy show            # the effective policy, and the file it came from
```

With only `@promptsign/verify` there is no CLI to run, so create the file by
hand at one of the paths above.

Blocking unsigned files means an `enforce` catch-all. An allowlist puts the
specific rule ahead of it, since the first matching rule wins:

```json
{
  "schema": "promptsign/policy/v1",
  "default": "enforce",
  "rules": [
    {
      "pattern": "acme-*",
      "identity": "https://github.com/acme/*",
      "issuer": "https://token.actions.githubusercontent.com",
      "action": "enforce"
    },
    { "pattern": "*", "action": "enforce", "tofu": true }
  ]
}
```

Anything named `acme-*` must now be signed by a GitHub Actions workflow in the
`acme` organisation. Everything else must at least be signed by someone,
consistently. Every rule field is documented at
[promptsign.ai/docs#policy](https://promptsign.ai/docs?c=plugin-readme#policy).

## Configuration
Configuration is through environment variables.
| Variable | Effect |
|---|---|
| `PROMPTSIGN_STRICT=1` | Fail closed: unresolvable skills and verification failures block. |
| `PROMPTSIGN_BIN` | Explicit path to the `promptsign` binary. |
| `PROMPTSIGN_SKILL_ROOTS` | Extra skill directories to search, path-delimiter separated. |
| `PROMPTSIGN_TRUST_DIR` | Trust root other than the one pinned in `trust/`. |
| `PROMPTSIGN_HOME` | PromptSign state directory (default `~/.promptsign`). Set it, and the pinned trust root is not applied. |
| `PROMPTSIGN_POLICY` | Explicit trust policy path (see [Policy](#policy)). |

Enterprise: ship the plugin through managed settings so users cannot disable it,
and set `PROMPTSIGN_STRICT=1` with a managed `policy.json`.

## What a signature does and does not tell you

- It proves **origin and integrity**: these exact bytes, published by that
  identity, unchanged since.
- It is **not a safety verdict**. A signed skill can still be a bad skill.
  Review and scanning are the safety layer, and they just need a stable identity to
  attach a verdict to, which is what this provides.
- **Unsigned is not malicious.** Nearly everything is unsigned today. The plugin
  reports it as "origin cannot be checked", and that is all it means.

## This plugin is itself signed

`.promptsign/bundle.json` is produced by [`.github/workflows/sign.yml`](.github/workflows/sign.yml)
on every release tag, signed by that workflow's own identity. Check your copy:

```bash
promptsign verify /path/to/promptsign-plugin
```

## Development

```bash
claude plugin validate .                 # manifests
claude --plugin-dir .                    # load without installing
claude plugin details promptsign         # component inventory + token cost
```

`/reload-plugins` picks up edits in a running session; `claude --debug` shows
which hooks matched. Release with `claude plugin tag .`, which checks that
`plugin.json` and the marketplace entry agree before creating the tag.

Apache-2.0. <https://promptsign.ai>
