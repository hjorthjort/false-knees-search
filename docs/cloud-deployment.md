# Cloud Deployment

This project should deploy as a static Cloudflare Worker while scheduled scraping runs in GitHub Actions.

The scraper is intentionally not run inside a Cloudflare Worker. It uses native `sharp`, a local filesystem cache, and the `tesseract` binary. GitHub Actions can install and run those dependencies reliably, then commit the deployable `public/data` and `public/thumbs` outputs back to the repository. Cloudflare only needs to serve those public assets.

## Cloudflare Worker Settings

Use the connected repository deployment screen with:

```text
Build command: npm ci && npm run smoke
Deploy command: npm run deploy
```

The Worker deploy command reads `wrangler.jsonc`, serves `public/` as static assets, and uses `src/worker.js` only as a thin asset wrapper.

Make sure the Cloudflare project watches the same branch that contains this workflow and the committed public assets.

## Scheduled Updates

`.github/workflows/update-index.yml` runs:

- daily latest update: refresh the archive and fully reprocess the newest 4 comics
- monthly full refresh: refresh every comic page and rebuild the full search index, reusing cached OCR/page records when image URLs have not changed

The workflow commits changes under `public/data` and `public/thumbs`. Those commits trigger a normal Cloudflare redeploy from the repository.

GitHub scheduled workflows run from the repository default branch. If this repo's default branch is not the deployment branch, either change the default branch or merge these files into the default branch.

## Manual Runs

In GitHub Actions, run **Update False Knees index** manually with:

- `latest` to reprocess only the newest 4 comics
- `full` to refresh the whole archive
