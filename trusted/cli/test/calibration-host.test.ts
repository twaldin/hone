import { describe, expect, it } from "vitest";
import { inspectCalibrationHost, type CalibrationHostProbes } from "../src/calibration-host.js";

const image = `hone-mutation@sha256:${"a".repeat(64)}`;
const imageId = `sha256:${"b".repeat(64)}`;

function hostFixture(driver: "systemd" | "cgroupfs" = "systemd") {
  const parent = driver === "systemd" ? "hone-calibration.slice" : "/calibration";
  const path = driver === "systemd" ? "/hone.slice/hone-calibration.slice" : parent;
  const current = `${path}/supervisor.scope`;
  const files = new Map([
    ["/proc/self/mountinfo", "36 25 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n"],
    ["/proc/self/cgroup", `0::${current}\n`],
    [`/sys/fs/cgroup${current}/cgroup.procs`, "4242\n"],
    [`/sys/fs/cgroup${path}/memory.max`, "2147483648\n"],
    [`/sys/fs/cgroup${path}/memory.swap.max`, "0\n"],
    [`/sys/fs/cgroup${path}/cpu.max`, "200000 100000\n"],
  ]);
  const daemon = { ID: "native-engine", OSType: "linux", OperatingSystem: "Ubuntu 24.04",
    SecurityOptions: ["name=seccomp,profile=builtin"], Architecture: "x86_64", KernelVersion: "6.8.0-test",
    Name: "calhost", CgroupVersion: "2", CgroupDriver: driver, ServerErrors: [] };
  const probes: CalibrationHostProbes = {
    platform: "linux", machine: "x86_64", kernelRelease: "6.8.0-test", hostname: "calhost", pid: 4242,
    readText: (file) => { const value = files.get(file); if (value === undefined) throw new Error(`unprovided kernel file ${file}`); return value; },
    realpath: (file) => file,
    isDirectory: (file) => file === `/sys/fs/cgroup${path}`,
    isSocket: (file) => file === "/var/run/docker.sock",
    bootId: () => "01234567-89ab-4cde-8f01-23456789abcd",
    docker: (args) => {
      let stdout: string;
      if (args[0] === "context") stdout = "unix:///var/run/docker.sock\n";
      else if (args.includes("info")) stdout = JSON.stringify(daemon);
      else if (args.includes("image")) stdout = JSON.stringify({ Id: imageId, Os: "linux", Architecture: "amd64", RepoDigests: [image] });
      else throw new Error(`unexpected Docker operation: ${args.join(" ")}`);
      return { status: 0, stdout, stderr: "", error: null };
    },
  };
  return { parent, path, current, files, daemon, probes };
}

describe("calibration aggregate host admission", () => {
  it.each(["systemd", "cgroupfs"] as const)("resolves a capped native %s parent containing the supervisor", (driver) => {
    const fixture = hostFixture(driver);
    const binding = inspectCalibrationHost(image, fixture.parent, {}, fixture.probes);
    expect(binding).toMatchObject({ cgroupPath: fixture.path, cgroupDriver: driver, dockerId: "native-engine",
      imageId, architecture: "amd64", memoryBytes: 2147483648, cpuQuota: 200000, cpuPeriod: 100000 });
  });

  it("refuses a supervisor outside the parent even when the candidate group is capped", () => {
    const fixture = hostFixture();
    fixture.files.set("/proc/self/cgroup", `0::${fixture.path}-escape/supervisor.scope\n`);
    expect(() => inspectCalibrationHost(image, fixture.parent, {}, fixture.probes)).toThrow(/not inside/);
  });

  it.each([
    ["memory.max", "max\n"], ["cpu.max", "300000 100000\n"], ["memory.swap.max", "1\n"],
  ])("refuses unbounded or excessive aggregate %s", (file, value) => {
    const fixture = hostFixture();
    fixture.files.set(`/sys/fs/cgroup${fixture.path}/${file}`, value);
    expect(() => inspectCalibrationHost(image, fixture.parent, {}, fixture.probes)).toThrow(/ceiling|CPUs/);
  });

  it("refuses a local Unix socket backed by a different machine", () => {
    const fixture = hostFixture();
    fixture.daemon.Name = "different-host";
    expect(() => inspectCalibrationHost(image, fixture.parent, {}, fixture.probes)).toThrow(/host|daemon/);
  });

  it("refuses non-native and remote execution instead of falling back to per-container caps", () => {
    const fixture = hostFixture();
    expect(() => inspectCalibrationHost(image, fixture.parent, { DOCKER_HOST: "tcp://remote:2375" }, fixture.probes)).toThrow(/unix/);
    expect(() => inspectCalibrationHost(image, fixture.parent, {}, { ...fixture.probes, platform: "darwin" })).toThrow(/Linux|linux/);
  });

  it("refuses a cgroup namespace or mount that does not contain this process", () => {
    const fixture = hostFixture();
    fixture.files.set(`/sys/fs/cgroup${fixture.current}/cgroup.procs`, "9999\n");
    expect(() => inspectCalibrationHost(image, fixture.parent, {}, fixture.probes)).toThrow(/not listed/);
  });
});
