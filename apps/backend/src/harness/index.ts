import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  harnessLessonSchema,
  harnessLessonsResponseSchema,
  harnessToolsResponseSchema,
  harnessVetoSubmissionSchema,
  harnessVetoResultSchema,
  type HarnessLesson,
  type HarnessLessonsResponse,
  type HarnessToolsResponse,
  type HarnessVetoResult,
} from "@animus/contracts/operator";

export class HarnessService {
  private repoRoot: string;

  constructor(repoRoot = process.env.FACTORY_REPO_ROOT || process.cwd()) {
    this.repoRoot = repoRoot;
  }

  isSafeMode(): boolean {
    return existsSync(join(this.repoRoot, ".factory/NO_HARNESS_MEMORY"));
  }

  readLessons(): HarnessLesson[] {
    const filePath = join(this.repoRoot, ".factory/lessons.jsonl");
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8");
    const lessons: HarnessLesson[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = harnessLessonSchema.parse(JSON.parse(trimmed));
        lessons.push(parsed);
      } catch {}
    }
    return lessons;
  }

  getLessonsResponse(): HarnessLessonsResponse {
    return harnessLessonsResponseSchema.parse({
      safe_mode: this.isSafeMode(),
      lessons: this.readLessons(),
    });
  }

  readTools(): Record<string, string> {
    const filePath = join(this.repoRoot, ".factory/tool-guidance.json");
    if (!existsSync(filePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") result[k] = v;
        }
        return result;
      }
    } catch {}
    return {};
  }

  getToolsResponse(): HarnessToolsResponse {
    return harnessToolsResponseSchema.parse({
      tools: this.readTools(),
    });
  }

  vetoLesson(id: string): HarnessVetoResult | null {
    const filePath = join(this.repoRoot, ".factory/lessons.jsonl");
    const lessons = this.readLessons();
    let found = false;
    const updated = lessons.map((lesson) => {
      if (lesson.id === id) {
        found = true;
        return { ...lesson, vetoed: true };
      }
      return lesson;
    });
    if (!found) return null;

    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const content = updated.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);

    return harnessVetoResultSchema.parse({
      ok: true,
      id,
      vetoed: true,
    });
  }
}

export async function handleHarnessRoute(
  request: Request,
  path: string,
  service = new HarnessService(),
): Promise<Response | null> {
  const normalized = path.startsWith("/api/v1/harness/")
    ? path.slice("/api/v1/harness/".length)
    : path.startsWith("/api/harness/")
      ? path.slice("/api/harness/".length)
      : null;

  if (normalized === null) return null;

  if (normalized === "lessons") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    return Response.json(service.getLessonsResponse());
  }

  if (normalized === "tools") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    return Response.json(service.getToolsResponse());
  }

  if (normalized === "veto") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const parsed = harnessVetoSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const result = service.vetoLesson(parsed.data.id);
    if (!result) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(result);
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}
