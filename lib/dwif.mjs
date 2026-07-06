import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import gifenc from "gifenc";
import WebPMux from "node-webpmux";
import sharp from "sharp";

const { GIFEncoder, applyPalette, quantize } = gifenc;

export const REFERENCE_SIZE = 512;
export const AUTO_TOP_STRIP_BASE = 17;
export const AUTO_RADIUS_BASE = 36;
export const AUTO_TOP_STRIP_EXPONENT =
  Math.log(54 / 17) / Math.log(Math.sqrt(1844 * 853) / REFERENCE_SIZE);
export const AUTO_RADIUS_EXPONENT =
  Math.log(172 / 36) / Math.log(Math.sqrt(1844 * 853) / REFERENCE_SIZE);

const RUNTIME_ROOT = process.env.DWIF_RUNTIME_ROOT
  ? path.resolve(process.env.DWIF_RUNTIME_ROOT)
  : process.cwd();

const cornerCutoutCache = new Map();
const SHARP_SOURCE_OPTIONS = {
  animated: true,
  pages: -1,
  limitInputPixels: false
};
const SHARP_STILL_SOURCE_OPTIONS = {
  limitInputPixels: false
};

const DEFAULT_GIFSKI_QUALITY = 100;
const GIFSKI_WINDOWS_CANDIDATES = [
  path.join(RUNTIME_ROOT, "vendor", "gifski-cli", "bin", "gifski.exe"),
  path.join(process.env.ProgramFiles || "", "gifski", "gifski.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "", "gifski", "gifski.exe"),
  path.join(RUNTIME_ROOT, "vendor", "gifski.exe")
].filter(Boolean);

function getEncodingConcurrency(frameCount) {
  const cpuCount = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;

  return Math.max(1, Math.min(frameCount, Math.max(2, cpuCount - 1), 6));
}

export function parseOptionalNumber(value, label) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }

  return parsed;
}

export function getAutoValue(baseValue, exponent, width, height) {
  const sizeFactor = Math.sqrt(width * height) / REFERENCE_SIZE;
  return Math.max(0, Math.round(baseValue * Math.pow(sizeFactor, exponent)));
}

