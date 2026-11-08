import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ForgeRepoInfo {
  id: number;
  repoName: string;
}

export interface ForgeComment {
  id?: string;
  author?: string;
  authorAssociation?: string;
  body?: string | null;
}

export type ForgeIssueComment = ForgeComment;

export interface ForgeIssue {
  number: number;
  title: string;
  state: string; // "OPEN" | "CLOSED"
  body?: string | null;
  labels?: Array<{ name: string } | string>;
  comments?: ForgeComment[];
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels?: string[];
}

export interface UpdateIssueInput {
  title?: string;
  body?: string;
  state?: string;
  labels?: string[];
}

export interface ForgePullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: string; // "OPEN" | "CLOSED" | "MERGED"
  html_url?: string;
  draft?: boolean;
  headRefOid?: string;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface UpdatePullRequestInput {
  title?: string;
  body?: string;
  base?: string;
  state?: "open" | "closed";
}

export interface CreatePullRequestReviewInput {
  commitId: string;
  body: string;
  event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  comments?: Array<{ path: string; line: number; side?: "RIGHT" | "LEFT"; body: string }>;
}

export interface ForgePullRequestReview {
  id?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
}

export interface ForgeLabel {
  name: string;
  color: string;
  description: string;
}

export interface ForgeAdapter {
  listLabels?(repo: string): Promise<ForgeLabel[]>;
  createLabel?(repo: string, label: ForgeLabel): Promise<void>;
  getRepository(repo: string): Promise<ForgeRepoInfo>;
  createRepository(repo: string, isPrivate?: boolean): Promise<ForgeRepoInfo>;
  cloneRepository(repo: string, targetPath: string): Promise<void>;
  detectLocalCheckout(checkoutPath: string): Promise<ForgeRepoInfo>;
  /** Defaults to OPEN discovery; ALL includes closed issues for coordination/history. */
  listIssues?(repo: string, state?: "OPEN" | "ALL"): Promise<ForgeIssue[]>;
  /** Targeted states keyed by each unique requested positive issue number; null means unavailable.
   * Implementations must reject transport/partial-response errors, not convert them to null.
   */
  getIssueStates?(repo: string, numbers: number[]): Promise<Map<number, "OPEN" | "CLOSED" | null>>;
  getIssue?(repo: string, issueNumber: number): Promise<ForgeIssue | null>;
  createIssue?(repo: string, input: CreateIssueInput): Promise<ForgeIssue>;
  updateIssue?(repo: string, issueNumber: number, input: UpdateIssueInput): Promise<ForgeIssue>;
  createIssueComment?(repo: string, issueNumber: number, body: string): Promise<ForgeComment>;
  addSubIssue?(repo: string, parentNumber: number, childNumber: number): Promise<void>;
  addIssueDependency?(repo: string, childNumber: number, blockerNumber: number): Promise<void>;
  getSubIssues?(repo: string, parentNumber: number): Promise<number[]>;
  getIssueDependencies?(repo: string, childNumber: number): Promise<number[]>;
  createPullRequest?(repo: string, input: CreatePullRequestInput): Promise<ForgePullRequest>;
  updatePullRequest?(
    repo: string,
    prNumber: number,
    input: UpdatePullRequestInput,
  ): Promise<ForgePullRequest>;
  createPullRequestReview?(
    repo: string,
    prNumber: number,
    input: CreatePullRequestReviewInput,
  ): Promise<ForgePullRequestReview>;
  listPullRequestReviews?(repo: string, prNumber: number): Promise<ForgePullRequestReview[]>;
  listPullRequests?(repo: string): Promise<ForgePullRequest[]>;
  getPullRequest?(repo: string, prNumber: number): Promise<ForgePullRequest | null>;
  mergePullRequest?(repo: string, prNumber: number): Promise<{ merged: boolean; sha?: string }>;
}

export interface IssueForgeAdapter extends ForgeAdapter {
  listIssues(repo: string, state?: "OPEN" | "ALL"): Promise<ForgeIssue[]>;
  getIssue(repo: string, issueNumber: number): Promise<ForgeIssue | null>;
  createIssue(repo: string, input: CreateIssueInput): Promise<ForgeIssue>;
  updateIssue(repo: string, issueNumber: number, input: UpdateIssueInput): Promise<ForgeIssue>;
  createIssueComment(repo: string, issueNumber: number, body: string): Promise<ForgeComment>;
  addSubIssue?(repo: string, parentNumber: number, childNumber: number): Promise<void>;
  addIssueDependency?(repo: string, childNumber: number, blockerNumber: number): Promise<void>;
  getSubIssues?(repo: string, parentNumber: number): Promise<number[]>;
  getIssueDependencies?(repo: string, childNumber: number): Promise<number[]>;
  createPullRequest(repo: string, input: CreatePullRequestInput): Promise<ForgePullRequest>;
  updatePullRequest?(
    repo: string,
    prNumber: number,
    input: UpdatePullRequestInput,
  ): Promise<ForgePullRequest>;
  createPullRequestReview?(
    repo: string,
    prNumber: number,
    input: CreatePullRequestReviewInput,
  ): Promise<ForgePullRequestReview>;
  listPullRequestReviews?(repo: string, prNumber: number): Promise<ForgePullRequestReview[]>;
  listPullRequests(repo: string): Promise<ForgePullRequest[]>;
  getPullRequest(repo: string, prNumber: number): Promise<ForgePullRequest | null>;
}

export function assertIssueForge(forge: ForgeAdapter): IssueForgeAdapter {
  if (
    typeof forge.listIssues !== "function" ||
    typeof forge.getIssue !== "function" ||
    typeof forge.createIssue !== "function" ||
    typeof forge.updateIssue !== "function" ||
    typeof forge.createIssueComment !== "function"
  ) {
    throw new Error("Configured forge adapter does not support issue operations");
  }
  return forge as IssueForgeAdapter;
}

