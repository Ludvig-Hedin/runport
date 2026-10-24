FROM oven/bun:1.3-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 2525 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O - http://127.0.0.1:8080/health || exit 1
CMD ["bun", "src/index.ts"]
