declare const setTimeout: (fn: () => void, ms?: number) => unknown;
declare const clearTimeout: (timerId: unknown) => void;
declare class AbortController {
  readonly signal: any;
  abort(): void;
}

import type { HardwareMetrics, MonitorConnectionState, SshTarget } from "./types.js";
import { parseSshTarget, executeRemoteCommand, closeSshConnection } from "./ssh.js";
import { getProbeCommand, parseProbeOutput } from "./probe.js";

export type MetricsListener = (metrics: HardwareMetrics) => void;
export type StatusListener = (state: MonitorConnectionState, error?: string) => void;

export class ResourceCollector {
  private target: SshTarget | null = null;
  private intervalMs = 2000;
  private state: MonitorConnectionState = "idle";
  private latestMetrics: HardwareMetrics | null = null;
  private lastError: string | null = null;
  private timer: unknown = null;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private isFetching = false;

  private metricsListeners: Set<MetricsListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();

  constructor(targetString?: string, intervalSec = 2) {
    if (targetString) {
      this.target = parseSshTarget(targetString);
    }
    this.intervalMs = Math.max(1000, intervalSec * 1000);
  }

  public setTarget(targetString: string): void {
    const newTarget = parseSshTarget(targetString);
    if (this.target && this.target.raw !== newTarget.raw) {
      // Close previous connection if running
      void closeSshConnection(this.target);
    }
    this.target = newTarget;
    this.lastError = null;
  }

  public getTarget(): SshTarget | null {
    return this.target;
  }

  public setInterval(intervalSec: number): void {
    this.intervalMs = Math.max(1000, intervalSec * 1000);
  }

  public getIntervalSec(): number {
    return Math.round(this.intervalMs / 1000);
  }

  public getMetrics(): HardwareMetrics | null {
    return this.latestMetrics;
  }

  public getState(): MonitorConnectionState {
    return this.state;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public onMetrics(listener: MetricsListener): () => void {
    this.metricsListeners.add(listener);
    return () => this.metricsListeners.delete(listener);
  }

  public onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public start(): void {
    if (this.isRunning) return;
    if (!this.target) {
      this.setState("error", "No SSH target configured");
      return;
    }

    this.isRunning = true;
    this.setState("connecting");
    void this.pollImmediately();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.target) {
      await closeSshConnection(this.target);
    }

    this.setState("stopped");
  }

  public async fetchOnce(): Promise<HardwareMetrics | null> {
    if (!this.target) {
      throw new Error("No SSH target configured");
    }

    const command = getProbeCommand();
    const abortCtrl = new AbortController();
    const timeout = Math.min(8000, Math.max(4000, this.intervalMs * 2));

    try {
      const output = await executeRemoteCommand(this.target, command, timeout, abortCtrl.signal);
      const metrics = parseProbeOutput(output);
      if (!metrics) {
        throw new Error("Failed to parse remote metrics output");
      }
      this.latestMetrics = metrics;
      this.lastError = null;
      this.setState("connected");
      this.notifyMetrics(metrics);
      return metrics;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.setState("error", msg);
      throw err;
    }
  }

  private async pollImmediately(): Promise<void> {
    if (!this.isRunning || this.isFetching) return;

    this.isFetching = true;
    this.abortController = new AbortController();

    try {
      if (this.target) {
        const command = getProbeCommand();
        const timeout = Math.min(6000, this.intervalMs + 2000);
        const output = await executeRemoteCommand(
          this.target,
          command,
          timeout,
          this.abortController.signal
        );

        const metrics = parseProbeOutput(output);
        if (metrics) {
          this.latestMetrics = metrics;
          this.lastError = null;
          this.setState("connected");
          this.notifyMetrics(metrics);
        } else {
          this.setState("error", "Malformed probe metrics output");
        }
      }
    } catch (err: unknown) {
      if (this.isRunning) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        this.setState("error", msg);
      }
    } finally {
      this.isFetching = false;
      this.abortController = null;

      if (this.isRunning) {
        this.scheduleNextPoll();
      }
    }
  }

  private scheduleNextPoll(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.pollImmediately();
    }, this.intervalMs);
  }

  private setState(state: MonitorConnectionState, error?: string): void {
    this.state = state;
    if (error) {
      this.lastError = error;
    }
    for (const listener of this.statusListeners) {
      try {
        listener(state, error);
      } catch {
        // ignore listener errors
      }
    }
  }

  private notifyMetrics(metrics: HardwareMetrics): void {
    for (const listener of this.metricsListeners) {
      try {
        listener(metrics);
      } catch {
        // ignore listener errors
      }
    }
  }
}
