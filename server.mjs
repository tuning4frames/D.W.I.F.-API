import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import { cleanupTempArtifacts, parseApiRequest, processRemoteImage } from "./lib/http-api.mjs";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(message);
}

function buildContentDisposition(filename) {
  const safeFilename = filename.replace(/["\r\n]/g, "");
  return `attachment; filename="${safeFilename}"`;
}

async function pipeFileToResponse(response, filePath) {
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    let settled = false;

    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    stream.on("error", finish);
    stream.on("end", () => finish());
    response.on("close", () => finish());
    response.on("error", finish);
    stream.pipe(response);
  });
}

async function handleProcess(response, requestUrl) {
  let tempDir = null;

  try {
    const request = parseApiRequest(requestUrl);
    const result = await processRemoteImage(request);
    tempDir = result.tempDir;
    const headers = {
      "Content-Type": result.contentType,
      "Cache-Control": "no-store",
      "X-DWIF-Width": String(result.width),
      "X-DWIF-Height": String(result.height),
      "X-DWIF-Top-Strip": String(result.topStrip),
      "X-DWIF-Radius": String(result.radius),
      "X-DWIF-Animated": result.animated ? "true" : "false"
    };

    if (request.download) {
      headers["Content-Disposition"] = buildContentDisposition(result.downloadName);
    }

    response.writeHead(200, headers);

    await pipeFileToResponse(response, result.outputPath);
  } catch (error) {
    sendText(response, error.statusCode || 500, error.message || "Internal server error.");
  } finally {
    await cleanupTempArtifacts(tempDir);
  }
}

const server = http.createServer(async (request, response) => {
  if (!request.url || !request.method) {
    sendText(response, 400, "Invalid request.");
    return;
  }

  if (request.method !== "GET") {
    sendText(response, 405, "Method not allowed.");
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/api/health") {
    sendText(response, 200, "ok");
    return;
  }

  if (requestUrl.pathname === "/api/process") {
    await handleProcess(response, requestUrl);
    return;
  }

  sendText(response, 404, "Not found.");
});

server.listen(PORT, HOST, () => {
  console.log(`D.W.I.F API listening on http://${HOST}:${PORT}`);
});
