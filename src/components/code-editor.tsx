"use client";

import { useEffect, useRef } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { mono } from "@/app/fonts";
import type { Language } from "@/lib/schemas";

const THEME = "codeguard-ink";

const defineTheme: BeforeMount = (monaco) => {
  monaco.editor.defineTheme(THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8296AB", fontStyle: "italic" },
      { token: "keyword", foreground: "9DBBFF" },
      { token: "string", foreground: "F4D35E" },
      { token: "number", foreground: "F2A47E" },
      { token: "type", foreground: "8FD9C4" },
    ],
    colors: {
      "editor.background": "#13202F",
      "editor.foreground": "#E6EDF3",
      "editor.lineHighlightBackground": "#1B2B3E",
      "editor.lineHighlightBorder": "#1B2B3E",
      "editor.selectionBackground": "#F4D35E40",
      "editor.inactiveSelectionBackground": "#F4D35E22",
      "editorCursor.foreground": "#F4D35E",
      "editorLineNumber.foreground": "#5C7088",
      "editorLineNumber.activeForeground": "#F4D35E",
      "editorIndentGuide.background1": "#26384D",
      "editorWhitespace.foreground": "#26384D",
      "editor.placeholder.foreground": "#7F93A8",
    },
  });
};

type Props = {
  value: string;
  language: Language;
  onChange: (value: string) => void;
  onSubmit: () => void;
};

export function CodeEditor({ value, language, onChange, onSubmit }: Props) {
  // Monaco registers the keybinding once; read the latest handler through a ref.
  const submitRef = useRef(onSubmit);
  useEffect(() => {
    submitRef.current = onSubmit;
  });

  const handleMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => submitRef.current());
    // Monaco measures glyphs on mount; re-measure once the web font has loaded so the cursor lines up.
    document.fonts.ready.then(() => monaco.editor.remeasureFonts());
  };

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      theme={THEME}
      beforeMount={defineTheme}
      onMount={handleMount}
      onChange={(v) => onChange(v ?? "")}
      loading={<p className="text-sm text-sheet-muted">Loading editor…</p>}
      options={{
        ariaLabel: "Code to review",
        placeholder: "Paste your code here, or open a file.",
        fontFamily: mono.style.fontFamily,
        fontSize: 14,
        lineHeight: 22,
        tabSize: 4,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        padding: { top: 16, bottom: 16 },
        automaticLayout: true,
        accessibilitySupport: "auto",
        fixedOverflowWidgets: true,
      }}
    />
  );
}