function buildCornerCutout(radius) {
  const cached = cornerCutoutCache.get(radius);
  if (cached) {
    return cached;
  }

  const cutoutPromise = sharp({
    create: {
      width: radius,
      height: radius,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${radius}" height="${radius}" viewBox="0 0 ${radius} ${radius}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="${radius}" height="${radius}" fill="white"/>
          </svg>`
        )
      },
      {
        input: Buffer.from(
          `<svg width="${radius}" height="${radius}" viewBox="0 0 ${radius} ${radius}" xmlns="http://www.w3.org/2000/svg">
            <circle cx="0" cy="${radius}" r="${radius}" fill="black"/>
          </svg>`
        ),
        blend: "dest-out"
      }
    ])
    .png()
    .toBuffer();

  cornerCutoutCache.set(radius, cutoutPromise);
  return cutoutPromise;
}

function buildCornerClearStarts(radius) {
  const clearStarts = new Int32Array(radius);
  const radiusSquared = radius * radius;

  for (let localY = 0; localY < radius; localY += 1) {
    let clearStart = radius;
    const dy = localY + 0.5 - radius;

    for (let localX = 0; localX < radius; localX += 1) {
      const dx = localX + 0.5;

      if ((dx * dx) + (dy * dy) > radiusSquared) {
        clearStart = localX;
        break;
      }
    }

    clearStarts[localY] = clearStart;
  }

  return clearStarts;
}

function applyWidgetFixToRawFrames(inputData, width, frameHeight, frameCount, topStrip, radius) {
  const outputData = Buffer.alloc(width * frameHeight * frameCount * 4, 0);
  const frameStride = width * frameHeight * 4;
  const rowStride = width * 4;
  const clearStarts = radius > 0 ? buildCornerClearStarts(radius) : null;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frameOffset = frameIndex * frameStride;

    for (let y = 0; y < frameHeight; y += 1) {
      const destinationY = y + topStrip;

      if (destinationY >= frameHeight) {
        continue;
      }

      const sourceIndex = frameOffset + y * rowStride;
      const destinationIndex = frameOffset + destinationY * rowStride;
      inputData.copy(outputData, destinationIndex, sourceIndex, sourceIndex + rowStride);
    }

    if (radius <= 0) {
      continue;
    }

    const cornerStartX = width - radius;

    for (let localY = 0; localY < radius; localY += 1) {
      const y = topStrip + localY;

      if (y >= frameHeight) {
        break;
      }

      const clearStart = clearStarts[localY];

      if (clearStart >= radius) {
        continue;
      }

      const rowBase = frameOffset + y * rowStride;

      for (let localX = clearStart; localX < radius; localX += 1) {
        const x = cornerStartX + localX;
        const pixelBase = rowBase + x * 4;
        outputData[pixelBase] = 0;
        outputData[pixelBase + 1] = 0;
        outputData[pixelBase + 2] = 0;
        outputData[pixelBase + 3] = 0;
      }
    }
  }

  return outputData;
}

function applyOutputFormat(pipeline, outputPath, metadata) {
  const extension = path.extname(outputPath).toLowerCase();
  const delay = metadata.delay ?? undefined;
  const loop = metadata.loop ?? 0;

  if (extension === ".gif") {
    return pipeline.gif({
      effort: 7,
      loop,
      delay
    });
  }

  if (extension === ".webp") {
    return pipeline.webp({
      effort: 4,
      loop,
      delay
    });
  }

  if (extension === ".png" || extension === "") {
    return pipeline.png();
  }

  throw new Error("Unsupported output format. Use .png, .webp, or .gif.");
}

function getAnimatedEncodingOptions(metadata) {
  const config = resolveEncodingConfig(metadata);
  const fastAnimated = metadata.fastAnimated === true;

  if (config.mode === "advanced") {
    return {
      fastAnimated,
      gifEncoder: config.gifEncoder,
      gifColours: Math.max(2, Math.min(256, config.gifColours)),
      gifPaletteFormat: config.gifColours <= 192 ? "rgb444" : "rgb565",
      webpLossless: config.webpLossless,
      webpNearLossless: !config.webpLossless && config.webpQuality >= 88,
      webpQuality: config.webpLossless ? undefined : config.webpQuality,
      webpEffort: config.webpEffort,
      gifskiQuality: config.gifskiQuality,
      gifskiMotionQuality: config.gifskiMotionQuality,
      gifskiLossyQuality: config.gifskiLossyQuality
    };
  }

  const preset = Number(config.preset ?? (fastAnimated ? 0 : 3));
  const simplePresets = [
    {
      gifEncoder: "gifenc",
      gifColours: 192,
      gifPaletteFormat: "rgb444",
      webpLossless: false,
      webpNearLossless: true,
      webpQuality: 82,
      webpEffort: 1,
      gifskiQuality: 82,
      gifskiMotionQuality: 82,
      gifskiLossyQuality: 80
    },
    {
      gifEncoder: "gifenc",
      gifColours: 224,
      gifPaletteFormat: "rgb565",
      webpLossless: false,
      webpNearLossless: true,
      webpQuality: 88,
      webpEffort: 2,
      gifskiQuality: 88,
      gifskiMotionQuality: 88,
      gifskiLossyQuality: 88
    },
    {
      gifEncoder: "gifenc",
      gifColours: 256,
      gifPaletteFormat: "rgb565",
      webpLossless: false,
      webpNearLossless: false,
      webpQuality: 92,
      webpEffort: 3,
      gifskiQuality: 92,
      gifskiMotionQuality: 92,
      gifskiLossyQuality: 92
    },
    {
      gifEncoder: "gifski",
      gifColours: 256,
      gifPaletteFormat: "rgb565",
      webpLossless: false,
      webpNearLossless: false,
      webpQuality: 96,
      webpEffort: 4,
      gifskiQuality: 98,
      gifskiMotionQuality: 98,
      gifskiLossyQuality: 98
    },
    {
      gifEncoder: "gifski",
      gifColours: 256,
      gifPaletteFormat: "rgb565",
      webpLossless: true,
      webpNearLossless: false,
      webpQuality: undefined,
      webpEffort: 6,
      gifskiQuality: 100,
      gifskiMotionQuality: 100,
      gifskiLossyQuality: 100
    }
  ];
  const chosen = simplePresets[Math.max(0, Math.min(simplePresets.length - 1, preset))];

  return {
    fastAnimated,
    ...chosen
  };
}

function resolveEncodingConfig(metadata) {
  if (metadata.encodingConfig && typeof metadata.encodingConfig === "object") {
    return metadata.encodingConfig;
  }

  return {
    mode: "simple",
    preset: metadata.fastAnimated === true ? 0 : 3
  };
}

function collectOpaquePixels(rgbaData, alphaThreshold = 127) {
  const opaquePixelCount = Math.floor(rgbaData.length / 4);
  let keptPixels = 0;

  for (let pixelIndex = 0; pixelIndex < opaquePixelCount; pixelIndex += 1) {
    if (rgbaData[pixelIndex * 4 + 3] > alphaThreshold) {
      keptPixels += 1;
    }
  }

  if (keptPixels === opaquePixelCount) {
    return rgbaData;
  }

  const opaquePixels = new Uint8Array(keptPixels * 4);
  let writeOffset = 0;

  for (let pixelIndex = 0; pixelIndex < opaquePixelCount; pixelIndex += 1) {
    const sourceOffset = pixelIndex * 4;

    if (rgbaData[sourceOffset + 3] <= alphaThreshold) {
      continue;
    }

    opaquePixels[writeOffset] = rgbaData[sourceOffset];
    opaquePixels[writeOffset + 1] = rgbaData[sourceOffset + 1];
    opaquePixels[writeOffset + 2] = rgbaData[sourceOffset + 2];
    opaquePixels[writeOffset + 3] = 255;
    writeOffset += 4;
  }

  return opaquePixels;
}

function hasTransparentPixels(rgbaData, alphaThreshold = 127) {
  for (let offset = 3; offset < rgbaData.length; offset += 4) {
    if (rgbaData[offset] <= alphaThreshold) {
      return true;
    }
  }

  return false;
}

function resolveGifskiExecutable() {
  const envPath = process.env.DWIF_GIFSKI_PATH;

  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  if (process.platform === "win32") {
    const installedPath = GIFSKI_WINDOWS_CANDIDATES.find((candidate) => existsSync(candidate));
    return installedPath ?? "gifski.exe";
  }

  const bundledName = path.join(RUNTIME_ROOT, "vendor", "gifski");
  if (existsSync(bundledName)) {
    return bundledName;
  }

  return "gifski";
}

function getFrameDelays(metadata, frameCount) {
  if (Array.isArray(metadata.delay) && metadata.delay.length > 0) {
    return Array.from({ length: frameCount }, (_, index) =>
      Math.max(10, Number(metadata.delay[index] ?? metadata.delay.at(-1) ?? 100))
    );
  }

  const defaultDelay = Math.max(10, Number(metadata.delay ?? 100));
  return Array.from({ length: frameCount }, () => defaultDelay);
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);

  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a || 1;
}

function getTimingModel(metadata, frameCount) {
  const delays = getFrameDelays(metadata, frameCount).map((delay) => Math.max(10, Math.round(delay)));
  const frameStepMs = delays.reduce(
    (current, delay) => greatestCommonDivisor(current, delay),
    delays[0] ?? 100
  );

  return {
    delays,
    frameStepMs,
    fps: Math.max(1, Math.round(1000 / frameStepMs))
  };
}

function runProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${path.basename(executable)} failed with exit code ${code}.`));
    });
  });
}

