import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function resolvePath(urlPath) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const normalized = normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  return join(root, normalized);
}

createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const filePath = resolvePath(url.pathname);

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const contentType = contentTypes[extname(filePath)] || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  createReadStream(filePath).pipe(response);
}).listen(port, () => {
  console.log(`Dev server running at http://localhost:${port}`);
});
