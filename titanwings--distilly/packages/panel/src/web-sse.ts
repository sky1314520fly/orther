import { PANEL_SSE_EVENT_BYTES } from "./transport.js";

/** One complete SSE event/data frame after bounded UTF-8 decoding. */
export interface PanelSseFrame {
  readonly event: string;
  readonly data: string;
}

const parseFrame = (text: string): PanelSseFrame | undefined => {
  let event = "message";
  const data: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n") };
};

/** Incrementally decodes bounded UTF-8 SSE frames across arbitrary byte chunks. */
export class PanelSseDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #encoder = new TextEncoder();
  #buffer = "";

  /**
   * Adds one response-body chunk and returns every complete frame it contains.
   *
   * @param chunk - Arbitrary byte segment from the fetch response reader.
   * @returns Complete frames decoded from the accumulated bytes.
   */
  push(chunk: Uint8Array): readonly PanelSseFrame[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    this.#buffer = this.#buffer.replaceAll("\r\n", "\n");
    const frames: PanelSseFrame[] = [];
    let separator = this.#buffer.indexOf("\n\n");
    while (separator !== -1) {
      const raw = this.#buffer.slice(0, separator);
      this.#buffer = this.#buffer.slice(separator + 2);
      if (this.#encoder.encode(`${raw}\n\n`).byteLength > PANEL_SSE_EVENT_BYTES) {
        throw new Error("Panel SSE frame exceeds 16 KiB.");
      }
      const frame = parseFrame(raw);
      if (frame !== undefined) frames.push(frame);
      separator = this.#buffer.indexOf("\n\n");
    }
    const missingSeparatorBytes = this.#buffer.endsWith("\n") ? 1 : 2;
    if (
      this.#encoder.encode(this.#buffer).byteLength + missingSeparatorBytes >
      PANEL_SSE_EVENT_BYTES
    ) {
      throw new Error("Panel SSE frame exceeds 16 KiB.");
    }
    return frames;
  }

  /**
   * Finishes UTF-8 decoding and rejects a trailing incomplete frame.
   *
   * @returns Any final complete frames.
   */
  finish(): readonly PanelSseFrame[] {
    this.#buffer += this.#decoder.decode();
    const frames = this.push(new Uint8Array());
    if (this.#buffer.length !== 0) throw new Error("Panel SSE stream ended inside a frame.");
    return frames;
  }
}
