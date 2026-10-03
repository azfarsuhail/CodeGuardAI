import { Bug, Flame, GraduationCap, Gauge, ShieldCheck, Wrench, type LucideIcon } from "lucide-react";
import type { BadgeCode } from "./engine";

// Descriptions double as the unlock criteria shown on locked badges.
export const BADGES: Record<BadgeCode, { label: string; description: string; icon: LucideIcon }> = {
  first_bug_fixed: { label: "First Bug Fixed", description: "Fix your first bug.", icon: Wrench },
  security_beginner: { label: "Security Beginner", description: "Resolve 5 security issues.", icon: ShieldCheck },
  performance_optimizer: { label: "Performance Optimizer", description: "Fix 5 performance issues.", icon: Gauge },
  bug_hunter: { label: "Bug Hunter", description: "Fix 100 bugs.", icon: Bug },
  streak_keeper: { label: "Streak Keeper", description: "Review code 7 days in a row.", icon: Flame },
  quiz_master: { label: "Quiz Master", description: "Score 100% on 5 different quizzes on your first try.", icon: GraduationCap },
};
