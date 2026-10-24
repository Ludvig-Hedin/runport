# Nightly backup and the outage watcher. pg_dump comes from the same image
# as the database, so the versions always match.
FROM appwrite/postgres:0.1.0
COPY --from=oven/bun:1.3-debian /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /ops
COPY *.ts ./
ENTRYPOINT []
CMD ["bun", "monitor.ts"]
