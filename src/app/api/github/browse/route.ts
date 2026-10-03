import { NextResponse } from "next/server";
import { z } from "zod";
import { getFileContent, getInstallationToken, githubConfig, GitHubError } from "@/lib/github/client";
import { githubIdentity, installUrl, listFiles, listRepos, plainSegments, userInstallationId } from "@/lib/github/browse";
import { apiError } from "@/lib/http";
import { languageFromFileName } from "@/lib/languages";
import { LIMITS } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

const Query = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Invalid repository name.").refine(plainSegments, "Invalid repository name.").optional(),
  ref: z.string().min(1).max(250).regex(/^[^\s~^:?*[\\]+$/, "Invalid branch name.").refine(plainSegments, "Invalid branch name.").optional(),
  path: z.string().min(1).max(1000).refine(plainSegments, "Invalid file path.").optional(),
});

/**
 * Import from GitHub, for the signed-in user's own app installation:
 *   (no params)          -> { repos }
 *   ?repo&ref            -> { files, truncated } (reviewable files only)
 *   ?repo&ref&path       -> { code, language, path }
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser(); // verified with the auth server: identities come from here
  if (!user) return apiError(401, "unauthorized", "Sign in to import files from GitHub.");
  const cfg = githubConfig();
  if (!cfg) return apiError(503, "not_configured", "The GitHub integration is not configured.");
  const who = githubIdentity(user);
  if (!who) return apiError(409, "github_not_linked", "Sign in with GitHub to import files from your repositories.");

  const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return apiError(400, "validation_failed", q.error.issues[0].message);
  const { repo, ref, path } = q.data;
  if (repo && !ref) return apiError(400, "validation_failed", "A branch (ref) is required.");

  try {
    const installationId = await userInstallationId(cfg, who);
    if (!installationId)
      return apiError(404, "app_not_installed", "Install the CodeGuard AI GitHub App on your account, then choose the repositories it may read.", {
        install_url: await installUrl(cfg),
      });
    const token = await getInstallationToken(cfg, installationId);
    if (!repo || !ref) return NextResponse.json({ repos: await listRepos(token) });
    if (!path) return NextResponse.json(await listFiles(token, repo, ref));

    const language = languageFromFileName(path);
    if (!language) return apiError(422, "unsupported_file", "That file type isn't supported. Pick a .py, .js, .ts or .java file.");
    const code = await getFileContent(token, repo, path, ref);
    if (code === null) return apiError(422, "unsupported_file", "That file is binary or too large for GitHub to send.");
    if (new TextEncoder().encode(code).length > LIMITS.maxBytes || code.split("\n").length > LIMITS.maxLines)
      return apiError(413, "too_large", `That file is over the review limit of ${LIMITS.maxLines.toLocaleString()} lines or ${LIMITS.maxBytes / 1000} KB.`);
    return NextResponse.json({ code, language, path });
  } catch (e) {
    // The installation token only reaches repos the user granted the app, so other repos are a 404 too.
    if (e instanceof GitHubError && e.status === 404)
      return apiError(404, "not_found", "That repository or file isn't available to the CodeGuard AI app.");
    console.error("[github browse]", e instanceof Error ? e.message : e);
    return apiError(502, "github_unavailable", "GitHub didn't respond. Try again in a moment.");
  }
}