export function resolveGitConfigPath(checkoutPath: string): string | null {
  const gitEntry = join(checkoutPath, ".git");
  if (!existsSync(gitEntry)) {
    return null;
  }
  try {
    const stat = statSync(gitEntry);
    if (stat.isDirectory()) {
      const configPath = join(gitEntry, "config");
      return existsSync(configPath) ? configPath : null;
    }
    if (stat.isFile()) {
      const content = readFileSync(gitEntry, "utf-8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match && match[1]) {
        const gitDir = isAbsolute(match[1]) ? match[1] : resolve(checkoutPath, match[1]);
        if (!existsSync(gitDir)) return null;
        const configInGitDir = join(gitDir, "config");
        if (existsSync(configInGitDir)) return configInGitDir;

        const commondirFile = join(gitDir, "commondir");
        if (existsSync(commondirFile)) {
          const commonRel = readFileSync(commondirFile, "utf-8").trim();
          const commonDir = isAbsolute(commonRel) ? commonRel : resolve(gitDir, commonRel);
          const configInCommon = join(commonDir, "config");
          if (existsSync(configInCommon)) return configInCommon;
        }

        const parentConfig = resolve(gitDir, "..", "..", "config");
        if (existsSync(parentConfig)) return parentConfig;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function parseGitRemote(checkoutPath: string): string | null {
  const configPath = resolveGitConfigPath(checkoutPath);
  if (!configPath) {
    return null;
  }
  try {
    const config = readFileSync(configPath, "utf-8");
    const origin = config.match(/^\s*\[remote\s+"origin"\]\s*\r?\n([^[]*)/m)?.[1];
    const match = origin?.match(
      /^\s*url\s*=\s*(?:git@github\.com:|https:\/\/github\.com\/)([^\s]+?)(?:\.git)?\s*$/m,
    );
    if (match && match[1]) {
      return match[1].replace(/\.git$/, "");
    }
  } catch {
    return null;
  }
  return null;
}

type GraphRecord = Record<string, unknown>;

function graphRecord(value: unknown): GraphRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Incomplete GitHub GraphQL response");
  }
  return value as GraphRecord;
}

function validateIssueNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Invalid issue number");
  }
  return value;
}

function issueState(value: unknown): "OPEN" | "CLOSED" {
  if (value !== "OPEN" && value !== "CLOSED") throw new Error("Invalid GitHub issue state");
  return value;
}

function graphString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Incomplete GitHub GraphQL text");
  return value;
}

const pageFields = "pageInfo { hasNextPage endCursor }";
const commentFields = "id author { login } body";
const issueFields = `number title state body
  labels(first: 100) { nodes { name } ${pageFields} }
  comments(first: 100) { nodes { ${commentFields} } ${pageFields} }`;

export class SystemForgeAdapter implements IssueForgeAdapter {
  /** Full argv transport, including `gh`; rejects command failures. Used by discovery,
   * targeted issue reads and state lookups. Defaults to asynchronous execFile (no shell).
   */
  constructor(
    private readonly runner: (cmd: string[]) => Promise<string> = async (cmd) => {
      try {
        const { stdout } = await execFileAsync(cmd[0]!, cmd.slice(1), {
          encoding: "utf-8",
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
      } catch (error) {
        // gh exits nonzero for GraphQL NOT_FOUND too; validate its envelope below.
        const failure = error as {
          stdout?: unknown;
          code?: unknown;
          killed?: boolean;
          signal?: unknown;
        };
        const stdout = failure.stdout;
        if (
          failure.code === 1 &&
          !failure.killed &&
          !failure.signal &&
          typeof stdout === "string"
        ) {
          try {
            const envelope = graphRecord(JSON.parse(stdout));
            if (Array.isArray(envelope.errors) && envelope.errors.length > 0) return stdout;
          } catch {
            // Not a GraphQL response: preserve the command failure.
          }
        }
        throw error;
      }
    },
  ) {}

  private repositoryVariables(repo: string): Record<string, string> {
    const clean = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(clean)) {
      throw new Error("Invalid GitHub repository name");
    }
    const [owner, name] = clean.split("/");
    return { owner: owner!, name: name! };
  }

  private async graphql(
    query: string,
    variables: Record<string, string | number>,
    nullableFields: string[] = [],
  ): Promise<GraphRecord> {
    const args = ["gh", "api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    }
    const response = graphRecord(JSON.parse(await this.runner(args)));
    const data = graphRecord(response.data);
    const repository = graphRecord(data.repository);
    if (response.errors !== undefined) {
      if (!Array.isArray(response.errors)) throw new Error("Invalid GitHub GraphQL errors");
      for (const raw of response.errors) {
        const error = graphRecord(raw);
        const path = error.path;
        if (
          error.type !== "NOT_FOUND" ||
          !Array.isArray(path) ||
          path.length !== 2 ||
          path[0] !== "repository" ||
          !nullableFields.includes(String(path[1])) ||
          repository[String(path[1])] !== null
        ) {
          throw new Error(`GitHub GraphQL lookup failed: ${JSON.stringify(raw)}`);
        }
      }
    }
    return repository;
  }

  private page(value: unknown, seen: Set<string>): { nodes: unknown[]; cursor: string | null } {
    const connection = graphRecord(value);
    const info = graphRecord(connection.pageInfo);
    if (
      !Array.isArray(connection.nodes) ||
      typeof info.hasNextPage !== "boolean" ||
      (info.endCursor !== null && typeof info.endCursor !== "string")
    ) {
      throw new Error("Incomplete GitHub GraphQL connection");
    }
    let cursor: string | null = null;
    if (info.hasNextPage) {
      cursor = graphString(info.endCursor);
      if (!cursor || seen.has(cursor)) throw new Error("GitHub pagination cursor did not advance");
      seen.add(cursor);
    }
    return { nodes: connection.nodes, cursor };
  }

  private async completeIssue(repo: string, value: unknown): Promise<ForgeIssue> {
    const raw = graphRecord(value);
    const number = validateIssueNumber(raw.number);
    const result: ForgeIssue = {
      number,
      title: graphString(raw.title),
      state: issueState(raw.state),
      body: graphString(raw.body),
      labels: [],
      comments: [],
    };
    for (const field of ["labels", "comments"] as const) {
      const seen = new Set<string>();
      let page = this.page(raw[field], seen);
      for (;;) {
        for (const node of page.nodes) {
          const item = graphRecord(node);
          if (field === "labels") result.labels!.push({ name: graphString(item.name) });
          else {
            const comment: ForgeComment = { body: graphString(item.body) };
            if (typeof item.id === "string") {
              comment.id = item.id;
            } else if (typeof item.id === "number") {
              comment.id = String(item.id);
            }
            if (
              item.author &&
              typeof item.author === "object" &&
              typeof (item.author as GraphRecord).login === "string"
            ) {
              comment.author = (item.author as GraphRecord).login as string;
            } else if (typeof item.author === "string") {
              comment.author = item.author;
            }
            result.comments!.push(comment);
          }
        }
        if (page.cursor === null) break;
        const repository = await this.graphql(
          `query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
            repository(owner: $owner, name: $name) { issue(number: $number) {
              ${field}(first: 100, after: $cursor) { nodes { ${field === "labels" ? "name" : commentFields} } ${pageFields} }
            } }
          }`,
          { ...this.repositoryVariables(repo), number, cursor: page.cursor },
        );
        page = this.page(graphRecord(repository.issue)[field], seen);
      }
    }
    return result;
  }
  async listLabels(repo: string): Promise<ForgeLabel[]> {
    const { stdout } = await execFileAsync(
      "gh",
      ["api", `repos/${repo}/labels`, "--paginate", "--slurp"],
      {
        encoding: "utf-8",
        timeout: 30_000,
      },
    );
    return JSON.parse(stdout).flat();
  }

  async createLabel(repo: string, label: ForgeLabel): Promise<void> {
    try {
      await execFileAsync(
        "gh",
        [
          "api",
          `repos/${repo}/labels`,
          "--method",
          "POST",
          "-f",
          `name=${label.name}`,
          "-f",
          `color=${label.color}`,
          "-f",
          `description=${label.description}`,
        ],
        {
          timeout: 30_000,
        },
      );
    } catch (error) {
      // Another registration may have created the label between list and create.
      if (
        !(await this.listLabels(repo)).some(
          (existing) => existing.name.toLowerCase() === label.name.toLowerCase(),
        )
      )
        throw error;
    }
  }

  async getRepository(repo: string): Promise<ForgeRepoInfo> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(cleanRepo))
      throw new Error("Invalid GitHub repository name");
    const { stdout } = await execFileAsync(
      "gh",
      ["api", `repos/${cleanRepo}`, "--jq", "{id: .id, nameWithOwner: .full_name}"],
      { encoding: "utf-8", timeout: 30_000 },
    );
    const data = JSON.parse(stdout);
    if (!Number.isSafeInteger(data.id) || data.id <= 0 || typeof data.nameWithOwner !== "string")
      throw new Error("GitHub repository identity unavailable");
    return { id: data.id, repoName: data.nameWithOwner };
  }

