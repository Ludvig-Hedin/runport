import { config } from "./config";
import { run, succeeds } from "./exec";
import { readSecret } from "./keychain";

type Repo = { private: boolean; empty: boolean };

/** Creates a private Forgejo repo and pushes the starter commit over HTTPS. */
export async function createRunportRepo(dir: string, name: string): Promise<string> {
  const base = new URL(config.gitUrl);
  if (base.protocol !== "https:" || base.href !== base.origin + "/") {
    throw new Error("PLATFORM_GIT_URL must be an HTTPS origin without credentials or a path.");
  }
  const token = await readSecret("git-api-token", config.gitKeychainService);
  const request = (path: string, options?: { method: string; body: string }) => fetch(new URL(`/api/v1${path}`, base), {
    ...options,
    headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  });

  const profile = await request("/user");
  if (!profile.ok) throw new Error(`Runport Git authentication failed (HTTP ${profile.status}).`);
  const { login } = (await profile.json()) as { login: string };
  if (!/^[a-z0-9_.-]+$/i.test(login)) throw new Error("Runport Git returned an invalid username.");
  const repoPath = `/${encodeURIComponent(login)}/${encodeURIComponent(name)}`;
  const url = new URL(repoPath, base).href;
  const clone = `${url}.git`;

  if (!(await succeeds(["git", "rev-parse", "--resolve-git-dir", ".git"], dir))) {
    await run(["git", "init", "-q", "-b", "main"], dir);
  }
  const origin = await run(["git", "remote", "get-url", "--all", "origin"], dir).catch(() => null);
  if (origin && (origin !== clone || await run(["git", "remote", "get-url", "--push", "--all", "origin"], dir) !== clone)) {
    throw new Error("The local folder already has a different Git origin.");
  }

  const existing = await request(`/repos${repoPath}`);
  if (existing.status === 404) {
    const created = await request("/user/repos", {
      method: "POST",
      body: JSON.stringify({ name, private: true, default_branch: "main" }),
    });
    if (!created.ok) throw new Error(`Runport Git refused to create a private repo (HTTP ${created.status}).`);
    if (!((await created.json()) as Repo).private) throw new Error("Runport Git did not return a private repo.");
  } else if (existing.ok) {
    const repo = (await existing.json()) as Repo;
    if (!repo.private) throw new Error("The repository name is already used by a public repo.");
    if (!origin && !repo.empty) throw new Error("The repository name is already used by another app.");
  } else {
    throw new Error(`Runport Git could not look up the repo (HTTP ${existing.status}).`);
  }

  if (!origin) await run(["git", "remote", "add", "origin", clone], dir);
  await saveCredential(dir, clone, base, login, token);
  if (!(await succeeds(["git", "rev-parse", "--verify", "HEAD"], dir))) {
    await run(["git", "add", "--", "."], dir);
    await run(["git", "commit", "-q", "-m", "Start from platform template"], dir);
  }
  if (!(await succeeds(["git", "rev-parse", "--verify", "@{upstream}"], dir))) {
    await run(["git", "-c", "http.followRedirects=false", "push", "--set-upstream", "origin", "HEAD:refs/heads/main"], dir);
  }
  return url;
}

async function saveCredential(dir: string, clone: string, base: URL, login: string, token: string): Promise<void> {
  const scope = `credential.${clone}`;
  await run(["git", "config", "--local", "--replace-all", `${scope}.helper`, ""], dir);
  await run(["git", "config", "--local", "--add", `${scope}.helper`, "osxkeychain"], dir);
  await run(["git", "config", "--local", `${scope}.useHttpPath`, "true"], dir);
  const secret = `protocol=https\nhost=${base.host}\npath=${new URL(clone).pathname.slice(1)}\nusername=${login}\npassword=${token}\n\n`;
  const store = Bun.spawn(["git", "credential-osxkeychain", "store"], {
    cwd: dir, stdin: new Blob([secret]), stdout: "ignore", stderr: "ignore",
  });
  if ((await store.exited) !== 0) throw new Error("Could not store the Runport Git credential in macOS Keychain.");
}
