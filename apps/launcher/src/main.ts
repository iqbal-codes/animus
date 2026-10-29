import { parseArgs } from "node:util";
import { FactoryLauncher } from "./launcher";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "3000" },
    "remote-access": { type: "boolean", default: false },
  },
  strict: true,
});

const launcher = new FactoryLauncher({
  host: values.host,
  port: Number(values.port),
  remoteAccess: values["remote-access"],
});

console.log(`Starting Software Factory Console on ${values.host}:${values.port}...`);
const result = await launcher.start();

if (result.status === "partial_startup_failure") {
  console.error("Factory startup failed:", result.error);
  process.exit(1);
}

console.log(`Software Factory Console running at ${result.backendUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`\nStopping Software Factory Console...`);
    const stopResult = await launcher.stop();
    if (stopResult.status === "partial_shutdown_failure") {
      console.error("Factory shutdown partial failure:", stopResult.failed);
      process.exit(1);
    }
    process.exit(0);
  });
}