async function writeAnimatedGifWithGifski(
  outputData,
  width,
  frameHeight,
  frameCount,
  outputPath,
  metadata
) {
  const executable = resolveGifskiExecutable();
  const frameStride = width * frameHeight * 4;
  const timing = getTimingModel(metadata, frameCount);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dwif-gifski-"));
  const framePaths = [];

  try {
    let outputIndex = 0;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const frame = outputData.subarray(frameIndex * frameStride, (frameIndex + 1) * frameStride);
      const pngBuffer = await sharp(frame, {
        raw: {
          width,
          height: frameHeight,
          channels: 4
        }
      })
        .png()
        .toBuffer();
      const repeatCount = Math.max(1, Math.round(timing.delays[frameIndex] / timing.frameStepMs));

      for (let copyIndex = 0; copyIndex < repeatCount; copyIndex += 1) {
        const framePath = path.join(tempDir, `frame-${String(outputIndex).padStart(6, "0")}.png`);
        await fs.writeFile(framePath, pngBuffer);
        framePaths.push(framePath);
        outputIndex += 1;
      }

      metadata.onFrame?.(frameIndex + 1, frameCount, "encoding");
    }

    await runProcess(executable, [
      "--fps",
      String(timing.fps),
      "--quality",
      String(metadata.gifskiQuality ?? DEFAULT_GIFSKI_QUALITY),
      "--motion-quality",
      String(metadata.gifskiMotionQuality ?? DEFAULT_GIFSKI_QUALITY),
      "--lossy-quality",
      String(metadata.gifskiLossyQuality ?? DEFAULT_GIFSKI_QUALITY),
      "--output",
      outputPath,
      ...framePaths
    ]);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "High-quality GIF export requires gifski. Install it or set DWIF_GIFSKI_PATH to gifski.exe."
      );
    }

    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function writeAnimatedGif(outputData, width, frameHeight, frameCount, outputPath, metadata) {
  let onFrame = null;
  if (typeof metadata.onFrame === "function") {
    onFrame = metadata.onFrame;
  }
  const options = getAnimatedEncodingOptions(metadata);
  const gif = GIFEncoder();
  const frameStride = width * frameHeight * 4;
  const usesTransparency = hasTransparentPixels(outputData);
  const paletteSample = usesTransparency ? collectOpaquePixels(outputData) : outputData;
  const opaquePalette =
    paletteSample.length > 0
      ? quantize(paletteSample, usesTransparency ? options.gifColours - 1 : options.gifColours, {
          format: options.gifPaletteFormat
        })
      : [[0, 0, 0]];
  const palette = usesTransparency ? [[0, 0, 0], ...opaquePalette] : opaquePalette;
  const transparentIndex = usesTransparency ? 0 : -1;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frame = Uint8Array.from(
      outputData.subarray(frameIndex * frameStride, (frameIndex + 1) * frameStride)
    );
    let index;

    if (usesTransparency) {
      const opaqueIndex = applyPalette(frame, opaquePalette, options.gifPaletteFormat);
      index = new Uint8Array(opaqueIndex.length);

      for (let pixelIndex = 0; pixelIndex < opaqueIndex.length; pixelIndex += 1) {
        index[pixelIndex] =
          frame[pixelIndex * 4 + 3] <= 127 ? transparentIndex : opaqueIndex[pixelIndex] + 1;
      }
    } else {
      index = applyPalette(frame, palette, options.gifPaletteFormat);
    }

    gif.writeFrame(index, width, frameHeight, {
      palette: frameIndex === 0 ? palette : undefined,
      delay: metadata.delay?.[frameIndex] ?? 100,
      repeat: frameIndex === 0 ? (metadata.loop ?? 0) : undefined,
      transparent: usesTransparency,
      transparentIndex: transparentIndex === -1 ? 0 : transparentIndex,
      dispose: 1
    });

    onFrame?.(frameIndex + 1, frameCount, "encoding");
  }

  gif.finish();
  await fs.writeFile(outputPath, Buffer.from(gif.bytes()));
}

