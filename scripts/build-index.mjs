import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as cheerio from "cheerio";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const pageDir = path.join(dataDir, "pages");
const imageDir = path.join(dataDir, "images");
const mainImageDir = path.join(imageDir, "main");
const ocrInputDir = path.join(dataDir, "ocr-input");
const recordDir = path.join(dataDir, "records");
const publicDataDir = path.join(rootDir, "public", "data");
const publicThumbDir = path.join(rootDir, "public", "thumbs");

const archiveUrl = "https://falseknees.com/archive.html";
const siteOrigin = "https://falseknees.com";
const userAgent = "Mozilla/5.0 falseknees-search-local-indexer";

const monthNumbers = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december"
  ].map((month, index) => [month, String(index + 1).padStart(2, "0")])
);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDirs();

  const archive = await loadArchive(options);
  const selected = options.latest
    ? archive.entries.slice(-options.latest)
    : archive.entries.slice(options.offset, options.limit ? options.offset + options.limit : undefined);
  const selectedStart = options.latest ? archive.entries.length - selected.length : options.offset;

  console.log(`Archive has ${archive.entries.length} comics. Processing ${selected.length}.`);

  if (!options.rebuildIndexOnly) {
    await runPool(selected, options.concurrency, async (entry, index) => {
      const processed = await processComic(entry, options);
      const done = selectedStart + index + 1;
      const total = options.limit ? Math.min(options.offset + options.limit, archive.entries.length) : archive.entries.length;
      console.log(
        `${String(done).padStart(5, " ")}/${total} ${processed.id} ` +
          `images:${processed.imageCount} title:${processed.titleText ? processed.titleText.length : 0} ` +
          `comic:${processed.comicText ? processed.comicText.length : 0} ` +
          `hover:${processed.hoverText ? processed.hoverText.length : 0}`
      );
    });
  }

  const records = await loadRecords(archive.entries);
  await writeSearchIndex(archive, records);
  console.log(`Wrote ${records.length} indexed comics to public/data/search-index.json.`);
}

