import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FileSystemError, inferFileSystemErrorCode, mapFileSystemError } from "../src/base-fs.ts";

describe("filesystem error helpers", () => {
  it("infers codes from HTTP status and message tokens", () => {
    assert.equal(
      inferFileSystemErrorCode(Object.assign(new Error("missing"), { statusCode: 404 })),
      "NOT_FOUND",
    );
    assert.equal(inferFileSystemErrorCode(new Error("path does not exist")), "NOT_FOUND");
    assert.equal(inferFileSystemErrorCode(new Error("file already exists")), "ALREADY_EXISTS");
    assert.equal(inferFileSystemErrorCode(new Error("not a directory")), "NOT_DIRECTORY");
    assert.equal(inferFileSystemErrorCode(new Error("path is a directory")), "IS_DIRECTORY");
    assert.equal(inferFileSystemErrorCode(new Error("directory not empty")), "DIRECTORY_NOT_EMPTY");
    assert.equal(inferFileSystemErrorCode(new Error("permission denied")), "PERMISSION_DENIED");
    assert.equal(inferFileSystemErrorCode(new Error("filesystem is read only")), "READ_ONLY");
    assert.equal(inferFileSystemErrorCode(new Error("connection reset")), undefined);
  });

  it("mapFileSystemError uses shared-core message/cause and optional classifier", () => {
    const cause = { message: "boom", statusCode: 404 };
    const mapped = mapFileSystemError(cause, "/x");
    assert.ok(mapped instanceof FileSystemError);
    assert.equal(mapped.code, "NOT_FOUND");
    assert.equal(mapped.message, "boom");
    assert.equal(mapped.path, "/x");
    assert.ok(mapped.cause instanceof Error);
    assert.equal((mapped.cause as Error).message, "boom");

    const overridden = mapFileSystemError(cause, "/y", () => "IO_ERROR");
    assert.equal(overridden.code, "IO_ERROR");

    const passthrough = mapFileSystemError(
      new FileSystemError("READ_ONLY", "locked", "/z"),
      "/ignored",
    );
    assert.equal(passthrough.code, "READ_ONLY");
    assert.equal(passthrough.path, "/z");
  });
});
