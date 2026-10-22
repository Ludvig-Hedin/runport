import { run, succeeds } from "./exec";

// Uses the GitHub CLI's existing login (`gh auth login`), so no token is stored
// by the platform itself.

export async function githubUser(): Promise<string> {
  return run(["gh", "api", "user", "--jq", ".login"]);
}

export async function repoExists(fullName: string): Promise<boolean> {
  return succeeds(["gh", "repo", "view", fullName, "--json", "name"]);
}

/** Commits everything in `dir` and pushes it to a new private repo. */
export async function createPrivateRepo(dir: string, name: string): Promise<string> {
  const owner = await githubUser();
  const fullName = `${owner}/${name}`;
  if (!(await succeeds(["git", "rev-parse", "--git-dir"], dir))) {
    await run(["git", "init", "-q", "-b", "main"], dir);
  }
  await run(["git", "add", "-A"], dir);
  if (!(await succeeds(["git", "rev-parse", "HEAD"], dir))) {
    await run(["git", "commit", "-q", "-m", "Start from platform template"], dir);
  }
  if (!(await repoExists(fullName))) {
    await run(["gh", "repo", "create", fullName, "--private", "--source", ".", "--remote", "origin", "--push"], dir);
  }
  return `https://github.com/${fullName}`;
}
