import { describe, expect, it, vi } from "vitest";

import { subjectIdSchema, versionIdSchema } from "@distilly/protocol";

import { PanelLauncher } from "./server-launcher.js";
import type { PanelHandle } from "./server-http.js";

const TOKEN = "a".repeat(64);
const SUBJECT_ID = subjectIdSchema.parse(`subject_${"b".repeat(32)}`);
const OTHER_SUBJECT_ID = subjectIdSchema.parse(`subject_${"c".repeat(32)}`);
const VERSION_ID = versionIdSchema.parse(`version_${"d".repeat(64)}`);
const OTHER_VERSION_ID = versionIdSchema.parse(`version_${"e".repeat(64)}`);

interface TestPanelHandle extends PanelHandle {
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

const panelHandle = (url = `http://127.0.0.1:43111/#${TOKEN}`): TestPanelHandle => ({
  url,
  close: vi.fn(() => Promise.resolve()),
});

describe("PanelLauncher", () => {
  it("single-flights concurrent presents and preserves each exact review route", async () => {
    const handle = panelHandle();
    const start = vi.fn(() => Promise.resolve(handle));
    const launcher = new PanelLauncher({ start });

    const [first, second] = await Promise.all([
      launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }),
      launcher.present({ subjectId: OTHER_SUBJECT_ID, candidateVersionId: OTHER_VERSION_ID }),
    ]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(first).toEqual({
      ref: { subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID },
      url: `http://127.0.0.1:43111/#${TOKEN}/review/${SUBJECT_ID}/${VERSION_ID}`,
    });
    expect(second.url).toBe(
      `http://127.0.0.1:43111/#${TOKEN}/review/${OTHER_SUBJECT_ID}/${OTHER_VERSION_ID}`,
    );

    await Promise.all([launcher.close(), launcher.close()]);
    expect(handle.close.mock.calls).toHaveLength(1);
  });

  it("allows a retry after start failure", async () => {
    const handle = panelHandle();
    const start = vi
      .fn<() => Promise<PanelHandle>>()
      .mockRejectedValueOnce(new Error("occupied"))
      .mockResolvedValueOnce(handle);
    const launcher = new PanelLauncher({ start });

    await expect(
      launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }),
    ).rejects.toThrow("occupied");
    await expect(
      launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }),
    ).resolves.toMatchObject({ ref: { subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID } });
    expect(start).toHaveBeenCalledTimes(2);
    await launcher.close();
  });

  it("shares one start rejection across concurrent waiters before allowing retry", async () => {
    const failure = new Error("start failed");
    let rejectStart: ((error: Error) => void) | undefined;
    const handle = panelHandle();
    const start = vi
      .fn<() => Promise<PanelHandle>>()
      .mockImplementationOnce(
        async () =>
          await new Promise<PanelHandle>((_resolve, reject) => {
            rejectStart = reject;
          }),
      )
      .mockResolvedValueOnce(handle);
    const launcher = new PanelLauncher({ start });
    const first = launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID });
    const second = launcher.present({
      subjectId: OTHER_SUBJECT_ID,
      candidateVersionId: OTHER_VERSION_ID,
    });
    rejectStart?.(failure);

    const rejected = await Promise.allSettled([first, second]);
    expect(rejected).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await expect(
      launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }),
    ).resolves.toMatchObject({ ref: { subjectId: SUBJECT_ID } });
    expect(start).toHaveBeenCalledTimes(2);
    await launcher.close();
  });

  it("closes a handle whose root URL fails exact validation", async () => {
    for (const url of [
      `http://localhost:43111/#${TOKEN}`,
      `https://127.0.0.1:43111/#${TOKEN}`,
      `http://127.0.0.1:43111/path/#${TOKEN}`,
      `http://127.0.0.1:43111/#${TOKEN}/review/${SUBJECT_ID}/${VERSION_ID}`,
    ]) {
      const handle = panelHandle(url);
      const launcher = new PanelLauncher({ start: () => Promise.resolve(handle) });
      await expect(
        launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }),
      ).rejects.toThrow("exact loopback root");
      expect(handle.close.mock.calls).toHaveLength(1);
      await launcher.close();
      await expect(
        launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }),
      ).rejects.toThrow("closing or closed");
    }
  });

  it("shares an invalid-handle close failure while preserving the validation failure", async () => {
    const closeError = new Error("close failed");
    const handle = panelHandle(`http://localhost:43111/#${TOKEN}`);
    handle.close.mockRejectedValue(closeError);
    const start = vi.fn(() => Promise.resolve(handle));
    const launcher = new PanelLauncher({ start });

    const presenting = launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID });
    const closing = launcher.close();
    await expect(presenting).rejects.toThrow("exact loopback root");
    await expect(closing).rejects.toBe(closeError);
    await expect(launcher.close()).rejects.toBe(closeError);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("rejects the browser-canonicalized default HTTP port", async () => {
    const handle = panelHandle(`http://127.0.0.1:80/#${TOKEN}`);
    const launcher = new PanelLauncher({ start: () => Promise.resolve(handle) });

    await expect(
      launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }),
    ).rejects.toThrow("invalid or default port");
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("fails an in-flight present when close wins the start race", async () => {
    let resolveStart: ((handle: PanelHandle) => void) | undefined;
    const handle = panelHandle();
    const start = vi.fn(
      async () =>
        await new Promise<PanelHandle>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const launcher = new PanelLauncher({ start });
    const presenting = launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID });
    const closing = launcher.close();
    resolveStart?.(handle);

    await expect(presenting).rejects.toThrow("closed while");
    await closing;
    expect(handle.close.mock.calls).toHaveLength(1);
    await expect(
      launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }),
    ).rejects.toThrow("closing or closed");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("closes from idle without starting and stays terminal", async () => {
    const start = vi.fn(() => Promise.resolve(panelHandle()));
    const launcher = new PanelLauncher({ start });
    await launcher.close();
    await launcher.close();
    expect(start).not.toHaveBeenCalled();
    await expect(
      launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }),
    ).rejects.toThrow("closing or closed");
  });

  it("shares a running handle close failure and remains terminal", async () => {
    const closeError = new Error("close failed");
    const handle = panelHandle();
    handle.close.mockRejectedValue(closeError);
    const start = vi.fn(() => Promise.resolve(handle));
    const launcher = new PanelLauncher({ start });
    await launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID });

    const first = launcher.close();
    const second = launcher.close();
    expect(first).toBe(second);
    await expect(first).rejects.toBe(closeError);
    await expect(second).rejects.toBe(closeError);
    expect(handle.close).toHaveBeenCalledTimes(1);
    await expect(
      launcher.present({ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }),
    ).rejects.toThrow("closing or closed");
    expect(start).toHaveBeenCalledTimes(1);
  });
});
