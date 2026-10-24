# Appwrite admin with our colours. Rebuilt on top of the pinned console image;
# see ../README.md. Bump the tag together with the base image.
ARG BASE=appwrite/new:1.2.97-self-hosted
FROM ${BASE}
COPY patch.ts theme.css /theme/
RUN bun /theme/patch.ts /app/dist
