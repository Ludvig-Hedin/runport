FROM oven/bun:1.3.10-alpine AS bun
FROM ghcr.io/umami-software/umami:3.5.0
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY gateway.ts server.ts /runport/
CMD ["bun", "/runport/server.ts"]
