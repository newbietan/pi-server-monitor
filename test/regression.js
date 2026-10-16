import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseSshTarget, extractSshTargetFromCommand, extractSshTargetFromCode, executeRemoteCommand } from "../dist/ssh.js";
import { ResourceCollector } from "../dist/collector.js";
import { createRemoteHardwareTool } from "../dist/tool.js";
import { renderCompactWidgetLines } from "../dist/ui.js";
import extension from "../dist/index.js";

const metrics = (percent = 10) => ({
  timestamp: 1728000000,
  cpu: { percent, cores: 8 },
  memory: { totalMb: 8192, usedMb: 2048, availMb: 6144, percent: 25 },
  gpus: [],
  processes: [],
});
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function environment(t, values = {}) {
  const entries = { PI_SSH_TARGET: undefined, PI_SSH_INTERVAL: undefined, PI_SSH_TIMEOUT: undefined, PI_SSH_CONNECT_TIMEOUT: undefined, ...values };
  const saved = Object.fromEntries(Object.keys(entries).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// No regression test contacts an SSH server or needs credentials.
function mockSsh(t, respond) {
  const calls = [];
  t.mock.method(childProcess, "spawn", (executable, args) => {
    assert.equal(executable, "ssh");
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killedWith = [];
    child.kill = (signal) => {
      child.killedWith.push(signal);
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    child.complete = (data = metrics(), code = 0) => {
      child.stdout.write(typeof data === "string" ? data : JSON.stringify(data));
      child.emit("close", code);
    };
    calls.push({ args, child });
    if (respond) queueMicrotask(() => respond(child, args));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

function mockExtension(flags = {}) {
  const events = new Map();
  const commands = new Map();
  extension({
    registerFlag() {},
    getFlag: (name) => flags[name],
    on: (name, handler) => events.set(name, handler),
    registerTool() {},
    registerCommand: (name, definition) => commands.set(name, definition),
  });
  const ctx = { hasUI: false, ui: {
    notify() { assert.fail("No notifications expected without UI"); },
    setWidget() { assert.fail("No widgets expected without UI"); },
    setStatus() { assert.fail("No status expected without UI"); },
  } };
  return { events, commands, ctx };
}

test("target detection respects each client's options and SSH transport", () => {
  const cases = [
    ["ssh -p2222 user@compute-node hostname", "user@compute-node:2222"],
    ["ssh -o Port=2200 -l trainer compute-node", "trainer@compute-node:2200"],
    ["ssh -oPort=2200 -oUser=trainer compute-node", "trainer@compute-node:2200"],
    ["ssh -L 8080:localhost:80 -J gateway compute-node", "compute-node"],
    ["sftp -P 2201 user@storage-node", "user@storage-node:2201"],
    ["sftp -b batch.txt -P2201 user@storage-node:/data", "user@storage-node:2201"],
    ["scp -p weights.bin user@storage-node:/data", "user@storage-node"],
    ["scp -P2201 user@storage-node:/data ./local", "user@storage-node:2201"],
    ["rsync -p ./local/ user@storage-node:/data/", "user@storage-node"],
    ["rsync -P ./local/ user@storage-node:/data/", "user@storage-node"],
    ["rsync -e 'ssh -p 2201 -l trainer' ./local/ storage-node:/data", "trainer@storage-node:2201"],
    ["rsync --rsh='ssh -p 2201' ./local/ storage-node:/data", "storage-node:2201"],
    ["rsync --exclude 'cache:tmp' --rsync-path 'sudo rsync' ./local/ storage-node:/data", "storage-node"],
    ["sudo -u trainer /usr/bin/ssh compute-node hostname", "compute-node"],
    ["env CI=1 ssh compute-node hostname", "compute-node"],
    ["bash -lc 'ssh compute-node hostname'", "compute-node"],
    ["git status && ssh compute-node hostname", "compute-node"],
    ["ssh -p 2201 user@[2001:db8::1] hostname", "user@[2001:db8::1]:2201"],
    ["scp -P 2201 ./local user@[2001:db8::1]:/data", "user@[2001:db8::1]:2201"],
    ["sftp -P 2201 user@[2001:db8::1]:/data", "user@[2001:db8::1]:2201"],
    ["rsync -e 'ssh -p 2201' ./local user@[2001:db8::1]:/data", "user@[2001:db8::1]:2201"],
  ];
  for (const [command, expected] of cases) assert.equal(extractSshTargetFromCommand(command), expected, command);
});

test("target detection does not guess from scripts, text, daemon transfers or invalid input", () => {
  const commands = [
    "./scripts/sync.sh push", "./scripts/sync.sh --host other-node", "./deploy.sh --host compute-node",
    "echo 'ssh not-a-connection'", "printf '%s' 'ssh not-a-connection'", "# ssh not-a-connection",
    "cat <<'EOF'\nssh documented-host\nEOF", // A heredoc body is data, not a command.
    "git clone git@github.com:org/repo", "ssh -T git@github.com", "ssh -T git@gitlab.com",
    "ssh -G compute-node", "ssh -V", "ssh -Q cipher", "ssh -O exit compute-node",
    "ssh -p 99999 compute-node", "ssh -p 0 compute-node", "ssh -p invalid compute-node", "ssh -p",
    "ssh -o Port=99999 compute-node", "ssh '$UNRESOLVED_HOST' hostname", "ssh 'unterminated",
    "rsync -az ./src/ ./dst/", "rsync storage-node::module ./local", "rsync rsync://storage-node/module ./local",
    "rsync --port=873 ./local storage-node:/data", "rsync -e rsh ./local storage-node:/data",
    "scp ./dir/file:name ./local", "echo ssh compute-node", "ls -la", "",
  ];
  for (const command of commands) assert.equal(extractSshTargetFromCommand(command), null, command);
});

test("code detection requires a known execution language and literal subprocess argv", () => {
  const cases = [
    ["subprocess.run(['ssh', '-p', '2200', 'trainer@compute-node', 'hostname'])", "python", "trainer@compute-node:2200"],
    ['result = subprocess.check_output(["scp", "-P", "2200", "node:/data", "./local"])', "python", "node:2200"],
    ["subprocess.run(['ssh', '-T', 'git@github.com'])", "python", null],
    ["subprocess.run(['ssh', destination])", "python", null],
    ["subprocess.run(['ssh' 'compute-node'])", "python", null],
    ['"""\nsubprocess.run([\'ssh\', \'documented-node\'])\n"""', "python", null],
    ["# subprocess.run(['ssh', 'compute-node'])", "python", null],
    ['example = "subprocess.run([\'ssh\', \'compute-node\'])"', "python", null],
    ["['ssh', 'compute-node']", "python", null],
    ["subprocess.run(['ssh', 'compute-node'])", undefined, null],
    ["ssh compute-node hostname", "javascript", null],
    ["ssh compute-node hostname", "shell", "compute-node"],
  ];
  for (const [code, language, expected] of cases) assert.equal(extractSshTargetFromCode(code, language), expected, code);
});

test("SSH targets validate ports and reject option injection", () => {
  for (const raw of ["", "-oProxyCommand=evil", "user@-host", "user@host:22junk", "host:0", "host:65536", "host:/path", "user@host other", "a@b@host"]) {
    assert.throws(() => parseSshTarget(raw), undefined, raw);
  }
  assert.equal(parseSshTarget("user@[2001:db8::1]:2200").host, "2001:db8::1");
  assert.equal(parseSshTarget("2001:db8::1").port, undefined);
});

test("timeout policy honors valid overrides and cleans up abort listeners", async (t) => {
  environment(t, { PI_SSH_TIMEOUT: "30", PI_SSH_CONNECT_TIMEOUT: "7" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = mockSsh(t);
  const controller = new AbortController();
  const pending = assert.rejects(executeRemoteCommand(parseSshTarget("test-node"), "probe", 20000, controller.signal), /timed out after 30ms/);
  assert.ok(calls[0].args.includes("ConnectTimeout=7"));
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  t.mock.timers.tick(30);
  await pending;
  assert.deepEqual(calls[0].child.killedWith, ["SIGKILL"]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("invalid timeout environment values fall back rather than overflowing timers", async (t) => {
  for (const value of ["-1", "0", "NaN", "Infinity", "2147483648", "not-a-number"]) {
    await t.test(value, async (t) => {
      environment(t, { PI_SSH_TIMEOUT: value, PI_SSH_CONNECT_TIMEOUT: value });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const calls = mockSsh(t);
      const pending = assert.rejects(executeRemoteCommand(parseSshTarget("test-node"), "probe"), /timed out after 20000ms/);
      assert.ok(calls[0].args.includes("ConnectTimeout=15"));
      t.mock.timers.tick(20000);
      await pending;
    });
  }
});

test("SSH cancellation works before spawn and during a request", async (t) => {
  environment(t);
  const calls = mockSsh(t);
  const early = new AbortController();
  early.abort();
  await assert.rejects(executeRemoteCommand(parseSshTarget("test-node"), "probe", undefined, early.signal), /aborted/);
  assert.equal(calls.length, 0);
  const active = new AbortController();
  const pending = assert.rejects(executeRemoteCommand(parseSshTarget("test-node"), "probe", undefined, active.signal), /aborted/);
  active.abort();
  await pending;
  assert.equal(getEventListeners(active.signal, "abort").length, 0);
  assert.deepEqual(calls[0].child.killedWith, ["SIGKILL"]);
});

test("SSH success and process failure release abort listeners", async (t) => {
  environment(t);
  const calls = mockSsh(t);
  for (const success of [true, false]) {
    const controller = new AbortController();
    const request = executeRemoteCommand(parseSshTarget("test-node"), "probe", undefined, controller.signal);
    const child = calls.at(-1).child;
    if (success) {
      child.complete("ok");
      assert.equal(await request, "ok");
    } else {
      child.emit("error", new Error("spawn failed"));
      await assert.rejects(request, /spawn failed/);
    }
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("switching targets discards old in-flight results and clears the old cache", async (t) => {
  environment(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = mockSsh(t);
  const collector = new ResourceCollector("test-node-a");
  t.after(() => collector.stop());
  const received = [];
  collector.onMetrics((value) => received.push(value.cpu.percent));
  collector.start();
  calls[0].child.complete(metrics(11));
  // Switch before the already-completed SSH promise resumes the polling callback.
  collector.setTarget("test-node-b");
  assert.equal(collector.getMetrics(), null);
  await flush();
  t.mock.timers.tick(0);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes("test-node-b"));
  calls[1].child.complete(metrics(22));
  await flush();
  assert.deepEqual(received, [22]);
  assert.equal(collector.getMetrics().cpu.percent, 22);
  collector.setTarget("test-node-c");
  assert.equal(collector.getMetrics(), null);
});

test("poll failures back off for five seconds and recovery restores normal polling", async (t) => {
  environment(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = mockSsh(t);
  const collector = new ResourceCollector("test-node", 2);
  t.after(() => collector.stop());
  collector.start();
  calls[0].child.complete("malformed output");
  await flush();
  assert.equal(collector.getState(), "error");
  t.mock.timers.tick(4999);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 2);
  calls[1].child.complete();
  await flush();
  assert.equal(collector.getLastError(), null);
  t.mock.timers.tick(2000);
  assert.equal(calls.length, 3);
});

test("late one-shot results cannot revive a stopped collector", async (t) => {
  environment(t);
  const calls = mockSsh(t);
  const collector = new ResourceCollector("test-node");
  const pending = collector.fetchOnce();
  await collector.stop();
  calls[0].child.complete();
  await pending;
  assert.equal(collector.getState(), "stopped");
  assert.equal(collector.getMetrics(), null);
});

test("invalid polling intervals cannot create hot loops", () => {
  const collector = new ResourceCollector();
  for (const value of [NaN, Infinity, -1, 0, 0.5, 2147484]) assert.throws(() => collector.setInterval(value), RangeError);
  assert.equal(collector.getIntervalSec(), 2);
  assert.throws(() => new ResourceCollector(undefined, Infinity), RangeError);
  collector.setInterval(1.5);
  assert.equal(collector.getIntervalSec(), 1.5);
});

test("explicit hardware queries are one-shot and never silently adopt or switch targets", async (t) => {
  environment(t);
  const calls = mockSsh(t, (child) => child.complete());
  const idle = new ResourceCollector();
  const first = await createRemoteHardwareTool(idle).execute("first", { target: "test-node-a" });
  assert.ok(!first.isError);
  assert.equal(idle.getTarget(), null);
  assert.equal(idle.getState(), "idle");
  const collector = new ResourceCollector("test-node-a");
  t.after(() => collector.stop());
  collector.start();
  await flush();
  const tool = createRemoteHardwareTool(collector);
  await tool.execute("refresh", { forceRefresh: true });
  assert.equal(collector.getState(), "connected");
  const cached = collector.getMetrics();
  await tool.execute("other", { target: "test-node-b" });
  assert.equal(collector.getTarget().raw, "test-node-a");
  assert.equal(collector.getMetrics(), cached);
  await tool.execute("cache", {});
  assert.equal(calls.length, 4);
});

test("snapshots of an idle or stopped monitor do not make it active", async (t) => {
  environment(t);
  mockSsh(t, (child) => child.complete());
  const collector = new ResourceCollector("test-node");
  const tool = createRemoteHardwareTool(collector);
  await tool.execute("idle", { forceRefresh: true });
  assert.equal(collector.getState(), "idle");
  assert.ok(collector.getMetrics());
  await collector.stop();
  await tool.execute("stopped", { forceRefresh: true });
  assert.equal(collector.getState(), "stopped");
});

test("compact error messages distinguish failures and never disguise stale data as live", () => {
  const target = parseSshTarget("user@test-node:2200");
  const cases = [
    ["SSH command timed out after 20000ms", "连接超时"],
    ["Permission denied (publickey)", "认证失败"],
    ["Connection refused", "连接被拒"],
    ["Could not resolve hostname test-node", "主机名解析失败"],
    ["unknown failure", "连接失败"],
  ];
  for (const [error, hint] of cases) {
    const line = renderCompactWidgetLines(metrics(), "error", target, undefined, 200, error)[0];
    assert.ok(line.includes(hint), error);
    assert.ok(line.includes("上次数据已过期"));
    assert.ok(line.includes(":2200"));
    assert.ok(!line.includes("CPU 10%"));
  }
  const narrow = renderCompactWidgetLines(null, "error", target, undefined, 25, "Connection refused")[0];
  assert.ok(visibleWidth(narrow) <= 25);
});

test("extension ignores project configuration and supports non-UI automatic activation", async (t) => {
  environment(t);
  const calls = mockSsh(t, (child) => child.complete());
  const dir = mkdtempSync(join(tmpdir(), "pi-monitor-test-"));
  const cwd = process.cwd();
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ target: "unrelated-project-target" }));
  writeFileSync(join(dir, ".pi-server-monitor.json"), JSON.stringify({ target: "unrelated-project-target" }));
  process.chdir(dir);
  t.after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  const { events, ctx } = mockExtension();
  t.after(() => events.get("session_shutdown")({}, ctx));
  events.get("session_start")({}, ctx);
  assert.equal(calls.length, 0);
  events.get("tool_call")({ toolName: "write", input: { code: "ssh documented-node", language: "javascript" } }, ctx);
  assert.equal(calls.length, 0);
  events.get("tool_call")({ toolName: "bash", input: { command: "ssh test-node-a hostname" } }, ctx);
  await flush();
  assert.equal(calls.length, 1);
  events.get("tool_call")({ toolName: "ctx_execute", input: { code: "subprocess.run(['ssh', '-p', '2200', 'test-node-b'])", language: "python" } }, ctx);
  await flush();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes("test-node-b"));
  assert.ok(calls[1].args.includes("2200"));
});

test("stop/start during an in-flight poll resumes without publishing old results", async (t) => {
  environment(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = mockSsh(t);
  const collector = new ResourceCollector("test-node");
  t.after(() => collector.stop());
  collector.start();
  await collector.stop();
  collector.start();
  await flush();
  t.mock.timers.tick(0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].child.killedWith, ["SIGKILL"]);
  calls[1].child.complete(metrics(33));
  await flush();
  assert.equal(collector.getState(), "connected");
  assert.equal(collector.getMetrics().cpu.percent, 33);
});

test("remote-execution --ssh flag keeps bracketed IPv6 while removing its path", async (t) => {
  environment(t);
  const calls = mockSsh(t, (child) => child.complete());
  const { events, ctx } = mockExtension({ ssh: "trainer@[2001:db8::1]:/workspace" });
  t.after(() => events.get("session_shutdown")({}, ctx));
  events.get("session_start")({}, ctx);
  await flush();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("trainer@2001:db8::1"));
});

test("explicit startup target and invalid interval environment are handled safely", async (t) => {
  environment(t, { PI_SSH_TARGET: "env-node", PI_SSH_INTERVAL: "Infinity" });
  const calls = mockSsh(t, (child) => child.complete());
  const { events, ctx } = mockExtension({ "ssh-monitor": "flag-node:2200" });
  t.after(() => events.get("session_shutdown")({}, ctx));
  events.get("session_start")({}, ctx);
  await flush();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("flag-node"));
  assert.ok(calls[0].args.includes("2200"));
});
