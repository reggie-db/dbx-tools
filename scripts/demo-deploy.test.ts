import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deployBundleWithRetry,
  isPermissionDeadlineFailure,
  runDemoApp,
  type DeployCommandResult,
} from "./demo-deploy.ts";

const COMMAND = ["databricks", "bundle", "deploy", "--auto-approve"];
const TRANSIENT_ERROR =
  "Failed to grant permissions for SP 85bb1708-d2a7-4351-ad4e-dbc99fc144ed on database projects/dbx-tools-demo-v2/branches/production/databases/databricks-postgres: deadline exceeded after 998000000ns.";

function result(exitCode: number, stderr = ""): DeployCommandResult {
  return { exitCode, stdout: "", stderr };
}

describe("demo bundle deployment retry", () => {
  it("recognizes only the database permission deadline", () => {
    assert.equal(isPermissionDeadlineFailure(result(1, TRANSIENT_ERROR)), true);
    assert.equal(
      isPermissionDeadlineFailure(
        result(
          1,
          "Failed to grant permissions for SP 85bb1708-d2a7-4351-ad4e-dbc99fc144ed on database projects/dbx-tools-demo-v2/branches/production/databases/databricks-postgres: permission denied.",
        ),
      ),
      false,
    );
    assert.equal(
      isPermissionDeadlineFailure(result(1, "deadline exceeded after 998000000ns.")),
      false,
    );
  });

  it("waits once and succeeds on the second attempt", async () => {
    let attempts = 0;
    const delays: number[] = [];
    await deployBundleWithRetry(COMMAND, ".", {
      run: async () => (++attempts === 1 ? result(1, TRANSIENT_ERROR) : result(0)),
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [15_000]);
  });

  it("stops after the second matching failure", async () => {
    let attempts = 0;
    await assert.rejects(
      deployBundleWithRetry(COMMAND, ".", {
        run: async () => {
          attempts++;
          return result(1, TRANSIENT_ERROR);
        },
        sleep: async () => {},
      }),
      /exited with code 1/,
    );
    assert.equal(attempts, 2);
  });

  it("does not retry unrelated failures", async () => {
    let attempts = 0;
    await assert.rejects(
      deployBundleWithRetry(COMMAND, ".", {
        run: async () => {
          attempts++;
          return result(1, "Error: bundle lock is held");
        },
        sleep: async () => {
          throw new Error("sleep must not run");
        },
      }),
      /exited with code 1/,
    );
    assert.equal(attempts, 1);
  });

  it("returns immediately after an initial success", async () => {
    let attempts = 0;
    await deployBundleWithRetry(COMMAND, ".", {
      run: async () => {
        attempts++;
        return result(0);
      },
      sleep: async () => {
        throw new Error("sleep must not run");
      },
    });
    assert.equal(attempts, 1);
  });

  it("does not start another deploy after backoff is aborted", async () => {
    let attempts = 0;
    let continued = false;
    const controller = new AbortController();
    await assert.rejects(async () => {
      await deployBundleWithRetry(COMMAND, ".", {
        signal: controller.signal,
        run: async () => {
          attempts++;
          return result(1, TRANSIENT_ERROR);
        },
        sleep: async (_ms, signal) =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
            controller.abort(new Error("deployment interrupted"));
          }),
      });
      continued = true;
    }, /deployment interrupted/);
    assert.equal(attempts, 1);
    assert.equal(continued, false);
  });
});

describe("demo app startup logs", () => {
  it("prints app logs before preserving a startup failure", async () => {
    const startupError = new Error("startup failed");
    let logsRead = false;
    await assert.rejects(
      runDemoApp("demo", ["-t", "dev", "--profile", "TEST"], ".", {
        logs: async () => {
          logsRead = true;
        },
        run: async () => {
          throw startupError;
        },
      }),
      (error) => error === startupError,
    );
    assert.equal(logsRead, true);
  });

  it("does not read logs after successful startup", async () => {
    let logsRead = false;
    await runDemoApp("demo", ["-t", "dev"], ".", {
      logs: async () => {
        logsRead = true;
      },
      run: async () => {},
    });
    assert.equal(logsRead, false);
  });
});
