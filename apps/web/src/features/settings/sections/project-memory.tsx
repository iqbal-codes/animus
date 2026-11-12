import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { BookOpen, Brain, ShieldAlert } from "lucide-react";

interface LessonItem {
  id: string;
  topic: string;
  triggers: string;
  rule: string;
  vetoed: boolean;
}

const INITIAL_LESSONS: LessonItem[] = [
  {
    id: "les-094",
    topic: "Monitor lock recovery",
    triggers: "apps/backend/src/monitor/** · 3 occurrences",
    rule: "Verify the owner PID is no longer running before reclaiming a monitor lock.",
    vetoed: false,
  },
  {
    id: "les-088",
    topic: "SQLite busy timeout",
    triggers: "apps/backend/src/registry/db.ts · 2 occurrences",
    rule: "Set PRAGMA busy_timeout = 5000 on shared SQLite connections.",
    vetoed: false,
  },
  {
    id: "les-071",
    topic: "Legacy aliases",
    triggers: "packages/contracts/** · Clean Cutover conflict",
    rule: "Retain backward-compatible aliases when renaming internal helpers.",
    vetoed: true,
  },
];

export function ProjectMemorySection() {
  const [safeMode, setSafeMode] = useState(false);
  const [gitLockSkill, setGitLockSkill] = useState(true);
  const [sqliteSkill, setSqliteSkill] = useState(false);
  const [lessons, setLessons] = useState(INITIAL_LESSONS);

  useEffect(() => {
    fetch("/api/v1/harness/lessons")
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            safe_mode?: boolean;
            lessons?: Array<{
              id: string;
              topic?: string;
              triggers?: string;
              globs?: string[];
              occurrences?: number;
              rule?: string;
              text?: string;
              vetoed?: boolean;
            }>;
          } | null,
        ) => {
          if (!data) return;
          if (typeof data.safe_mode === "boolean") {
            setSafeMode(data.safe_mode);
          }
          if (Array.isArray(data.lessons) && data.lessons.length > 0) {
            setLessons(
              data.lessons.map((l: any) => ({
                id: l.id,
                topic: l.topic || l.id,
                triggers:
                  l.triggers ||
                  `${l.trigger_patterns?.join(", ") || l.globs?.join(", ") || "general"} · ${l.occurrence_count || l.occurrences || 1} occurrences`,
                rule: l.rule || l.text || "",
                vetoed: Boolean(l.vetoed),
              })),
            );
          }
        },
      )
      .catch(() => {});
  }, []);

  const toggleVeto = async (id: string) => {
    setLessons((current) => current.map((l) => (l.id === id ? { ...l, vetoed: true } : l)));
    await fetch("/api/v1/harness/veto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  };

  const activeLessons = lessons.filter((l) => !l.vetoed).length;
  const vetoedLessons = lessons.filter((l) => l.vetoed).length;

  return (
    <div className="flex flex-col gap-8">
      {/* Harness Memory Governance Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Brain className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">
            Harness memory governance
          </h3>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Safe mode */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium leading-[1.4] text-foreground">Safe mode</span>
                <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                  .animus/NO_HARNESS_MEMORY
                </span>
              </div>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Bypass dynamic harness memory and lessons during autonomous execution.
              </span>
            </div>
            <Switch checked={safeMode} onCheckedChange={setSafeMode} />
          </div>

          {/* Learned skills: git-lock-recovery */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                git-lock-recovery
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Reflector · Reviewed PR · Clean stale index.lock before retrying git operations.
              </span>
            </div>
            <Switch checked={gitLockSkill} onCheckedChange={setGitLockSkill} />
          </div>

          {/* Learned skills: sqlite-contention-checks */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                sqlite-contention-checks
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Reflector · Reviewed PR · Check busy timeouts on shared SQLite connections.
              </span>
            </div>
            <Switch checked={sqliteSkill} onCheckedChange={setSqliteSkill} />
          </div>
        </div>
      </section>

      {/* Evidence-Backed Lessons Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="size-4 text-text-secondary" />
            <h3 className="text-base font-medium leading-[1.4] text-foreground">
              Evidence-backed lessons
            </h3>
          </div>
          <span className="text-xs text-text-secondary">
            {activeLessons} active · {vetoedLessons} vetoed
          </span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {lessons.map((lesson) => (
            <div key={lesson.id} className="flex items-center justify-between gap-6 py-3.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{lesson.topic}</span>
                  <span className="text-xs text-text-secondary">{lesson.triggers}</span>
                </div>
                <span className="text-[13px] leading-[1.45] text-text-secondary">
                  {lesson.rule}
                </span>
              </div>
              <div>
                {lesson.vetoed ? (
                  <Badge variant="error" className="font-mono text-[10px] tracking-wider uppercase">
                    VETOED
                  </Badge>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleVeto(lesson.id)}
                    className="inline-flex h-8 shrink-0 items-center rounded-full border border-[var(--border-subtle)] bg-[var(--card)] px-3 text-xs font-medium text-text-secondary transition-colors hover:border-[var(--error)] hover:text-[var(--error)]"
                  >
                    Veto lesson
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Codebase Rules Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">
            Codebase rules / Guardrails
          </h3>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          <div className="flex items-center justify-between gap-6 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium text-foreground">
                  no-atomics-wait
                </span>
                <span className="rounded bg-white/5 px-2 py-0.5 font-mono text-xs text-text-secondary">
                  apps/backend/**/*.ts
                </span>
              </div>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Flag Atomics.wait · Prefer an async mutex
              </span>
            </div>
            <Badge variant="warning" className="font-mono text-[10px] tracking-wider uppercase">
              WARN
            </Badge>
          </div>

          <div className="flex items-center justify-between gap-6 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium text-foreground">
                  no-wildcard-bind
                </span>
                <span className="rounded bg-white/5 px-2 py-0.5 font-mono text-xs text-text-secondary">
                  apps/**/*.ts
                </span>
              </div>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Forbid 0.0.0.0 · Use an explicit private address
              </span>
            </div>
            <Badge variant="error" className="font-mono text-[10px] tracking-wider uppercase">
              BLOCK
            </Badge>
          </div>
        </div>
      </section>
    </div>
  );
}
