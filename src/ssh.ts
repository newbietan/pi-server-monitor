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
