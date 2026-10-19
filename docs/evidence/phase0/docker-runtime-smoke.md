# Phase 0 Docker runtime smoke

## Commands

```sh
corepack pnpm run docker-build
corepack pnpm run docker-test
LP_TOKEN=<redacted> LP_SMOKE_PORT=4318 corepack pnpm run docker-smoke
docker image inspect lightphysics:runtime --format '{{json .Config.Env}}|{{json .Config.Healthcheck.Test}}|{{json .Config.Cmd}}'
docker ps -a --format '{{.Names}}\t{{.Status}}'
```

## Recorded result

```text
docker-build: PASS
docker-test: PASS (network=none)
docker-smoke: authenticated system.info passed
image inspection: no LP_TOKEN in image environment; healthcheck and pnpm run lpd command present
container cleanup: no smoke containers remained
```

The smoke used loopback publication only. The default now asks Docker to choose a free host port; an explicit `LP_SMOKE_PORT=4318` can be used when a stable port is needed. The token was supplied only at runtime and is redacted here. This is a Phase 0 service smoke, not a production release or engine qualification.
