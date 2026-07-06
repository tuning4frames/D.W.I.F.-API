# D.W.I.F. API Guide

<p align="center">
  Detailed request, response, and deployment guide for the D.W.I.F. HTTP API.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/endpoint-/api/process-2563eb?style=flat-square" alt="/api/process endpoint">
  <img src="https://img.shields.io/badge/health-/api/health-16a34a?style=flat-square" alt="/api/health endpoint">
  <img src="https://img.shields.io/badge/download-optional-f59e0b?style=flat-square" alt="Optional download mode">
  <img src="https://img.shields.io/badge/gif-gifski%20supported-f97316?style=flat-square" alt="gifski supported">
</p>

<p align="center">
  <a href="../README.md">Main README</a>
</p>

<p align="center">
  Use this guide for the full endpoint contract, curl examples, response behavior, and operational notes.
</p>

## Endpoints

### `GET /api/health`

Simple health check.

Example:

```bash
curl http://127.0.0.1:3000/api/health
```

Response:

```text
ok
```

### `GET /api/process`

Fetches a remote image, applies the D.W.I.F transform, and returns the processed image bytes.

Required query param:

- `url=<absolute-https-url>`

Optional query params:

- `topStrip=<non-negative integer>`
- `radius=<non-negative integer>`
- `gifEncoder=gifenc|gifski`
- `download=1`

## Common examples

Inline/embeddable PNG response:

```bash
curl -o fixed.png "http://127.0.0.1:3000/api/process?url=https://placehold.co/512x512.png"
```

Force download with server-suggested filename:

```bash
curl -OJ "http://127.0.0.1:3000/api/process?url=https://placehold.co/512x512.png&download=1"
```

Manual strip/radius override:

```bash
curl -o fixed.png "http://127.0.0.1:3000/api/process?url=https://placehold.co/512x512.png&topStrip=17&radius=36"
```

High-quality GIF encoding with `gifski`:

```bash
curl -OJ "http://127.0.0.1:3000/api/process?url=https://cdn.discordapp.com/attachments/1522711715676946462/1522712469397835938/CustomEmbed.gif?ex=6a4cc3bf&is=6a4b723f&hm=44c8b7a471781ea9d46f2b153911f4cc8815d2a3b40a1e356d55b802dc85e14f&gifEncoder=gifski&download=1"
```

URL-encoded version:

```bash
curl -OJ "http://127.0.0.1:3000/api/process?url=https%3A%2F%2Fcdn.discordapp.com%2Fattachments%2F1522711715676946462%2F1522712469397835938%2FCustomEmbed.gif%3Fex%3D6a4cc3bf%26is%3D6a4b723f%26hm%3D44c8b7a471781ea9d46f2b153911f4cc8815d2a3b40a1e356d55b802dc85e14f%26&gifEncoder=gifski&download=1"
```

Discord-friendly inline URL:

```text
https://your-domain.com/api/process?url=https%3A%2F%2Fcdn.discordapp.com%2Fattachments%2F1522711715676946462%2F1522712469397835938%2FCustomEmbed.gif%3Fex%3D6a4cc3bf%26is%3D6a4b723f%26hm%3D44c8b7a471781ea9d46f2b153911f4cc8815d2a3b40a1e356d55b802dc85e14f%26&gifEncoder=gifski
```

## Response behavior

On success:

- returns image bytes directly
- `Content-Type` matches the output image type
- default mode is inline/embeddable
- `download=1` adds `Content-Disposition: attachment`
- includes metadata headers:
  - `X-DWIF-Width`
  - `X-DWIF-Height`
  - `X-DWIF-Top-Strip`
  - `X-DWIF-Radius`
  - `X-DWIF-Animated`

Typical success headers:

```text
Content-Type: image/gif
X-DWIF-Width: 800
X-DWIF-Height: 738
X-DWIF-Top-Strip: 29
X-DWIF-Radius: 73
X-DWIF-Animated: true
```

Download-mode header:

```text
Content-Disposition: attachment; filename="CustomEmbed-dwif.gif"
```

## Errors

Errors return plain text.

Typical status codes:

- `400` invalid query or blocked source URL
- `413` remote image too large
- `415` unsupported media type
- `502` upstream fetch failure
- `504` upstream timeout
- `500` local processing failure

Example invalid request:

```bash
curl "http://127.0.0.1:3000/api/process"
```

Response:

```text
Missing required query parameter: url
```

## Security and limits

- only public `https://` source URLs are allowed by default
- localhost and private-network hosts are blocked
- redirects are revalidated
- fetch timeout is controlled by `DWIF_FETCH_TIMEOUT_MS`
- max remote download size is controlled by `DWIF_MAX_DOWNLOAD_BYTES`

Current defaults:

- `DWIF_FETCH_TIMEOUT_MS=10000`
- `DWIF_MAX_DOWNLOAD_BYTES=10485760`

## GIF quality

- default GIF path is faster and lighter-weight
- `gifEncoder=gifski` enables the high-quality GIF path
- `gifski` must be installed and available on the machine
- optional override: `DWIF_GIFSKI_PATH=/full/path/to/gifski`
