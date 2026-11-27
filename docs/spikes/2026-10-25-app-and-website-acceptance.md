# App and website acceptance, 2026-10-25

Browser checks completed against the existing online Todo app and a local
website made from the current Runport starter. No app or infrastructure code
was deployed. No confirmed product failure was found in these journeys.

## Online app: https://todo.runport.app

Two new test accounts used separate browser profiles (default and incognito),
with two distinct email aliases delivered to the owner's test inbox.

- Both signed up through the default email-code flow. Real codes arrived from
  `todo@runport.app`, and both accounts reached Items.
- A deliberately wrong code was rejected, then the real code worked.
- Both created private items. Neither account saw the other's items.
- Marking an item done survived a full reload and signing out and back in.
- Both accounts signed out and back in using newly delivered email codes.
  Their own saved items remained.
- Opening `/items` after signing out returned to `/login`.
- Signing out account A left account B signed in and able to use its list.
- Both accounts added another item concurrently. Both writes appeared.
- Five page requests per account ran together (ten overlapping requests).
  All returned HTTP 200 and only the correct account's item markers.
- A replay of A's delete form from B was rejected with HTTP 400 and A's item
  remained. This does not establish which validation layer rejected it, so it
  is not claimed as direct database authorization proof.
- All four test items were deleted through their owners' UI. Reloading each
  list showed zero items. Both accounts were signed out and test tabs closed.
  The two test accounts remain available for future checks.

This establishes two simultaneous users, not large-scale capacity. Password
signup, password reset, Google/GitHub, uploads, realtime updates and session
expiry were outside this run. The deployed app was exercised as it exists;
this does not establish that it matches every file in today's starter.

## Local website: http://localhost:3112

Prepared with `bun scripts/prepare-website-test.ts`, which copies the current
starter and overlays `examples/website`. Used Node 22 and a registered
`agent-heavy-run dev` server. Reused the existing Todo installation's exact
compatible packages by making a disposable local copy. No dependency updates,
backend project, GitHub repository or hosting service were created.

- Public home and About pages loaded, and both navigation links worked.
- At a 390px mobile viewport, page width and scroll width were both 390px.
- Default robots.txt, robots meta and HTTP header all blocked indexing.
- With a site password, direct visits to About went to the unlock screen.
- Wrong passwords were rejected. Correct passwords returned visitors to the
  requested page, including its query string. Unlock survived reloading.
- A second browser profile stayed locked until it supplied the password.
- Locked POSTs to `/`, `/about`, `/login`, `/unlock` and `/robots.txt`
  returned HTTP 403.
- Changing the password invalidated both visitors' old unlock cookies.
- In an open production-like local configuration, `ALLOW_INDEXING=1` gave
  `Allow: /` with no noindex header or meta. Setting the environment to preview
  restored all three noindex signals despite that opt-in.

This is a website page/lock check. Account journeys were tested in the app,
not connected to a new website backend. Public hosting, DNS and TLS for a new
website were not tested or changed.

## Code-check limit

Browser compilation and the journeys above passed. Separate typecheck and
production build could not run through the installed guard:

- `agent-heavy-run focused-typecheck bun run typecheck` exited 64:
  `Blocked: use exactly npm --prefix mobile-native run typecheck.`
- `agent-heavy-run client-build bun run build` exited 64:
  `Blocked: client-build requires a real Git repository root`

The fixture is a disposable directory, and the client-build lane is scoped to
bound client repositories. These checks are blocked, not passed. No guard was
changed or bypassed. No remote CI ran.

## Saved evidence and cleanup

Screenshots taken before deleting the test items are in this machine's T3
browser artifacts:

- User A: `browser-screenshot-todo-runport-app-mvnsdre0-acf1160e.png`
- User B: `browser-screenshot-todo-runport-app-mvnsdrjt-44cf70ba.png`
- Local website: `browser-screenshot-localhost-mvnsetzv-8784881d.png`

These are observation artifacts, not deployed changes. The local server and
browser tabs were stopped. The disposable website copy, packages and build
output were removed; the fixture source remains in Git.

Browser acceptance is complete. A guarded production build/typecheck remains
unverified; the next code-check step needs a supported Runport check lane in
the machine guard, owned by the machine tooling maintainer. Deployment of a
new website remains a separate owner decision.
