import { spawn } from "node:child_process";
import { isIP } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SshTarget } from "./types.js";

/**
 * Parse an SSH target string like:
 * - user@host
 * - user@host:2222
 * - host:2222
 * - host
 */
export function parseSshTarget(raw: string): SshTarget {
  const trimmed = raw.trim();
  const match = /^(?:([a-zA-Z0-9_.-]+)@)?(\[[^\]]+\]|[^@\s]+)$/.exec(trimmed);
  if (!match || match[1]?.startsWith("-")) throw new Error("Invalid SSH target");

  const user = match[1];
  let host = match[2];
  let port: number | undefined;
  const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host);
  if (withPort) {
    host = withPort[1];
    port = Number(withPort[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH port");
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(host) && isIP(host) !== 6) {
    throw new Error("Invalid SSH host");
  }

  return { user, host, port, raw: trimmed };
}

/**
 * Get unique control socket path for connection multiplexing
 */
export function getControlPath(target: SshTarget): string {
  const safeHost = target.host.replace(/[^a-zA-Z0-9.-]/g, "_");
  const safeUser = target.user ? target.user.replace(/[^a-zA-Z0-9_-]/g, "_") : "default";
  const port = target.port ?? 22;
  const filename = `pi-mon-${safeUser}-${safeHost}-${port}.sock`;
  return path.join(os.tmpdir(), filename);
}

const MAX_TIMER_MS = 2_147_483_647;

function positiveNumber(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= max ? value : fallback;
}

/**
 * Execute command on remote host via SSH with connection multiplexing.
 * Timeout configuration is resolved here so all callers use the same policy.
 */
export function executeRemoteCommand(
  target: SshTarget,
  command: string,
  timeoutMs = 20000,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("SSH command aborted"));
      return;
    }
    const controlPath = getControlPath(target);
    const destination = target.user ? `${target.user}@${target.host}` : target.host;
    const connectTimeout = Math.ceil(positiveNumber(process.env.PI_SSH_CONNECT_TIMEOUT, 15, 86400));
    const fallbackTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS
      ? timeoutMs : 20000;
    const effectiveTimeout = positiveNumber(process.env.PI_SSH_TIMEOUT, fallbackTimeout, MAX_TIMER_MS);

    const args = [
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${controlPath}`,
      "-o",
      "ControlPersist=300s",
      "-o",
      `ConnectTimeout=${connectTimeout}`,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
    ];

    if (target.port) {
      args.push("-p", String(target.port));
    }

    args.push(destination, command);

    const child = spawn("ssh", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        reject(new Error(`SSH command timed out after ${effectiveTimeout}ms`));
      }
    }, effectiveTimeout);

    const onAbort = () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        reject(new Error("SSH command aborted"));
      }
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);

        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`SSH exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        }
      }
    });
  });
}

/**
 * Close master SSH connection socket if present
 */
export async function closeSshConnection(target: SshTarget): Promise<void> {
  const controlPath = getControlPath(target);
  const destination = target.user ? `${target.user}@${target.host}` : target.host;

  if (fs.existsSync(controlPath)) {
    await new Promise<void>((resolve) => {
      const child = spawn("ssh", ["-O", "exit", "-o", `ControlPath=${controlPath}`, destination], {
        stdio: "ignore",
      });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
      setTimeout(resolve, 1000);
    });

    try {
      if (fs.existsSync(controlPath)) {
        fs.unlinkSync(controlPath);
      }
    } catch {
      // ignore
    }
  }
}

const EXCLUDED_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "gitee.com",
  "bitbucket.org",
  "hf.co",
  "huggingface.co",
]);

