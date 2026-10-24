# Releasing

GitHub Actions builds and signs releases. Set these repository secrets under
**Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `TIZEN_AUTHOR_CERT_BASE64` | Base64-encoded contents of `~/tizen-studio-data/keystore/author/f1tv-author.p12` |
| `TIZEN_AUTHOR_PASSWORD` | Contents of `.cert-password` |

The workflow uses GitHub's built-in token and the SDK's distributor certificate.

After committing and pushing the changes you want to release, create and push a version tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The **Build release** workflow runs tests and creates a draft release with `F1TV.wgt` and
`F1TV.wgt.sha256`. It uses the tag's version (`v0.2.0` becomes `0.2.0`);
`app/config.xml` stays at `0.0.0` in the repo. The install commands use scripts from the default
branch, so those must be merged there before releasing.

Download `F1TV.wgt` from the draft and test it on your TV before publishing. To retry a build,
use **Actions → Build release → Run workflow** with the same tag. The workflow must be on the
default branch for this option to appear. Retries can replace draft assets, but published
releases are left alone.

To build an existing release tag locally with your configured signing profile:

```sh
scripts/build-release.sh v0.2.0
```

This writes `build/F1TV.wgt` and `build/F1TV.wgt.sha256`.

Keep the same author certificate for every release. Back up
`~/tizen-studio-data/keystore/author/f1tv-author.p12` and `.cert-password`.
