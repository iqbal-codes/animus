import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export function configuration() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { port: { type: "string" }, host: { type: "string", default: "127.0.0.1" } },
    strict: true,
  });
  if (!values.port || !/^\d+$/.test(values.port) || Number(values.port) > 65535)
    throw new Error("Invalid --port");
  if (!["127.0.0.1", "::1"].includes(values.host)) throw new Error("Invalid --host");
  const token = process.env.FACTORY_HOST_TOKEN;
  if (!token || !/^[\x21-\x7e]{32,}$/.test(token)) throw new Error("Invalid FACTORY_HOST_TOKEN");
  let buildId = process.env.FACTORY_RUNTIME_CANDIDATE;
  if (buildId === undefined) {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    });
    if (result.exitCode !== 0) throw new Error("Candidate identity unavailable");
    buildId = result.stdout.toString().trim();
  }
  return { hostname: values.host, port: Number(values.port), token, buildId };
}
