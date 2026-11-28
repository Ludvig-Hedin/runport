FROM oven/bun:1.3-alpine
USER root
RUN apk add --no-cache su-exec
WORKDIR /cutover
COPY merge.ts ./
# Keep the volume reachable for an operator. This image serves no traffic.
CMD ["sleep", "2147483647"]
