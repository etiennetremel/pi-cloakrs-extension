# pi-cloakrs-extension

Local PII redaction for [Pi](https://github.com/earendil-works/pi) powered by [cloakrs](https://github.com/kadir/cloakrs). It masks supported PII in normal conversation text, tool results, and `!` command output before normal agent requests.

## Install

```bash
pi install git:github.com/etiennetremel/pi-cloakrs-extension
```

Installation downloads the pinned cloakrs v0.3.0 release for macOS (arm64/x64), glibc Linux (arm64/x64), x64 musl Linux, or x64 Windows, verifies it against a checksum pinned in this package, and keeps the binary inside this package. Rust is not required.

For local development:

```bash
npm install
pi -e .
```

Use `/cloakrs-status` to inspect the active version and settings.

## How to test

Start Pi with the local extension:

```bash
npm install
pi -e .
```

Enter text containing supported PII:

```text
Contact jane@example.com about BSN 123456782
```

The model should receive:

```text
Contact [EMAIL] about BSN [BSN]
```

To verify tool-output redaction, create a file outside Pi and ask Pi to read it:

```bash
printf 'burgerservicenummer 111222333\n' > /tmp/cloakrs-test.txt
```

```text
Read /tmp/cloakrs-test.txt
```

The read result sent to the model should contain `burgerservicenummer [BSN]`.
Run the automated checks with `npm test`.

## What is redacted

- User prompts via Pi's `input` event
- Text returned by every tool via `tool_result`
- `!` command output via `user_bash` (`!!` output remains local)
- Persisted user, assistant, and custom message text via `message_end`; assistant tool arguments remain local and are redacted by `context` before outbound model requests
- All message text, summaries, thinking, and tool arguments in normal model requests via `context`
- Pi's assembled system prompt, including cwd and loaded project instructions, via `before_agent_start`

These handlers fail closed: prompts are blocked and model-bound text is withheld if cloakrs cannot scan it. Pi's internal branch and compaction summarizers bypass the `context` hook, so the extension supplies a local opaque summary instead of sending session history through those model calls. This trades older compacted context for the no-leak guarantee; recent messages remain available.

Images are passed through without OCR. Do not attach images containing sensitive information.

The extension uses every cloakrs recognizer enabled for the configured locale. See cloakrs' [supported entities](https://github.com/kadir/cloakrs/blob/master/docs/supported-entities.md) for the current detection matrix.

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_CLOAKRS_LOCALE` | `nl` | Locale-specific recognizers to enable alongside universal recognizers |
| `PI_CLOAKRS_MIN_CONFIDENCE` | `0.35` | Minimum confidence accepted by cloakrs |
| `PI_CLOAKRS_BINARY` | bundled binary | Use another cloakrs executable |
| `PI_CLOAKRS_SKIP_DOWNLOAD` | unset | Set to `1` during install to use a system executable |

After changing the environment, restart Pi.

## Development

```bash
npm install
npm test
```

## Security

Pi extensions and npm lifecycle scripts execute with your user permissions. Review this package before installing it. The installer downloads only the pinned cloakrs release from GitHub, limits it to 32 MiB/60 seconds, and verifies its hard-coded SHA-256 checksum before extraction.

Redaction is fail-closed and bounded to 1 MiB/1,000 input strings, 16 MiB/10,000 properties/100 levels per message graph, 2 MiB stdout, 64 KiB stderr, and four concurrent cloakrs processes. Larger, malformed, or unsafe content is withheld.

## License

MIT