  async createRepository(repo: string, isPrivate = true): Promise<ForgeRepoInfo> {
    const visibilityFlag = isPrivate ? "--private" : "--public";
    try {
      await execFileAsync("gh", ["repo", "create", repo, visibilityFlag], {
        encoding: "utf-8",
        timeout: 30_000,
      });
      return await this.getRepository(repo);
    } catch (error: any) {
      throw new Error(`Failed to create repository ${repo}: ${error?.message || String(error)}`);
    }
  }

  async cloneRepository(repo: string, targetPath: string): Promise<void> {
    try {
      await execFileAsync("gh", ["repo", "clone", repo, targetPath], {
        encoding: "utf-8",
        timeout: 120_000,
      });
    } catch (error: any) {
      throw new Error(`Failed to clone repository ${repo}: ${error?.message || String(error)}`);
    }
  }

  async detectLocalCheckout(checkoutPath: string): Promise<ForgeRepoInfo> {
    const remote = parseGitRemote(checkoutPath);
    if (!remote) {
      throw new Error(`No GitHub origin remote found in ${checkoutPath}`);
    }
    return await this.getRepository(remote);
  }

  /** Defaults to OPEN; ALL includes both OPEN and CLOSED issues. Full body, labels
   * and comments in either mode. Connections are cursor-paginated in pages of 100
   * without a total cap; any incomplete page rejects.
   */
  async listIssues(repo: string, state: "OPEN" | "ALL" = "OPEN"): Promise<ForgeIssue[]> {
    const variables = this.repositoryVariables(repo);
    const result: ForgeIssue[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const repository = await this.graphql(
        `query($owner: String!, $name: String!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            issues(first: 100, after: $cursor, states: ${state === "ALL" ? "[OPEN, CLOSED]" : "OPEN"}, orderBy: {field: CREATED_AT, direction: ASC}) {
              nodes { ${issueFields} } ${pageFields}
            }
          }
        }`,
        { ...variables, ...(cursor === null ? {} : { cursor }) },
      );
      const page = this.page(repository.issues, seen);
      for (const node of page.nodes) result.push(await this.completeIssue(repo, node));
      cursor = page.cursor;
    } while (cursor !== null);
    return result;
  }

  /** Deduplicated targeted lookups in batches of at most 50 aliases. Empty input
   * makes no request. Null/field-scoped NOT_FOUND means unavailable (also for PR
   * numbers); repository, authorization, transport and other partial errors reject.
   */
  async getIssueStates(
    repo: string,
    numbers: number[],
  ): Promise<Map<number, "OPEN" | "CLOSED" | null>> {
    const variables = this.repositoryVariables(repo);
    const unique = [...new Set(numbers.map(validateIssueNumber))];
    const result = new Map<number, "OPEN" | "CLOSED" | null>();
    for (let offset = 0; offset < unique.length; offset += 50) {
      const batch = unique.slice(offset, offset + 50);
      const aliases = batch.map((number) => `issue_${number}`);
      const repository = await this.graphql(
        `query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            ${batch.map((number, index) => `${aliases[index]}: issue(number: ${number}) { number state }`).join("\n")}
          }
        }`,
        variables,
        aliases,
      );
      for (const number of batch) {
        const value = repository[`issue_${number}`];
        if (value === null) result.set(number, null);
        else {
          const issue = graphRecord(value);
          if (issue.number !== number) throw new Error("GitHub returned the wrong issue");
          result.set(number, issueState(issue.state));
        }
      }
    }
    return result;
  }