async function writeAnimatedWebP(outputData, width, frameHeight, frameCount, outputPath, metadata) {
  let onFrame = null;
  if (typeof metadata.onFrame === "function") {
    onFrame = metadata.onFrame;
  }
  const options = getAnimatedEncodingOptions(metadata);
  const frameStride = width * frameHeight * 4;
  const frames = new Array(frameCount);
  const concurrency = getEncodingConcurrency(frameCount);
  let nextFrameIndex = 0;
  let encodedFrames = 0;

  async function encodeFrame(frameIndex) {
    const frame = outputData.subarray(frameIndex * frameStride, (frameIndex + 1) * frameStride);
    const frameWebP = await sharp(frame, {
      raw: {
        width,
        height: frameHeight,
        channels: 4
      }
    })
      .webp({
        lossless: options.webpLossless,
        nearLossless: options.webpNearLossless,
        quality: options.webpQuality,
        effort: options.webpEffort
      })
      .toBuffer();

    frames[frameIndex] = await WebPMux.Image.generateFrame({
      buffer: frameWebP,
      delay: metadata.delay?.[frameIndex] ?? 100
    });

    encodedFrames += 1;
    onFrame?.(encodedFrames, frameCount, "encoding");
  }

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextFrameIndex < frameCount) {
        const frameIndex = nextFrameIndex;
        nextFrameIndex += 1;
        await encodeFrame(frameIndex);
      }
    })
  );

  await WebPMux.Image.save(outputPath, {
    width,
    height: frameHeight,
    loops: metadata.loop ?? 0,
    frames
  });
}

