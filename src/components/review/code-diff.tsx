"use client";

import { useSyncExternalStore } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { THEME, defineTheme } from "@/components/code-editor";
import { mono } from "@/app/fonts";
import type { Language } from "@/lib/schemas";
import { cn } from "@/lib/utils";

// Side-by-side needs room; below 768px Monaco's inline diff reads better.
const wideQuery = "(min-width: 768px)";
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(wideQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
export const useWide = () => useSyncExternalStore(subscribe, () => window.matchMedia(wideQuery).matches, () => true);

/** Read-only Monaco diff: the submitted code is never editable here (FR-051). */
export function CodeDiff({
  original,
  modified,
  language,
  modifiedLabel,
  className,
}: {
  original: string;
  modified: string;
  language: Language;
  modifiedLabel: string;
  className?: string;
}) {
  const wide = useWide();
  return (
    <div className={cn("h-[min(70vh,680px)] min-h-96 overflow-hidden rounded-2xl bg-sheet shadow-[0_28px_56px_-28px_rgb(22_32_43/0.55)]", className)}>
      <DiffEditor
        height="100%"
        language={language}
        original={original}
        modified={modified}
        theme={THEME}
        beforeMount={defineTheme}
        loading={<p className="p-4 text-sm text-sheet-muted">Loading diff…</p>}
        options={{
          readOnly: true,
          originalEditable: false,
          renderSideBySide: wide,
          useInlineViewWhenSpaceIsLimited: false,
          fontFamily: mono.style.fontFamily,
          fontSize: 14,
          lineHeight: 22,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          renderOverviewRuler: false,
          padding: { top: 12, bottom: 12 },
          accessibilitySupport: "auto",
          ariaLabel: modifiedLabel,
          originalAriaLabel: "Original code as submitted",
        }}
      />
    </div>
  );
}

export const fixedFileName = (name: string, suffix: string) =>
  /\.[^.]+$/.test(name) ? name.replace(/(\.[^.]+)$/, `.${suffix}$1`) : `${name}.${suffix}`;

export function downloadText(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
  a.click();
  URL.revokeObjectURL(url);
}