function parseArgs(args) {
  const options = {
    concurrency: 2,
    delayMs: 250,
    limit: 0,
    latest: 0,
    offset: 0,
    refreshPages: false,
    refreshImages: false,
    refreshOcr: false,
    rebuildIndexOnly: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readNumber = (name) => {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} expects a number`);
      }
      i += 1;
      return Number(value);
    };

    if (arg === "--concurrency") options.concurrency = readNumber(arg);
    else if (arg === "--delay-ms") options.delayMs = readNumber(arg);
    else if (arg === "--limit") options.limit = readNumber(arg);
    else if (arg === "--latest") options.latest = readNumber(arg);
    else if (arg === "--offset") options.offset = readNumber(arg);
    else if (arg === "--refresh-pages") options.refreshPages = true;
    else if (arg === "--refresh-images") options.refreshImages = true;
    else if (arg === "--refresh-ocr") options.refreshOcr = true;
    else if (arg === "--rebuild-index-only") options.rebuildIndexOnly = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative integer");
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error("--limit must be a non-negative integer");
  }
  if (!Number.isInteger(options.latest) || options.latest < 0) {
    throw new Error("--latest must be a non-negative integer");
  }
  if (options.latest && (options.limit || options.offset)) {
    throw new Error("--latest cannot be combined with --limit or --offset");
  }
  if (!Number.isInteger(options.offset) || options.offset < 0) {
    throw new Error("--offset must be a non-negative integer");
  }

  return options;
}

async function ensureDirs() {
  await Promise.all(
    [dataDir, pageDir, mainImageDir, ocrInputDir, recordDir, publicDataDir, publicThumbDir].map((dir) =>
      mkdir(dir, { recursive: true })
    )
  );
}

async function loadArchive(options) {
  const archivePath = path.join(dataDir, "archive.json");
  if (!options.refreshPages) {
    const cached = await readJsonIfExists(archivePath);
    if (cached?.entries?.length) return cached;
  }

  const html = await fetchText(archiveUrl, options);
  const $ = cheerio.load(html);
  const thumbnailByPath = new Map();
  $("a[href^='/comics/']").each((_, element) => {
    const href = $(element).attr("href");
    const thumbnailUrl = absoluteUrl($(element).find("img").first().attr("src"));
    if (href && thumbnailUrl) thumbnailByPath.set(href, thumbnailUrl);
  });

  const listAnchors = $("#list a[href^='/comics/']").toArray();
  const archiveAnchors = listAnchors.length ? listAnchors : $("a[href^='/comics/']").toArray();
  const seen = new Set();
  const entries = [];

  for (const element of archiveAnchors) {
    const href = $(element).attr("href");
    const label = squashWhitespace($(element).text());
    if (!href || seen.has(href) || !label) continue;
    seen.add(href);

    const slug = slugFromPath(href);
    const parsed = parseArchiveLabel(label, slug);
    entries.push({
      id: stableId(slug),
      slug,
      path: href,
      url: absoluteUrl(href),
      title: parsed.title,
      archiveLabel: label,
      date: parsed.date,
      dateLabel: parsed.dateLabel,
      thumbnailUrl: thumbnailByPath.get(href) || ""
    });
  }

  entries.reverse();

  const archive = {
    source: archiveUrl,
    fetchedAt: new Date().toISOString(),
    count: entries.length,
    entries
  };

  await writeJsonAtomic(archivePath, archive);
  return archive;
}

function parseArchiveLabel(label, slug) {
  const match = /^(.*?)\s+-\s+(.*)$/.exec(label);
  const dateLabel = match ? squashWhitespace(match[1]) : "";
  const title = match ? squashWhitespace(match[2]) : squashWhitespace(label) || slug;

  return {
    dateLabel,
    title,
    date: parseArchiveDate(dateLabel)
  };
}

async function processComic(entry, options) {
  const recordPath = path.join(recordDir, `${entry.id}.json`);
  const cachedRecord = await readJsonIfExists(recordPath);
  if (cachedRecord && !options.refreshPages && !options.refreshImages && !options.refreshOcr) {
    const thumbnailPath = cachedRecord.thumbnail ? path.join(rootDir, "public", cachedRecord.thumbnail) : "";
    const localImages = cachedRecord.localImages || (cachedRecord.localImage ? [cachedRecord.localImage] : []);
    if ((!thumbnailPath || (await exists(thumbnailPath))) && (await allExist(localImages.map((file) => path.join(rootDir, file))))) {
      return cachedRecord;
    }
  }

  await sleep(options.delayMs);

  const pageHtml = await loadComicPage(entry, options);
  const page = parseComicPage(entry, pageHtml);
  const downloadedImages = [];
  for (const [index, imageUrl] of page.imageUrls.entries()) {
    const basename = page.imageUrls.length === 1 ? page.id : `${page.id}-${String(index + 1).padStart(2, "0")}`;
    downloadedImages.push(await downloadComicImage(imageUrl, mainImageDir, basename, options));
  }

  const comicTexts = [];
  for (const [index, image] of downloadedImages.entries()) {
    comicTexts.push(await ocrCached(page.id, `comic-${index + 1}`, image.path, options));
  }

  const thumbnail = downloadedImages.length ? await writeThumbnail(page.id, downloadedImages[0].path) : "";
  const titleText = cleanTitle(page.title);
  const comicText = cleanOcr(comicTexts.filter(Boolean).join("\n\n"));

  const record = {
    id: page.id,
    slug: page.slug,
    url: page.url,
    title: page.title,
    date: page.date,
    dateLabel: page.dateLabel,
    imageUrl: page.imageUrls[0] || "",
    imageUrls: page.imageUrls,
    imageCount: page.imageUrls.length,
    localImages: downloadedImages.map((image) => path.relative(rootDir, image.path)),
    thumbnail,
    titleText,
    comicText,
    hoverText: page.hoverText,
    updatedAt: new Date().toISOString()
  };

  await writeJsonAtomic(recordPath, record);
  return record;
}

async function loadComicPage(entry, options) {
  const pagePath = path.join(pageDir, `${entry.id}.html`);
  if (!options.refreshPages && (await exists(pagePath))) {
    return readFile(pagePath, "utf8");
  }

  const html = await fetchText(entry.url, options);
  await writeFileAtomic(pagePath, html);
  return html;
}

function parseComicPage(entry, html) {
  const $ = cheerio.load(html);
  const comicImages = $("img")
    .toArray()
    .filter((element) => {
      const src = $(element).attr("src") || "";
      return /^imgs\//.test(src) || /\/comics\/imgs\//.test(src);
    });
  const imageUrls = unique(
    comicImages
      .map((element) => absoluteUrl($(element).attr("src"), entry.url))
      .filter(Boolean)
  );

  if (!imageUrls.length) {
    throw new Error(`No main image found for ${entry.url}`);
  }

  const hoverText = squashWhitespace(
    comicImages
      .flatMap((element) => [$(element).attr("title"), $(element).attr("alt")])
      .filter(Boolean)
      .join(" ")
  );

  return {
    ...entry,
    title: entry.title || cleanTitle($("title").first().text()) || entry.slug,
    imageUrls,
    hoverText
  };
}

async function downloadComicImage(url, targetDir, basename, options) {
  const extension = extensionFromUrl(url);
  const targetPath = path.join(targetDir, `${basename}${extension}`);

  if (!options.refreshImages && (await exists(targetPath))) {
    return { path: targetPath, url };
  }

  const response = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" }
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType && !contentType.startsWith("image/") && !isImageUrl(url)) {
    throw new Error(`Expected image for ${url}, got ${contentType || "unknown content type"}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFileAtomic(targetPath, buffer);
  return { path: targetPath, url };
}

async function ocrCached(id, kind, imagePath, options) {
  const ocrPath = path.join(dataDir, "ocr", `${id}-${kind}.txt`);
  await mkdir(path.dirname(ocrPath), { recursive: true });

  if (!options.refreshOcr && (await exists(ocrPath))) {
    return cleanOcr(await readFile(ocrPath, "utf8"));
  }

  const preparedPath = path.join(ocrInputDir, `${id}-${kind}.png`);
  let text = "";
  let inputForOcr = preparedPath;
  try {
    try {
      await prepareForOcr(imagePath, preparedPath);
    } catch (error) {
      console.warn(`OCR preprocessing failed for ${id} ${kind}; trying original image. ${firstErrorLine(error)}`);
      inputForOcr = imagePath;
    }
    try {
      text = cleanOcr(await runTesseract(inputForOcr));
    } catch (error) {
      if (inputForOcr === imagePath) throw error;
      console.warn(`OCR failed on prepared image for ${id} ${kind}; trying original image. ${firstErrorLine(error)}`);
      text = cleanOcr(await runTesseract(imagePath));
    }
  } catch (error) {
    console.warn(`OCR failed for ${id} ${kind}; leaving that field empty. ${firstErrorLine(error)}`);
  } finally {
    await rm(preparedPath, { force: true });
  }
  await writeFileAtomic(ocrPath, text);
  return text;
}

async function prepareForOcr(inputPath, outputPath) {
  const image = sharp(inputPath, { animated: false, limitInputPixels: false });
  const metadata = await image.metadata();
  const sourceWidth = metadata.width || 1000;
  const targetWidth = sourceWidth < 1800 ? 1800 : sourceWidth;

  await image
    .flatten({ background: "#ffffff" })
    .resize({ width: targetWidth, withoutEnlargement: sourceWidth >= 1800 })
    .grayscale()
    .normalize()
    .sharpen()
    .png({ compressionLevel: 6 })
    .toFile(outputPath);
}

async function runTesseract(imagePath) {
  const args = [
    imagePath,
    "stdout",
    "-l",
    "eng",
    "--oem",
    "1",
    "--psm",
    "11",
    "-c",
    "preserve_interword_spaces=1"
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("tesseract", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`tesseract exited ${code} for ${imagePath}\n${stderr}`));
    });
  });
}

