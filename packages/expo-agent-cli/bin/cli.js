#!/usr/bin/env node

// src/run.ts
import { spawn } from "node:child_process";

// src/readAliasVersion.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
function readAliasVersion(from = import.meta.url) {
  const fromPath = from.startsWith("file:") ? fileURLToPath(from) : from;
  let packageJsonPath;
  try {
    packageJsonPath = path.join(path.dirname(fs.realpathSync(fromPath)), "..", "package.json");
  } catch {
    throw new Error(`expo-agent-cli: cannot resolve package.json from ${fromPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`expo-agent-cli: cannot read version from ${packageJsonPath} (${reason})`);
  }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`expo-agent-cli: missing version in ${packageJsonPath}`);
  }
  return parsed.version;
}

// src/resolveRunner.ts
var BIN = "expo-agent-cli";
function canonicalSpec(cliVersion) {
  return `@expo/agent-cli@<=${cliVersion}`;
}
function resolveRunner(hints, cliVersion, argv) {
  const spec = canonicalSpec(cliVersion);
  switch (detectManager(hints)) {
    case "bun":
      return { command: "bunx", args: ["--package", spec, BIN, ...argv] };
    case "pnpm":
      return { command: "pnpm", args: ["--package", spec, "dlx", BIN, ...argv] };
    case "yarn":
      return { command: "yarn", args: ["dlx", "--package", spec, BIN, ...argv] };
    default:
      return resolveNpxRunner(cliVersion, argv);
  }
}
function resolveNpxRunner(cliVersion, argv) {
  return {
    command: "npx",
    args: ["--yes", `--package=${canonicalSpec(cliVersion)}`, "--", BIN, ...argv]
  };
}
function detectManager(hints) {
  if (hints.bunRuntime) {
    return "bun";
  }
  const ua = (hints.userAgent ?? "").toLowerCase();
  if (ua.startsWith("bun/")) {
    return "bun";
  }
  if (ua.startsWith("pnpm/")) {
    return "pnpm";
  }
  if (ua.startsWith("yarn/")) {
    const major = Number(ua.match(/^yarn\/(\d+)/)?.[1]);
    return Number.isFinite(major) && major >= 2 ? "yarn" : "npm";
  }
  if (ua.startsWith("npm/")) {
    return "npm";
  }
  const execPath = hints.execPath ?? "";
  if (/(^|[\\/])bun(\.exe)?$/i.test(execPath)) {
    return "bun";
  }
  if (/(^|[\\/])pnpm(\.cjs|\.cmd|\.exe)?$/i.test(execPath)) {
    return "pnpm";
  }
  return "npm";
}

// src/windowsShim.ts
var BATCH_FILE = /\.(cmd|bat)$/i;
var CMD_META_CHARS = /([()[\]%!^"`<>&|;, *?])/g;
function resolveSpawnTarget(command, args, platform = process.platform) {
  if (platform !== "win32" || !BATCH_FILE.test(command)) {
    return { command, args, shell: false };
  }
  return {
    command: `"${command}"`,
    args: args.map(escapeArgumentForCmd),
    shell: true
  };
}
function escapeArgumentForCmd(value) {
  const forProgram = value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/, "$1$1");
  return `"${forProgram}"`.replace(CMD_META_CHARS, "^$1");
}

// src/run.ts
function defaultIo() {
  return {
    spawn,
    platform: process.platform,
    exit: (code) => process.exit(code),
    kill: (pid, signal) => process.kill(pid, signal),
    error: (message) => console.error(message),
    pid: process.pid,
    bunRuntime: typeof process.versions.bun === "string"
  };
}
function run(env = process.env, argv = process.argv.slice(2), io = {}) {
  const resolved = { ...defaultIo(), ...io };
  let version;
  try {
    version = readAliasVersion();
  } catch (error) {
    resolved.error(error instanceof Error ? error.message : String(error));
    resolved.exit(1);
    return;
  }
  const runner = resolveRunner({
    userAgent: env.npm_config_user_agent,
    execPath: env.npm_execpath,
    bunRuntime: resolved.bunRuntime
  }, version, argv);
  spawnRunner(runner, resolved, () => {
    if (runner.command === "npx") {
      return false;
    }
    resolved.error(`expo-agent-cli: cannot find ${runner.command}; falling back to npx`);
    spawnRunner(resolveNpxRunner(version, argv), resolved);
    return true;
  });
}
function spawnRunner(runner, io, onMissing) {
  const command = io.platform === "win32" && !/\.(cmd|bat|exe)$/i.test(runner.command) ? `${runner.command}.cmd` : runner.command;
  const target = resolveSpawnTarget(command, runner.args, io.platform);
  const child = io.spawn(target.command, target.args, {
    stdio: "inherit",
    shell: target.shell
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      io.kill(io.pid, signal);
    } else {
      io.exit(code ?? 1);
    }
  });
  child.on("error", (error) => {
    if (error.code === "ENOENT" && onMissing?.()) {
      return;
    }
    io.error(error.message);
    io.exit(1);
  });
}

// src/cli.ts
run();
