# Static PWA deployment

Build `apps/pwa` and publish the contents of `apps/pwa/dist/` as ordinary static
files. No Node, Vinext, Cloudflare Worker, database, or application API runs in
production.

The directory can be uploaded to Caddy/Nginx object storage, GitHub Pages, or a
CDN. For a non-root location, build with `MALINK_PWA_BASE_PATH=/path/`. The
origin and optional base path must be entered exactly in the Android static
service setting.

For Caddy, place the build at a stable path such as
`/srv/malink-pwa/current/` and include [`Caddyfile.static.fragment`](Caddyfile.static.fragment)
inside the HTTPS site block. Keep the more specific `/gateway-updates/*` and
`/native-updates/*` handlers ahead of the SPA fallback.

The Matrix Rust Crypto WASM asset is several megabytes. Caddy should compress
it so a cold mobile connection can initialize end-to-end encryption before a
pairing invitation expires.

Apply the site-level performance directives idempotently:

```sh
chmod +x install-caddy-performance.sh
sudo ./install-caddy-performance.sh
```

The existing installer enables Zstandard and gzip response encoding and
prevents the versioned Service Worker registration from being hidden by an
HTTP cache.
Immutable Gateway and native-update artifacts are excluded from transfer
compression so update clients can compare `Content-Length` with the signed
artifact size before streaming and hashing the response.

GitHub Pages deployment only needs the generated `dist/` directory. The build
includes `.nojekyll` and `404.html`; repository Pages normally uses a base path:

```bash
MALINK_PWA_BASE_PATH=/repository-name/ pnpm --dir apps/pwa build
```

Validate the deployed WASM response with a compression-capable client:

```sh
curl --compressed --head \
  https://rd.anciety.my.id/assets/matrix_sdk_crypto_wasm_bg-DDJzNWwu.wasm
```
