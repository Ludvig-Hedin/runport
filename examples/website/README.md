# Website test fixture

This overlays the real Next.js starter with a public home page and an About
page. The starter supplies the password lock, robots rules and member routes.
It creates no Appwrite project, GitHub repository or hosting service.

From the Runport repository, run `bun scripts/prepare-website-test.ts` once.
Install the starter's pinned packages in `.scratch/website-test`, then run
`agent-heavy-run dev bun run dev -- --port 3112` from that folder using Node 22.
Set `SITE_PASSWORD` in its gitignored `.env.local` to test the lock. Leave it
unset for a public website. Account routes need a separate Appwrite test
project and its server key; public pages and the lock do not.

After stopping your test server, remove this copy's real `node_modules` and
`.next` folders. The source fixture remains here for the next check.
