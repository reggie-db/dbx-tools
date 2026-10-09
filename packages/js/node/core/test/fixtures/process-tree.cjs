const { spawn } = require("node:child_process");

/**
 * Process-tree fixture whose processes exit, retain SIGTERM, or create a late
 * descendant so tests can exercise process-tree shutdown behavior.
 */
const mode = process.argv[2];
const role = process.argv[3] ?? "parent";
let lateStarted = false;

function spawnChild(childMode) {
  return spawn(process.execPath, [__filename, childMode, "child"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
}

process.on("SIGTERM", () => {
  if (mode === "graceful") process.exit(0);
  if (mode === "force") process.stdout.write(`term:${role}\n`);
  if (mode === "late" && role === "parent" && !lateStarted) {
    lateStarted = true;
    const lateChild = spawnChild("graceful");
    lateChild.stdout.once("data", () => {
      process.stdout.write(`late:${lateChild.pid}\n`);
    });
  }
});

if (role === "child") {
  process.stdout.write("ready\n");
} else {
  const child = spawnChild(mode);
  child.stdout.once("data", () => {
    process.stdout.write(`ready:${child.pid}\n`);
  });
}

setInterval(() => {}, 1_000);
