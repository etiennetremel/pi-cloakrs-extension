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

## Development

```bash
npm install
npm test
```

Run the clean-package installation smoke test separately (requires npm, Pi, and GitHub network access):

```bash
PI_CLOAKRS_TEST_INSTALL=1 node --test --test-name-pattern='clean package'
```

## Releases and npm publishing

[release-please](https://github.com/googleapis/release-please) opens release PRs on `main`. Use Conventional Commits in commits or squash-merge titles: `fix:` for patches, `feat:` for minor releases, and `feat!:` or a `BREAKING CHANGE:` footer for major releases. The highest bump wins; `chore:` alone does not normally release.

**Merging a release PR approves publication.** `.github/workflows/publish.yml` creates the GitHub release, verifies committed versions, runs tests including the clean-install smoke test, and publishes to npm with provenance. Only stable `vMAJOR.MINOR.PATCH` tags are accepted.

The workflow uses `GITHUB_TOKEN` and npm trusted publishing; no extra token secrets are needed. Separate workflows triggered by release-please's PR or release events need a GitHub App token or PAT to run.

If publishing fails, fix the cause and **rerun only the failed jobs** in the original workflow run. Rerunning everything may skip publication because the release already exists. Never reuse a published npm version; manually publishing a GitHub release does not trigger this workflow.

### One-time setup

1. Before enabling the workflows, publish the current package version and create its matching baseline GitHub release (`v0.1.0`). Trusted publishing requires an existing npm package:

   ```bash
   npm login --registry=https://registry.npmjs.org
   npm publish --access public --registry=https://registry.npmjs.org
   ```

   If the npm name is taken, update `package.json` and the lockfile to a name you own first.

2. Create a GitHub environment named **`npm`**, allowing the **`main`** branch (not just release tags). Add required reviewers if desired.
3. Configure the npm package's trusted publisher: GitHub owner **`etiennetremel`**, repository **`pi-cloakrs-extension`**, workflow **`publish.yml`**, environment **`npm`**. Allow direct `npm publish` if offered. Configure it shortly before publishing; npm currently requires the first successful publish within two days.
4. Enable **Allow GitHub Actions to create and approve pull requests** in repository Settings → Actions → General. Keep `.release-please-manifest.json` aligned with the bootstrap release (`0.1.0`), then merge the workflow and release configuration.

After a successful release, install with `pi install npm:pi-cloakrs-extension@<version>`. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers).

## Security

Pi extensions and npm lifecycle scripts execute with your user permissions. Review this package before installing it. The installer downloads only the pinned GitHub release, limits downloads to 32 MiB/60 seconds, and verifies its hard-coded SHA-256 checksum before extraction.

Redaction is fail-closed and bounded to 1 MiB/1,000 input strings, 16 MiB/10,000 properties/100 levels per message graph, 2 MiB stdout, 64 KiB stderr, and four concurrent cloakrs processes. Larger, malformed, or unsafe content is withheld.

## License

MIT
