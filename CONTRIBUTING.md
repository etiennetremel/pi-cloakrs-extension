# Contributing

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
