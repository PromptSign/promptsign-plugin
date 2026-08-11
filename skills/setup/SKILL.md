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
effect, and whether strict mode is on.

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

- `PROMPTSIGN_STRICT=1` makes verification failures block instead of warn. Suggest
  it only once a user's own instruction files are actually signed; on a mostly
  unsigned machine it will block constantly.
- The plugin ships a pinned Sigstore trust root in `trust/`. It is used only when
  the machine has no `PROMPTSIGN_TRUST_DIR` and no `PROMPTSIGN_HOME` of its own,
  so an enterprise private trust root is never silently overridden.
