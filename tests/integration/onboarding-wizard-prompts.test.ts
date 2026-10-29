import { describe, expect, test } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { TerminalWizardPrompts } from "../../scripts/cli/commands/onboarding-prompts";

function terminal() {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  let transcript = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      transcript += chunk;
      done();
    },
  });
  const prompts = new TerminalWizardPrompts(input, output);
  return { input, prompts, output, transcript: () => transcript };
}

const choices = [
  { value: "pi", label: "Pi — installed" },
  { value: "codex", label: "Codex — missing" },
];

describe("onboarding keyboard prompts", () => {
  test.each(["\u001b", "\u0003", "\u0004"])(
    "cancellation restores raw mode and listeners (%j)",
    async (key) => {
      const t = terminal();
      const before = process.listenerCount("SIGINT");
      const answer = t.prompts.select("Tier", choices);
      t.input.write(key);
      await expect(answer).rejects.toThrow("cancelled");
      expect(t.input.isRaw).toBe(false);
      expect(t.input.listenerCount("keypress")).toBe(0);
      expect(process.listenerCount("SIGINT")).toBe(before);
      t.prompts.close();
    },
  );

  test.each(["end", "error", "SIGTERM", "close"])(
    "terminal restores its previous state on %s",
    async (event) => {
      const t = terminal();
      t.input.isRaw = true;
      t.input.pause();
      const answer = t.prompts.text("Model", "default");
      if (event === "SIGTERM") process.emit("SIGTERM");
      else if (event === "error") t.input.emit("error", new Error("terminal failed"));
      else if (event === "close") t.prompts.close();
      else t.input.emit("end");
      await expect(answer).rejects.toThrow();
      expect(t.input.isRaw).toBe(true);
      expect(t.input.isPaused()).toBe(true);
      expect(t.input.listenerCount("keypress")).toBe(0);
    },
  );

  test("successful prompts stop a previously idle input stream", async () => {
    const t = terminal();
    const answer = t.prompts.text("Default", "3");
    t.input.write("\r");
    await answer;
    expect(t.input.isPaused()).toBe(true);
  });

  test("output errors reject and restore the terminal", async () => {
    const t = terminal();
    const answer = t.prompts.text("Default", "3");
    t.output.emit("error", new Error("broken output"));
    await expect(answer).rejects.toThrow("broken output");
    expect(t.input.isRaw).toBe(false);
  });

  test("large searchable catalogs render a bounded viewport and scroll to the cursor", async () => {
    const t = terminal();
    const models = Array.from({ length: 100 }, (_, index) => ({
      value: String(index),
      label: `Model ${index}`,
    }));
    const answer = t.prompts.select("Model", models, "90", true);
    expect(t.transcript()).toContain("> Model 90");
    expect(t.transcript().split("\n").length).toBeLessThan(20);
    t.input.write("\r");
    expect(await answer).toBe("90");
  });

  test("search filters harnesses and Space selects the matching row", async () => {
    const t = terminal();
    const answer = t.prompts.select("Harness", choices, "pi", true);
    t.input.write("cod ");
    expect(await answer).toBe("codex");
    t.prompts.close();
  });

  test("text shows default and supports backspace before Enter", async () => {
    const t = terminal();
    const answer = t.prompts.text("Max laps", "3");
    expect(t.transcript()).toContain("[3]");
    t.input.write("19\u007f2\r");
    expect(await answer).toBe("12");
    t.prompts.close();
  });

  test("checkboxes reject empty, toggle with space and navigate with arrows", async () => {
    const t = terminal();
    try {
      const answer = t.prompts.checkbox("Agent harnesses", choices, []);
      t.input.write("\r");
      expect(t.transcript()).toContain("Select at least one");
      t.input.write("\u001b[B \u001b[A \r");
      expect(await answer).toEqual(["pi", "codex"]);
      expect(t.transcript()).toContain("Codex — missing");
      expect(t.input.isRaw).toBe(false);
    } finally {
      t.prompts.close();
    }
  });
});
