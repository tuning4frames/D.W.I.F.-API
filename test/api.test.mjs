import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { cleanupTempArtifacts, parseApiRequest, processRemoteImage } from "../lib/http-api.mjs";

let fixtureDir;

before(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "dwif-tests-"));
});

after(async () => {
  if (fixtureDir) {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test("parseApiRequest reads the supported query params", () => {
  const requestUrl = new URL(
    "http://localhost/api/process?url=https://example.com/image.png&topStrip=17&radius=36&gifEncoder=gifski&download=1"
  );
  const parsed = parseApiRequest(requestUrl);

  assert.equal(parsed.sourceUrl.href, "https://example.com/image.png");
  assert.equal(parsed.manualTopStrip, 17);
  assert.equal(parsed.manualRadius, 36);
  assert.equal(parsed.gifEncoder, "gifski");
  assert.equal(parsed.download, true);
});

test("parseApiRequest rejects missing url", () => {
  assert.throws(
    () => parseApiRequest(new URL("http://localhost/api/process")),
    /Missing required query parameter/
  );
});

test("parseApiRequest rejects non-https URLs by default", () => {
  assert.throws(
    () => parseApiRequest(new URL("http://localhost/api/process?url=http://example.com/test.png")),
    /Only https source URLs are allowed/
  );
});

test("parseApiRequest rejects unsupported gifEncoder values", () => {
  assert.throws(
    () =>
      parseApiRequest(
        new URL("http://localhost/api/process?url=https://example.com/test.gif&gifEncoder=banana")
      ),
    /gifEncoder must be either gifenc or gifski/
  );
});

test("processRemoteImage handles a PNG source with test-only fetch overrides", async () => {
  process.env.DWIF_ALLOW_PRIVATE_HOSTS = "true";
  process.env.DWIF_ALLOW_INSECURE_SOURCE_URLS = "true";

  const pngPath = path.join(fixtureDir, "source.png");
  const pngBuffer = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
  await fs.writeFile(pngPath, pngBuffer);

  let tempDir = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(pngBuffer, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(pngBuffer.length)
      }
    });

  try {
    const result = await processRemoteImage({
      sourceUrl: new URL("http://127.0.0.1/source.png"),
      manualTopStrip: null,
      manualRadius: null,
      gifEncoder: null
    });
    tempDir = result.tempDir;

    const metadata = await sharp(result.outputPath).metadata();
    assert.equal(result.contentType, "image/png");
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 32);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupTempArtifacts(tempDir);
    delete process.env.DWIF_ALLOW_PRIVATE_HOSTS;
    delete process.env.DWIF_ALLOW_INSECURE_SOURCE_URLS;
  }
});

test("processRemoteImage handles an AVIF source with test-only fetch overrides", async () => {
  process.env.DWIF_ALLOW_PRIVATE_HOSTS = "true";
  process.env.DWIF_ALLOW_INSECURE_SOURCE_URLS = "true";

  const avifPath = path.join(fixtureDir, "source.avif");
  const avifBuffer = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 0, g: 128, b: 255, alpha: 1 }
    }
  })
    .avif()
    .toBuffer();
  await fs.writeFile(avifPath, avifBuffer);

  let tempDir = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(avifBuffer, {
      status: 200,
      headers: {
        "Content-Type": "image/avif",
        "Content-Length": String(avifBuffer.length)
      }
    });

  try {
    const result = await processRemoteImage({
      sourceUrl: new URL("http://127.0.0.1/source.avif"),
      manualTopStrip: null,
      manualRadius: null,
      gifEncoder: null
    });
    tempDir = result.tempDir;

    const metadata = await sharp(result.outputPath).metadata();
    assert.equal(result.contentType, "image/avif");
    assert.equal(metadata.format, "heif");
    assert.equal(metadata.width, 32);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupTempArtifacts(tempDir);
    delete process.env.DWIF_ALLOW_PRIVATE_HOSTS;
    delete process.env.DWIF_ALLOW_INSECURE_SOURCE_URLS;
  }
});
