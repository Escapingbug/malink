# Manually published Gateway updates

The public Malink site stores only immutable signed Gateway manifests and
artifacts. It does not select a latest release, poll Gateways, or hold the
release signing private key. A manually deployed PWA build names the exact
Gateway release that it should trigger once after connecting.

## One-time server route

Install the immutable route in the existing Caddy site:

```sh
chmod +x deploy/gateway-update/install-caddy-route.sh
sudo deploy/gateway-update/install-caddy-route.sh
```

This maps `https://rd.anciety.my.id/gateway-updates/...` to
`/srv/malink-gateway-updates/...`.

## Manual publication order

1. Build and acceptance-test a self-contained Gateway release as described in
   `docs/gateway-online-updates.md`.
2. Sign it with `pnpm release:gateway-update`, using
   `https://rd.anciety.my.id/gateway-updates/` as `--base-url`.
3. Upload the generated `artifacts/` and `manifests/` trees without replacing
   an existing path. Verify the public manifest and every referenced file.
4. Build the PWA with the exact release and build IDs:

   ```sh
   MALINK_BUILD_VERSION=2026.08.26.2 \
   MALINK_GATEWAY_RELEASE_ID=2026.08.26.2 \
   MALINK_GATEWAY_BUILD_ID=gateway-2026.08.26.2-arm64 \
   pnpm --dir apps/pwa build
   ```

5. Deploy that PWA manually only after the Gateway files are publicly
   reachable. The new PWA does not poll an update channel. On connection it
   compares its paired build ID with each signed Gateway Directory entry and
   sends one authenticated `stage` followed by a drain-and-switch apply
   (`when_idle` on the wire) to every old, update-capable node. Each node stops
   starting new tasks, finishes only its current tasks, switches, and then
   resumes the durably queued tasks.

If the automatic attempt fails, the PWA records the attempt instead of looping.
Use Advanced diagnostics to retry the same immutable release manually after
correcting the release or network problem.
