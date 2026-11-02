import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createFactoryClient, FactoryClientError } from "@animus/client";
import type { Project } from "@animus/contracts/operator";

export interface FactoryConnectionOptions {
  factoryUrl?: string;
  factoryToken?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface RegistrationOptions extends FactoryConnectionOptions {
  repoRoot: string;
  name?: string;
  path?: string;
  repo?: string;
}

function factoryUrl(options: FactoryConnectionOptions): URL {
  let url: URL;
  try {
    url = new URL(options.factoryUrl ?? process.env.FACTORY_URL ?? "http://127.0.0.1:3000");
  } catch {
    throw new Error("--factory-url must be an absolute HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "--factory-url must be an HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
  return url;
}

function isLoopback(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

export function createRegistrationClient(options: FactoryConnectionOptions = {}) {
  const url = factoryUrl(options);
  const token = options.factoryToken ?? process.env.FACTORY_TOKEN ?? process.env.FACTORY_HOST_TOKEN;
  if (token && url.protocol !== "https:" && !isLoopback(url)) {
    throw new Error("Operator credentials require HTTPS for a non-loopback factory URL.");
  }
  const transport = options.fetch ?? globalThis.fetch;
  const authenticatedFetch = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const timeout = AbortSignal.timeout(30_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await transport(input, { ...init, headers, signal });
    // Authentication middleware can reject before the API's structured error handler.
    if (response.status === 401 || response.status === 403) {
      return Response.json({ error: "host_unauthorized" }, { status: response.status });
    }
    return response;
  };
  return createFactoryClient({ baseUrl: url.origin, fetch: authenticatedFetch });
}

export function parseGitHubRemoteUrl(value: string): string | null {
  const trimmed = value.trim();
  const patterns = [
    /^https:\/\/(?:[^@\s/]+@)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com(?::\d+)?\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function githubRepo(value: string, allowBare = false): string {
  const parsed = parseGitHubRemoteUrl(value);
  if (parsed) return parsed;
  if (allowBare) {
    const match = /^([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(value.trim());
    if (match?.[1]) return match[1];
  }
  throw new Error("Repository must identify a GitHub owner/repository.");
}

export function verifyGitHubRepositoryPreflight(repoRoot: string): {
  checkoutPath: string;
  repo: string;
} {
  const target = resolve(repoRoot);
  try {
    const isWorkTree = execFileSync("git", ["-C", target, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (isWorkTree.trim() !== "true") {
      throw new Error();
    }
  } catch {
    throw new Error("Local registration requires a Git checkout with a GitHub origin remote.");
  }

  let remote: string;
  try {
    remote = execFileSync("git", ["-C", target, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("Local registration requires a Git checkout with a GitHub origin remote.");
  }

  const repo = parseGitHubRemoteUrl(remote);
  if (!repo) {
    throw new Error("Repository must identify a GitHub owner/repository.");
  }

  return { checkoutPath: realpathSync(target), repo };
}

export async function registerRepository(options: RegistrationOptions): Promise<{
  project: Project;
  status: "registered" | "existing";
}> {
  if (options.repo && options.path)
    throw new Error(
      "Use --repo for a factory-managed clone or --path for a local checkout, not both.",
    );
  const url = factoryUrl(options);
  const clone = options.repo !== undefined;
  let checkout: string | undefined;
  let repo: string;
  if (clone) {
    repo = githubRepo(options.repo!, true);
  } else {
    if (!isLoopback(url)) {
      throw new Error(
        "Cannot verify a local checkout on a remote factory. Use project register --repo <owner/repository> for a factory-managed GitHub clone; no laptop path will be sent.",
      );
    }
    const preflight = verifyGitHubRepositoryPreflight(
      resolve(options.repoRoot, options.path ?? "."),
    );
    checkout = preflight.checkoutPath;
    repo = preflight.repo;
  }
  const client = createRegistrationClient(options);
  const matches = (project: Project) =>
    project.status === "active" &&
    project.repo_name.toLowerCase() === repo.toLowerCase() &&
    (clone || project.checkout_path === checkout);
  try {
    const name = options.name ?? repo.split("/")[1]!;
    const project = clone
      ? await client.registerProject({ method: "github_clone", name, repo })
      : await client.registerProject({ method: "local_checkout", name, checkout_path: checkout! });
    if (!matches(project))
      throw new Error(
        "Factory registration response does not match the requested repository and checkout, or the project is not active.",
      );
    return { project, status: "registered" };
  } catch (error) {
    if (!(error instanceof FactoryClientError) || error.code !== "project_already_exists" || clone)
      throw error;
    const projects = await client.projects();
    const existing = projects.find(matches);
    if (!existing)
      throw new Error(
        "Repository is already registered, but not as an active project at this local checkout. Inspect project list; no checkout was changed.",
      );
    return { project: existing, status: "existing" };
  }
}

export function registrationErrorMessage(error: unknown): string {
  if (error instanceof FactoryClientError) {
    if (error.code === "host_unauthorized")
      return "Factory authentication failed. Set --factory-token or FACTORY_TOKEN (operator token).";
    if (error.code === "transport_unavailable")
      return "Factory is unavailable. Start the factory or check --factory-url / FACTORY_URL.";
    if (error.code === "invalid_operator_response")
      return "Factory returned an invalid API response; registration could not be verified.";
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function completeRepositoryOnboarding<T extends { repoRoot: string }>(
  summary: T,
  options: Omit<RegistrationOptions, "repoRoot"> & { localOnly?: boolean; json?: boolean } = {},
): Promise<number> {
  if (options.localOnly) {
    if (options.json)
      console.log(
        JSON.stringify(
          { ...summary, registration: { status: "skipped", reason: "local-only" } },
          null,
          2,
        ),
      );
    else
      console.log(
        "Local setup complete. Factory enrollment skipped (--local-only); repository is not enrolled.",
      );
    return 0;
  }
  try {
    const registration = await registerRepository({ ...options, repoRoot: summary.repoRoot });
    if (options.json) console.log(JSON.stringify({ ...summary, registration }, null, 2));
    else
      console.log(
        `Local setup complete. Factory project ${registration.project.id} (${registration.project.name}) ${registration.status === "existing" ? "already enrolled" : "enrolled"} at ${registration.project.checkout_path}.`,
      );
    return 0;
  } catch (error) {
    const message = `Local setup complete; factory registration failed: ${registrationErrorMessage(error)}`;
    if (options.json)
      console.log(
        JSON.stringify(
          { ...summary, ok: false, error: message, registration: { status: "failed" } },
          null,
          2,
        ),
      );
    else console.error(message);
    return 1;
  }
}