/** Split shell commands without interpreting quoted text as executable commands. */
function shellCommands(command: string): string[][] {
  const commands: string[][] = [];
  let args: string[] = [];
  let token = "";
  let quote = "";
  const flushToken = () => {
    if (token) args.push(token);
    token = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"' && /["\\]/.test(command[i + 1] || "")) token += command[++i];
      else token += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "\\") {
      if (command[i + 1] === "\n") i++;
      else token += command[++i] || "";
    } else if (ch === "<" && command[i + 1] === "<") {
      // Do not mistake heredoc bodies (scripts or documentation) for shell commands.
      return [];
    } else if (ch === "#" && !token) {
      while (i < command.length && command[i] !== "\n") i++;
      flushToken();
      if (args.length) commands.push(args);
      args = [];
    } else if (/[;&|()\n`]/.test(ch)) {
      flushToken();
      if (args.length) commands.push(args);
      args = [];
    } else if (/\s/.test(ch)) {
      flushToken();
    } else {
      token += ch;
    }
  }
  if (quote) return []; // Incomplete commands are not evidence of a connection.
  flushToken();
  if (args.length) commands.push(args);
  return commands;
}

const RSYNC_VALUE_OPTIONS = new Set([
  "-e", "-f", "-B", "-T", "-M", "--rsh", "--exclude", "--include", "--filter",
  "--exclude-from", "--include-from", "--files-from", "--log-file", "--log-file-format",
  "--out-format", "--rsync-path", "--remote-option", "--password-file", "--address",
  "--backup-dir", "--suffix", "--compare-dest", "--copy-dest", "--link-dest", "--temp-dir",
  "--partial-dir", "--bwlimit", "--timeout", "--contimeout", "--block-size", "--max-size",
  "--min-size", "--max-delete", "--chmod", "--chown", "--usermap", "--groupmap",
  "--compress-level", "--compress-choice", "--checksum-choice", "--sockopts",
]);

function detectedTarget(raw: string, port?: string, user?: string): string | null {
  try {
    const parsed = parseSshTarget(raw);
    if (EXCLUDED_HOSTS.has(parsed.host.toLowerCase())) return null;
    const host = parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host;
    const login = parsed.user || user;
    const effectivePort = port || parsed.port?.toString();
    const target = `${login ? `${login}@` : ""}${host}${effectivePort ? `:${effectivePort}` : ""}`;
    return parseSshTarget(target).raw;
  } catch {
    return null;
  }
}

/** Parse known argv forms only; never infer hosts from script names or local files. */
function targetFromArgv(argv: string[], depth = 0): string | null {
  if (depth > 3) return null;
  let offset = 0;
  // Common transparent command wrappers.
  while (["sudo", "env", "command", "nohup"].includes(argv[offset])) {
    const wrapper = argv[offset++];
    while (offset < argv.length) {
      if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[offset])) offset++;
      else if (["-u", "-g", "--user", "--group", "--unset"].includes(argv[offset])) offset += 2;
      else if (argv[offset].startsWith("-")) offset++;
      else break;
    }
  }
  const bin = path.posix.basename(argv[offset] || "");
  const args = argv.slice(offset + 1);
  if (["sh", "bash", "zsh"].includes(bin) && /^-[a-z]*c[a-z]*$/.test(args[0] || "")) {
    return extractSshTargetFromCommand(args[1] || "", depth + 1);
  }
  if (!["ssh", "scp", "sftp", "rsync"].includes(bin)) return null;

  let port: string | undefined;
  let user: string | undefined;
  let options = true;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") { options = false; continue; }
    if (options && arg.startsWith("-")) {
      // These SSH modes print configuration, query algorithms, or control an existing socket.
      if (bin === "ssh" && /^-[GVOQ]/.test(arg)) return null;
      if (bin === "rsync") {
        // Daemon transport is not SSH.
        if (arg === "--daemon" || arg === "--port" || arg.startsWith("--port=")) return null;
        const key = arg.split("=", 1)[0];
        const transport = key === "--rsh" || arg.startsWith("-e");
        const takesValue = RSYNC_VALUE_OPTIONS.has(key);
        let value: string | undefined;
        if (arg.includes("=")) value = arg.slice(arg.indexOf("=") + 1);
        else if (arg.startsWith("-e") && arg.length > 2) value = arg.slice(2);
        else if (takesValue) value = args[++i];
        if (takesValue && value === undefined) return null;
        if (transport) {
          const transportArgs = shellCommands(value || "");
          if (transportArgs.length !== 1 || path.posix.basename(transportArgs[0][0]) !== "ssh") return null;
          const via = targetFromArgv([...transportArgs[0], "monitor-placeholder"], depth + 1);
          if (!via) return null;
          const parsed = parseSshTarget(via);
          port = parsed.port?.toString();
          user = parsed.user;
        }
        continue;
      }
      const portFlag = bin === "ssh" ? "-p" : "-P";
      if (arg === portFlag || (arg.startsWith(portFlag) && arg.length > 2)) {
        port = arg.length > 2 ? arg.slice(2) : args[++i];
        if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
        continue;
      }
      const valued = bin === "ssh" ? "BbcDEeFIiJLlmOoPpQRSWw" : "bcDFiJloPSX";
      if (arg.length >= 2 && valued.includes(arg[1])) {
        const value = arg.length > 2 ? arg.slice(2) : args[++i];
        if (!value) return null;
        if (bin === "ssh" && arg[1] === "l") user = value;
        if (arg[1] === "o") {
          const option = /^(Port|User)\s*[=\s]\s*(\S+)$/i.exec(value);
          if (option?.[1].toLowerCase() === "port") {
            if (!/^\d+$/.test(option[2]) || Number(option[2]) < 1 || Number(option[2]) > 65535) return null;
            port = option[2];
          } else if (option) user = option[2];
        }
      }
      continue;
    }
    if (bin === "ssh" || bin === "sftp") {
      const remote = bin === "sftp" ? arg.replace(/:(?!\d+$)(?![^\[]*\])[^:]*$/, "") : arg;
      return detectedTarget(remote, port, user);
    }
    if (bin === "rsync" && (/^rsync:\/\//i.test(arg) || /^(?:[^@:/\s]+@)?[^:/\[\]\s]+::/.test(arg))) return null;
    const remote = /^((?:[^@:/\s]+@)?(?:\[[^\]]+\]|[^:/\s]+)):(?!:)/.exec(arg);
    if (remote && !target) target = remote[1];
  }
  return target ? detectedTarget(target, port, user) : null;
}

/** Detect actual SSH/scp/sftp/rsync invocations, not mentions inside quoted text. */
export function extractSshTargetFromCommand(cmd: string, depth = 0): string | null {
  if (typeof cmd !== "string" || !cmd.trim() || depth > 3) return null;
  for (const argv of shellCommands(cmd)) {
    const target = targetFromArgv(argv, depth);
    if (target) return target;
  }
  return null;
}

/** Recognize literal Python subprocess argv without executing or evaluating code. */
export function extractSshTargetFromCode(code: string, language?: string): string | null {
  if (["shell", "bash", "sh"].includes(language || "")) return extractSshTargetFromCommand(code);
  if (language !== "python" || code.includes('\"\"\"') || code.includes("'''")) return null;
  for (const line of code.split("\n")) {
    const call = /^\s*(?:(?:[A-Za-z_]\w*\s*=\s*)|(?:return\s+))?subprocess\.(?:run|Popen|call|check_call|check_output)\(\s*\[((?:[^\]"']|"[^"\\]*"|'[^'\\]*')*)\]/.exec(line);
    if (!call) continue;
    const literals = call[1].match(/"[^"\\]*"|'[^'\\]*'/g) || [];
    const literal = `(?:"[^"\\\\]*"|'[^'\\\\]*')`;
    if (!new RegExp(`^\\s*${literal}(?:\\s*,\\s*${literal})*\\s*,?\\s*$`).test(call[1])) continue;
    const target = targetFromArgv(literals.map((literal) => literal.slice(1, -1)));
    if (target) return target;
  }
  return null;
}
