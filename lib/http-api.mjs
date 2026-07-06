import dns from "node:dns/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseOptionalNumber, processImage } from "./dwif.mjs";

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Map([
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"]
]);

function envFlag(name) {
  return process.env[name] === "1" || process.env[name] === "true";
}

function getFetchTimeoutMs() {
  const raw = Number.parseInt(process.env.DWIF_FETCH_TIMEOUT_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FETCH_TIMEOUT_MS;
}

function getMaxDownloadBytes() {
  const raw = Number.parseInt(process.env.DWIF_MAX_DOWNLOAD_BYTES || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_DOWNLOAD_BYTES;
}

function textError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function isIpv4Private(address) {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) {
    return true;
  }

  if (parts[0] === 169 && parts[1] === 254) {
    return true;
  }

  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }

  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }

  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) {
    return true;
  }

  return false;
}

function isIpv6Private(address) {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}

function isPrivateAddress(address) {
  if (address.includes(":")) {
    return isIpv6Private(address);
  }

  return isIpv4Private(address);
}

async function assertPublicHostname(hostname) {
  if (envFlag("DWIF_ALLOW_PRIVATE_HOSTS")) {
    return;
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw textError(400, "Source URL must not point to localhost or a private network.");
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw textError(502, "Could not resolve the source host.");
  }

  if (!records.length) {
    throw textError(502, "Could not resolve the source host.");
  }

  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw textError(400, "Source URL must not point to localhost or a private network.");
    }
  }
}

function sanitizeFilenamePart(value) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "dwif";
}

function getDownloadNameFromUrl(sourceUrl, extension) {
  const rawBaseName = path.basename(sourceUrl.pathname, path.extname(sourceUrl.pathname));
  const safeBaseName = sanitizeFilenamePart(rawBaseName);
  return `${safeBaseName}-dwif${extension}`;
}

function inferExtensionFromUrl(url) {
  const lowerPath = url.pathname.toLowerCase();
  for (const extension of [".png", ".webp", ".gif"]) {
    if (lowerPath.endsWith(extension)) {
      return extension;
    }
  }

  return null;
}

function extensionFromContentType(contentTypeHeader) {
  const mime = (contentTypeHeader || "").split(";")[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.get(mime) || null;
}

function contentTypeFromExtension(extension) {
  for (const [contentType, knownExtension] of ALLOWED_CONTENT_TYPES.entries()) {
    if (knownExtension === extension) {
      return contentType;
    }
  }

  return "application/octet-stream";
}

function parseGifEncoder(value) {
  if (value == null || value === "") {
    return null;
  }

  if (value === "gifenc" || value === "gifski") {
    return value;
  }

  throw new Error("gifEncoder must be either gifenc or gifski.");
}

function parseDownloadFlag(value) {
  if (value == null || value === "") {
    return false;
  }

  return value === "1" || value === "true";
}

export function parseApiRequest(requestUrl) {
  const remoteUrl = requestUrl.searchParams.get("url");
  if (!remoteUrl) {
    throw textError(400, "Missing required query parameter: url");
  }

  let sourceUrl;
  try {
    sourceUrl = new URL(remoteUrl);
  } catch {
    throw textError(400, "The url query parameter must be a valid absolute URL.");
  }

  if (sourceUrl.protocol !== "https:" && !envFlag("DWIF_ALLOW_INSECURE_SOURCE_URLS")) {
    throw textError(400, "Only https source URLs are allowed.");
  }

  try {
    return {
      sourceUrl,
      manualTopStrip: parseOptionalNumber(requestUrl.searchParams.get("topStrip"), "topStrip"),
      manualRadius: parseOptionalNumber(requestUrl.searchParams.get("radius"), "radius"),
      gifEncoder: parseGifEncoder(requestUrl.searchParams.get("gifEncoder")),
      download: parseDownloadFlag(requestUrl.searchParams.get("download"))
    };
  } catch (error) {
    throw textError(400, error.message || "Invalid query parameters.");
  }
}

async function fetchWithRedirects(sourceUrl, signal, redirectCount = 0) {
  const response = await fetch(sourceUrl, {
    redirect: "manual",
    signal
  });

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= 5) {
      throw textError(502, "Too many upstream redirects.");
    }

    const location = response.headers.get("location");
    if (!location) {
      throw textError(502, "Upstream redirect did not include a location.");
    }

    const nextUrl = new URL(location, sourceUrl);
    if (nextUrl.protocol !== "https:" && !envFlag("DWIF_ALLOW_INSECURE_SOURCE_URLS")) {
      throw textError(400, "Only https source URLs are allowed.");
    }

    await assertPublicHostname(nextUrl.hostname);
    return fetchWithRedirects(nextUrl, signal, redirectCount + 1);
  }

  return response;
}

