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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private isFetching = false;

  private metricsListeners: Set<MetricsListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();

  constructor(targetString?: string, intervalSec = 2) {
    if (targetString) {
      this.target = parseSshTarget(targetString);
    }
    this.setInterval(intervalSec);
  }

  public setTarget(targetString: string): void {
    const newTarget = parseSshTarget(targetString);
    if (this.target?.raw === newTarget.raw) return;
    const previousTarget = this.target;
    this.generation++;
    this.abortController?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.target = newTarget;
    this.latestMetrics = null;
    this.lastError = null;
    if (previousTarget) void closeSshConnection(previousTarget);
    if (this.isRunning) {
      this.setState("connecting");
      void this.pollImmediately();
    }
  }

  public getTarget(): SshTarget | null {
    return this.target;
  }

  public setInterval(intervalSec: number): void {
    if (!Number.isFinite(intervalSec) || intervalSec < 1 || intervalSec * 1000 > 2_147_483_647) {
      throw new RangeError("SSH monitor interval must be at least 1 second and fit within a Node.js timer");
    }
    this.intervalMs = intervalSec * 1000;
  }

  public getIntervalSec(): number {
    return this.intervalMs / 1000;
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
    this.generation++;
    this.setState("stopped");

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
  }

  public async fetchOnce(signal?: AbortSignal): Promise<HardwareMetrics> {
    if (!this.target) {
      throw new Error("No SSH target configured");
    }

    const target = this.target;
    const generation = this.generation;
    const command = getProbeCommand();

    try {
      const output = await executeRemoteCommand(target, command, undefined, signal);
      const metrics = parseProbeOutput(output);
      if (!metrics) {
        throw new Error("Failed to parse remote metrics output");
      }
      if (generation === this.generation) {
        this.latestMetrics = metrics;
        this.lastError = null;
        // A snapshot must not make an idle/stopped monitor appear active.
        if (this.isRunning) this.setState("connected");
        this.notifyMetrics(metrics);
      }
      return metrics;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (generation === this.generation && !signal?.aborted) {
        this.lastError = msg;
        if (this.isRunning) this.setState("error", msg);
      }
      throw err;
    }
  }

  private async pollImmediately(): Promise<void> {
    if (!this.isRunning || this.isFetching) return;

    this.isFetching = true;
    const generation = this.generation;
    const target = this.target;
    this.abortController = new AbortController();

    try {
      if (target) {
        const output = await executeRemoteCommand(
          target, getProbeCommand(), undefined, this.abortController.signal
        );
        if (!this.isRunning || generation !== this.generation) return;
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
      if (this.isRunning && generation === this.generation) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        this.setState("error", msg);
      }
    } finally {
      this.isFetching = false;
      this.abortController = null;

      if (this.isRunning) {
        this.scheduleNextPoll(generation !== this.generation);
      }
    }
  }

  private scheduleNextPoll(immediate = false): void {
    if (this.timer) clearTimeout(this.timer);
    let delay = this.lastError ? Math.max(5000, this.intervalMs) : this.intervalMs;
    if (immediate) delay = 0;
    this.timer = setTimeout(() => {
      void this.pollImmediately();
    }, delay);
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
