#!/usr/bin/env node
// GENERATED from src/_rust-release.ts by tasks/build-rust-release.ts.
// src/_rust-release.ts
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// ../packages/js/node/core/src/exec.ts
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync
} from "node:child_process";
var COMMAND_NOT_FOUND_EXIT_CODE = 127;
function parseSpawnArgs(input) {
  let [value, ...values] = input;
  const [command, ...commandArgs] = shlex(value);
  const last = values.at(-1);
  const options = last !== null && typeof last === "object" && !Array.isArray(last) ? last : undefined;
  const argumentValues = options ? values.slice(0, -1) : values;
  const valueArgs = argumentValues.length === 1 && Array.isArray(argumentValues[0]) ? [...argumentValues[0]] : argumentValues;
  return {
    command,
    commandArgs: [...commandArgs, ...valueArgs],
    options
  };
}
function withoutSpawnTrailingEmptyLine(lines) {
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}
function trimSingleTrailingNewline(text) {
  if (text.endsWith(`\r
`))
    return text.slice(0, -2);
  if (text.endsWith(`
`))
    return text.slice(0, -1);
  return text;
}
function normalizedSyncLines(lines, trim) {
  if (trim === false)
    return lines;
  if (trim === true)
    return linesFromCapturedOutput(lines.join(`
`).trim());
  return withoutSpawnTrailingEmptyLine(lines);
}
function formatSyncCapturedText(text, trim) {
  if (text === undefined)
    return;
  if (trim === false)
    return text;
  if (trim === true)
    return text.trim();
  return trimSingleTrailingNewline(text);
}
function commandLabel(command, args) {
  return `\`${command} ${args.join(" ")}\``;
}
function isCommandNotFoundError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function createSyncExecResult(exitCode, stdoutText, stderrText, trim) {
  let stdoutLinesCache;
  let stderrLinesCache;
  const syncLines = (text) => {
    if (text === undefined)
      return;
    return normalizedSyncLines(linesFromCapturedOutput(text), trim);
  };
  return {
    exitCode,
    get stdoutLines() {
      if (stdoutText === undefined)
        return [];
      stdoutLinesCache ??= syncLines(stdoutText) ?? [];
      return stdoutLinesCache;
    },
    get stderrLines() {
      if (stderrText === undefined)
        return [];
      stderrLinesCache ??= syncLines(stderrText) ?? [];
      return stderrLinesCache;
    },
    get stdout() {
      return formatSyncCapturedText(stdoutText, trim) ?? "";
    },
    get stderr() {
      return formatSyncCapturedText(stderrText, trim) ?? "";
    }
  };
}
function isPassthroughMode(option) {
  return option === "inherit" || option === "pipe" || option === "ignore";
}
function isStdinPayload(stdin) {
  return typeof stdin === "string" && !isPassthroughMode(stdin);
}
function execError(command, args, result) {
  const detail = result.stderr || result.stdout;
  return new Error(`${commandLabel(command, args)} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
}
function resolveSyncStdio(option, defaultMode = "inherit") {
  if (option === undefined)
    return defaultMode;
  if (option === "capture")
    return "pipe";
  return option;
}
function capturedText(output) {
  if (output === null || output === undefined)
    return;
  return typeof output === "string" ? output : output.toString("utf8");
}
function linesFromCapturedOutput(output) {
  return output.replace(/\r\n/g, `
`).replace(/\r/g, `
`).split(`
`);
}
function spawnSync(...args) {
  const { command, commandArgs, options = {} } = parseSpawnArgs(args);
  const { stdin, stdout, stderr, check, trim, ...spawnOpts } = options;
  const stdinMode = isStdinPayload(stdin) ? "pipe" : stdin ?? "inherit";
  const captureStdout = stdout === "capture";
  const captureStderr = stderr === "capture";
  const stdoutMode = resolveSyncStdio(stdout);
  const stderrMode = resolveSyncStdio(stderr);
  const result = nodeSpawnSync(command, commandArgs, {
    ...spawnOpts,
    encoding: captureStdout || captureStderr ? "utf8" : undefined,
    stdio: [stdinMode, stdoutMode, stderrMode],
    input: isStdinPayload(stdin) ? stdin : undefined
  });
  const commandNotFound = isCommandNotFoundError(result.error);
  const exitCode = commandNotFound ? COMMAND_NOT_FOUND_EXIT_CODE : result.status ?? 1;
  const stdoutText = captureStdout ? capturedText(result.stdout) : undefined;
  const stderrText = captureStderr ? capturedText(result.stderr) : undefined;
  const execResult = createSyncExecResult(exitCode, stdoutText, stderrText, trim);
  if (result.error && (!commandNotFound || check)) {
    const err = execError(command, commandArgs, execResult);
    err.cause = result.error;
    throw err;
  }
  if (check && execResult.exitCode !== 0)
    throw execError(command, commandArgs, execResult);
  return execResult;
}
function shlex(command) {
  const args = [];
  let current = "";
  let quote;
  let escaped = false;
  let quoted = false;
  const push = () => {
    if (quoted || current.length > 0) {
      args.push(current);
    }
    current = "";
    quoted = false;
  };
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = undefined;
        quoted = true;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  if (quote) {
    return [command];
  }
  if (escaped) {
    current += "\\";
  }
  push();
  return args.length ? args : [command];
}

// ../node_modules/smol-toml/dist/date.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;

class TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    if (typeof date === "string") {
      let match = date.match(DATE_TIME_RE);
      if (match) {
        if (!match[1]) {
          hasDate = false;
          date = `0000-01-01T${date}`;
        }
        hasTime = !!match[2];
        hasTime && date[10] === " " && (date = date.replace(" ", "T"));
        if (match[2] && +match[2] > 23) {
          date = "";
        } else {
          offset = match[3] || null;
          date = date.toUpperCase();
          if (!offset && hasTime)
            date += "Z";
        }
      } else {
        date = "";
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 60000);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
}

// ../node_modules/smol-toml/dist/error.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1;i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += `
`;
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += `^
`;
    }
  }
  return codeblock;
}

class TomlError extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
}

// ../node_modules/smol-toml/dist/util.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function indexOfNewline(str, start = 0) {
  let idx = str.indexOf(`
`, start);
  if (str.charCodeAt(idx - 1) === 13)
    idx--;
  return idx;
}
function skipComment(ctx) {
  for (;ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      throw new TomlError("control characters are not allowed in comments", {
        toml: ctx.s,
        ptr: ctx.p
      });
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (true) {
    while ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}
function skipUntil(ctx, sep, end) {
  let ptr = ctx.p;
  if (!end) {
    ptr = indexOfNewline(ctx.s, ptr);
    ctx.p = ptr < 0 ? ctx.s.length : ptr;
    return;
  }
  for (;ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 35) {
      skipComment(ctx);
    } else if (c === end || c === sep) {
      return;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: ctx.s,
    ptr
  });
}

// ../node_modules/smol-toml/dist/primitive.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
var FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
var LEADING_ZERO = /^[+-]?0[0-9_]/;
function parseString(ctx) {
  let start = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (;ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      throw new TomlError("control characters are not allowed in strings", {
        toml: ctx.s,
        ptr: ctx.p
      });
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state)
        parsed += ctx.s.slice(sliceStart, ctx.p);
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0;j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p + 1);
          let digit = hex >= 48 && hex <= 57 ? hex - 48 : hex >= 65 && hex <= 70 ? hex - 65 + 10 : hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1;
          if (digit < 0)
            throw new TomlError("invalid non-hex character in unicode escape", { toml: ctx.s, ptr: ctx.p + 1 });
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          throw new TomlError("invalid unicode escape", { toml: ctx.s, ptr: ctx.p });
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p + 1;
        state = 0;
      } else if (c === 32 || c === 9) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "\t";
        else if (c === 110)
          parsed += `
`;
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          throw new TomlError("unrecognized escape sequence", { toml: ctx.s, ptr: ctx.p });
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2) {
        throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
          toml: ctx.s,
          ptr: sliceStart
        });
      }
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  throw new TomlError("unfinished string", { toml: ctx.s, ptr: start });
}
function sliceAndTrimEndOf(ctx, start, end) {
  let value = ctx.s.slice(start, end);
  let commentIdx = value.indexOf("#");
  if (commentIdx > 0) {
    skipComment({ s: value, p: commentIdx, d: 0 });
    value = value.slice(0, commentIdx);
  }
  return value.trimEnd();
}
function parseValue(ctx, integersAsBigInt, end) {
  let ptr = ctx.p;
  let err = { toml: ctx.s, ptr };
  skipUntil(ctx, 44, end);
  let value = sliceAndTrimEndOf(ctx, ptr, ctx.p);
  if (!value)
    throw new TomlError("incomplete declaration: value expected", err);
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", err);
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", err);
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", err);
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid())
    throw new TomlError("invalid value", err);
  return date;
}

// ../node_modules/smol-toml/dist/extract.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function extractValue(ctx, end, integersAsBigInt) {
  let ptr = ctx.p;
  let c = ctx.s.charCodeAt(ptr);
  if (c === 91 || c === 123) {
    if (!ctx.d--) {
      throw new TomlError("document contains excessively nested structures. aborting.", {
        toml: ctx.s,
        ptr
      });
    }
    let value = c === 91 ? parseArray(ctx, integersAsBigInt) : parseInlineTable(ctx, integersAsBigInt);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      throw new TomlError("invalid value", { toml: ctx.s, ptr });
    ctx.p++;
    return true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      throw new TomlError("invalid value", { toml: ctx.s, ptr });
    ctx.p++;
    return false;
  }
  return parseValue(ctx, integersAsBigInt, end);
}

// ../node_modules/smol-toml/dist/struct.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
function parseKey(ctx, end = "=") {
  let start = ctx.p;
  let dot = start - 1;
  let parsed = [];
  let endPtr = ctx.s.indexOf(end, start);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: ctx.s,
      ptr: start
    });
  }
  do {
    let c = ctx.s.charCodeAt(ctx.p = ++dot);
    if (c !== 32 && c !== 9) {
      if (c === 34 || c === 39) {
        if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2)) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        let part = parseString(ctx);
        dot = ctx.s.indexOf(".", ctx.p);
        let strEnd = ctx.s.slice(ctx.p, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: ctx.s,
            ptr: newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        if (endPtr < ctx.p) {
          endPtr = ctx.s.indexOf(end, ctx.p);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: ctx.s,
              ptr: start
            });
          }
        }
        parsed.push(part);
      } else {
        dot = ctx.s.indexOf(".", ctx.p);
        let part = ctx.s.slice(ctx.p, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  ctx.p = endPtr + 1;
  skipVoid(ctx, true, true);
  return parsed;
}
function parseInlineTable(ctx, integersAsBigInt) {
  let res = {};
  let seen = new Set;
  let c;
  ctx.p++;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let p = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0;i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = {};
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: ctx.s,
          ptr: p
        });
      }
      if (!hasOwn && k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      throw new TomlError("trying to redefine an already defined value", {
        toml: ctx.s,
        ptr: ctx.p
      });
    }
    let value = extractValue(ctx, 125, integersAsBigInt);
    seen.add(t[k] = value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44) {
      throw new TomlError("expected comma or end of structure", { toml: ctx.s, ptr: ctx.p - 1 });
    }
  }
  throw new TomlError("unfinished table encountered", {
    toml: ctx.s,
    ptr: ctx.p
  });
}
function parseArray(ctx, integersAsBigInt) {
  let res = [];
  let c;
  ctx.p++;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(ctx, 93, integersAsBigInt));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44) {
      throw new TomlError("expected comma or end of structure", { toml: ctx.s, ptr: ctx.p - 1 });
    }
  }
  throw new TomlError("unfinished array encountered", {
    toml: ctx.s,
    ptr: ctx.p
  });
}

// ../node_modules/smol-toml/dist/parse.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function peekTable(key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0;i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function parse(toml, { maxDepth = 1000, integersAsBigInt } = {}) {
  let ctx = { s: toml, p: 0, d: maxDepth };
  let res = {};
  let meta = {};
  let tmp;
  let tbl = res;
  let m = meta;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      let k = parseKey(ctx, "]");
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p - 1) !== 93) {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: ctx.p - 1
          });
        }
        ctx.p++;
      }
      let p = peekTable(k, res, meta, isTableArray ? 2 : 1);
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr: tmp
        });
      }
      m = p[2];
      tbl = p[1];
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(k, tbl, m, 0);
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr: tmp
        });
      }
      p[1][p[0]] = extractValue(ctx, undefined, integersAsBigInt);
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && tmp !== 13) {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr: ctx.p
      });
    }
    skipVoid(ctx);
  }
  return res;
}

// ../node_modules/smol-toml/dist/stringify.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var BARE_KEY = /^[a-z0-9-_]+$/i;
function extendedTypeOf(obj) {
  let type = typeof obj;
  if (type === "object") {
    if (Array.isArray(obj))
      return "array";
    if (typeof obj?.getUTCDate === "function" && obj instanceof Date)
      return "date";
    if (globalThis.Temporal && typeof obj?.since === "function" && (obj instanceof Temporal.Instant || obj instanceof Temporal.PlainDate || obj instanceof Temporal.PlainDateTime || obj instanceof Temporal.PlainTime || obj instanceof Temporal.ZonedDateTime)) {
      return "temporal";
    }
  }
  return type;
}
function isArrayOfTables(obj) {
  for (let i = 0;i < obj.length; i++) {
    if (extendedTypeOf(obj[i]) !== "object")
      return false;
  }
  return obj.length != 0;
}
function formatString(s) {
  return JSON.stringify(s).replace(/\x7f/g, "\\u007f");
}
function stringifyTemporal(temporal) {
  return temporal.toString({
    calendarName: "never",
    timeZoneName: "never"
  });
}
function stringifyValue(val, type, depth, numberAsFloat) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  switch (type) {
    case "number":
      if (isNaN(val))
        return "nan";
      if (val === Infinity)
        return "inf";
      if (val === -Infinity)
        return "-inf";
      if (Number.isInteger(val) && (numberAsFloat || !Number.isSafeInteger(val)))
        return val.toFixed(1);
    case "bigint":
    case "boolean":
      return val.toString();
    case "string":
      return formatString(val);
    case "date":
      if (isNaN(val.getTime()))
        throw new TypeError("cannot serialize invalid date");
      return val.toISOString();
    case "object":
      return stringifyInlineTable(val, depth, numberAsFloat);
    case "array":
      return stringifyArray(val, depth, numberAsFloat);
    case "temporal":
      return stringifyTemporal(val);
  }
}
function stringifyInlineTable(obj, depth, numberAsFloat) {
  let keys = Object.keys(obj);
  if (keys.length === 0)
    return "{}";
  let res = "{ ";
  for (let i = 0;i < keys.length; i++) {
    let k = keys[i];
    if (i)
      res += ", ";
    res += BARE_KEY.test(k) ? k : formatString(k);
    res += " = ";
    res += stringifyValue(obj[k], extendedTypeOf(obj[k]), depth - 1, numberAsFloat);
  }
  return res + " }";
}
function stringifyArray(array, depth, numberAsFloat) {
  if (array.length === 0)
    return "[]";
  let res = "[ ";
  for (let i = 0;i < array.length; i++) {
    if (i)
      res += ", ";
    if (array[i] === null || array[i] === undefined) {
      throw new TypeError("arrays cannot contain null or undefined values");
    }
    res += stringifyValue(array[i], extendedTypeOf(array[i]), depth - 1, numberAsFloat);
  }
  return res + " ]";
}
function stringifyArrayTable(array, key, depth, numberAsFloat) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  let res = "";
  for (let i = 0;i < array.length; i++) {
    res += `${res && `
`}[[${key}]]
`;
    res += stringifyTable(0, array[i], key, depth, numberAsFloat);
  }
  return res;
}
function stringifyTable(tableKey, obj, prefix, depth, numberAsFloat) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  let preamble = "";
  let tables = "";
  let keys = Object.keys(obj);
  for (let i = 0;i < keys.length; i++) {
    let k = keys[i];
    if (obj[k] !== null && obj[k] !== undefined) {
      let type = extendedTypeOf(obj[k]);
      if (type === "symbol" || type === "function") {
        throw new TypeError(`cannot serialize values of type '${type}'`);
      }
      let key = BARE_KEY.test(k) ? k : formatString(k);
      if (type === "array" && isArrayOfTables(obj[k])) {
        tables += (tables && `
`) + stringifyArrayTable(obj[k], prefix ? `${prefix}.${key}` : key, depth - 1, numberAsFloat);
      } else if (type === "object") {
        let tblKey = prefix ? `${prefix}.${key}` : key;
        tables += (tables && `
`) + stringifyTable(tblKey, obj[k], tblKey, depth - 1, numberAsFloat);
      } else {
        preamble += key;
        preamble += " = ";
        preamble += stringifyValue(obj[k], type, depth, numberAsFloat);
        preamble += `
`;
      }
    }
  }
  if (tableKey && (preamble || !tables))
    preamble = preamble ? `[${tableKey}]
${preamble}` : `[${tableKey}]`;
  return preamble && tables ? `${preamble}
${tables}` : preamble || tables;
}
function stringify(obj, { maxDepth = 1000, numbersAsFloat = false } = {}) {
  if (extendedTypeOf(obj) !== "object") {
    throw new TypeError("stringify can only be called with an object");
  }
  let str = stringifyTable(0, obj, "", maxDepth, numbersAsFloat);
  if (str[str.length - 1] !== `
`)
    return str + `
`;
  return str;
}

// ../node_modules/smol-toml/dist/index.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// src/_rust-release.ts
var FINGERPRINT_SCHEMA = 3;
var VERSION_SLOT_SCHEMA = 1;
var VERSION_CAPACITY = 64;
var MAGIC = Buffer.from("DBXVERSION\x00\x00", "binary");
var RECORD_SIZE = 128;
var VERSION_OFFSET = 16;
var EMPTY_RECORD_OFFSET = 80;
var MACH_O_MAGICS = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca"
]);
function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, [...args], {
    ...options.cwd ? { cwd: options.cwd } : {},
    stdout: options.inherit ? "inherit" : "capture",
    stderr: options.inherit ? "inherit" : "capture",
    stdin: "ignore",
    check: options.check ?? true
  });
  return result.stdout;
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function removeVersionOnlyFields(value, key) {
  if (Array.isArray(value)) {
    for (const item of value)
      removeVersionOnlyFields(item);
    return;
  }
  if (!record(value))
    return;
  if (typeof value.path === "string")
    delete value.version;
  if (key === "package")
    delete value.version;
  for (const [childKey, child] of Object.entries(value)) {
    removeVersionOnlyFields(child, childKey);
  }
}
function normalizeManifest(text) {
  const document = parse(text);
  const packageTable = document.package;
  if (record(packageTable))
    delete packageTable.version;
  const workspace = document.workspace;
  if (record(workspace) && record(workspace.package))
    delete workspace.package.version;
  removeVersionOnlyFields(document);
  return stringify(document);
}
function normalizeLockfile(text, workspaceVersion, packageNames = new Set) {
  const document = parse(text);
  const packages = document.package;
  if (Array.isArray(packages)) {
    for (const candidate of packages) {
      if (!record(candidate) || candidate.source !== undefined)
        continue;
      if (typeof candidate.name === "string" && packageNames.has(candidate.name) || candidate.version === workspaceVersion) {
        candidate.version = "<workspace>";
      }
    }
  }
  return stringify(document);
}
function cargoMetadata(root) {
  const parsed = JSON.parse(command("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root }));
  if (!Array.isArray(parsed.packages) || !Array.isArray(parsed.workspace_members) || typeof parsed.workspace_root !== "string") {
    throw new Error("cargo metadata returned an incomplete workspace description");
  }
  return parsed;
}
function workspaceVersion(root) {
  const versionFile = join(root, "VERSION");
  if (existsSync(versionFile))
    return readFileSync(versionFile, "utf8").trim();
  const document = parse(readFileSync(join(root, "Cargo.toml"), "utf8"));
  const workspace = document.workspace;
  return record(workspace) && record(workspace.package) && typeof workspace.package.version === "string" ? workspace.package.version : "";
}
function toPosix(path) {
  return path.split(sep).join("/");
}
function sourceRoots(root, metadata, sources) {
  const members = new Set(metadata.workspace_members);
  const discovered = metadata.packages.filter((candidate) => members.has(candidate.id)).map((candidate) => dirname(candidate.manifest_path));
  return [...new Set([...discovered, ...sources.map((source) => resolve(root, source))])].map((path) => toPosix(relative(root, path)) || ".").sort();
}
function ignoredInput(path) {
  const segments = path.split("/");
  return segments.some((segment) => segment === ".git" || segment === "node_modules" || segment === "target");
}
function walkFiles(root, path, output) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute))
    return;
  const stat = lstatSync(absolute);
  if (!stat.isDirectory()) {
    output.push(toPosix(relative(root, absolute)));
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = toPosix(relative(root, join(absolute, entry.name)));
    if (ignoredInput(child))
      continue;
    if (entry.isDirectory())
      walkFiles(root, child, output);
    else
      output.push(child);
  }
}
function inputFiles(root, roots) {
  const pathspecs = [
    "Cargo.toml",
    "Cargo.lock",
    ".cargo",
    "rust-toolchain",
    "rust-toolchain.toml",
    ...roots
  ];
  const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...pathspecs], {
    cwd: root,
    stdout: "capture",
    stderr: "ignore",
    stdin: "ignore",
    check: false,
    trim: false
  });
  const files = git.exitCode === 0 ? git.stdout.split("\x00").filter(Boolean) : pathspecs.flatMap((path) => {
    const found = [];
    walkFiles(root, path, found);
    return found;
  });
  return [...new Set(files.map(toPosix))].filter((file) => !ignoredInput(file) && existsSync(join(root, file))).sort();
}
function normalizedInput(root, file, content, packageNames) {
  if (file.endsWith("Cargo.toml"))
    return Buffer.from(normalizeManifest(content.toString("utf8")));
  if (file === "Cargo.lock") {
    return Buffer.from(normalizeLockfile(content.toString("utf8"), workspaceVersion(root), packageNames));
  }
  return content;
}
function sourceHash(root, sources = []) {
  const resolvedRoot = resolve(root);
  const metadata = cargoMetadata(resolvedRoot);
  const members = new Set(metadata.workspace_members);
  const packageNames = new Set(metadata.packages.filter((candidate) => members.has(candidate.id)).map((candidate) => candidate.name));
  const hash = createHash("sha256");
  for (const file of inputFiles(resolvedRoot, sourceRoots(resolvedRoot, metadata, sources))) {
    const absolute = join(resolvedRoot, file);
    const stat = lstatSync(absolute);
    hash.update(file);
    hash.update(Buffer.from([0]));
    hash.update(String(stat.mode & 73));
    hash.update(Buffer.from([0]));
    hash.update(stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : normalizedInput(resolvedRoot, file, readFileSync(absolute), packageNames));
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}
function linkerIdentity(target) {
  if (target.includes("windows-msvc"))
    return "rust-lld";
  if (target.includes("linux"))
    return "system-linux-linker";
  if (target.includes("apple-darwin"))
    return "apple-ld";
  return "system-linker";
}
function targetKey({
  rustSourceHash,
  target,
  targetConfig = "",
  toolchain = "stable",
  rustc
}) {
  const hash = createHash("sha256");
  for (const value of [
    String(FINGERPRINT_SCHEMA),
    String(VERSION_SLOT_SCHEMA),
    rustSourceHash,
    target,
    targetConfig,
    toolchain,
    rustc ?? "<portable>",
    linkerIdentity(target),
    "release",
    "raw-target-release-v2"
  ]) {
    hash.update(value);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}
function rustcIdentity() {
  return command("rustc", ["--version", "--verbose"]).split(/\r?\n/).filter((line) => line && !line.startsWith("host: ")).join(`
`);
}
function fingerprint({
  root = process.cwd(),
  output = ".release/rust-build.json",
  check = false,
  targets,
  toolchain = "stable",
  portable = false,
  sources = []
}) {
  if (!targets.length)
    throw new Error("at least one --target is required");
  const resolvedRoot = resolve(root);
  const rustSourceHash = sourceHash(resolvedRoot, sources);
  const rustc = portable ? undefined : rustcIdentity();
  const targetEntries = targets.map((specification) => {
    const separator = specification.indexOf("|");
    const target = separator < 0 ? specification : specification.slice(0, separator);
    const targetConfig = separator < 0 ? "" : specification.slice(separator + 1);
    return [
      target,
      targetKey({ rustSourceHash, target, targetConfig, toolchain, rustc })
    ];
  }).sort(([left], [right]) => left.localeCompare(right));
  const manifest = {
    schemaVersion: FINGERPRINT_SCHEMA,
    versionSlotSchema: VERSION_SLOT_SCHEMA,
    rustSourceHash,
    targets: Object.fromEntries(targetEntries)
  };
  const outputPath = resolve(resolvedRoot, output);
  if (check) {
    const current = JSON.parse(readFileSync(outputPath, "utf8"));
    const targetsMatch = targetEntries.every(([target, key]) => current.targets?.[target] === key);
    if (current.schemaVersion !== manifest.schemaVersion || current.versionSlotSchema !== manifest.versionSlotSchema || current.rustSourceHash !== manifest.rustSourceHash || !targetsMatch) {
      throw new Error(`${outputPath} does not match current Rust inputs`);
    }
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}
`);
  }
  return manifest;
}
var SECTION_BY_FORMAT = {
  elf: ".dbxversion",
  macho: "__DATA,__dbxver",
  pe: ".dbxver"
};
function binaryFormat(data) {
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])))
    return "elf";
  if (data.length >= 2 && data.subarray(0, 2).toString("ascii") === "MZ")
    return "pe";
  if (data.length >= 4 && MACH_O_MAGICS.has(data.subarray(0, 4).toString("hex")))
    return "macho";
  return;
}
function binaryHeader(path) {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    return header.subarray(0, readSync(descriptor, header, 0, header.length, 0));
  } finally {
    closeSync(descriptor);
  }
}
function executableOnPath(name) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    check: false
  }).exitCode === 0;
}
function llvmObjcopy(explicit) {
  if (explicit)
    return explicit;
  if (process.env.LLVM_OBJCOPY)
    return process.env.LLVM_OBJCOPY;
  if (executableOnPath("llvm-objcopy"))
    return "llvm-objcopy";
  const verbose = command("rustc", ["--version", "--verbose"]);
  const host = /^host:\s*(.+)$/m.exec(verbose)?.[1];
  const sysroot = command("rustc", ["--print", "sysroot"]);
  if (host) {
    const candidate = join(sysroot, "lib", "rustlib", host, "bin", process.platform === "win32" ? "llvm-objcopy.exe" : "llvm-objcopy");
    if (existsSync(candidate))
      return candidate;
  }
  throw new Error("llvm-objcopy is unavailable; install the Rust llvm-tools-preview component");
}
function validRecord(data, binary, section) {
  if (data.length !== RECORD_SIZE) {
    throw new Error(`version section ${section} in ${binary} must be ${RECORD_SIZE} bytes, got ${data.length}`);
  }
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`version section ${section} in ${binary} has invalid magic`);
  }
  if (data.readUInt16LE(12) !== VERSION_SLOT_SCHEMA || data.readUInt16LE(14) > VERSION_CAPACITY) {
    throw new Error(`version section ${section} in ${binary} has an unsupported record schema`);
  }
  if (!data.subarray(EMPTY_RECORD_OFFSET).every((byte) => byte === 0)) {
    throw new Error(`version section ${section} in ${binary} has non-zero reserved bytes`);
  }
}
function stamp(binary, version, options = {}) {
  const encoded = Buffer.from(version, "utf8");
  if (!encoded.length || encoded.length > VERSION_CAPACITY) {
    throw new Error(`version must contain 1 to ${VERSION_CAPACITY} bytes`);
  }
  const format = binaryFormat(binaryHeader(binary));
  if (!format)
    return false;
  const section = SECTION_BY_FORMAT[format];
  const objcopy = llvmObjcopy(options.objcopy);
  const temporary = mkdtempSync(join(tmpdir(), "dbx-rust-version-"));
  const recordPath = join(temporary, "record.bin");
  const mode = statSync(binary).mode;
  try {
    const dumped = spawnSync(objcopy, ["--dump-section", `${section}=${recordPath}`, binary], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      check: false
    });
    if (dumped.exitCode !== 0 || !existsSync(recordPath))
      return false;
    const data = readFileSync(recordPath);
    validRecord(data, binary, section);
    data.writeUInt16LE(encoded.length, 14);
    data.fill(0, VERSION_OFFSET, VERSION_OFFSET + VERSION_CAPACITY);
    encoded.copy(data, VERSION_OFFSET);
    writeFileSync(recordPath, data);
    command(objcopy, ["--update-section", `${section}=${recordPath}`, binary], { inherit: true });
    chmodSync(binary, mode);
    if (format === "macho") {
      command(options.codesign ?? "codesign", ["--force", "--sign", "-", binary], {
        inherit: true
      });
    }
    return true;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
function files(root) {
  const found = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        pending.push(path);
      else if (entry.isFile())
        found.push(path);
    }
  }
  return found.sort();
}
function stampTree(root, version, options = {}) {
  let stamped = 0;
  for (const file of files(root))
    if (stamp(file, version, options))
      stamped += 1;
  if (!stamped)
    throw new Error(`no structured version sections found under ${root}`);
  process.stdout.write(`stamped ${stamped} native artifact(s)
`);
  return stamped;
}
function fingerprintCommand(args) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      root: { type: "string", default: process.cwd() },
      output: { type: "string", default: ".release/rust-build.json" },
      check: { type: "boolean", default: false },
      target: { type: "string", multiple: true },
      toolchain: { type: "string", default: "stable" },
      portable: { type: "boolean", default: false },
      source: { type: "string", multiple: true }
    },
    strict: true
  });
  fingerprint({
    root: values.root,
    output: values.output,
    check: values.check,
    targets: values.target ?? [],
    toolchain: values.toolchain,
    portable: values.portable,
    sources: values.source ?? []
  });
}
function stampCommand(args) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      binary: { type: "string" },
      version: { type: "string" },
      objcopy: { type: "string" }
    },
    strict: true
  });
  if (!values.binary || values.version === undefined)
    throw new Error("stamp requires --binary and --version");
  if (!stamp(values.binary, values.version, { objcopy: values.objcopy })) {
    throw new Error(`no structured version section found in ${values.binary}`);
  }
}
function stampTreeCommand(args) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      root: { type: "string" },
      version: { type: "string" },
      objcopy: { type: "string" }
    },
    strict: true
  });
  if (!values.root || values.version === undefined)
    throw new Error("stamp-tree requires --root and --version");
  stampTree(values.root, values.version, { objcopy: values.objcopy });
}
function main(args = process.argv.slice(2)) {
  const [subcommand, ...commandArgs] = args;
  if (subcommand === "fingerprint")
    return fingerprintCommand(commandArgs);
  if (subcommand === "stamp")
    return stampCommand(commandArgs);
  if (subcommand === "stamp-tree")
    return stampTreeCommand(commandArgs);
  throw new Error("expected fingerprint, stamp, or stamp-tree");
}
var invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  }
}
export {
  targetKey,
  stampTree,
  stamp,
  sourceHash,
  normalizeManifest,
  normalizeLockfile,
  main,
  linkerIdentity,
  fingerprint,
  VERSION_SLOT_SCHEMA,
  VERSION_CAPACITY,
  FINGERPRINT_SCHEMA
};
