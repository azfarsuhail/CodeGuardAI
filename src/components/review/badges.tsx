import {
  BadgeCheck,
  Bug,
  CircleAlert,
  Gauge,
  Hand,
  Info,
  Layers,
  Lightbulb,
  OctagonAlert,
  PenLine,
  ShieldAlert,
  ShieldCheck,
  Sparkle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { FindingCategory, FindingSource, FixSafety, Severity } from "@/lib/schemas";
import { cn } from "@/lib/utils";

// Severity is always icon + text + colour (WCAG 1.4.1); colours meet 4.5:1 on their tint.
export const SEVERITY: Record<Severity, { label: string; icon: LucideIcon; badge: string; edge: string }> = {
  critical: { label: "Critical", icon: OctagonAlert, badge: "bg-[#fee4e2] text-[#912018]", edge: "border-l-[#d92d20]" },
  high: { label: "High", icon: TriangleAlert, badge: "bg-[#ffead5] text-[#93370d]", edge: "border-l-[#e8590c]" },
  medium: { label: "Medium", icon: CircleAlert, badge: "bg-[#fef7c3] text-[#713b12]", edge: "border-l-[#d4a20b]" },
  low: { label: "Low", icon: Info, badge: "bg-[#dce4f7] text-[#1d3a8a]", edge: "border-l-[#2446d8]" },
  info: { label: "Info", icon: Lightbulb, badge: "bg-[#e2e8e5] text-[#36424b]", edge: "border-l-[#7d8b85]" },
};

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export const CATEGORY: Record<FindingCategory, { label: string; icon: LucideIcon }> = {
  bug: { label: "Bug", icon: Bug },
  security: { label: "Security", icon: ShieldAlert },
  performance: { label: "Performance", icon: Gauge },
  quality: { label: "Quality", icon: PenLine },
  maintainability: { label: "Maintainability", icon: Layers },
};

export const SAFETY: Record<FixSafety, { label: string; description: string; icon: LucideIcon; badge: string }> = {
  safe: {
    label: "Safe fix",
    description: "Keeps behaviour the same. Included in Fix All Safe Issues.",
    icon: ShieldCheck,
    badge: "bg-[#d1fadf] text-[#05603a]",
  },
  needs_review: {
    label: "Needs review",
    description: "Changes behaviour or a contract. Apply only after checking it.",
    icon: TriangleAlert,
    badge: "bg-[#fef7c3] text-[#713b12]",
  },
  manual_only: {
    label: "Manual only",
    description: "Depends on design or intent. Suggestion only, never auto-applied.",
    icon: Hand,
    badge: "bg-[#e2e8e5] text-[#36424b]",
  },
};

const pill = "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold whitespace-nowrap";

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const s = SEVERITY[severity];
  return (
    <span className={cn(pill, s.badge, className)}>
      <s.icon aria-hidden className="size-3.5" />
      {s.label}
    </span>
  );
}

export function SafetyBadge({ safety, className }: { safety: FixSafety; className?: string }) {
  const s = SAFETY[safety];
  return (
    <span className={cn(pill, s.badge, className)} title={s.description}>
      <s.icon aria-hidden className="size-3.5" />
      {s.label}
    </span>
  );
}

// PRD 8.3: analyzer-backed findings are "Verified"; AI-only findings show their confidence.
export function SourceBadge({ source, confidence }: { source: FindingSource; confidence: number }) {
  if (source === "ai")
    return (
      <span className={cn(pill, "bg-[#ede9fe] text-[#4c1d95]")}>
        <Sparkle aria-hidden className="size-3.5" />
        AI-suggested, {Math.round(confidence * 100)}% confidence
      </span>
    );
  return (
    <span className={cn(pill, "bg-[#d1fadf] text-[#05603a]")} title={source === "both" ? "Found by static analysis and confirmed by the AI reviewer" : "Found by static analysis"}>
      <BadgeCheck aria-hidden className="size-3.5" />
      Verified
    </span>
  );
}
