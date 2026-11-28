FROM golang:1.26-alpine AS build
WORKDIR /src
COPY backup-server.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /git-backup backup-server.go

FROM codeberg.org/forgejo/forgejo:15.0.12
COPY --from=build /git-backup /usr/local/bin/git-backup
COPY --chmod=755 start /usr/local/bin/runport-git
# The image entrypoint prepares /data. Run only Forgejo and the backup listener.
CMD ["/usr/local/bin/runport-git"]
