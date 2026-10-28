import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface ForgeRepoInfo {
  id: number;
  repoName: string;
}

export interface ForgeAdapter {
  getRepository(repo: string): Promise<ForgeRepoInfo>;
  createRepository(repo: string, isPrivate?: boolean): Promise<ForgeRepoInfo>;
  cloneRepository(repo: string, targetPath: string): Promise<void>;
  detectLocalCheckout(checkoutPath: string): Promise<ForgeRepoInfo>;
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
    const match = config.match(
      /url\s*=\s*(?:git@github\.com:|https:\/\/github\.com\/)([^\s]+?)(?:\.git)?\s*$/m,
    );
    if (match && match[1]) {
      return match[1].replace(/\.git$/, "");
    }
  } catch {
    return null;
  }
  return null;
}

export class SystemForgeAdapter implements ForgeAdapter {
  async getRepository(repo: string): Promise<ForgeRepoInfo> {
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    try {
      const output = execFileSync(
        "gh",
        ["api", `repos/${cleanRepo}`, "--jq", "{id: .id, nameWithOwner: .full_name}"],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const data = JSON.parse(output);
      if (typeof data.id === "number" && data.id > 0) {
        return {
          id: data.id,
          repoName: data.nameWithOwner || cleanRepo,
        };
      }
    } catch {
      // Fallback to gh repo view
    }

    try {
      const output = execFileSync("gh", ["repo", "view", cleanRepo, "--json", "id,nameWithOwner"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const data = JSON.parse(output);
      const rawId = data.id;
      let numId: number;
      if (typeof rawId === "number") {
        numId = rawId;
      } else {
        const digits = String(rawId).replace(/\D/g, "");
        if (digits.length > 0) {
          numId = parseInt(digits.slice(0, 9), 10);
        } else {
          let hash = 0;
          for (let i = 0; i < String(rawId).length; i++) {
            hash = ((hash << 5) - hash + String(rawId).charCodeAt(i)) | 0;
          }
          numId = Math.abs(hash) || 1;
        }
      }
      return {
        id: numId,
        repoName: data.nameWithOwner || cleanRepo,
      };
    } catch (error: any) {
      throw new Error(`Failed to query repository ${repo}: ${error?.message || String(error)}`);
    }
  }

  async createRepository(repo: string, isPrivate = true): Promise<ForgeRepoInfo> {
    const visibilityFlag = isPrivate ? "--private" : "--public";
    try {
      execFileSync("gh", ["repo", "create", repo, visibilityFlag], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return await this.getRepository(repo);
    } catch (error: any) {
      throw new Error(`Failed to create repository ${repo}: ${error?.message || String(error)}`);
    }
  }

  async cloneRepository(repo: string, targetPath: string): Promise<void> {
    try {
      execFileSync("gh", ["repo", "clone", repo, targetPath], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
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
}

export class SyntheticForgeAdapter implements ForgeAdapter {
  private repos = new Map<string, ForgeRepoInfo>();
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
}
