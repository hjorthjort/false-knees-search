# False Knees Search

A local, reproducible indexer and search page for [False Knees](https://falseknees.com/).

The scraper reads the official archive, downloads each comic image, extracts:

- archive title text
- main comic OCR text
- hover or alt text when present

Search defaults to title and comic text, with a toggle for hover text. Result thumbnails are generated locally from the comic images so the app can deploy as a static site.

## Requirements

- Node.js 20+
- npm
- Tesseract OCR available as `tesseract`

## Install

```sh
npm install
```

## Build the index

For a quick sanity check:

```sh
npm run scrape:sample
```

For the full archive:

```sh
npm run scrape
```

The full run is resumable. It caches fetched pages, images, OCR records, generated thumbnails, and the final search index under `data/`, `public/data/`, and `public/thumbs/`.

Useful options:

```sh
node scripts/build-index.mjs --limit 100
node scripts/build-index.mjs --offset 200 --limit 100
node scripts/build-index.mjs --concurrency 2 --delay-ms 300
node scripts/build-index.mjs --refresh-pages
node scripts/build-index.mjs --refresh-ocr
node scripts/build-index.mjs --rebuild-index-only
```

## Run the search page

```sh
npm run serve
```

Open the printed local URL.

## Verify

```sh
npm run smoke
```

## Cloud deployment

For the set-and-forget Cloudflare/GitHub Actions setup, see [docs/cloud-deployment.md](docs/cloud-deployment.md).
