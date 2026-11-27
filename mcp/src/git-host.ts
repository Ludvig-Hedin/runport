import { z } from "zod";

export const parseGitHost = z.enum(["runport", "github"]).optional();
export type GitHost = NonNullable<z.infer<typeof parseGitHost>>;

export function selectGitHost(requested?: GitHost, existing?: GitHost): GitHost {
  if (requested && existing && requested !== existing) {
    throw new Error(`This app already uses ${existing} for Git hosting. Retry with that host or omit git.`);
  }
  return existing ?? requested ?? "runport";
}
