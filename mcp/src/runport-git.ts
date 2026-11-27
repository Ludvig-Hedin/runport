import { config } from "./config";
import { run, succeeds } from "./exec";
import { readSecret } from "./keychain";

const productionOrigin = "https://git.runport.app";
const mainRef = "refs/heads/main";
type Repo = { private: boolean; empty: boolean };
type RepoToken = { id: number; sha1?: string; token_last_eight?: string; scopes: string[]; repositories?: { full_name: string }[] };

export function provisioningCredentials(url: string, service?: string) {
  const base = new URL(url);
  if (base.protocol !== "https:" || base.href !== base.origin + "/") {
    throw new Error("PLATFORM_GIT_URL must be an HTTPS origin without credentials or a path.");
  }
  const custom = base.origin !== productionOrigin;
  if (custom && !service) throw new Error("A custom PLATFORM_GIT_URL requires PLATFORM_GIT_KEYCHAIN_SERVICE.");
  const suffix = custom ? `@${base.origin}` : "";
  return {
    base,
    service: service ?? "runport-prod",
    tokenAccount: `git-provision-token${suffix}`,
    passwordAccount: `git-provision-password${suffix}`,
  };
}

export function needsStarterPush(empty: boolean, upstream: string, remoteMainExists: boolean): boolean {
  return empty || upstream !== "refs/remotes/origin/main" || !remoteMainExists;
}

function api(base: URL, auth: string, path: string, options?: { method: string; body?: string }) {
  return fetch(new URL(`/api/v1${path}`, base), {
    ...options,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  });
}

function scopedTo(token: RepoToken, fullName: string): boolean {
  return token.scopes?.length === 1 && token.scopes[0] === "write:repository" &&
    token.repositories?.length === 1 && token.repositories[0]?.full_name === fullName;
}

async function findSavedToken(base: URL, auth: string, path: string, secret: string, fullName: string): Promise<boolean> {
  // The API returns only a suffix for stored tokens. Verify authorization
  // separately after matching the scope and repository.
  for (let page = 1; ; page++) {
    const response = await api(base, auth, `${path}?limit=50&page=${page}`);
    if (!response.ok) throw new Error(`Runport Git could not verify repository token scope (HTTP ${response.status}).`);
    const tokens = await response.json() as RepoToken[];
    const matches = tokens.filter((token) => token.token_last_eight === secret.slice(-8));
    if (matches.length) return matches.length === 1 && scopedTo(matches[0]!, fullName);
    if (!response.headers.get("link")?.includes('rel="next"')) return false;
  }
}

/** Creates a private Forgejo repo and pushes the starter commit over HTTPS. */
export async function createRunportRepo(dir: string, name: string): Promise<string> {
  const { base, service, tokenAccount, passwordAccount } = provisioningCredentials(config.gitUrl, config.gitKeychainService);
  const provisionToken = await readSecret(tokenAccount, service);
  const auth = `token ${provisionToken}`;
  const profile = await api(base, auth, "/user");
  if (!profile.ok) throw new Error(`Runport Git authentication failed (HTTP ${profile.status}).`);
  const { login, is_admin } = (await profile.json()) as { login: string; is_admin: boolean };
  if (!/^[a-z0-9_.-]+$/i.test(login) || is_admin !== false) {
    throw new Error("Runport Git requires a dedicated non-admin provisioning account.");
  }
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

  const repoApi = `/repos${repoPath}`;
  const existing = await api(base, auth, repoApi);
  let repo: Repo;
  if (existing.status === 404) {
    const created = await api(base, auth, "/user/repos", {
      method: "POST",
      body: JSON.stringify({ name, private: true, default_branch: "main" }),
    });
    if (!created.ok) throw new Error(`Runport Git refused to create a private repo (HTTP ${created.status}).`);
    repo = (await created.json()) as Repo;
  } else if (existing.ok) {
    repo = (await existing.json()) as Repo;
    if (!origin && !repo.empty) throw new Error("The repository name is already used by another app.");
  } else {
    throw new Error(`Runport Git could not look up the repo (HTTP ${existing.status}).`);
  }
  if (!repo.private) throw new Error("Runport Git did not return a private repo.");

  if (!origin) await run(["git", "remote", "add", "origin", clone], dir);
  const scope = `credential.${clone}`;
  await run(["git", "config", "--local", "--replace-all", `${scope}.helper`, ""], dir);
  await run(["git", "config", "--local", "--add", `${scope}.helper`, "osxkeychain"], dir);
  await run(["git", "config", "--local", `${scope}.useHttpPath`, "true"], dir);
  await run(["git", "config", "--local", `${scope}.username`, login], dir);
  await run(["git", "config", "--local", `http.${clone}.followRedirects`, "false"], dir);

  const credential = `protocol=https\nhost=${base.host}\npath=${new URL(clone).pathname.slice(1)}\nusername=${login}\n`;
  const saved = (await keychain("get", dir, credential)).match(/^password=(.+)$/m)?.[1];
  const password = await readSecret(passwordAccount, service);
  const basic = `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
  const tokens = `/users/${encodeURIComponent(login)}/tokens`;
  const fullName = `${login}/${name}`;
  let reuse = false;
  if (saved && saved !== provisionToken && await findSavedToken(base, basic, tokens, saved, fullName)) {
    const check = await api(base, `token ${saved}`, repoApi);
    if (!check.ok && ![401, 403, 404].includes(check.status)) {
      throw new Error(`Runport Git could not verify the saved credential (HTTP ${check.status}).`);
    }
    reuse = check.ok;
  }
  if (!reuse) {
    const created = await api(base, basic, tokens, {
      method: "POST",
      body: JSON.stringify({
        name: `runport-${name}-${crypto.randomUUID()}`,
        scopes: ["write:repository"],
        repositories: [{ owner: login, name }],
      }),
    });
    if (!created.ok) throw new Error(`Runport Git refused to create the repository credential (HTTP ${created.status}).`);
    const token = await created.json() as RepoToken;
    const { id, sha1 } = token;
    try {
      if (!sha1 || !/^[a-f0-9]{40}$/.test(sha1) || sha1 === provisionToken || !scopedTo(token, fullName)) {
        throw new Error("Forgejo returned an invalid or unscoped repository token.");
      }
      await keychain("store", dir, `${credential}password=${sha1}\n`);
    } catch (error) {
      if (Number.isSafeInteger(id)) await api(base, basic, `${tokens}/${id}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
  }

  if (!(await succeeds(["git", "rev-parse", "--verify", "HEAD"], dir))) {
    await run(["git", "add", "--", "."], dir);
    await run(["git", "commit", "-q", "-m", "Start from platform template"], dir);
  }
  const upstream = await run(["git", "for-each-ref", "--format=%(upstream)", mainRef], dir);
  const git = ["git", "-c", "credential.interactive=false", "-c", "http.followRedirects=false"];
  const remoteMain = !repo.empty && !!(await run([...git, "ls-remote", "--heads", "origin", mainRef], dir));
  if (needsStarterPush(repo.empty, upstream, remoteMain)) {
    await run([...git, "push", "--set-upstream", "origin", `${mainRef}:${mainRef}`], dir);
  }
  return url;
}

async function keychain(action: "get" | "store", dir: string, input: string): Promise<string> {
  const proc = Bun.spawn(["git", "credential-osxkeychain", action], {
    cwd: dir, stdin: new Blob([input + "\n"]), stdout: "pipe", stderr: "ignore",
  });
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`Could not ${action} the Runport Git credential in macOS Keychain.`);
  return output;
}