  /** Full targeted issue (including CLOSED), paginated labels/comments. Returns
   * null only for explicit null or issue-scoped NOT_FOUND; other failures reject.
   */
  async getIssue(repo: string, issueNumber: number): Promise<ForgeIssue | null> {
    const repository = await this.graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issue(number: $number) { ${issueFields} } }
      }`,
      { ...this.repositoryVariables(repo), number: validateIssueNumber(issueNumber) },
      ["issue"],
    );
    if (repository.issue === null) return null;
    const result = await this.completeIssue(repo, repository.issue);
    if (result.number !== issueNumber) throw new Error("GitHub returned the wrong issue");
    return result;
  }

  async createIssue(repo: string, input: CreateIssueInput): Promise<ForgeIssue> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    const args = [
      "issue",
      "create",
      "--repo",
      cleanRepo,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    for (const label of input.labels || []) {
      args.push("--label", label);
    }
    try {
      const output = await this.runner(["gh", ...args]);
      const match = output.match(/\/issues\/(\d+)/);
      if (!match || !match[1]) {
        throw new Error(`Failed to parse created issue number from gh output: ${output}`);
      }
      const num = parseInt(match[1], 10);
      const created = await this.getIssue(repo, num);
      if (!created) {
        return {
          number: num,
          title: input.title,
          state: "OPEN",
          body: input.body,
          labels: input.labels ? input.labels.map((name) => ({ name })) : [],
          comments: [],
        };
      }
      return created;
    } catch (error: any) {
      throw new Error(
        `Failed to create issue for ${cleanRepo}: ${error?.message || String(error)}`,
      );
    }
  }

  async updateIssue(
    repo: string,
    issueNumber: number,
    input: UpdateIssueInput,
  ): Promise<ForgeIssue> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    const args = ["issue", "edit", String(issueNumber), "--repo", cleanRepo];
    if (input.title !== undefined) args.push("--title", input.title);
    if (input.body !== undefined) args.push("--body", input.body);
    if (input.labels !== undefined) {
      const existing = await this.getIssue(repo, issueNumber);
      const existingLabels = new Set(
        (existing?.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
      );
      const newLabels = new Set(input.labels);
      for (const l of newLabels) {
        if (!existingLabels.has(l)) args.push("--add-label", l);
      }
      for (const l of existingLabels) {
        if (!newLabels.has(l)) args.push("--remove-label", l);
      }
    }
    try {
      if (args.length > 5) {
        await this.runner(["gh", ...args]);
      }
      if (input.state) {
        const stateLower = input.state.toLowerCase();
        if (stateLower === "closed") {
          await this.runner(["gh", "issue", "close", String(issueNumber), "--repo", cleanRepo]);
        } else if (stateLower === "open") {
          await this.runner(["gh", "issue", "reopen", String(issueNumber), "--repo", cleanRepo]);
        }
      }
      const updated = await this.getIssue(repo, issueNumber);
      if (!updated) {
        throw new Error(`Failed to load updated issue #${issueNumber}`);
      }
      return updated;
    } catch (error: any) {
      throw new Error(
        `Failed to update issue #${issueNumber} for ${cleanRepo}: ${error?.message || String(error)}`,
      );
    }
  }

  async createIssueComment(repo: string, issueNumber: number, body: string): Promise<ForgeComment> {
    const { owner, name } = this.repositoryVariables(repo);
    const cleanRepo = `${owner}/${name}`;
    const validNumber = validateIssueNumber(issueNumber);
    if (typeof body !== "string") {
      throw new Error("Issue comment body must be a string");
    }

    const cmd = [
      "gh",
      "issue",
      "comment",
      String(validNumber),
      "--repo",
      cleanRepo,
      "--body",
      body,
    ];

    const output = await this.runner(cmd);
    let id: string | undefined;
    let author: string | undefined;

    if (typeof output === "string") {
      const trimmed = output.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
      ) {
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === "string") {
            const match = parsed.match(/#issuecomment-([A-Za-z0-9_-]+)/);
            if (match) id = match[1];
          } else if (parsed && typeof parsed === "object") {
            const parsedObj = parsed as Record<string, unknown>;
            if (typeof parsedObj.id === "string") {
              id = parsedObj.id;
            } else if (typeof parsedObj.id === "number") {
              id = String(parsedObj.id);
            }
            if (typeof parsedObj.author === "string") {
              author = parsedObj.author;
            } else if (
              parsedObj.author &&
              typeof parsedObj.author === "object" &&
              typeof (parsedObj.author as Record<string, unknown>).login === "string"
            ) {
              author = (parsedObj.author as Record<string, unknown>).login as string;
            } else if (
              parsedObj.user &&
              typeof parsedObj.user === "object" &&
              typeof (parsedObj.user as Record<string, unknown>).login === "string"
            ) {
              author = (parsedObj.user as Record<string, unknown>).login as string;
            }
            if (!id && typeof parsedObj.html_url === "string") {
              const match = parsedObj.html_url.match(/#issuecomment-([A-Za-z0-9_-]+)/);
              if (match) id = match[1];
            }
          }
        } catch {
          // not JSON, fall through
        }
      }
      if (!id) {
        const match = trimmed.match(/#issuecomment-([A-Za-z0-9_-]+)/);
        if (match) {
          id = match[1];
        }
      }
    }

    const result: ForgeComment = { body };
    if (id !== undefined) {
      result.id = id;
    }
    if (author !== undefined) {
      result.author = author;
    }
    return result;
  }

  private async resolveIssueDatabaseId(cleanRepo: string, issueNumber: number): Promise<number> {
    const num = validateIssueNumber(issueNumber);
    const endpoint = `repos/${cleanRepo}/issues/${num}`;
    const output = await this.runner(["gh", "api", endpoint]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (err: any) {
      throw new Error(
        `Failed to parse issue #${num} JSON from gh api: ${err?.message || String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid issue #${num} response shape: expected object`);
    }
    const id = (parsed as Record<string, unknown>).id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      throw new Error(
        `Invalid or missing numeric database ID in issue #${num} response: ${JSON.stringify(id)}`,
      );
    }
    return id;
  }

  async addSubIssue(repo: string, parentNumber: number, childNumber: number): Promise<void> {
    const { owner, name } = this.repositoryVariables(repo);
    const cleanRepo = `${owner}/${name}`;
    const pNum = validateIssueNumber(parentNumber);
    const cNum = validateIssueNumber(childNumber);

    const childDatabaseId = await this.resolveIssueDatabaseId(cleanRepo, cNum);
    const endpoint = `repos/${cleanRepo}/issues/${pNum}/sub_issues`;
    const cmd = [
      "gh",
      "api",
      "--method",
      "POST",
      endpoint,
      "-F",
      `sub_issue_id=${childDatabaseId}`,
    ];
    await this.runner(cmd);
  }

  async getSubIssues(repo: string, parentNumber: number): Promise<number[]> {
    const { owner, name } = this.repositoryVariables(repo);
    const cleanRepo = `${owner}/${name}`;
    const pNum = validateIssueNumber(parentNumber);
    const endpoint = `repos/${cleanRepo}/issues/${pNum}/sub_issues`;
    const output = await this.runner(["gh", "api", "--paginate", "--slurp", endpoint]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (err: any) {
      throw new Error(
        `Failed to parse sub_issues JSON for issue #${pNum}: ${err?.message || String(err)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid sub_issues response shape for issue #${pNum}: expected array`);
    }
    const rawItems: unknown[] =
      parsed.length > 0 && Array.isArray(parsed[0]) ? (parsed as unknown[][]).flat() : parsed;

    const result: number[] = [];
    for (const item of rawItems) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Invalid sub_issue item shape in #${pNum}: expected object`);
      }
      const num = (item as Record<string, unknown>).number ?? (item as Record<string, unknown>).id;
      if (typeof num !== "number" || !Number.isInteger(num) || num <= 0) {
        throw new Error(`Invalid or missing issue number/id in sub_issue item for #${pNum}`);
      }
      result.push(num);
    }
    return result;
  }

  async addIssueDependency(
    repo: string,
    childNumber: number,
    blockerNumber: number,
  ): Promise<void> {
    const { owner, name } = this.repositoryVariables(repo);
    const cleanRepo = `${owner}/${name}`;
    const cNum = validateIssueNumber(childNumber);
    const bNum = validateIssueNumber(blockerNumber);

    const blockerDatabaseId = await this.resolveIssueDatabaseId(cleanRepo, bNum);
    const endpoint = `repos/${cleanRepo}/issues/${cNum}/dependencies/blocked_by`;
    const cmd = ["gh", "api", "--method", "POST", endpoint, "-F", `issue_id=${blockerDatabaseId}`];
    await this.runner(cmd);
  }

  async getIssueDependencies(repo: string, childNumber: number): Promise<number[]> {
    const { owner, name } = this.repositoryVariables(repo);
    const cleanRepo = `${owner}/${name}`;
    const cNum = validateIssueNumber(childNumber);
    const endpoint = `repos/${cleanRepo}/issues/${cNum}/dependencies/blocked_by`;
    const output = await this.runner(["gh", "api", "--paginate", "--slurp", endpoint]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (err: any) {
      throw new Error(
        `Failed to parse dependencies JSON for issue #${cNum}: ${err?.message || String(err)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid dependencies response shape for issue #${cNum}: expected array`);
    }
    const rawItems: unknown[] =
      parsed.length > 0 && Array.isArray(parsed[0]) ? (parsed as unknown[][]).flat() : parsed;

    const result: number[] = [];
    for (const item of rawItems) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Invalid dependency item shape in #${cNum}: expected object`);
      }
      const num = (item as Record<string, unknown>).number ?? (item as Record<string, unknown>).id;
      if (typeof num !== "number" || !Number.isInteger(num) || num <= 0) {
        throw new Error(`Invalid or missing issue number/id in dependency item for #${cNum}`);
      }
      result.push(num);
    }
    return result;
  }

  async createPullRequest(repo: string, input: CreatePullRequestInput): Promise<ForgePullRequest> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    const args = [
      "pr",
      "create",
      "--repo",
      cleanRepo,
      "--title",
      input.title,
      "--body",
      input.body,
      "--head",
      input.head,
      "--base",
      input.base,
    ];
    if (input.draft) args.push("--draft");
    try {
      const output = execFileSync("gh", args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const match = output.match(/\/pull\/(\d+)/);
      const prNumber = match && match[1] ? parseInt(match[1], 10) : 1;
      return {
        number: prNumber,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        state: "OPEN",
        html_url: output.trim(),
      };
    } catch (error: any) {
      throw new Error(
        `Failed to create pull request for ${cleanRepo}: ${error?.message || String(error)}`,
      );
    }
  }

  async listPullRequests(repo: string): Promise<ForgePullRequest[]> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    try {
      const output = execFileSync(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          cleanRepo,
          "--state",
          "all",
          "--limit",
          "100",
          "--json",
          "number,title,body,headRefName,baseRefName,state,url,isDraft,headRefOid",
        ],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const items = JSON.parse(output);
      return items.map((i: any) => ({
        number: i.number,
        title: i.title,
        body: i.body || "",
        head: i.headRefName,
        base: i.baseRefName,
        state: i.state,
        html_url: i.url,
        draft: Boolean(i.isDraft),
        ...(typeof i.headRefOid === "string" ? { headRefOid: i.headRefOid } : {}),
      }));
    } catch (error: any) {
      throw new Error(
        `Failed to list pull requests for ${cleanRepo}: ${error?.message || String(error)}`,
      );
    }
  }

  async getPullRequest(repo: string, prNumber: number): Promise<ForgePullRequest | null> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    try {
      const output = execFileSync(
        "gh",
        [
          "pr",
          "view",
          String(prNumber),
          "--repo",
          cleanRepo,
          "--json",
          "number,title,body,headRefName,baseRefName,state,url,isDraft,headRefOid",
        ],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const i = JSON.parse(output);
      return {
        number: i.number,
        title: i.title,
        body: i.body || "",
        head: i.headRefName,
        base: i.baseRefName,
        state: i.state,
        html_url: i.url,
        draft: Boolean(i.isDraft),
        ...(typeof i.headRefOid === "string" ? { headRefOid: i.headRefOid } : {}),
      };
    } catch {
      return null;
    }
  }

  async updatePullRequest(
    repo: string,
    prNumber: number,
    input: UpdatePullRequestInput,
  ): Promise<ForgePullRequest> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    const args =
      input.state === "closed"
        ? ["pr", "close", String(prNumber), "--repo", cleanRepo]
        : (() => {
            const next = ["pr", "edit", String(prNumber), "--repo", cleanRepo];
            if (input.title !== undefined) next.push("--title", input.title);
            if (input.body !== undefined) next.push("--body", input.body);
            if (input.base !== undefined) next.push("--base", input.base);
            return next;
          })();
    try {
      execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error: any) {
      throw new Error(
        `Failed to update pull request ${prNumber} for ${cleanRepo}: ${error?.message || String(error)}`,
      );
    }
    const updated = await this.getPullRequest(cleanRepo, prNumber);
    if (!updated) {
      throw new Error(`Pull request ${prNumber} disappeared after update`);
    }
    return updated;
  }

  async createPullRequestReview(
    repo: string,
    prNumber: number,
    input: CreatePullRequestReviewInput,
  ): Promise<ForgePullRequestReview> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    const [owner, name] = cleanRepo.split("/");
    if (!owner || !name) throw new Error(`Invalid repository '${repo}'`);
    const dir = mkdtempSync(join(tmpdir(), "animus-pr-review-"));
    const payloadPath = join(dir, "review.json");
    writeFileSync(
      payloadPath,
      JSON.stringify({
        commit_id: input.commitId,
        body: input.body,
        event: input.event ?? "COMMENT",
        comments: (input.comments ?? []).map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side ?? "RIGHT",
          body: comment.body,
        })),
      }),
      "utf-8",
    );
    try {
      const output = execFileSync(
        "gh",
        [
          "api",
          `repos/${owner}/${name}/pulls/${prNumber}/reviews`,
          "--method",
          "POST",
          "--input",
          payloadPath,
        ],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const parsed = JSON.parse(output || "{}");
      return {
        ...(parsed.id !== undefined ? { id: String(parsed.id) } : {}),
        body: parsed.body ?? input.body,
        ...(typeof parsed.state === "string" ? { state: parsed.state } : {}),
        ...(typeof parsed.html_url === "string" ? { html_url: parsed.html_url } : {}),
      };
    } catch (error: any) {
      throw new Error(
        `Failed to create pull request review ${prNumber} for ${cleanRepo}: ${error?.message || String(error)}`,
      );
    }
  }

  async listPullRequestReviews(repo: string, prNumber: number): Promise<ForgePullRequestReview[]> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    const [owner, name] = cleanRepo.split("/");
    if (!owner || !name) throw new Error(`Invalid repository '${repo}'`);
    try {
      const output = execFileSync(
        "gh",
        ["api", `repos/${owner}/${name}/pulls/${prNumber}/reviews`, "--paginate"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const items = JSON.parse(output || "[]");
      return items.map((item: any) => ({
        ...(item.id !== undefined ? { id: String(item.id) } : {}),
        body: item.body ?? null,
        ...(typeof item.state === "string" ? { state: item.state } : {}),
        ...(typeof item.html_url === "string" ? { html_url: item.html_url } : {}),
      }));
    } catch (error: any) {
      throw new Error(
        `Failed to list pull request reviews ${prNumber} for ${cleanRepo}: ${error?.message || String(error)}`,
      );
    }
  }
}

