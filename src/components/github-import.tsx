"use client";

import { useMemo, useRef, useState } from "react";
import { FileCode2, FolderGit2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { RepoFile, RepoSummary } from "@/lib/github/browse";
import type { Language } from "@/lib/schemas";

export type ImportedFile = { code: string; language: Language; path: string };
type Problem = { message: string; installUrl?: string };

const MAX_LISTED = 200; // the filter narrows the rest
const field =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40";

/** "Import from GitHub": pick a file from a repository the CodeGuard GitHub App can read, into the editor. */
export function GitHubImport({ onPick }: { onPick: (file: ImportedFile) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [tree, setTree] = useState<{ files: RepoFile[]; truncated: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState<string | null>(null); // what is loading, for the status line
  const [problem, setProblem] = useState<Problem | null>(null);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (tree?.files ?? []).filter((f) => f.path.toLowerCase().includes(needle));
  }, [tree, filter]);

  async function get<T>(params: Record<string, string>, what: string): Promise<T | null> {
    setLoading(what);
    setProblem(null);
    try {
      const res = await fetch(`/api/github/browse?${new URLSearchParams(params)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setProblem({ message: body?.error?.message ?? `GitHub import failed (HTTP ${res.status}).`, installUrl: body?.error?.details?.install_url });
        return null;
      }
      return body as T;
    } catch {
      setProblem({ message: "Couldn't reach the server. Check your connection and try again." });
      return null;
    } finally {
      setLoading(null);
    }
  }

  async function open() {
    dialog.current?.showModal(); // native modal: focus trap, Escape to close, inert background
    if (!repos) {
      const r = await get<{ repos: RepoSummary[] }>({}, "Loading your repositories…");
      if (r) setRepos(r.repos);
    }
  }

  async function chooseRepo(fullName: string) {
    const next = repos?.find((r) => r.full_name === fullName) ?? null;
    setRepo(next);
    setTree(null);
    setFilter("");
    if (!next) return;
    const t = await get<{ files: RepoFile[]; truncated: boolean }>({ repo: next.full_name, ref: next.default_branch }, `Listing files in ${next.full_name}…`);
    if (t) setTree(t);
  }

  async function pick(path: string) {
    if (!repo) return;
    const file = await get<ImportedFile>({ repo: repo.full_name, ref: repo.default_branch, path }, `Loading ${path}…`);
    if (file) {
      onPick(file);
      dialog.current?.close();
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/30 px-3 text-sm hover:bg-white/10 focus-visible:ring-3 focus-visible:ring-highlighter/60 focus-visible:outline-none"
      >
        <FolderGit2 aria-hidden className="size-4 text-sheet-muted" />
        Import from GitHub
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="github-import-title"
        className="m-auto w-[min(94vw,40rem)] rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-[#16202b]/60"
      >
        <div className="flex max-h-[min(85vh,44rem)] flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="github-import-title" className="font-display text-xl font-bold [font-stretch:88%]">
                Import from GitHub
              </h2>
              <p className="text-sm text-muted-foreground">Pick a file from a repository you&apos;ve given the CodeGuard AI app access to.</p>
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={() => dialog.current?.close()}>
              <X aria-hidden />
            </Button>
          </div>

          {repos && repos.length > 0 && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="github-repo">Repository</Label>
              <select id="github-repo" className={field} value={repo?.full_name ?? ""} onChange={(e) => chooseRepo(e.target.value)}>
                <option value="" disabled>
                  Choose a repository
                </option>
                {repos.map((r) => (
                  <option key={r.full_name} value={r.full_name}>
                    {r.full_name}
                    {r.private ? " (private)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          {repos?.length === 0 && (
            <p className="text-sm">
              The app can&apos;t see any repositories yet. In GitHub, open Settings → Applications → CodeGuard AI and grant it access to a repository.
            </p>
          )}

          {tree && (
            <div className="flex min-h-0 flex-col gap-2">
              <Label htmlFor="github-filter">Filter files</Label>
              <input id="github-filter" className={field} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="src/api" autoComplete="off" />
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {matches.length.toLocaleString()} reviewable file{matches.length === 1 ? "" : "s"}
                {matches.length > MAX_LISTED ? `, showing the first ${MAX_LISTED}; type to narrow the list` : ""}
                {tree.truncated ? ". This repository is large, so not every file is listed." : ""}
              </p>
              {matches.length > 0 ? (
                <ul className="min-h-0 overflow-y-auto rounded-lg border border-border">
                  {matches.slice(0, MAX_LISTED).map((f) => (
                    <li key={f.path} className="border-b border-border last:border-b-0">
                      <button
                        type="button"
                        onClick={() => pick(f.path)}
                        disabled={loading !== null}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-60"
                      >
                        <FileCode2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 break-all">{f.path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm">No .py, .js, .ts or .java files under 100 KB match.</p>
              )}
            </div>
          )}

          {loading && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:hidden" />
              {loading}
            </p>
          )}
          {problem && (
            <p role="alert" className="text-sm font-bold text-destructive">
              {problem.message}{" "}
              {problem.installUrl && (
                <a href={problem.installUrl} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">
                  Install the app on GitHub
                </a>
              )}
            </p>
          )}
        </div>
      </dialog>
    </>
  );
}
