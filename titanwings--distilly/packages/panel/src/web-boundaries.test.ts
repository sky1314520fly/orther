import { describe, expect, it, vi } from "vitest";

import { consumePanelFragment } from "./web-fragment.js";
import { PanelSseDecoder } from "./web-sse.js";

const TOKEN = "a".repeat(64);
const SUBJECT_ID = `subject_${"b".repeat(32)}`;
const VERSION_ID = `version_${"c".repeat(64)}`;

describe("Panel fragment boundary", () => {
  it("removes a root token synchronously without persisting it", () => {
    const replaceState = vi.fn();
    const result = consumePanelFragment(
      { hash: `#${TOKEN}`, pathname: "/", search: "" },
      { state: { marker: true }, replaceState },
    );
    expect(result).toEqual({ token: TOKEN, route: { kind: "library" } });
    expect(replaceState).toHaveBeenCalledWith({ marker: true }, "", "/");
  });

  it("preserves only the validated review route", () => {
    const replaceState = vi.fn();
    const result = consumePanelFragment(
      {
        hash: `#${TOKEN}/review/${SUBJECT_ID}/${VERSION_ID}`,
        pathname: "/index.html",
        search: "",
      },
      { state: null, replaceState },
    );
    expect(result.route).toEqual({
      kind: "review",
      review: { subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID },
    });
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      `/index.html#/review/${SUBJECT_ID}/${VERSION_ID}`,
    );
    for (const call of replaceState.mock.calls) expect(call[2]).not.toContain(TOKEN);
  });

  it("rejects missing, uppercase, malformed, and extra routes", () => {
    for (const hash of [
      "",
      `#${TOKEN.toUpperCase()}`,
      `#${TOKEN}/subject/${SUBJECT_ID}`,
      `#${TOKEN}/review/${SUBJECT_ID}`,
      `#${TOKEN}/review/${SUBJECT_ID}/${VERSION_ID}/extra`,
    ]) {
      const replaceState = vi.fn();
      expect(() =>
        consumePanelFragment({ hash, pathname: "/", search: "" }, { state: null, replaceState }),
      ).toThrow();
      if (hash.startsWith(`#${TOKEN}/`)) {
        expect(replaceState).toHaveBeenCalledWith(null, "", "/");
      }
    }
  });
});

describe("Panel SSE byte decoder", () => {
  it("decodes UTF-8 and multiple frames split at arbitrary byte boundaries", () => {
    const bytes = new TextEncoder().encode(
      'event: ready\r\ndata: {"wireVersion":"3"}\r\n\r\nevent: engine\ndata: {"kind":"job.changed","subjectId":"人物"}\n\n',
    );
    const decoder = new PanelSseDecoder();
    const frames = [
      ...decoder.push(bytes.slice(0, 8)),
      ...decoder.push(bytes.slice(8, bytes.length - 1)),
      ...decoder.push(bytes.slice(bytes.length - 1)),
      ...decoder.finish(),
    ];
    expect(frames).toEqual([
      { event: "ready", data: '{"wireVersion":"3"}' },
      { event: "engine", data: '{"kind":"job.changed","subjectId":"人物"}' },
    ]);
  });

  it("joins multiple data fields and ignores comments", () => {
    const decoder = new PanelSseDecoder();
    const frames = decoder.push(
      new TextEncoder().encode(": keepalive\nevent: engine\ndata: one\ndata: two\n\n"),
    );
    expect(frames).toEqual([{ event: "engine", data: "one\ntwo" }]);
  });

  it("rejects over-limit and incomplete frames", () => {
    const prefix = "event: engine\ndata:";
    const exact = new PanelSseDecoder();
    const exactPayload = "x".repeat(16_384 - new TextEncoder().encode(prefix).byteLength - 2);
    expect(exact.push(new TextEncoder().encode(`${prefix}${exactPayload}\n\n`))).toHaveLength(1);

    const oversized = new PanelSseDecoder();
    expect(() => oversized.push(new TextEncoder().encode(`${prefix}${exactPayload}x\n\n`))).toThrow(
      "exceeds 16 KiB",
    );
    const incomplete = new PanelSseDecoder();
    incomplete.push(new TextEncoder().encode("data: partial"));
    expect(() => incomplete.finish()).toThrow("ended inside a frame");
  });

  it("rejects invalid UTF-8", () => {
    const decoder = new PanelSseDecoder();
    expect(() => decoder.push(Uint8Array.from([0xff]))).toThrow();
  });
});