export class SyntheticForgeAdapter implements IssueForgeAdapter {
  private repos = new Map<string, ForgeRepoInfo>();
  private issuesByRepo = new Map<string, Map<number, ForgeIssue>>();
  private pullRequestsByRepo = new Map<string, Map<number, ForgePullRequest>>();
  private pullRequestReviews = new Map<string, Map<number, ForgePullRequestReview[]>>();
  private labelsByRepo = new Map<string, Map<string, ForgeLabel>>();
  private subIssues = new Map<string, Map<number, Set<number>>>();
  private issueDependencies = new Map<string, Map<number, Set<number>>>();
  public failNextLabel = false;

  async listLabels(repo: string): Promise<ForgeLabel[]> {
    await this.getRepository(repo);
    return [...(this.labelsByRepo.get(repo.toLowerCase())?.values() ?? [])].map((label) => ({
      ...label,
    }));
  }

  async createLabel(repo: string, label: ForgeLabel): Promise<void> {
    await this.getRepository(repo);
    if (this.failNextLabel) {
      this.failNextLabel = false;
      throw new Error("Synthetic forge label creation failed");
    }
    let labels = this.labelsByRepo.get(repo.toLowerCase());
    if (!labels) {
      labels = new Map();
      this.labelsByRepo.set(repo.toLowerCase(), labels);
    }
    if (!labels.has(label.name.toLowerCase())) labels.set(label.name.toLowerCase(), { ...label });
  }

