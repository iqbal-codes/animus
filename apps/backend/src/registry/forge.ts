import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface ForgeRepoInfo {
  id: number;
  repoName: string;
}

export interface ForgeIssue {
  number: number;
  title: string;
  state: string; // "OPEN" | "CLOSED"
  body?: string | null;
  labels?: Array<{ name: string } | string>;
  comments?: Array<{ body?: string | null }>;
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
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
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
  listIssues?(repo: string): Promise<ForgeIssue[]>;
  getIssue?(repo: string, issueNumber: number): Promise<ForgeIssue | null>;
  createIssue?(repo: string, input: CreateIssueInput): Promise<ForgeIssue>;
  updateIssue?(repo: string, issueNumber: number, input: UpdateIssueInput): Promise<ForgeIssue>;
  createPullRequest?(repo: string, input: CreatePullRequestInput): Promise<ForgePullRequest>;
  listPullRequests?(repo: string): Promise<ForgePullRequest[]>;
  getPullRequest?(repo: string, prNumber: number): Promise<ForgePullRequest | null>;
  mergePullRequest?(repo: string, prNumber: number): Promise<{ merged: boolean; sha?: string }>;
}

export interface IssueForgeAdapter extends ForgeAdapter {
  listIssues(repo: string): Promise<ForgeIssue[]>;
  getIssue(repo: string, issueNumber: number): Promise<ForgeIssue | null>;
  createIssue(repo: string, input: CreateIssueInput): Promise<ForgeIssue>;
  updateIssue(repo: string, issueNumber: number, input: UpdateIssueInput): Promise<ForgeIssue>;
  createPullRequest(repo: string, input: CreatePullRequestInput): Promise<ForgePullRequest>;
  listPullRequests(repo: string): Promise<ForgePullRequest[]>;
  getPullRequest(repo: string, prNumber: number): Promise<ForgePullRequest | null>;
}

export function assertIssueForge(forge: ForgeAdapter): IssueForgeAdapter {
  if (
    typeof forge.listIssues !== "function" ||
    typeof forge.getIssue !== "function" ||
    typeof forge.createIssue !== "function" ||
    typeof forge.updateIssue !== "function"
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

export class SystemForgeAdapter implements IssueForgeAdapter {
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

  async listIssues(repo: string): Promise<ForgeIssue[]> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    try {
      const output = execFileSync(
        "gh",
        [
          "issue",
          "list",
          "--repo",
          cleanRepo,
          "--state",
          "all",
          "--limit",
          "100",
          "--json",
          "number,title,labels,body,state,comments",
        ],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return JSON.parse(output);
    } catch (error: any) {
      throw new Error(`Failed to list issues for ${cleanRepo}: ${error?.message || String(error)}`);
    }
  }

  async getIssue(repo: string, issueNumber: number): Promise<ForgeIssue | null> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    try {
      const output = execFileSync(
        "gh",
        [
          "issue",
          "view",
          String(issueNumber),
          "--repo",
          cleanRepo,
          "--json",
          "number,title,labels,body,state,comments",
        ],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return JSON.parse(output);
    } catch {
      return null;
    }
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
      const output = execFileSync("gh", args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
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
        execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      }
      if (input.state) {
        const stateLower = input.state.toLowerCase();
        if (stateLower === "closed") {
          execFileSync("gh", ["issue", "close", String(issueNumber), "--repo", cleanRepo], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } else if (stateLower === "open") {
          execFileSync("gh", ["issue", "reopen", String(issueNumber), "--repo", cleanRepo], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          });
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
          "number,title,body,headRefName,baseRefName,state,url",
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
          "number,title,body,headRefName,baseRefName,state,url",
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
      };
    } catch {
      return null;
    }
  }
}

export class SyntheticForgeAdapter implements IssueForgeAdapter {
  private repos = new Map<string, ForgeRepoInfo>();
  private issuesByRepo = new Map<string, Map<number, ForgeIssue>>();
  private pullRequestsByRepo = new Map<string, Map<number, ForgePullRequest>>();
  private labelsByRepo = new Map<string, Map<string, ForgeLabel>>();
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
  public failNextClone = false;
  public failNextCreate = false;

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
    repoMap.set(issue.number, { ...issue });
    return issue;
  }

  async listIssues(repo: string): Promise<ForgeIssue[]> {
    const key = repo.toLowerCase();
    const repoMap = this.issuesByRepo.get(key);
    if (!repoMap) return [];
    return Array.from(repoMap.values()).map((i) => ({ ...i }));
  }

  async getIssue(repo: string, issueNumber: number): Promise<ForgeIssue | null> {
    const key = repo.toLowerCase();
    const repoMap = this.issuesByRepo.get(key);
    if (!repoMap) return null;
    const found = repoMap.get(issueNumber);
    return found ? { ...found } : null;
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
    const key = repo.toLowerCase();
    const prMap = this.pullRequestsByRepo.get(key);
    if (!prMap) return [];
    return Array.from(prMap.values()).map((p) => ({ ...p }));
  }

  async getPullRequest(repo: string, prNumber: number): Promise<ForgePullRequest | null> {
    const key = repo.toLowerCase();
    const prMap = this.pullRequestsByRepo.get(key);
    if (!prMap) return null;
    const found = prMap.get(prNumber);
    return found ? { ...found } : null;
  }

  async createPullRequest(repo: string, input: CreatePullRequestInput): Promise<ForgePullRequest> {
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
    };
    prMap.set(prNumber, pr);
    return { ...pr };
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
