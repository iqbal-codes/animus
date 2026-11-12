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

interface Style {
  bold(text: string): string;
  dim(text: string): string;
  cyan(text: string): string;
  green(text: string): string;
  red(text: string): string;
}

function createStyle(enabled: boolean): Style {
  const wrap =
    (open: number, close: number) =>
    (text: string): string =>
      enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    cyan: wrap(36, 39),
    green: wrap(32, 39),
    red: wrap(31, 39),
  };
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Visible width of a rendered line, ignoring escape sequences. */
function displayWidth(text: string): number {
  return Array.from(text.replace(ANSI_PATTERN, "")).length;
}

/**
 * Rows a rendered view occupies on screen. The terminal reflows anything wider
 * than its column count, so cursor-up arithmetic must count wrapped rows, not
 * newline characters; counting newlines leaves stale copies of long prompts.
 */
export function visualRows(view: string, columns: number): number {
  return view
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line) / columns)), 0);
}

export class TerminalWizardPrompts implements WizardPrompts {
  private cancel?: () => void;
  private readonly style: Style;

  constructor(
    private input: TerminalInput = process.stdin,
    private output: Writable = process.stdout,
  ) {
    emitKeypressEvents(input);
    const isTTYOut = "isTTY" in output && output.isTTY === true;
    this.style = createStyle(isTTYOut && !process.env.NO_COLOR);
  }

  note(message: string): void {
    this.output.write(`${message}\n`);
  }

  close(): void {
    this.cancel?.();
  }

  private columns(): number {
    const width = "columns" in this.output ? this.output.columns : undefined;
    return typeof width === "number" && width > 0 ? Math.max(20, width) : 80;
  }

  private question<T>(
    render: () => string,
    keypress: (text: string, key: Key, done: (value: T) => void) => void,
    summarize?: (value: T) => string,
  ): Promise<T> {
    if (!this.input.isTTY || !this.input.setRawMode)
      return Promise.reject(
        new Error("Interactive setup requires a terminal; use --yes for noninteractive setup."),
      );
    return new Promise<T>((resolve, reject) => {
      const wasRaw = this.input.isRaw ?? false;
      const wasFlowing = this.input.readableFlowing === true;
      let rows = 0;
      let settled = false;
      const erase = () => {
        if (rows) this.output.write(`\u001b[${rows}A\r\u001b[0J`);
      };
      const draw = () => {
        erase();
        const view = render();
        rows = visualRows(view, this.columns());
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
          this.output.write("\u001b[?25h");
        } catch {
          // A closed output cannot restore the cursor; the terminal handles it.
        }
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
        if (error) {
          reject(error);
          return;
        }
        if (summarize && value !== undefined) {
          erase();
          this.output.write(`${summarize(value)}\n`);
        }
        resolve(value as T);
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
        this.output.write("\u001b[?25l");
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
      () => {
        const header = `${this.style.cyan("?")} ${this.style.bold(message)}`;
        const hint = this.style.dim("↑/↓ move · space toggle · enter continue · esc cancel");
        const list = choices
          .map((choice, position) => {
            const pointer = position === index ? this.style.cyan("❯") : " ";
            const box = checked.has(choice.value) ? this.style.green("[x]") : "[ ]";
            return `${pointer} ${box} ${choice.label}`;
          })
          .join("\n");
        return `${header}\n  ${hint}\n${list}${error ? `\n  ${this.style.red(error)}` : ""}`;
      },
      (_text, key, done) => {
        if (key.name === "up") index = (index + choices.length - 1) % choices.length;
        if (key.name === "down") index = (index + 1) % choices.length;
        if (key.name === "space") {
          const value = choices[index]!.value;
          if (checked.has(value)) checked.delete(value);
          else checked.add(value);
        }
        if (key.name === "return") {
          const values = choices.filter((choice) => checked.has(choice.value)).map((c) => c.value);
          if (values.length) done(values);
          else error = "Select at least one harness.";
        }
      },
      (values) =>
        `${this.style.green("✔")} ${message} ${this.style.dim(
          values
            .map((value) => choices.find((choice) => choice.value === value)?.label ?? value)
            .join(", "),
        )}`,
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
      choices.findIndex((choice) => choice.value === initial),
    );
    let query = "";
    const filtered = () =>
      choices.filter((choice) => choice.label.toLowerCase().includes(query.toLowerCase()));
    return this.question(
      () => {
        const list = filtered();
        const start = Math.max(0, index - 4);
        const visible = list.slice(start, start + 8);
        const header = `${this.style.cyan("?")} ${this.style.bold(message)}`;
        const hint = this.style.dim("↑/↓ move · enter select · esc cancel");
        const search = searchable ? `\n  ${this.style.dim("search:")} ${query}` : "";
        const rows = list.length
          ? visible
              .map(
                (choice, position) =>
                  `${position + start === index ? this.style.cyan("❯") : " "} ${choice.label}`,
              )
              .join("\n")
          : "  no matches — backspace to edit";
        const counter =
          list.length > visible.length
            ? `\n  ${this.style.dim(`${index + 1}/${list.length}`)}`
            : "";
        return `${header}${search}\n  ${hint}\n${rows}${counter}`;
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
      (value) =>
        `${this.style.green("✔")} ${message} ${this.style.dim(
          choices.find((choice) => choice.value === value)?.label ?? value,
        )}`,
    );
  }

  text(message: string, initial: string): Promise<string> {
    let value = "";
    return this.question(
      () =>
        `${this.style.cyan("?")} ${this.style.bold(message)} ${this.style.dim(`[${initial}]`)}\n  ${this.style.dim("enter accepts default · esc cancels")}\n${this.style.cyan("❯")} ${value}`,
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
      (answer) => `${this.style.green("✔")} ${message} ${this.style.dim(answer)}`,
    );
  }
}