  private nextId = 1000;
  private nextCommentId = 1;
  public failNextClone = false;
  public failNextCreate = false;
  public failNextComment = false;
  public failNextPullRequest = false;
  public failNextUpdate = false;
  public failNextReview = false;
  public failNextGetPullRequest = false;
  public failNextListPullRequests = false;

  constructor(initialRepos?: Record<string, number>) {
    if (initialRepos) {
      for (const [name, id] of Object.entries(initialRepos)) {
        this.repos.set(name.toLowerCase(), { id, repoName: name });
      }
    }
  }

  addRepository(repoName: string, id?: number): ForgeRepoInfo {
    const assignedId = id ?? this.nextId++;
    const info: ForgeRepoInfo = { id: assignedId, repoName };
    this.repos.set(repoName.toLowerCase(), info);
    return info;
  }

  addIssue(repo: string, issue: ForgeIssue): ForgeIssue {
    const key = repo.toLowerCase();
    let repoMap = this.issuesByRepo.get(key);
    if (!repoMap) {
      repoMap = new Map<number, ForgeIssue>();
      this.issuesByRepo.set(key, repoMap);
    }
    repoMap.set(issue.number, {
      ...issue,
      body: issue.body === undefined ? "" : issue.body,
      labels: issue.labels ? [...issue.labels] : [],
      comments: issue.comments ? issue.comments.map((c) => ({ ...c })) : [],
    });
    return issue;
  }

