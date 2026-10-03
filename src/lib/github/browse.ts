import type { User } from "@supabase/supabase-js";
import { languageFromFileName } from "../languages.ts";
import { LIMITS } from "../schemas.ts";
import { createAppJwt, GitHubError, githubRequest, type GitHubConfig } from "./client.ts";

// "Import from GitHub": a signed-in user picks a file from a repo the CodeGuard GitHub App can read.
// Access rule: the installation must be on the user's own GitHub account, matched by the numeric GitHub user id
// from their Supabase GitHub identity (verified by Supabase during OAuth; logins can be renamed, ids can't).
// The installation token stays on the server; the app can only read repos the user granted it.
// ponytail: personal-account installations only; org installations need an org-membership check first.

export type GitHubIdentity = { id: number; login: string };
export type RepoSummary = { full_name: string; default_branch: string; private: boolean };
export type RepoFile = { path: string; size: number };

export const MAX_TREE_FILES = 2000;

// Repo, branch and path are interpolated into GitHub API paths: a "." or ".." segment would let the
// installation token reach a different endpoint, so only plain segments are accepted.
export const plainSegments = (s: string) => s.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");

export function githubIdentity(user: Pick<User, "identities">): GitHubIdentity | null {
  const identity = user.identities?.find((i) => i.provider === "github");
  const data = identity?.identity_data ?? {};
  const id = Number(data.provider_id ?? data.sub ?? identity?.id);
  const login = data.user_name ?? data.preferred_username;
  return Number.isSafeInteger(id) && id > 0 && typeof login === "string" ? { id, login } : null;
}

/** The app's installation on this user's own account, or null when they haven't installed it. */
export async function userInstallationId(cfg: GitHubConfig, who: GitHubIdentity): Promise<number | null> {
  try {
    const inst = await githubRequest<{ id: number; account: { id: number } | null }>(
      createAppJwt(cfg.appId, cfg.privateKey),
      "GET",
      `/users/${encodeURIComponent(who.login)}/installation`,
    );
    return inst.account?.id === who.id ? inst.id : null; // a renamed login now owned by someone else
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

export async function installUrl(cfg: GitHubConfig): Promise<string> {
  const app = await githubRequest<{ slug: string }>(createAppJwt(cfg.appId, cfg.privateKey), "GET", "/app");
  return `https://github.com/apps/${app.slug}/installations/new`;
}

export async function listRepos(token: string): Promise<RepoSummary[]> {
  const { repositories } = await githubRequest<{ repositories: RepoSummary[] }>(token, "GET", "/installation/repositories?per_page=100");
  return repositories
    .map(({ full_name, default_branch, private: isPrivate }) => ({ full_name, default_branch, private: isPrivate }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

type TreeEntry = { path: string; type: string; size?: number };

/** Reviewable files only: a supported language and within the review size limit. */
export function reviewableFiles(tree: TreeEntry[]): RepoFile[] {
  return tree
    .filter((e) => e.type === "blob" && languageFromFileName(e.path) && (e.size ?? 0) <= LIMITS.maxBytes)
    .map((e) => ({ path: e.path, size: e.size ?? 0 }))
    .slice(0, MAX_TREE_FILES);
}

export async function listFiles(token: string, repo: string, ref: string): Promise<{ files: RepoFile[]; truncated: boolean }> {
  const tree = await githubRequest<{ tree: TreeEntry[]; truncated: boolean }>(
    token,
    "GET",
    `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  const files = reviewableFiles(tree.tree);
  return { files, truncated: tree.truncated || files.length === MAX_TREE_FILES };
}
