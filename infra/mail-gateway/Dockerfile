FROM oven/bun:1.3-alpine
WORKDIR /app
RUN apk add --no-cache su-exec
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY entrypoint.sh /app/entrypoint.sh
USER root
EXPOSE 2525 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O - http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
CMD ["bun", "src/index.ts"]
