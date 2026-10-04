# OMS fixtures

OpenSSF Model Signing (OMS) signatures for the tests in `test/napi.test.mjs`,
made with `model_signing` 1.1.1 in certificate mode:

```
model_signing sign certificate --signature <dir>/<name> \
  --private_key leaf.key --signing_certificate leaf.pem \
  --certificate_chain test-ca.pem <dir>
```

| Fixture | Signed directory | Signature as written | Stored as |
|---|---|---|---|
| A skill signed on its own | `skill/` | `skill/skill.oms.sig` | `skill.sig` |
| A plugin signed at its root | `plugin/` | `plugin/model.sig` | `plugin.sig` |

`test-ca.pem` is the trust anchor (`CN=PromptSign Test OMS CA,O=PromptSign Tests`,
P-256, valid until 2126). The leaf is `CN=PromptSign Test Skill Signer,O=PromptSign Tests`
with `digitalSignature` and `codeSigning`. Neither private key was kept.

The signatures are stored beside the directories they sign, not inside them.
An installed plugin carries this folder, and the session-start scan would
otherwise find a live signature under a CA nobody trusts and report it as a
failure. The tests copy each directory to a temp dir and put the signature
back under its real name.

`.gitattributes` marks this folder `-text`. OMS hashes raw bytes, so a
line-ending conversion would break every signature here.
