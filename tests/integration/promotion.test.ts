import { describe, expect, test } from "vitest";
import { createFactoryClient } from "@labq/client";
import type { PromotionStatus, PromotionResult } from "@labq/contracts/operator";
import { PromotionService } from "../../apps/engine-host/src/promotion";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Promotion status and prepare promotion", () => {
  test("AC1: PromotionService parses unpromoted commits and existing PR status", () => {
    const dir = mkdtempSync(join(tmpdir(), "promo-test-"));
    try {
      const mockRunner = (cmd: string[]) => {
        if (cmd[0] === "git" && cmd[1] === "rev-parse") {
          return "abc1234\n";
        }
        if (cmd[0] === "git" && cmd[1] === "log") {
          return "hash1|feat: implement thing (#42)\nhash2|fix: solve bug (#43)\n";
        }
        if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
          return "[]\n";
        }
        return "";
      };

      const promo = new PromotionService(dir, "main", "develop", mockRunner);
      const status = promo.getStatus();

      expect(status.main_branch).toBe("main");
      expect(status.develop_branch).toBe("develop");
      expect(status.unpromoted_count).toBe(2);
      expect(status.delivered_tickets).toEqual([42, 43]);
      expect(status.candidate_freeze).toBe(false);
      expect(status.existing_pr).toBeNull();
      expect(status.ready_to_promote).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC2: Refuses prepare promotion when 0 commits or PR already open", () => {
    const dir = mkdtempSync(join(tmpdir(), "promo-refuse-"));
    try {
      const emptyRunner = (cmd: string[]) => {
        if (cmd[0] === "git" && cmd[1] === "rev-parse") return "abc\n";
        if (cmd[0] === "git" && cmd[1] === "log") return "\n";
        if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") return "[]\n";
        return "";
      };
      const promoEmpty = new PromotionService(dir, "main", "develop", emptyRunner);
      expect(() => promoEmpty.preparePromotion()).toThrow("no_unpromoted_commits");

      const openRunner = (cmd: string[]) => {
        if (cmd[0] === "git" && cmd[1] === "rev-parse") return "abc\n";
        if (cmd[0] === "git" && cmd[1] === "log") return "hash1|feat: test (#1)\n";
        if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
          return JSON.stringify([
            { number: 99, url: "https://github.com/org/repo/pull/99", title: "Open" },
          ]);
        }
        return "";
      };
      const promoOpen = new PromotionService(dir, "main", "develop", openRunner);
      expect(() => promoOpen.preparePromotion()).toThrow("promotion_pr_already_open");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC3: Truthful partial-effect reporting when external PR succeeds but local pause brake fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "promo-partial-"));
    try {
      const runner = (cmd: string[]) => {
        if (cmd[0] === "git" && cmd[1] === "rev-parse") return "abc\n";
        if (cmd[0] === "git" && cmd[1] === "log") return "hash1|feat: test (#10)\n";
        if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") return "[]\n";
        if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "create") {
          return "https://github.com/org/repo/pull/123\n";
        }
        return "";
      };

      const promo = new PromotionService(dir, "main", "develop", runner);
      const res = promo.preparePromotion();

      expect(res.pr_number).toBe(123);
      expect(res.pr_url).toBe("https://github.com/org/repo/pull/123");
      expect(res.unpromoted_count).toBe(1);
      expect(res.candidate_freeze).toBe(true);
      expect(res.partial_effect).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC1/AC5: Client interacts with promotion routes and parses truthful contracts", async () => {
    const mockStatus: PromotionStatus = {
      main_branch: "main",
      develop_branch: "develop",
      unpromoted_count: 5,
      delivered_tickets: [28, 29, 30],
      candidate_freeze: false,
      existing_pr: null,
      ready_to_promote: true,
    };
    const mockResult: PromotionResult = {
      pr_number: 105,
      pr_url: "https://github.com/org/repo/pull/105",
      title: "chore(release): promote develop to main",
      unpromoted_count: 5,
      candidate_freeze: true,
      partial_effect: false,
      local_effect_error: null,
    };

    const client = createFactoryClient({
      baseUrl: "http://localhost:3000",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/v1/promotion/status")) {
          return Response.json(mockStatus);
        }
        if (url.endsWith("/api/v1/promotion/prepare") && init?.method === "POST") {
          return Response.json(mockResult, { status: 201 });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });

    const status = await client.promotionStatus();
    expect(status).toEqual(mockStatus);

    const result = await client.preparePromotion({ title: "Custom Title" });
    expect(result).toEqual(mockResult);
  });
});
