---
name: setup
description: Check or repair the PromptSign plugin's verifier, reporting which verifier is active, which trust root is in use, and whether anything is actually being verified. Use when PromptSign reports it has no verifier, after installing the plugin, or when the user asks why signatures are not being checked.
---

# PromptSign setup

The plugin's hooks verify signatures using either the `promptsign` binary (fast
path) or `@promptsign/verify` from npm. Neither is bundled, because there are no binaries in git
and Claude Code does not run `npm install` for a plugin. So on a machine with
neither, the hooks report that nothing is being verified and stop.

## Report current status

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"
```

Show the user the output as-is. It names the active verifier, the trust root in
effect, every trust root a signature may chain to, and whether strict mode is
on.

## Trusting a publisher's own CA

PromptSign also verifies skills signed with OpenSSF Model Signing (OMS), which
carry a `skill.oms.sig` or `model.sig` file. Some publishers sign with their own
certificate authority rather than public Sigstore. Out of the box only the
public Sigstore root is trusted, so such a skill fails with "invalid signature"
and a message naming the CA it chains to.

Adding a CA is the user's decision, never yours. Explain what it means: every
signature that chains to that CA will verify. Then give the command and let the
user run it:

```
promptsign trust add <name> --ca <ca.pem>
```

Here `<name>` is a short label the user picks, such as `nvidia`, and `<ca.pem>`
is the root certificate the publisher distributes (NVIDIA ships
`nv-agent-root-cert.pem`). The command shows the CA's subject and SHA-256
fingerprint and asks for confirmation. `promptsign trust list` shows the added
roots and `promptsign trust rm <name>` removes one. These are CLI commands, so
on a machine with only `@promptsign/verify` the user needs the CLI from
https://promptsign.ai for this step. A project cannot add a root
for the user: roots live under `~/.promptsign/trust/roots` only.

## If no verifier is available

Two options. Present both, and do not pick for the user:

1. **Install the CLI** from https://promptsign.ai. Recommended: verification runs
   in-process in about 8 ms with no Node startup, and the same binary can sign,
   not just verify. Once it is on `PATH` the hooks pick it up with no further
   configuration.
2. **Install the npm verifier** into the plugin directory:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --install
   ```

   This runs `npm install` in the plugin directory and fetches a pinned
   `@promptsign/verify` is the same Rust core, as a native Node addon. It reaches
   the network, so say so before running it.

Re-run the status command afterwards to confirm.

## Notes

- `PROMPTSIGN_STRICT=1` makes failures fail closed instead of warning: a
  SessionStart failure ends the session, and a skill that cannot be located on
  disk, or whose verifier errors out, is blocked. It does not change unsigned
  files, which stay warn-only unless a policy rule says `enforce`.
- The plugin ships a pinned Sigstore trust root in `trust/`. It is used only when
  the machine has no `PROMPTSIGN_TRUST_DIR` and no `PROMPTSIGN_HOME` of its own,
  so an enterprise private trust root is never silently overridden.
