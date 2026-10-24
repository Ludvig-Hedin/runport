# Spike: set up a project from code (Appwrite 2.6.1)

Date: 2026-10-24. Result: **passes** with option 1 (owner console session).
The CLI and organization-key fallbacks were not needed.

`bun run spike` output:

```
PASS create project via POST /projects
PASS create server key via POST /projects/{id}/keys
PASS add web platform localhost via POST /projects/{id}/platforms
PASS delete project via DELETE /projects/{id}
```

## What 2.6.1 requires

- Owner session: `POST /v1/account/sessions/email` with
  `X-Appwrite-Project: console`, then send the session cookie.
- Do **not** send `X-Appwrite-Mode: admin` with the console project. 2.6.1
  answers `Admin mode is not allowed for console project (400)`. Admin mode is
  only for project-scoped routes (`X-Appwrite-Project: <projectId>`).
- `POST /projects` takes `projectId`, `name`, `teamId` (the owner's
  organization from `GET /teams`) and `region: "default"`.
- `POST /projects/{id}/keys` requires `keyId` (`"unique()"` works).
- `POST /projects/{id}/platforms` requires `platformId` and `type: "web"`.
  Platform ids are unique across **all** projects, not per project, despite
  the error text. A fixed id such as `localhost` makes the second project fail
  with 409. Use `"unique()"` and check `GET /projects/{id}/platforms` for the
  hostname first, so reruns do not add duplicates.
- Project-scoped equivalents also work: `POST /project/keys` and
  `POST /project/platforms/web` with `X-Appwrite-Project: <projectId>` and
  `X-Appwrite-Mode: admin`.

Checked with two projects in a row: each ends with exactly one `localhost`
platform after adding it twice.
