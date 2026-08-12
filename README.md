# PromptSign for Claude Code

Verifies signatures on the instruction files Claude Code loads: `CLAUDE.md`,
skills, and agent definitions. It also blocks a skill whose bundle no longer
matches what was signed.

Signing and verification are [Sigstore](https://sigstore.dev) keyless: the same
infrastructure behind npm provenance and PyPI attestations. There is no key to
store, lose, or rotate, and verification runs offline against a trust root
pinned in this repo. Nothing phones home, ever.

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

which reports whether a verifier is present and how to get one if not. See
[Runtime](#runtime).

## What it does

| Hook | When | Behaviour |
|---|---|---|
| `SessionStart` | before work starts | verify-tree over the project, `CLAUDE.md`/`AGENTS.md`, and `~/.claude`; failures are injected into session context |
| `PreToolUse` (`Skill`) | before a skill runs | re-verify that skill's bundle; a failure exits 2, which blocks the call and tells the model why |

Fail-open by default: most of the ecosystem is unsigned today, and a plugin that
blocked on every unsigned file would be uninstalled within the hour. Set
`PROMPTSIGN_STRICT=1` once your own files are signed and both hooks fail closed.

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
   rather than through a marketplace, or the automatic install failed quietly,
   `/promptsign:setup --install` installs it by hand.
3. **Neither.** The plugin says so once at session start and verifies nothing.
   It does not install anything behind your back beyond the automatic step
   above, which is Claude Code's own plugin-install behavior, not this
   plugin's.

## Configuration

| Variable | Effect |
|---|---|
| `PROMPTSIGN_STRICT=1` | Fail closed: unresolvable skills and verification failures block. |
| `PROMPTSIGN_BIN` | Explicit path to the `promptsign` binary. |
| `PROMPTSIGN_SKILL_ROOTS` | Extra skill directories to search, path-delimiter separated. |
| `PROMPTSIGN_TRUST_DIR` | Trust root other than the one pinned in `trust/`. |
| `PROMPTSIGN_HOME` | PromptSign state directory (default `~/.promptsign`). Set it, and the pinned trust root is not applied. |
| `PROMPTSIGN_POLICY` | Explicit trust policy path (see `spec/04-policy.md`). |

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
on every push, signed by that workflow's own identity. Check your copy:

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
