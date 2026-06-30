import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStaticServer } from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const indexPath = path.join(rootDir, "public", "data", "search-index.json");
const index = JSON.parse(await readFile(indexPath, "utf8"));

assert(Array.isArray(index.comics), "search-index.json must contain comics array");
assert(index.comics.length > 0, "search-index.json must contain at least one comic");

for (const comic of index.comics.slice(0, 10)) {
  assert(comic.id, "comic id is required");
  assert(comic.url?.startsWith("https://falseknees.com/comics/"), `invalid official URL for ${comic.id}`);
  assert(comic.thumbnail, `thumbnail is required for ${comic.id}`);
  assert(
    typeof comic.titleText === "string" && typeof comic.comicText === "string" && typeof comic.hoverText === "string",
    `text fields must be strings for ${comic.id}`
  );
}

const server = createStaticServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;

await waitForServer(`http://127.0.0.1:${port}/`);
await waitForServer(`http://127.0.0.1:${port}/data/search-index.json`);
server.close();

console.log(`Smoke test passed for ${index.comics.length} indexed comics.`);

function waitForServer(url) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const attempt = () => {
      http
        .get(url, (response) => {
          response.resume();
          if (response.statusCode && response.statusCode < 400) {
            resolve();
            return;
          }
          retry();
        })
        .on("error", retry);
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