async function writeThumbnail(id, imagePath) {
  const relativePath = `thumbs/${id}.webp`;
  const targetPath = path.join(rootDir, "public", relativePath);
  if (await exists(targetPath)) return relativePath;

  try {
    await sharp(imagePath, { animated: false, limitInputPixels: false })
      .flatten({ background: "#ffffff" })
      .resize({ width: 320, height: 240, fit: "contain", background: "#ffffff" })
      .webp({ quality: 68, effort: 4 })
      .toFile(targetPath);
  } catch (error) {
    console.warn(`Thumbnail generation failed for ${id}; using placeholder. ${firstErrorLine(error)}`);
    await sharp({
      create: {
        width: 320,
        height: 240,
        channels: 3,
        background: "#f1f3ec"
      }
    })
      .webp({ quality: 68, effort: 4 })
      .toFile(targetPath);
  }

  return relativePath;
}

async function loadRecords(entries) {
  const previousIndex = await readExistingSearchIndex();
  const previousRecords = new Map((previousIndex?.comics || []).map((comic) => [comic.id, comic]));
  const records = [];
  for (const entry of entries) {
    const record = await readJsonIfExists(path.join(recordDir, `${entry.id}.json`));
    if (record) records.push(record);
    else if (previousRecords.has(entry.id)) records.push(previousRecords.get(entry.id));
  }
  return records;
}

