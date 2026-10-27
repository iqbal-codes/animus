import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readControlState, applyControlAction } from "../../apps/engine-host/src/native";

describe("Native machine-state controls", () => {
  test("AC1: halt, unhalt, pause, and unpause are idempotent and mutate brakes properly", () => {
    const tmp = mkdtempSync(join(tmpdir(), "control-test-"));
    try {
      const initial = readControlState(tmp);
      expect(initial.halted).toBe(false);
      expect(initial.paused).toBe(false);
      expect(initial.active_brake).toBe("none");

      // Idempotent halt
      const h1 = applyControlAction(tmp, "halt");
      expect(h1.halted).toBe(true);
      expect(h1.active_brake).toBe("stop");
      const h2 = applyControlAction(tmp, "halt");
      expect(h2.halted).toBe(true);
      expect(h2.active_brake).toBe("stop");

      // Pause while halted -> both
      const p1 = applyControlAction(tmp, "pause");
      expect(p1.halted).toBe(true);
      expect(p1.paused).toBe(true);
      expect(p1.active_brake).toBe("both");

      // Unhalt -> pause remains
      const u1 = applyControlAction(tmp, "unhalt");
      expect(u1.halted).toBe(false);
      expect(u1.paused).toBe(true);
      expect(u1.active_brake).toBe("pause");

      // Unpause -> none
      const u2 = applyControlAction(tmp, "unpause");
      expect(u2.halted).toBe(false);
      expect(u2.paused).toBe(false);
      expect(u2.active_brake).toBe("none");

      // Idempotent unpause when already unpaused
      const u3 = applyControlAction(tmp, "unpause");
      expect(u3.paused).toBe(false);
      expect(u3.active_brake).toBe("none");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("AC3: control state reports truthful brake distinction and never a merge freeze", () => {
    const tmp = mkdtempSync(join(tmpdir(), "control-test-"));
    try {
      mkdirSync(join(tmp, ".factory"), { recursive: true });
      writeFileSync(join(tmp, ".factory/PAUSE"), "Paused\n");
      const state = readControlState(tmp);
      expect(state.paused).toBe(true);
      expect(state.halted).toBe(false);
      expect(state.active_brake).toBe("pause");
      // Check that control state object does not claim a merge freeze
      expect((state as any).merge_freeze).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
