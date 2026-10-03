import { languageFromFileName } from "@/lib/languages";
import { aiReview, staticReview } from "@/lib/pipeline";
import { prisma } from "@/lib/prisma";
import { createCompletedReview } from "@/lib/reviews";
import { CreateReviewRequest } from "@/lib/schemas";
import { getFileContent, getInstallationToken, githubConfig, GitHubError, githubRequest, listPullFiles } from "./client";
import {
  buildSummary,
  bySeverity,
  checkConclusion,
  formatComment,
  MAX_INLINE_COMMENTS,
  parsePatch,
  splitFindings,
  type FileOutcome,
} from "./review";

const MAX_FILES = 10;
const CONCURRENCY = 2;
const BUDGET_MS = 230_000; // analysis budget inside maxDuration 300 s, leaving room to post results
const AI_DEADLINE_MS = 60_000;
const REVIEWABLE = new Set(["added", "modified", "renamed"]);

export type PullRequestJob = {
  pullRequestReviewId: string;
  installationId: number;
  repo: string; // owner/name
  prNumber: number;
  headSha: string;
  userId: string | null;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const safeError = (e: unknown) =>
  e instanceof GitHubError ? `GitHub API error (HTTP ${e.status}).` : "The review could not be completed.";

/** Runs after the webhook has answered 202: review each changed file, then post one PR review and a check run. */
export async function processPullRequest(job: PullRequestJob): Promise<void> {
  const startedAt = Date.now();
  const cfg = githubConfig();
  let token: string | null = null;
  const checkRun = (conclusion: string, output: { title: string; summary: string }) =>
    githubRequest<{ id: number }>(token!, "POST", `/repos/${job.repo}/check-runs`, {
      name: "CodeGuard AI",
      head_sha: job.headSha,
      status: "completed",
      conclusion,
      output: { title: output.title, summary: output.summary.slice(0, 65_000) },
    });

  try {
    if (!cfg) throw new Error("GitHub App is not configured.");
    token = await getInstallationToken(cfg, job.installationId);

    const files = await listPullFiles(token, job.repo, job.prNumber);
    const candidates = files.filter((f) => REVIEWABLE.has(f.status) && f.patch && languageFromFileName(f.filename));
    const picked = candidates.slice(0, MAX_FILES);
    const notes: string[] = [];
    if (candidates.length > MAX_FILES)
      notes.push(`Reviewed the first ${MAX_FILES} of ${candidates.length} supported changed files; the other ${candidates.length - MAX_FILES} were skipped.`);
    const unsupported = files.length - candidates.length;
    if (unsupported) notes.push(`${unsupported} changed file${unsupported === 1 ? " was" : "s were"} skipped (removed, binary, too large to diff or unsupported language).`);

    const outcomes = await mapLimit(picked, CONCURRENCY, async (file): Promise<FileOutcome> => {
      const skip = (note: string): FileOutcome => ({ path: file.filename, introduced: [], preexisting: 0, scores: null, note });
      const remaining = startedAt + BUDGET_MS - Date.now();
      if (remaining < 20_000) return skip("time budget exceeded");
      try {
        const code = await getFileContent(token!, job.repo, file.filename, job.headSha);
        if (code === null) return skip("binary or over 1 MB");
        const parsed = CreateReviewRequest.safeParse({
          code,
          language: languageFromFileName(file.filename),
          mode: "developer",
          file_name: file.filename.length > 120 ? file.filename.slice(-120) : file.filename,
        });
        if (!parsed.success) return skip(parsed.error.issues[0].message);
        const req = parsed.data;
        const fileStart = Date.now();
        const { analysis } = staticReview(req);
        const result = await aiReview(req, analysis, Math.min(AI_DEADLINE_MS, remaining - 15_000));
        await createCompletedReview({ req, analysis, result, userId: job.userId, pullRequestReviewId: job.pullRequestReviewId, startedAt: fileStart });

        const { introduced, preexisting } = splitFindings(result.findings, parsePatch(file.patch).added);
        return { path: file.filename, introduced, preexisting, scores: result.scores };
      } catch (e) {
        console.error(`[github] ${job.repo}#${job.prNumber} ${file.filename}:`, e instanceof Error ? e.message : e);
        return skip("analysis failed");
      }
    });

    // Most severe first across all files.
    const inline = outcomes
      .flatMap((o) => o.introduced.map((f) => ({ f, path: o.path })))
      .sort((a, b) => bySeverity(a.f, b.f))
      .slice(0, MAX_INLINE_COMMENTS)
      .map(({ f, path }) => formatComment(path, f, parsePatch(files.find((x) => x.filename === path)!.patch)));

    const { title, summary } = buildSummary(outcomes, notes);
    const introduced = outcomes.flatMap((o) => o.introduced);
    let posted = 0;
    if (picked.length) {
      const review = (withComments: boolean, body: string) =>
        githubRequest(token!, "POST", `/repos/${job.repo}/pulls/${job.prNumber}/reviews`, {
          commit_id: job.headSha,
          event: "COMMENT",
          body: body.slice(0, 65_000),
          comments: withComments ? inline : [],
        });
      try {
        await review(true, summary);
        posted = inline.length;
      } catch (e) {
        // 422 = a comment GitHub couldn't anchor; post the summary alone rather than nothing.
        if (!(e instanceof GitHubError && e.status === 422) || !inline.length) throw e;
        await review(false, summary + "\n\n_Inline comments could not be placed on this diff._");
      }
    }

    const run = await checkRun(checkConclusion(introduced), { title, summary });
    await prisma.pullRequestReview.update({
      where: { id: job.pullRequestReviewId },
      data: { status: "completed", commentsPosted: posted, checkRunId: BigInt(run.id), error: null },
    });
  } catch (e) {
    console.error(`[github] ${job.repo}#${job.prNumber} failed:`, e);
    const error = safeError(e);
    let checkRunId: bigint | null = null;
    if (token) {
      try {
        // Neutral, not failure: our outage must not block merges in repos that require this check.
        checkRunId = BigInt((await checkRun("neutral", { title: "CodeGuard AI couldn't review this pull request", summary: error })).id);
      } catch (e2) {
        console.error("[github] could not post the failed check run:", e2 instanceof Error ? e2.message : e2);
      }
    }
    await prisma.pullRequestReview
      .update({ where: { id: job.pullRequestReviewId }, data: { status: "failed", error, checkRunId } })
      .catch((e3) => console.error("[github] could not mark the PR review failed:", e3));
  }
}