async function readExistingSearchIndex() {
  return (
    (await readJsonIfExists(path.join(publicDataDir, "search-index.json"))) ||
    (await readJsonIfExists(path.join(dataDir, "search-index.json")))
  );
}

async function writeSearchIndex(archive, records) {
  const index = {
    generatedAt: new Date().toISOString(),
    source: archive.source,
    totalArchiveComics: archive.entries.length,
    totalIndexedComics: records.length,
    fields: ["titleText", "comicText", "hoverText"],
    comics: records.map((record) => ({
      id: record.id,
      slug: record.slug,
      url: record.url,
      title: record.title,
      date: record.date,
      dateLabel: record.dateLabel,
      thumbnail: record.thumbnail,
      imageCount: record.imageCount || 1,
      titleText: record.titleText || record.title || "",
      comicText: record.comicText || "",
      hoverText: record.hoverText || ""
    }))
  };

  await writeJsonAtomic(path.join(publicDataDir, "search-index.json"), index);
  await writeJsonAtomic(path.join(dataDir, "search-index.json"), index);
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function fetchText(url, options) {
  await sleep(options.delayMs);
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return text;
}

function parseArchiveDate(dateLabel) {
  if (!dateLabel) return "";

  const cleaned = squashWhitespace(
    dateLabel
      .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1")
      .replace(/,/g, "")
  );
  const fullDate = /^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})$/.exec(cleaned);
  if (fullDate) {
    const month = monthNumbers.get(fullDate[1].toLowerCase());
    if (!month) return "";
    return `${fullDate[3]}-${month}-${fullDate[2].padStart(2, "0")}`;
  }

  const monthDate = /^([A-Za-z]+)\s+(\d{4})$/.exec(cleaned);
  if (monthDate) {
    const month = monthNumbers.get(monthDate[1].toLowerCase());
    if (!month) return "";
    return `${monthDate[2]}-${month}-01`;
  }

  return "";
}

function cleanTitle(title) {
  return squashWhitespace(String(title || "").replace(/^False Knees\s*-\s*/i, ""));
}

function cleanOcr(text) {
  return String(text || "")
    .replace(/\f/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function squashWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function absoluteUrl(value, base = siteOrigin) {
  if (!value) return "";
  try {
    return new URL(value, base).toString();
  } catch {
    return "";
  }
}

function slugFromPath(value) {
  const pathname = new URL(value, siteOrigin).pathname;
  return path.basename(pathname, path.extname(pathname));
}

function extensionFromUrl(url) {
  const pathname = new URL(url).pathname;
  const extension = path.extname(pathname).toLowerCase();
  return extension && extension.length <= 6 ? extension : ".img";
}

function isImageUrl(url) {
  return /\.(avif|gif|jpe?g|png|webp)$/i.test(new URL(url).pathname);
}

function unique(values) {
  return Array.from(new Set(values));
}

function firstErrorLine(error) {
  return String(error?.message || error || "").split("\n")[0];
}

function stableId(slug) {
  const safe = slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (safe) return safe;
  return createHash("sha1").update(slug).digest("hex").slice(0, 12);
}

async function allExist(filePaths) {
  for (const filePath of filePaths) {
    if (!(await exists(filePath))) return false;
  }
  return true;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, data) {
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeFileAtomic(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, data);
  await rename(tempPath, filePath);
}

async function sleep(ms) {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
