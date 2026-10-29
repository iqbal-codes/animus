import { emitKeypressEvents, type Key } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface WizardChoice {
  value: string;
  label: string;
}

export interface WizardPrompts {
  checkbox(message: string, choices: WizardChoice[], selected: string[]): Promise<string[]>;
  select(
    message: string,
    choices: WizardChoice[],
    initial?: string,
    searchable?: boolean,
  ): Promise<string>;
  text(message: string, initial: string): Promise<string>;
  note(message: string): void;
  close(): void;
}

export class OnboardingCancelled extends Error {
  constructor() {
    super("Setup cancelled. No configuration was saved.");
  }
}

type TerminalInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(value: boolean): void;
};

export class TerminalWizardPrompts implements WizardPrompts {
  private cancel?: () => void;
  constructor(
    private input: TerminalInput = process.stdin,
    private output: Writable = process.stdout,
  ) {
    emitKeypressEvents(input);
  }

  note(message: string): void {
    this.output.write(`${message}\n`);
  }
  close(): void {
    this.cancel?.();
  }

  private question<T>(
    render: () => string,
    keypress: (text: string, key: Key, done: (value: T) => void) => void,
  ): Promise<T> {
    if (!this.input.isTTY || !this.input.setRawMode)
      return Promise.reject(
        new Error("Interactive setup requires a terminal; use --yes for noninteractive setup."),
      );
    return new Promise<T>((resolve, reject) => {
      const wasRaw = this.input.isRaw ?? false;
      const wasFlowing = this.input.readableFlowing === true;
      let lines = 0;
      let settled = false;
      const draw = () => {
        if (lines) this.output.write(`\u001b[${lines}A\r\u001b[0J`);
        const view = render();
        lines = view.split("\n").length;
        this.output.write(`${view}\n`);
      };
      const cleanup = () => {
        this.input.removeListener("keypress", onKey);
        this.input.removeListener("end", abort);
        this.input.removeListener("close", abort);
        this.input.removeListener("error", fail);
        this.output.removeListener("error", fail);
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
        this.cancel = undefined;
        try {
          this.input.setRawMode!(wasRaw);
        } finally {
          if (!wasFlowing) this.input.pause();
        }
      };
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        try {
          cleanup();
        } catch (cleanupError) {
          error ??= cleanupError as Error;
        }
        if (error) reject(error);
        else resolve(value as T);
      };
      const fail = (error: Error) => finish(error);
      const abort = () => finish(new OnboardingCancelled());
      const onKey = (text: string, key: Key) => {
        if (key.name === "escape" || (key.ctrl && ["c", "d"].includes(key.name ?? "")))
          return abort();
        try {
          keypress(text, key, (value) => finish(undefined, value));
          if (!settled) draw();
        } catch (error) {
          finish(error as Error);
        }
      };
      this.cancel = abort;
      this.input.on("keypress", onKey);
      this.input.once("end", abort);
      this.input.once("close", abort);
      this.input.once("error", fail);
      this.output.once("error", fail);
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        this.input.setRawMode!(true);
        this.input.resume();
        draw();
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  checkbox(message: string, choices: WizardChoice[], selected: string[]): Promise<string[]> {
    let index = 0;
    let error = "";
    const checked = new Set(selected);
    return this.question(
      () =>
        `${message} (Up/Down, Space toggle, Enter continue, Esc cancel)\n${choices.map((c, i) => `${i === index ? ">" : " "} [${checked.has(c.value) ? "x" : " "}] ${c.label}`).join("\n")}${error ? `\n${error}` : ""}`,
      (_text, key, done) => {
        if (key.name === "up") index = (index + choices.length - 1) % choices.length;
        if (key.name === "down") index = (index + 1) % choices.length;
        if (key.name === "space") {
          const value = choices[index]!.value;
          if (checked.has(value)) checked.delete(value);
          else checked.add(value);
        }
        if (key.name === "return") {
          const values = choices.filter((c) => checked.has(c.value)).map((c) => c.value);
          if (values.length) done(values);
          else error = "Select at least one harness.";
        }
      },
    );
  }

  select(
    message: string,
    choices: WizardChoice[],
    initial?: string,
    searchable = false,
  ): Promise<string> {
    let index = Math.max(
      0,
      choices.findIndex((c) => c.value === initial),
    );
    let query = "";
    const filtered = () =>
      choices.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()));
    return this.question(
      () => {
        const list = filtered();
        const start = Math.max(0, index - 4);
        const visible = list.slice(start, start + 8);
        return `${message} (Up/Down, Enter/Space select, Esc cancel)${searchable ? `\nSearch: ${query}` : ""}\n${list.length ? visible.map((c, i) => `${i + start === index ? ">" : " "} ${c.label}`).join("\n") : "No matches. Backspace to change search."}${list.length > visible.length ? `\n${index + 1}/${list.length} matches` : ""}`;
      },
      (text, key, done) => {
        const list = filtered();
        if (key.name === "up" && list.length) index = (index + list.length - 1) % list.length;
        else if (key.name === "down" && list.length) index = (index + 1) % list.length;
        else if (["return", "space"].includes(key.name ?? "")) {
          if (list[index]) done(list[index]!.value);
        } else if (searchable && key.name === "backspace") {
          query = query.slice(0, -1);
          index = 0;
        } else if (
          searchable &&
          text &&
          !key.ctrl &&
          !key.meta &&
          Array.from(text).every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          )
        ) {
          query += text;
          index = 0;
        }
      },
    );
  }

  text(message: string, initial: string): Promise<string> {
    let value = "";
    return this.question(
      () => `${message} [${initial}] (Enter accepts default, Esc cancels)\n> ${value}`,
      (text, key, done) => {
        if (key.name === "return") done(value.trim() || initial);
        else if (key.name === "backspace") value = value.slice(0, -1);
        else if (
          text &&
          !key.ctrl &&
          !key.meta &&
          Array.from(text).every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          )
        )
          value += text;
      },
    );
  }
}
