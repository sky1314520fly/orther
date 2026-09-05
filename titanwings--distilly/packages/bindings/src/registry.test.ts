import { type HostName, type HostPreflight } from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import type {
  HostBinding,
  HostCapabilityBinding,
  HostContext,
  HostRegistryBinding,
} from "./protocol.js";
import { HostRegistry } from "./registry.js";

const unsupported = (): Promise<HostPreflight> =>
  Promise.resolve({
    ok: false,
    capabilities: {
      webResearch: "unknown",
      localFileRead: "unknown",
      vision: "unknown",
      documentTextExtraction: "unknown",
      imageOcr: "unknown",
      audioTranscription: "unknown",
      videoCaptions: "unknown",
      privateUiCapture: "unavailable",
      windowScopedCapture: "unknown",
      captureDataPolicy: "unknown",
      structuredToolCalls: false,
      lifecycleHooks: [],
      subruns: false,
      subrunsInheritMcp: false,
      opensLoopbackUrls: false,
    },
    error: {
      code: "host_unsupported",
      message: "Unsupported fixture.",
      retryable: false,
    },
    warnings: [],
  });

const capability = (host: string): HostCapabilityBinding => ({
  kind: "capability",
  host: host as HostName,
  preflight: unsupported,
});

const full = (host: string): HostBinding => ({
  kind: "full",
  host: host as HostName,
  preflight: unsupported,
  createInjector: () => ({
    host: host as HostName,
    injectSubrun: (_injection, request) => request,
    install: () => Promise.reject(new Error("not exercised")),
    uninstall: () => Promise.resolve(),
    exportIdentity: () => Promise.reject(new Error("not exercised")),
  }),
  createFormRenderer: () => ({
    host: host as HostName,
    ask: () => Promise.reject(new Error("not exercised")),
  }),
  installPlugin: () => Promise.reject(new Error("not exercised")),
  uninstallPlugin: () => Promise.resolve(),
  doctor: () =>
    Promise.resolve({
      host: host as HostName,
      installed: false,
      launcherReachable: false,
      wireCompatible: false,
      warnings: [],
    }),
});

const registerUnknown = (registry: HostRegistry, binding: unknown): void => {
  registry.register(binding as HostRegistryBinding);
};

describe("HostRegistry", () => {
  it("registers and retrieves both discriminated binding branches", () => {
    const registry = new HostRegistry();
    const custom = capability("custom-host");
    const complete = full("full-host");

    registry.register(custom);
    registry.register(complete);

    expect(registry.get(custom.host)).toBe(custom);
    expect(registry.get(complete.host)).toBe(complete);
    expect(registry.get("missing-host" as HostName)).toBeUndefined();
  });

  it("rejects invalid names, loose injectors, and incomplete branch methods", () => {
    const context = {} as HostContext;
    const invalid = [
      null,
      { host: "custom", injectSubrun: () => context },
      { kind: "capability", host: "Invalid", preflight: unsupported },
      { kind: "capability", host: "custom" },
      { kind: "full", host: "custom", preflight: unsupported },
      { ...full("custom"), createInjector: undefined },
      { ...full("custom"), createFormRenderer: undefined },
      { ...full("custom"), installPlugin: undefined },
      { ...full("custom"), uninstallPlugin: undefined },
      { ...full("custom"), doctor: undefined },
      { ...full("custom"), createPrivateUiCaptureController: true },
      { kind: "injector", host: "custom", preflight: unsupported },
    ] as const;

    for (const binding of invalid) {
      const registry = new HostRegistry();
      expect(() => registerUnknown(registry, binding)).toThrow(TypeError);
      expect(registry.list()).toEqual([]);
    }
  });

  it("rejects cross-kind duplicates synchronously without mutation", () => {
    const registry = new HostRegistry();
    const first = capability("same-host");
    registry.register(first);

    expect(() => registry.register(full("same-host"))).toThrowError(
      expect.objectContaining({ name: "DuplicateHostBindingError" }),
    );
    expect(registry.list()).toEqual([first]);

    const reverse = new HostRegistry();
    const complete = full("same-host");
    reverse.register(complete);
    expect(() => reverse.register(capability("same-host"))).toThrowError(
      expect.objectContaining({ name: "DuplicateHostBindingError" }),
    );
    expect(reverse.list()).toEqual([complete]);
  });

  it("returns frozen UTF-8-ordered snapshots that do not change later", () => {
    const registry = new HostRegistry();
    registry.register(capability("zeta"));
    registry.register(capability("a1"));
    registry.register(capability("a"));
    registry.register(capability("claude-code"));
    registry.register(capability("alpha"));

    const snapshot = registry.list();
    expect(snapshot.map(({ host }) => host)).toEqual(["a", "a1", "alpha", "claude-code", "zeta"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot as HostRegistryBinding[]).push(capability("later"))).toThrow(TypeError);

    registry.register(capability("beta"));
    expect(snapshot.map(({ host }) => host)).toEqual(["a", "a1", "alpha", "claude-code", "zeta"]);
    expect(registry.list().map(({ host }) => host)).toEqual([
      "a",
      "a1",
      "alpha",
      "beta",
      "claude-code",
      "zeta",
    ]);
  });

  it("validates get lookups at runtime", () => {
    const registry = new HostRegistry();
    expect(() => registry.get("Invalid" as HostName)).toThrow(TypeError);
  });
});
