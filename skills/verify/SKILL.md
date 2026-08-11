---
name: verify
description: Verify PromptSign signatures on a skill, plugin, agent definition, CLAUDE.md, or a whole directory tree, and explain the result. Use when the user asks whether a file or skill is signed, who signed it, or whether a downloaded skill can be trusted.
---

# Verify with PromptSign

## Single target

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs" <path>
```

`<path>` may be a directory (a skill or plugin bundle, where every file in it is
covered) or a single file (verified against its `<file>.psig.json` sidecar, or an
embedded `x-promptsign:` frontmatter signature).

## A whole tree

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs" --tree <root>...
```

Walks the roots and reports every signable artifact, including well-known
instruction files that *should* be signed but are not. Useful roots: the project
directory, `~/.claude`.

## Reading the result

Exit code 0 means pass, 2 means a verification failure, 1 means the verifier
itself could not run (see `/promptsign:setup`).

Report what the output actually says, and be precise about what a pass means:

- **A pass proves origin and integrity.** These exact bytes were published by
  the identity shown, and nothing has changed since. Report that identity; it is
  the substance of the result.
- **A pass is not a safety verdict.** It says nothing about whether the skill's
  instructions are benign. Do not describe a verified skill as "safe".
- **Unsigned is not malicious.** Most of the ecosystem is unsigned today. Report
  it as "no signature, so origin cannot be checked", never as a red flag.
- **A failure is worth stopping for**: it means the content does not match what
  was signed, or the signer is not trusted by the effective policy. Say which.