async function writeAnimatedOutput(outputData, width, frameHeight, frameCount, outputPath, metadata) {
  const extension = path.extname(outputPath).toLowerCase();
  const options = getAnimatedEncodingOptions(metadata);

  if (extension === ".gif") {
    if (options.gifEncoder === "gifski") {
      await writeAnimatedGifWithGifski(
        outputData,
        width,
        frameHeight,
        frameCount,
        outputPath,
        metadata
      );
      return;
    }

    await writeAnimatedGif(outputData, width, frameHeight, frameCount, outputPath, metadata);
    return;
  }

  if (extension === ".webp") {
    await writeAnimatedWebP(outputData, width, frameHeight, frameCount, outputPath, metadata);
    return;
  }

  throw new Error("Animated output currently supports only .webp and .gif.");
}

export async function processImage({
  inputPath,
  outputPath,
  manualTopStrip = null,
  manualRadius = null,
  fastAnimated = true,
  encodingConfig = null,
  onProgress = null
}) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const source = sharp(inputPath, SHARP_SOURCE_OPTIONS);
  const metadata = await source.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not read image dimensions.");
  }

  const frameCount = metadata.pages ?? 1;
  const frameHeight = metadata.pageHeight ?? metadata.height;

  const topStrip =
    manualTopStrip ??
    getAutoValue(AUTO_TOP_STRIP_BASE, AUTO_TOP_STRIP_EXPONENT, metadata.width, frameHeight);
  const radius =
    manualRadius ??
    getAutoValue(AUTO_RADIUS_BASE, AUTO_RADIUS_EXPONENT, metadata.width, frameHeight);

  const imageHeight = Math.max(frameHeight - topStrip, 0);
  const clampedRadius = Math.min(radius, metadata.width, imageHeight);
  const reportProgress =
    typeof onProgress === "function"
      ? (current, total, stage) =>
          onProgress({
            current,
            total,
            stage,
            percent: total > 0 ? Math.round((current / total) * 100) : 0
          })
      : null;

  if (frameCount > 1) {
    const { data: inputData, info } = await source.ensureAlpha().raw().toBuffer({
      resolveWithObject: true
    });
    reportProgress?.(0, frameCount, "preparing");
    const outputData = applyWidgetFixToRawFrames(
      inputData,
      info.width,
      frameHeight,
      frameCount,
      topStrip,
      clampedRadius
    );

    await writeAnimatedOutput(
      outputData,
      info.width,
      frameHeight,
      frameCount,
      outputPath,
      {
        ...metadata,
        fastAnimated,
        encodingConfig,
        onFrame: reportProgress
      }
    );
    reportProgress?.(frameCount, frameCount, "finishing");
  } else {
    let pipeline = sharp(inputPath, SHARP_STILL_SOURCE_OPTIONS)
      .ensureAlpha()
      .extend({
        top: topStrip,
        bottom: 0,
        left: 0,
        right: 0,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .extract({
        left: 0,
        top: 0,
        width: metadata.width,
        height: frameHeight
      });

    if (clampedRadius > 0) {
      pipeline = pipeline.composite([
        {
          input: await buildCornerCutout(clampedRadius),
          top: topStrip,
          left: metadata.width - clampedRadius,
          blend: "dest-out"
        }
      ]);
    }

    await applyOutputFormat(pipeline, outputPath, metadata).toFile(outputPath);
  }

  return {
    outputPath,
    width: metadata.width,
    height: frameHeight,
    topStrip,
    radius: clampedRadius,
    autoCalculated: manualTopStrip == null && manualRadius == null,
    frameCount,
    animated: frameCount > 1,
    warning:
      metadata.width !== REFERENCE_SIZE || metadata.height !== REFERENCE_SIZE
        ? `Widget may look odd if the original image size is not ${REFERENCE_SIZE}x${REFERENCE_SIZE}. Detected ${metadata.width}x${frameHeight}.`
        : null
  };
}
