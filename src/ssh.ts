import { spawn } from "node:child_process";
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
  let user: string | undefined;
  let hostPart = trimmed;

  if (trimmed.includes("@")) {
    const atIdx = trimmed.indexOf("@");
    user = trimmed.slice(0, atIdx);
    hostPart = trimmed.slice(atIdx + 1);
  }

  let host = hostPart;
  let port: number | undefined;

  if (hostPart.includes(":")) {
    const colonIdx = hostPart.lastIndexOf(":");
    const possiblePort = hostPart.slice(colonIdx + 1);
    const parsedPort = Number.parseInt(possiblePort, 10);
    if (!Number.isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
      port = parsedPort;
      host = hostPart.slice(0, colonIdx);
    }
  }

  return {
    user,
    host,
    port,
    raw: trimmed,
  };
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

/**
 * Execute command on remote host via SSH with connection multiplexing
 */
export function executeRemoteCommand(
  target: SshTarget,
  command: string,
  timeoutMs = 6000,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const controlPath = getControlPath(target);
    const destination = target.user ? `${target.user}@${target.host}` : target.host;

    const args = [
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${controlPath}`,
      "-o",
      "ControlPersist=120s",
      "-o",
      "ConnectTimeout=5",
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
        child.kill("SIGTERM");
        reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const onAbort = () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("SSH command aborted"));
      }
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
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

/**
 * Automatically extract SSH remote target from a command string.
 * Supports:
 * - ssh [options] user@host[:port] [cmd]
 * - scp [options] ... user@host:/path
 * - sftp [options] user@host
 * Excludes git hosting domains (github.com, gitlab.com, etc.)
 */
export function extractSshTargetFromCommand(cmd: string): string | null {
  if (typeof cmd !== "string" || !cmd.trim()) return null;

  // Ignore git commands that might reference git@github.com etc.
  const isGitCmd = /^\s*git\s+/i.test(cmd.trim());
  if (isGitCmd) return null;

  // Regex to find ssh, scp, or sftp invocations
  const regex = /(?:^|[;&|`$()]\s*|\b(?:sudo\s+)?)(ssh|scp|sftp)\s+([^;&|\n`$]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(cmd)) !== null) {
    const bin = match[1].toLowerCase();
    const rawArgs = match[2].trim();

    // Tokenize rawArgs respecting quotes
    const tokens = rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    let explicitPort: string | undefined;
    let target: string | undefined;

    for (let i = 0; i < tokens.length; i++) {
      let token = tokens[i].replace(/^['"]|['"]$/g, "");
      if (!token) continue;

      // Handle -p <port> or -P <port> (scp uses -P)
      if (token === "-p" || (bin === "scp" && token === "-P")) {
        if (i + 1 < tokens.length) {
          explicitPort = tokens[i + 1].replace(/^['"]|['"]$/g, "");
          i++;
        }
        continue;
      }
      if (/^-[pP](\d+)$/.test(token)) {
        explicitPort = token.slice(2);
        continue;
      }

      // Handle flags taking arguments
      if (["-i", "-o", "-F", "-l", "-c", "-b", "-J", "-E"].includes(token)) {
        i++; // skip next arg
        continue;
      }
      // Handle -oKey=Val or -iKey
      if (token.startsWith("-o") || token.startsWith("-i")) {
        continue;
      }
      // Skip other flags
      if (token.startsWith("-")) {
        continue;
      }

      // First positional argument in ssh is the destination
      if (bin === "ssh" || bin === "sftp") {
        target = token;
        break;
      }

      // In scp, destination could be one of the args matching [user@]host:path
      if (bin === "scp") {
        if (token.includes(":") && !token.startsWith(":") && !token.startsWith("./") && !token.startsWith("/")) {
          const colonIdx = token.indexOf(":");
          target = token.slice(0, colonIdx);
          break;
        }
      }
    }

    if (target) {
      // Strip potential path if user specified host:/path
      if (target.includes(":")) {
        const colonIdx = target.indexOf(":");
        const possiblePortOrPath = target.slice(colonIdx + 1);
        if (/^\d+$/.test(possiblePortOrPath)) {
          // It's a port like host:2222
          explicitPort = possiblePortOrPath;
          target = target.slice(0, colonIdx);
        } else {
          // It's a path like host:/root
          target = target.slice(0, colonIdx);
        }
      }

      // Check user and host
      let hostOnly = target;
      if (target.includes("@")) {
        hostOnly = target.slice(target.indexOf("@") + 1);
      }

      if (EXCLUDED_HOSTS.has(hostOnly.toLowerCase())) {
        continue;
      }

      // Validate host name basic format (not a local filename or option)
      if (/^[a-zA-Z0-9_.-]+$/.test(hostOnly) && !hostOnly.startsWith("-")) {
        return explicitPort ? `${target}:${explicitPort}` : target;
      }
    }
  }

  return null;
}
