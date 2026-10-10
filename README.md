# pi-cloakrs-extension

Local PII redaction for [Pi](https://github.com/earendil-works/pi), powered by [cloakrs](https://github.com/kadir/cloakrs). Masks supported PII in conversation text, tool results, and `!` command output before normal agent requests.

## Install

```bash
pi install git:github.com/etiennetremel/pi-cloakrs-extension
```

This tracks the default branch. Append `@<tag-or-commit>` for a reproducible install.

Installation downloads cloakrs v0.4.0 for macOS (arm64/x64), glibc Linux (arm64/x64), x64 musl Linux, or x64 Windows, verifies a pinned checksum, and stores the binary inside this package. Rust is not required.

Use `/cloakrs-status` to inspect the active version and settings.

## Try it locally

From a checkout:

```bash
npm install
pi -e .
```

Send a prompt containing a synthetic email address: use the name `alice` at the domain `example.com`. The model should receive `[EMAIL]` instead of the address.

To check tool-output redaction, save the same address in `/tmp/cloakrs-test.txt` outside Pi, then ask Pi to read that file. The model-bound tool result should also replace the address with `[EMAIL]`.

## What is redacted

- User prompts via `input`
- Tool-result text via `tool_result`
- `!` command output via `user_bash` (`!!` output remains local)
- Persisted user, assistant, and custom message text via `message_end`; assistant tool arguments remain local and are redacted by `context` before outbound requests
- Message text, summaries, thinking, and tool arguments in normal model requests via `context`
- Pi's assembled system prompt, including cwd and project instructions, via `before_agent_start`

These handlers fail closed: prompts are blocked and model-bound text is withheld if scanning fails. Pi's internal branch and compaction summarizers bypass `context`, so the extension supplies local opaque summaries instead. This avoids sending history to those summarizers but loses older compacted context; recent messages remain available.

**Images pass through without OCR. Do not attach images containing sensitive information.**

Detection depends on the configured locale. URLs and hostnames are preserved by default, also avoiding hostname false positives in filenames. Supported nested email addresses can still be masked inside URLs; nested US SSNs require the US locale. See the [supported entities](https://github.com/kadir/cloakrs/blob/v0.4.0/docs/supported-entities.md).

**Warning:** Preserved URLs can expose embedded passwords or encoded credentials, and hostnames can expose internal infrastructure. Set `PI_CLOAKRS_EXCLUDE_ENTITIES=''` and remove exclusions from cloakrs configuration to restore URL and hostname redaction. Pattern-based redaction does not guarantee that text contains no secrets.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PI_CLOAKRS_LOCALE` | `nl` | Locale-specific recognizers alongside universal recognizers |
| `PI_CLOAKRS_MIN_CONFIDENCE` | `0.35` | Minimum accepted confidence |
| `PI_CLOAKRS_EXCLUDE_ENTITIES` | `url,hostname` | Entity types to preserve; empty disables extension-provided exclusions |
| `PI_CLOAKRS_BINARY` | bundled binary | Use another cloakrs executable |
| `PI_CLOAKRS_SKIP_DOWNLOAD` | unset | Set to `1` during install to use a system executable |

For example, `PI_CLOAKRS_EXCLUDE_ENTITIES=url pi` preserves URLs while redacting hostnames. Adding `user-path` preserves personal paths and is opt-in. Home-directory prefixes are replaced with `~` before scanning.

Exclusions combine with those in automatically discovered `.cloakrs.toml` files; an empty environment value does not clear those. Unknown entity names fail closed. Custom binaries must support configured exclusions (v0.4.0+). See [entity exclusions](https://github.com/kadir/cloakrs/blob/v0.4.0/docs/entity-exclusions.md).

Restart Pi after changing the environment.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, testing, and release instructions.

## Security

Pi extensions and npm lifecycle scripts execute with your user permissions. Review this package before installing it. The installer downloads only the pinned GitHub release, limits downloads to 32 MiB/60 seconds, and verifies its hard-coded SHA-256 checksum before extraction.

Redaction is fail-closed and bounded to 1 MiB/1,000 input strings, 16 MiB/10,000 properties/100 levels per message graph, 2 MiB stdout, 64 KiB stderr, and four concurrent cloakrs processes. Larger, malformed, or unsafe content is withheld.

## License

MIT
