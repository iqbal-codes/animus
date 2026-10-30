import { fileURLToPath } from "node:url";

if (import.meta.main) {
  try {
    const [operation, root, repo, number] = process.argv.slice(2);
    if (!root || !repo) throw new Error("Missing GitHub operation scope");
    const factory = new URL("../../../../", import.meta.url);
    if (operation === "backlog") {
      const { fetchGithubBacklog } = await import(
        fileURLToPath(new URL("scripts/scheduler.ts", factory))
      );
      const data = await fetchGithubBacklog(root, repo);
      console.log(JSON.stringify({ ...data, closedNumbers: [...data.closedNumbers] }));
    } else if (operation === "contract") {
      const { readIssueContract } = await import(
        fileURLToPath(new URL("scripts/loop.ts", factory))
      );
      console.log(JSON.stringify(readIssueContract(root, Number(number), repo)));
    } else throw new Error("Unknown GitHub operation");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
