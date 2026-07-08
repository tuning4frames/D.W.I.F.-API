# D.W.I.F. API

<p align="center">
  Discord Widget Image Fixer API.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-18%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 18+">
  <img src="https://img.shields.io/badge/output-PNG%20%7C%20WEBP%20%7C%20AVIF%20%7C%20GIF-8A2BE2?style=flat-square" alt="PNG, WEBP, AVIF, and GIF output">
  <img src="https://img.shields.io/badge/embeds-inline-1f8b4c?style=flat-square" alt="Inline embeddable responses">
  <img src="https://img.shields.io/badge/gif-gifski%20optional-f59e0b?style=flat-square" alt="Optional gifski support">
</p>

<p align="center">
  <a href="./docs/API_GUIDE.md">Full API Guide</a>
</p>

<p align="center">
  Small HTTP API for fetching remote images, applying the D.W.I.F transform, and returning processed PNG, WEBP, AVIF, or GIF output.
</p>

<p align="center">
  <img src="./docs/images/image.png" alt="Original input preview" height="256">
  <img src="./docs/images/fixed.png" alt="Processed output preview" height="256">
</p>

## Features

- `GET /api/process?url=...` (also at `/api/process.gif` for Discord/animated GIF embeds)
- `GET /api/health`
- `HEAD /api/process` for link-preview services
- PNG, WEBP, AVIF, and GIF input/output
- optional `topStrip` and `radius` query params
- optional `gifEncoder=gifenc|gifski` for GIF output mode
- optional `download=1` to force file download
- inline/embeddable responses by default
- server-suggested download filenames when `download=1`
- per-IP rate limiting: 5 req/min normal, 1 req/min gifski (configurable)
- lightweight response metadata headers for width, height, strip, radius, and animation state
- high-quality Linux GIF output via `gifski` when requested
- HTTPS-only remote sources by default
- rejects localhost and private-network targets
- redirect validation
- fetch timeout and max download size guards

## Install

Requirements:

- Node.js 18+
- npm

Setup:

```bash
npm install
cp .env.example .env
```

## Run locally

Start the API:

```bash
npm start
```

Default bind:

- `HOST=0.0.0.0`
- `PORT=3000`

## Quick use

Health check:

```bash
curl http://127.0.0.1:3000/api/health
```

Inline/embeddable image response:

```bash
curl -o fixed.png "http://127.0.0.1:3000/api/process?url=https://placehold.co/512x512.png"
```

Discord animated GIF embed (use `/api/process.gif` so Discord recognises it as a GIF):

```bash
curl -o fixed.gif "http://127.0.0.1:3000/api/process.gif?url=https://example.com/animation.gif"
```

Force download with server-suggested filename:

```bash
curl -OJ "http://127.0.0.1:3000/api/process?url=https://placehold.co/512x512.png&download=1"
```

High-quality GIF output:

```bash
curl -OJ "http://127.0.0.1:3000/api/process?url=https%3A%2F%2Fcdn.discordapp.com%2Fattachments%2F1522711715676946462%2F1522712469397835938%2FCustomEmbed.gif%3Fex%3D6a4cc3bf%26is%3D6a4b723f%26hm%3D44c8b7a471781ea9d46f2b153911f4cc8815d2a3b40a1e356d55b802dc85e14f%26&gifEncoder=gifski&download=1"
```

See the full request and response guide in [docs/API_GUIDE.md](./docs/API_GUIDE.md).

## Environment variables

Start from the committed template:

```bash
cp .env.example .env
```

- `HOST` default `0.0.0.0`
- `PORT` default `3000`
- `ROUTE_PREFIX` optional URL path prefix for reverse proxy (e.g. `/dwif` strips `/dwif` from incoming paths before routing)
- `DWIF_FETCH_TIMEOUT_MS` default `10000`
- `DWIF_MAX_DOWNLOAD_BYTES` default `10485760`

Local-test-only overrides:

- `DWIF_ALLOW_PRIVATE_HOSTS=true`
- `DWIF_ALLOW_INSECURE_SOURCE_URLS=true`

Rate limit configuration:

- `RATE_LIMIT_WINDOW_MS` default `60000` (1 minute window)
- `RATE_LIMIT_MAX` default `5` (requests per window)
- `RATE_LIMIT_MAX_GIFSKI` default `1` (gifski requests per window)

Rate-limited responses return `429` with a `Retry-After` header.

## PM2

Start with the included PM2 config:

```bash
npm run pm2:start
pm2 save
```

Or directly:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## Tests

```bash
npm test
```

## Repo layout

- `server.mjs` HTTP server
- `lib/http-api.mjs` request validation, remote fetch, cleanup
- `lib/dwif.mjs` image processing core
- `test/api.test.mjs` API-focused tests
