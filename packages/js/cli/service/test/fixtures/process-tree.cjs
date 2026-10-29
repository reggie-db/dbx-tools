const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const [statePath, role = "parent"] = process.argv.slice(2);

process.on("SIGTERM", () => process.exit(0));

if (role === "parent") {
  const child = spawn(process.execPath, [__filename, statePath, "child"], {
    stdio: "ignore",
  });
  writeFileSync(statePath, JSON.stringify({ parentPid: process.pid, childPid: child.pid }));
}

setInterval(() => undefined, 1_000);
