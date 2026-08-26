# Legacy Gateway artifact route

This route is retained only for supervisors installed before the Agent Prompt
channel. New deployments use `deploy/gateway-agent-update`: the public site
publishes a small signed Prompt and each Gateway builds locally through its
maintenance Agent.

To keep an older installation working:

```sh
chmod +x deploy/gateway-update/install-caddy-route.sh
sudo deploy/gateway-update/install-caddy-route.sh
```

This maps `https://rd.anciety.my.id/gateway-updates/...` to
`/srv/malink-gateway-updates/...`. Legacy releases are produced with
`pnpm release:gateway-update`; their manifest and artifact paths remain
immutable. Do not use this full-artifact flow for new releases on low-bandwidth
Gateways.
