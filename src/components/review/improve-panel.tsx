"use client";

import { useState } from "react";
import { Check, CircleCheck, Copy, Download, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FixVersionDetail, type ImproveKind, type ReviewDetail } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { SafetyBadge } from "./badges";
import { CodeDiff, downloadText, fixedFileName } from "./code-diff";

const MAX_VERSIONS = 3; // mirrors MAX_IMPROVE_VERSIONS on the server, which enforces it

const KIND_LABEL: Record<ImproveKind, string> = {
  extract_function: "Extracted function",
  rename: "Renamed",
  remove_redundancy: "Removed redundancy",
  error_handling: "Added error handling",
  simplify: "Simplified",
  performance: "Performance",
  security: "Security",
  documentation: "Documentation",
  other: "Other",
};

/** FR-050 Improve Code: generate a full rewrite, show the change list and the diff. The original is never changed. */
export function ImprovePanel({ review, done }: { review: ReviewDetail; done: boolean }) {
  const [versions, setVersions] = useState(() => review.fix_versions.filter((v) => v.type === "improve"));
  const [selectedId, setSelectedId] = useState<string | null>(versions[0]?.id ?? null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const version = versions.find((v) => v.id === selectedId) ?? null;
  const atLimit = versions.length >= MAX_VERSIONS;

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/reviews/${review.id}/improve`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `Improving failed (HTTP ${res.status}).`);
      const v = FixVersionDetail.parse(body);
      setVersions((prev) => [v, ...prev]);
      setSelectedId(v.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Improving failed. Try again.");
    } finally {
      setGenerating(false);
    }
  }

  async function copy() {
    if (!version) return;
    try {
      await navigator.clipboard.writeText(version.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy to the clipboard. Use Download instead.");
    }
  }

  return (
    <section aria-labelledby="improve-heading" className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-[62ch]">
          <h3 id="improve-heading" className="font-display text-xl font-bold [font-stretch:90%]">
            Improve code
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            A rewrite of the whole file for readability and robustness: extracted functions, clearer names, error handling, less
            redundancy. Behaviour is kept the same, every change is listed, and the result is re-checked by static analysis.
          </p>
        </div>
        <Button type="button" onClick={generate} disabled={!done || generating || atLimit} aria-busy={generating} className="h-10 px-4 font-bold">
          {generating ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Sparkles aria-hidden />}
          {generating ? "Improving…" : versions.length ? "Generate another version" : "Generate improved version"}
        </Button>
      </div>

      <div role="status" aria-live="polite" className="text-sm">
        {generating && <p className="text-muted-foreground">Rewriting your code. This usually takes 20 to 40 seconds.</p>}
        {!done && <p className="text-muted-foreground">Available once the review has finished.</p>}
        {atLimit && !generating && <p className="text-muted-foreground">This review has reached its limit of {MAX_VERSIONS} improved versions.</p>}
        {copied && <span className="sr-only">Improved code copied to the clipboard</span>}
      </div>
      {error && (
        <p role="alert" className="text-sm font-bold text-destructive">
          {error}
        </p>
      )}

      {versions.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Version</span>
          {versions.map((v, i) => (
            <Button
              key={v.id}
              type="button"
              size="sm"
              variant={v.id === selectedId ? "default" : "outline"}
              aria-pressed={v.id === selectedId}
              onClick={() => setSelectedId(v.id)}
            >
              {versions.length - i}
            </Button>
          ))}
        </div>
      )}

      {version && (
        <div className="flex flex-col gap-4">
          {version.summary && <p className="text-[15px]">{version.summary}</p>}

          {version.validated ? (
            <p className="flex items-center gap-2 rounded-xl border border-[#75e0a7] bg-[#ecfdf3] px-4 py-3 text-sm font-bold text-[#05603a]">
              <CircleCheck aria-hidden className="size-4" />
              Validated: the improved version parses and introduces no new static-analysis issues.
            </p>
          ) : (
            <div className="rounded-xl border border-[#fda29b] bg-[#fef3f2] px-4 py-3 text-sm text-[#912018]">
              <p className="flex items-center gap-2 font-bold">
                <TriangleAlert aria-hidden className="size-4" />
                The improved version introduces {version.validation_errors.length}{" "}
                {version.validation_errors.length === 1 ? "issue" : "issues"}. Check these before using it:
              </p>
              <ul className="mt-2 list-disc pl-6">
                {version.validation_errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <ol className="divide-y divide-border rounded-xl border border-border" aria-label="Changes in the improved version">
            {version.improvements.map((c, i) => (
              <li key={i} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                <span className="w-44 shrink-0 text-sm font-bold">{KIND_LABEL[c.kind]}</span>
                <div className="flex-1 text-[15px]">
                  <p>{c.description}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">
                      original lines {c.start_line}
                      {c.end_line !== c.start_line ? `-${c.end_line}` : ""}
                    </span>
                    {c.finding_refs.length > 0 && <span className="font-mono">resolves {c.finding_refs.join(", ")}</span>}
                    <SafetyBadge safety={c.safety} />
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-bold">
              Original on the left, improved version on the right
              <span className="sr-only"> (stacked on small screens)</span>
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={copy}>
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button type="button" variant="outline" onClick={() => downloadText(version.code, fixedFileName(review.file_name, "improved"))}>
                <Download aria-hidden />
                Download
              </Button>
            </div>
          </div>
          <CodeDiff
            original={review.original_code}
            modified={version.code}
            language={review.language}
            modifiedLabel="Improved version of the code"
            className={cn("h-[min(65vh,620px)]")}
          />
        </div>
      )}
    </section>
  );
}
