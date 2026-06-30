import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const requestedPort = Number(process.env.PORT || 5173);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webp", "image/webp"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"]
]);

export function createStaticServer() {
  return http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      const pathname = decodeURIComponent(requestUrl.pathname);
      const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(publicDir, relativePath);

      if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== publicDir) {
        response.writeHead(403).end("Forbidden");
        return;
      }

      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }

      response.writeHead(200, {
        "content-type": mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
        "cache-control": "no-store"
      });
      createReadStream(filePath).pipe(response);
    } catch (error) {
      if (error.code === "ENOENT") {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(500).end("Internal server error");
      console.error(error);
    }
  });
}

export async function listen(port = requestedPort, host = "127.0.0.1") {
  let nextPort = port;
  while (nextPort < port + 20) {
    const server = createStaticServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(nextPort, host, resolve);
      });
      return server;
    } catch (error) {
      server.close();
      if (error.code !== "EADDRINUSE") throw error;
      console.warn(`Port ${nextPort} is in use; retrying on ${nextPort + 1}.`);
      nextPort += 1;
    }
  }
  throw new Error(`No open port found from ${port} to ${nextPort - 1}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await listen(requestedPort);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  console.log(`False Knees Search is available at http://127.0.0.1:${port}/`);
}