  async listIssues(repo: string, state: "OPEN" | "ALL" = "OPEN"): Promise<ForgeIssue[]> {
    const key = repo.toLowerCase();
    const repoMap = this.issuesByRepo.get(key);
    if (!repoMap) return [];
    return Array.from(repoMap.values())
      .filter((issue) => state === "ALL" || issue.state === "OPEN")
      .map((i) => ({
        ...i,
        labels: i.labels ? [...i.labels] : [],
        comments: i.comments ? i.comments.map((c) => ({ ...c })) : [],
      }));
  }

  async getIssue(repo: string, issueNumber: number): Promise<ForgeIssue | null> {
    const key = repo.toLowerCase();
    const repoMap = this.issuesByRepo.get(key);
    if (!repoMap) return null;
    const found = repoMap.get(issueNumber);
    if (!found) return null;
    return {
      ...found,
      labels: found.labels ? [...found.labels] : [],
      comments: found.comments ? found.comments.map((c) => ({ ...c })) : [],
    };
  }

  async createIssueComment(repo: string, issueNumber: number, body: string): Promise<ForgeComment> {
    if (this.failNextComment) {
      this.failNextComment = false;
      throw new Error("Synthetic forge comment creation failed");
    }
    const key = repo.toLowerCase();
    const repoMap = this.issuesByRepo.get(key);
    if (!repoMap || !repoMap.has(issueNumber)) {
      throw new Error(`Issue #${issueNumber} not found in repository ${repo}`);
    }
    const issue = repoMap.get(issueNumber)!;
    const commentId = String(this.nextCommentId++);
    const comment: ForgeComment = {
      id: commentId,
      body,
    };
    if (!issue.comments) {
      issue.comments = [];
    }
    issue.comments.push({ ...comment });
    return { ...comment };
  }

  editIssueComment(repo: string, issueNumber: number, commentId: string, newBody: string): void {
    const key = repo.toLowerCase();
    const repoMap = this.issuesByRepo.get(key);
    const issue = repoMap?.get(issueNumber);
    if (issue && issue.comments) {
      const comment = issue.comments.find((c) => c.id === commentId);
      if (comment) {
        comment.body = newBody;
      }
    }
  }

  async addSubIssue(repo: string, parentNumber: number, childNumber: number): Promise<void> {
    const key = repo.toLowerCase();
    const repoMap = this.issuesByRepo.get(key);
    if (!repoMap || !repoMap.has(parentNumber) || !repoMap.has(childNumber)) {
      throw new Error(
        `Parent #${parentNumber} or child #${childNumber} not found in repository ${repo}`,
      );
    }
    let repoSub = this.subIssues.get(key);
    if (!repoSub) {
      repoSub = new Map();
      this.subIssues.set(key, repoSub);
    }
    let subs = repoSub.get(parentNumber);
    if (!subs) {
      subs = new Set();
      repoSub.set(parentNumber, subs);
    }
    subs.add(childNumber);
  }

  async getSubIssues(repo: string, parentNumber: number): Promise<number[]> {
    const key = repo.toLowerCase();
    return Array.from(this.subIssues.get(key)?.get(parentNumber) ?? []);
  }

  async addIssueDependency(
    repo: string,
    childNumber: number,
    blockerNumber: number,
  ): Promise<void> {
    const key = repo.toLowerCase();
    const repoMap = this.issuesByRepo.get(key);
    if (!repoMap || !repoMap.has(childNumber) || !repoMap.has(blockerNumber)) {
      throw new Error(
        `Child #${childNumber} or blocker #${blockerNumber} not found in repository ${repo}`,
      );
    }
    let repoDeps = this.issueDependencies.get(key);
    if (!repoDeps) {
      repoDeps = new Map();
      this.issueDependencies.set(key, repoDeps);
    }
    let deps = repoDeps.get(childNumber);
    if (!deps) {
      deps = new Set();
      repoDeps.set(childNumber, deps);
    }
    deps.add(blockerNumber);
  }

  async getIssueDependencies(repo: string, childNumber: number): Promise<number[]> {
    const key = repo.toLowerCase();
    return Array.from(this.issueDependencies.get(key)?.get(childNumber) ?? []);
  }

  async createIssue(repo: string, input: CreateIssueInput): Promise<ForgeIssue> {
    const key = repo.toLowerCase();
    let repoMap = this.issuesByRepo.get(key);
    if (!repoMap) {
      repoMap = new Map<number, ForgeIssue>();
      this.issuesByRepo.set(key, repoMap);
    }
    const maxNum = Array.from(repoMap.keys()).reduce((max, n) => Math.max(max, n), 0);
    const issueNumber = maxNum + 1;
    const issue: ForgeIssue = {
      number: issueNumber,
      title: input.title,
      state: "OPEN",
      body: input.body,
      labels: input.labels ? input.labels.map((name) => ({ name })) : [],
      comments: [],
    };
    repoMap.set(issueNumber, issue);
    return { ...issue };
  }

  async updateIssue(
    repo: string,
    issueNumber: number,
    input: UpdateIssueInput,
  ): Promise<ForgeIssue> {
    const key = repo.toLowerCase();
    const repoMap = this.issuesByRepo.get(key);
    if (!repoMap || !repoMap.has(issueNumber)) {
      throw new Error(`Issue #${issueNumber} not found in repository ${repo}`);
    }
    const existing = repoMap.get(issueNumber)!;
    if (input.title !== undefined) existing.title = input.title;
    if (input.body !== undefined) existing.body = input.body;
    if (input.state !== undefined) existing.state = input.state.toUpperCase();
    if (input.labels !== undefined) {
      existing.labels = input.labels.map((name) => ({ name }));
    }
    return { ...existing };
  }

  async getRepository(repo: string): Promise<ForgeRepoInfo> {
    const found = this.repos.get(repo.toLowerCase());
    if (!found) {
      throw new Error(`Repository ${repo} not found in synthetic forge`);
    }
    return found;
  }

