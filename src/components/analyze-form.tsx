"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Loader2 } from "lucide-react";
import { CodeEditor } from "@/components/code-editor";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { LANGUAGE_IDS, LANGUAGES, defaultFileName, detectLanguage, languageFromFileName } from "@/lib/languages";
import { CreateReviewRequest, LIMITS, type FocusArea, type Language, type ReviewMode } from "@/lib/schemas";
import { cn } from "@/lib/utils";

const MODES: Record<ReviewMode, { label: string; description: string }> = {
  developer: { label: "Developer", description: "Short, technical findings." },
  student: { label: "Student", description: "Plain-language explanations and a short primer on each concept." },
};

const FOCUS: Record<FocusArea, string> = { bugs: "Bugs", security: "Security", performance: "Performance" };

const ACCEPT = LANGUAGE_IDS.flatMap((id) => LANGUAGES[id].extensions).join(",");
const LANGUAGE_ITEMS = LANGUAGE_IDS.map((id) => ({ value: id, label: LANGUAGES[id].label }));
const encoder = new TextEncoder();
const kb = (bytes: number) => (bytes / 1000).toFixed(1);

export function AnalyzeForm({ className }: { className?: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState<Language>("python");
  const [mode, setMode] = useState<ReviewMode>("developer");
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusArea[]>(["bugs", "security", "performance"]);
  const [assignment, setAssignment] = useState("");
  const [intended, setIntended] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = code ? code.split("\n").length : 0;
  const bytes = encoder.encode(code).length;
  const tooBig = lines > LIMITS.maxLines || bytes > LIMITS.maxBytes;
  const detected = useMemo(() => (code.trim().length > 20 ? detectLanguage(code) : null), [code]);

  async function openFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-opening the same file
    if (!file) return;
    const lang = languageFromFileName(file.name);
    if (!lang) return setError(`${file.name} isn't a supported file type. Open a .py, .js, .ts or .java file.`);
    if (file.size > LIMITS.maxBytes)
      return setError(`${file.name} is ${kb(file.size)} KB. Files can be up to ${LIMITS.maxBytes / 1000} KB.`);
    const text = await file.text();
    if (text.includes("\u0000")) return setError(`${file.name} looks like a binary file. Open a source code file.`);
    setError(null);
    setCode(text);
    setLanguage(lang);
    setUploadedName(file.name);
  }

  function loadExample() {
    setError(null);
    setUploadedName(null);
    setCode(LANGUAGES[language].sample);
  }

  async function analyze() {
    if (submitting) return;
    const parsed = CreateReviewRequest.safeParse({
      code,
      language,
      mode,
      focus,
      source_type: uploadedName ? "upload" : "paste",
      file_name: uploadedName ?? defaultFileName(language),
      assignment_context: assignment.trim() || undefined,
      intended_behaviour: intended.trim() || undefined,
    });
    if (!parsed.success) return setError(parsed.error.issues[0].message);

    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const retry = res.headers.get("Retry-After");
        setError(
          body?.error?.message ??
            (res.status === 429
              ? `You've hit the review limit. Try again in ${retry ?? "a few"} seconds.`
              : `The review couldn't start (HTTP ${res.status}). Try again.`),
        );
        return setSubmitting(false);
      }
      router.push(`/reviews/${body.review_id}`);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  function toggleFocus(area: FocusArea, on: boolean) {
    setFocus((prev) => (on ? [...prev, area] : prev.filter((f) => f !== area)));
  }

  return (
    <form
      className={cn("flex flex-col gap-6", className)}
      onSubmit={(e) => {
        e.preventDefault();
        analyze();
      }}
    >
      <div className="overflow-hidden rounded-2xl bg-sheet text-white shadow-[0_28px_56px_-28px_rgb(22_32_43/0.55)] ring-2 ring-transparent transition-shadow focus-within:ring-highlighter">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-sheet-line px-4 py-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="language" className="text-sm text-sheet-muted">
              Language
            </Label>
            <Select
              items={LANGUAGE_ITEMS}
              value={language}
              onValueChange={(v) => v && setLanguage(v as Language)}
            >
              <SelectTrigger
                id="language"
                className="h-9 min-w-32 border-white/30 bg-white/5 text-white hover:bg-white/10 [&_svg]:text-sheet-muted"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-white/30 px-3 text-sm hover:bg-white/10 focus-within:ring-3 focus-within:ring-highlighter/60">
            <FileUp aria-hidden className="size-4 text-sheet-muted" />
            Open file
            <input type="file" accept={ACCEPT} onChange={openFile} className="sr-only" />
          </label>

          {code === "" && (
            <Button
              type="button"
              variant="ghost"
              onClick={loadExample}
              className="h-9 text-white underline-offset-4 hover:bg-white/10 hover:text-white hover:underline"
            >
              Try a {LANGUAGES[language].label} example
            </Button>
          )}

          <p className={cn("ml-auto flex gap-3 text-sm tabular-nums", tooBig ? "text-highlighter" : "text-sheet-muted")}>
            {uploadedName && <span className="max-w-40 truncate text-white">{uploadedName}</span>}
            <span>
              {lines.toLocaleString()} / {LIMITS.maxLines.toLocaleString()} lines
            </span>
            <span>
              {kb(bytes)} / {LIMITS.maxBytes / 1000} KB
            </span>
            {tooBig && <span className="font-bold">Over the limit</span>}
          </p>
        </div>

        <div className="h-[min(50vh,520px)] min-h-72">
          <CodeEditor value={code} language={language} onChange={setCode} onSubmit={analyze} />
        </div>

        <p className="flex flex-wrap gap-x-6 gap-y-1 border-t border-sheet-line px-4 py-2 text-xs text-sheet-muted">
          <span>Ctrl+Enter (⌘+Enter on Mac) starts the review.</span>
          <span>Tab indents. Ctrl+M (Ctrl+Shift+M on Mac) makes Tab move focus instead.</span>
        </p>
      </div>

      {detected && detected !== language && (
        <p role="status" className="-mt-2 flex flex-wrap items-center gap-x-3 text-sm">
          This looks like {LANGUAGES[detected].label}, not {LANGUAGES[language].label}.
          <Button type="button" variant="link" className="h-auto p-0" onClick={() => setLanguage(detected)}>
            Switch to {LANGUAGES[detected].label}
          </Button>
        </p>
      )}

      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span id="mode-label" className="text-sm font-bold">
              Mode
            </span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <ToggleGroup
                aria-labelledby="mode-label"
                aria-describedby="mode-description"
                variant="outline"
                spacing={0}
                value={[mode]}
                onValueChange={(v) => v[0] && setMode(v[0] as ReviewMode)}
                className="bg-card"
              >
                {(Object.keys(MODES) as ReviewMode[]).map((m) => (
                  <ToggleGroupItem
                    key={m}
                    value={m}
                    className="h-10 border-input px-4 aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:bg-foreground"
                  >
                    {MODES[m].label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p id="mode-description" className="text-sm text-muted-foreground">
                {MODES[mode].description}
              </p>
            </div>
          </div>

          <details className="group max-w-xl">
            <summary className="w-fit cursor-pointer rounded-sm text-sm font-bold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
              Add context (optional)
            </summary>
            <div className="mt-4 flex flex-col gap-4">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm text-muted-foreground">Check for</legend>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {(Object.keys(FOCUS) as FocusArea[]).map((area) => (
                    <Label key={area} className="font-normal">
                      <Checkbox
                        checked={focus.includes(area)}
                        onCheckedChange={(on) => toggleFocus(area, on === true)}
                        className="border-input bg-card"
                      />
                      {FOCUS[area]}
                    </Label>
                  ))}
                </div>
              </fieldset>
              <div className="flex flex-col gap-2">
                <Label htmlFor="assignment">Assignment or task description</Label>
                <Textarea
                  id="assignment"
                  value={assignment}
                  onChange={(e) => setAssignment(e.target.value)}
                  maxLength={2000}
                  rows={3}
                  className="border-input bg-card"
                  placeholder="Write a function that returns the average of a list of scores."
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="intended">What should the code do?</Label>
                <Textarea
                  id="intended"
                  value={intended}
                  onChange={(e) => setIntended(e.target.value)}
                  maxLength={2000}
                  rows={3}
                  className="border-input bg-card"
                  placeholder="Return 0 for an empty list instead of crashing."
                />
              </div>
            </div>
          </details>
        </div>

        <Button
          type="submit"
          disabled={submitting || tooBig || code.trim() === ""}
          aria-busy={submitting}
          className="h-12 w-full px-7 text-base font-bold sm:w-auto"
        >
          {submitting && <Loader2 aria-hidden className="animate-spin motion-reduce:hidden" />}
          {submitting ? "Starting review…" : "Analyze code"}
        </Button>
      </div>

      <p role="alert" className="min-h-6 text-sm font-bold text-destructive empty:min-h-0">
        {error}
      </p>
    </form>
  );
}