export async function fetchRemoteImage(sourceUrl) {
  await assertPublicHostname(sourceUrl.hostname);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getFetchTimeoutMs());
  const maxDownloadBytes = getMaxDownloadBytes();

  try {
    const response = await fetchWithRedirects(sourceUrl, controller.signal);

    if (!response.ok) {
      throw textError(502, `Upstream image request failed with status ${response.status}.`);
    }

    const contentType = response.headers.get("content-type");
    const extension = extensionFromContentType(contentType) || inferExtensionFromUrl(sourceUrl);
    if (!extension) {
      throw textError(415, "Only PNG, WEBP, and GIF source images are supported.");
    }

    const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxDownloadBytes) {
      throw textError(413, "Remote image is too large.");
    }

    if (!response.body) {
      throw textError(502, "Upstream response did not contain an image body.");
    }

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dwif-api-"));
    const baseName = sanitizeFilenamePart(
      path.basename(sourceUrl.pathname, path.extname(sourceUrl.pathname))
    );
    const downloadName = getDownloadNameFromUrl(sourceUrl, extension);
    const inputPath = path.join(tempDir, `${baseName}${extension}`);
    const outputPath = path.join(tempDir, downloadName);
    const nodeBody = Readable.fromWeb(response.body);
    let bytesWritten = 0;

    nodeBody.on("data", (chunk) => {
      bytesWritten += chunk.length;
      if (bytesWritten > maxDownloadBytes) {
        nodeBody.destroy(textError(413, "Remote image is too large."));
      }
    });

    await pipeline(nodeBody, fs.createWriteStream(inputPath));

    return {
      tempDir,
      inputPath,
      outputPath,
      extension,
      downloadName
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw textError(504, "Timed out while fetching the source image.");
    }

    if (error.statusCode) {
      throw error;
    }

    throw textError(502, error.message || "Could not fetch the source image.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function processRemoteImage({ sourceUrl, manualTopStrip, manualRadius, gifEncoder }) {
  const download = await fetchRemoteImage(sourceUrl);

  try {
    const encodingConfig = gifEncoder
      ? {
          mode: "advanced",
          gifEncoder,
          gifColours: 256,
          webpLossless: false,
          webpQuality: 92,
          webpEffort: 4,
          gifskiQuality: 100,
          gifskiMotionQuality: 100,
          gifskiLossyQuality: 100
        }
      : null;

    const result = await processImage({
      inputPath: download.inputPath,
      outputPath: download.outputPath,
      manualTopStrip,
      manualRadius,
      fastAnimated: gifEncoder !== "gifski",
      encodingConfig
    });

    return {
      ...result,
      outputPath: download.outputPath,
      contentType: contentTypeFromExtension(download.extension),
      tempDir: download.tempDir,
      downloadName: download.downloadName
    };
  } catch (error) {
    if (error.message === "Input file contains unsupported image format") {
      throw textError(415, "Only PNG, WEBP, and GIF source images are supported.");
    }

    throw error.statusCode ? error : textError(500, error.message || "Image processing failed.");
  }
}

export async function cleanupTempArtifacts(tempDir) {
  if (!tempDir) {
    return;
  }

  await fsp.rm(tempDir, { recursive: true, force: true });
}