  async createRepository(repo: string, _isPrivate?: boolean): Promise<ForgeRepoInfo> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("Synthetic forge repository creation failed");
    }
    const info = this.addRepository(repo);
    return info;
  }

  async cloneRepository(repo: string, targetPath: string): Promise<void> {
    if (this.failNextClone) {
      this.failNextClone = false;
      throw new Error("Synthetic forge repository clone failed");
    }
    const found = await this.getRepository(repo);
    // Create minimal git structure at targetPath
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(targetPath, ".git"), { recursive: true });
    writeFileSync(
      join(targetPath, ".git", "config"),
      `[remote "origin"]\n  url = https://github.com/${found.repoName}.git\n`,
    );
  }

  async detectLocalCheckout(checkoutPath: string): Promise<ForgeRepoInfo> {
    const remote = parseGitRemote(checkoutPath);
    if (!remote) {
      throw new Error(`No GitHub origin remote found in ${checkoutPath}`);
    }
    let found = this.repos.get(remote.toLowerCase());
    if (!found) {
      // Register it automatically in synthetic forge for local checkout test fixtures
      found = this.addRepository(remote);
    }
    return found;
  }

  addPullRequest(repo: string, pr: ForgePullRequest): ForgePullRequest {
    const key = repo.toLowerCase();
    let prMap = this.pullRequestsByRepo.get(key);
    if (!prMap) {
      prMap = new Map<number, ForgePullRequest>();
      this.pullRequestsByRepo.set(key, prMap);
    }
    prMap.set(pr.number, { ...pr });
    return pr;
  }

  async listPullRequests(repo: string): Promise<ForgePullRequest[]> {
    if (this.failNextListPullRequests) {
      this.failNextListPullRequests = false;
      throw new Error("Synthetic forge pull request listing failed");
    }
    const key = repo.toLowerCase();
    const prMap = this.pullRequestsByRepo.get(key);
    if (!prMap) return [];
    return Array.from(prMap.values()).map((p) => ({ ...p }));
  }

  async getPullRequest(repo: string, prNumber: number): Promise<ForgePullRequest | null> {
    if (this.failNextGetPullRequest) {
      this.failNextGetPullRequest = false;
      throw new Error("Synthetic forge pull request read failed");
    }
    const key = repo.toLowerCase();
    const prMap = this.pullRequestsByRepo.get(key);
    if (!prMap) return null;
    const found = prMap.get(prNumber);
    return found ? { ...found } : null;
  }

  async createPullRequest(repo: string, input: CreatePullRequestInput): Promise<ForgePullRequest> {
    if (this.failNextPullRequest) {
      this.failNextPullRequest = false;
      throw new Error("Synthetic forge pull request creation failed");
    }
    const key = repo.toLowerCase();
    let prMap = this.pullRequestsByRepo.get(key);
    if (!prMap) {
      prMap = new Map<number, ForgePullRequest>();
      this.pullRequestsByRepo.set(key, prMap);
    }
    const maxNum = Array.from(prMap.keys()).reduce((max, n) => Math.max(max, n), 0);
    const prNumber = maxNum + 1;
    const pr: ForgePullRequest = {
      number: prNumber,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      state: "OPEN",
      html_url: `https://github.com/${repo}/pull/${prNumber}`,
      draft: Boolean(input.draft),
    };
    prMap.set(prNumber, pr);
    // GitHub issues and pull requests share the comment surface. Mirror the PR
    // into the issue map so comments and read-back behave like the real forge.
    let issueMap = this.issuesByRepo.get(key);
    if (!issueMap) {
      issueMap = new Map<number, ForgeIssue>();
      this.issuesByRepo.set(key, issueMap);
    }
    if (!issueMap.has(prNumber)) {
      issueMap.set(prNumber, {
        number: prNumber,
        title: input.title,
        body: input.body,
        state: "OPEN",
        labels: [],
        comments: [],
      });
    }
    return { ...pr };
  }

  async updatePullRequest(
    repo: string,
    prNumber: number,
    input: UpdatePullRequestInput,
  ): Promise<ForgePullRequest> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("Synthetic forge pull request update failed");
    }
    const key = repo.toLowerCase();
    const pr = this.pullRequestsByRepo.get(key)?.get(prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found in repository ${repo}`);
    if (input.title !== undefined) pr.title = input.title;
    if (input.body !== undefined) pr.body = input.body;
    if (input.base !== undefined) pr.base = input.base;
    if (input.state === "closed") pr.state = "CLOSED";
    if (input.state === "open") pr.state = "OPEN";
    return { ...pr };
  }

  async createPullRequestReview(
    repo: string,
    prNumber: number,
    input: CreatePullRequestReviewInput,
  ): Promise<ForgePullRequestReview> {
    if (this.failNextReview) {
      this.failNextReview = false;
      throw new Error("Synthetic forge pull request review failed");
    }
    const key = repo.toLowerCase();
    const prMap = this.pullRequestsByRepo.get(key);
    if (!prMap || !prMap.has(prNumber)) {
      throw new Error(`PR #${prNumber} not found in repository ${repo}`);
    }
    let byPr = this.pullRequestReviews.get(key);
    if (!byPr) {
      byPr = new Map();
      this.pullRequestReviews.set(key, byPr);
    }
    const list = byPr.get(prNumber) ?? [];
    const review: ForgePullRequestReview = {
      id: String(list.length + 1),
      body: input.body,
      state: input.event ?? "COMMENT",
    };
    list.push(review);
    byPr.set(prNumber, list);
    return { ...review };
  }

  async listPullRequestReviews(repo: string, prNumber: number): Promise<ForgePullRequestReview[]> {
    const key = repo.toLowerCase();
    return [...(this.pullRequestReviews.get(key)?.get(prNumber) ?? [])].map((review) => ({
      ...review,
    }));
  }

  async mergePullRequest(
    repo: string,
    prNumber: number,
  ): Promise<{ merged: boolean; sha?: string }> {
    const key = repo.toLowerCase();
    const prMap = this.pullRequestsByRepo.get(key);
    if (!prMap || !prMap.has(prNumber)) {
      throw new Error(`PR #${prNumber} not found in repository ${repo}`);
    }
    const pr = prMap.get(prNumber)!;
    pr.state = "MERGED";
    return { merged: true, sha: `merged_sha_${prNumber}` };
  }
}
