import { after, NextResponse } from "next/server";
import { z } from "zod";
import { githubConfig, verifySignature } from "@/lib/github/client";
import { processPullRequest } from "@/lib/github/process";
import { apiError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

// PR reviews run in after() once GitHub has its 202 (it waits 10 s at most). Up to 10 files with AI review
// fit in 300 s, the Hobby maximum with Fluid Compute; processPullRequest keeps its own budget below that.
export const maxDuration = 300;

const MAX_BODY_BYTES = 2_000_000;
const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

const InstallationEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive(), account: z.object({ login: z.string() }) }),
});

const PullRequestEvent = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  pull_request: z.object({ draft: z.boolean().optional(), state: z.string(), head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) }),
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/), owner: z.object({ login: z.string() }) }),
  installation: z.object({ id: z.number().int().positive() }),
});

const ok = (status: number, result: string) => NextResponse.json({ result }, { status });

// POST /api/integrations/github/webhook (FR-080): GitHub App events.
export async function POST(req: Request) {
  const cfg = githubConfig();
  if (!cfg) return apiError(503, "not_configured", "The GitHub integration is not configured.");

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return apiError(413, "payload_too_large", "Payload too large.");
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return apiError(413, "payload_too_large", "Payload too large.");
  if (!verifySignature(cfg.webhookSecret, raw, req.headers.get("x-hub-signature-256")))
    return apiError(401, "invalid_signature", "Webhook signature mismatch.");

  const event = req.headers.get("x-github-event");
  const delivery = req.headers.get("x-github-delivery") ?? "unknown";
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return apiError(400, "invalid_json", "The payload must be valid JSON.");
  }

  try {
    if (event === "ping") return ok(200, "pong");

    if (event === "installation") {
      const p = InstallationEvent.safeParse(body);
      if (!p.success) return apiError(400, "invalid_payload", "Unexpected installation payload.");
      const installationId = BigInt(p.data.installation.id);
      const accountLogin = p.data.installation.account.login;
      if (p.data.action === "created" || p.data.action === "unsuspend") {
        await prisma.gitHubInstallation.upsert({ where: { installationId }, create: { installationId, accountLogin }, update: { accountLogin } });
      } else if (p.data.action === "deleted") {
        // Uninstalled: remove the installation and, by cascade, its PR review history.
        await prisma.gitHubInstallation.deleteMany({ where: { installationId } });
      } else return ok(202, "ignored"); // "suspend" keeps history; a suspended app can't get tokens, so nothing runs.
      console.info(`[github] ${delivery}: installation ${p.data.action} ${accountLogin}`);
      return ok(200, "ok");
    }

    if (event === "pull_request") {
      const p = PullRequestEvent.safeParse(body);
      if (!p.success) return apiError(400, "invalid_payload", "Unexpected pull_request payload.");
      const { action, number: prNumber, pull_request: pr, repository, installation } = p.data;
      if (!PR_ACTIONS.has(action) || pr.draft || pr.state !== "open") return ok(202, "ignored");

      const installationId = BigInt(installation.id);
      const repo = repository.full_name;
      let created;
      try {
        created = await prisma.$transaction([
          prisma.gitHubInstallation.upsert({
            where: { installationId },
            create: { installationId, accountLogin: repository.owner.login },
            update: {},
            select: { userId: true },
          }),
          prisma.pullRequestReview.create({ data: { installationId, repo, prNumber, headSha: pr.head.sha }, select: { id: true } }),
        ]);
      } catch (e) {
        // Unique (repo, prNumber, headSha): GitHub redelivered an event we already took.
        if ((e as { code?: string }).code === "P2002") return ok(200, "duplicate");
        throw e;
      }
      const [inst, prReview] = created;
      console.info(`[github] ${delivery}: reviewing ${repo}#${prNumber} @ ${pr.head.sha.slice(0, 7)}`);
      after(() =>
        processPullRequest({
          pullRequestReviewId: prReview.id,
          installationId: installation.id,
          repo,
          prNumber,
          headSha: pr.head.sha,
          userId: inst.userId,
        }),
      );
      return ok(202, "accepted");
    }

    return ok(202, "ignored");
  } catch (e) {
    console.error(`[github] ${delivery}: ${event} failed`, e);
    return apiError(503, "unavailable", "Temporarily unavailable.");
  }
}
