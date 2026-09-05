import type { MaterialParser } from "./contracts.js";

const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

class DuplicateMaterialParserError extends Error {
  public constructor(id: string) {
    super(`A material parser is already registered for ${id}.`);
    this.name = "DuplicateMaterialParserError";
  }
}

class ConflictingMediaTypeError extends Error {
  public constructor(mediaType: string) {
    super(`A material parser is already registered for ${mediaType}.`);
    this.name = "ConflictingMediaTypeError";
  }
}

const compareUtf8 = (left: string, right: string): number => {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

const validateParser = (candidate: MaterialParser): MaterialParser => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError("Material parser must be an object.");
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new TypeError("Material parser id must be a non-empty string.");
  }
  if (!Array.isArray(candidate.accepts) || candidate.accepts.length === 0) {
    throw new TypeError("Material parser accepts must be a non-empty array.");
  }
  if (typeof candidate.parse !== "function") {
    throw new TypeError("Material parser parse must be a function.");
  }
  const unique = new Set<string>();
  for (const mediaType of candidate.accepts) {
    if (typeof mediaType !== "string" || !MEDIA_TYPE_PATTERN.test(mediaType)) {
      throw new TypeError("Material parser media types must be exact lowercase MIME types.");
    }
    if (unique.has(mediaType)) {
      throw new TypeError(`Material parser repeats media type ${mediaType}.`);
    }
    unique.add(mediaType);
  }
  return candidate;
};

/** Registry for exact media-type selection of deterministic local parsers. */
export class ParserRegistry {
  readonly #byId = new Map<string, MaterialParser>();
  readonly #byMediaType = new Map<string, MaterialParser>();

  /**
   * Registers one parser without replacing an id or accepted media type.
   *
   * @param parser - Deterministic parser to register.
   */
  public register(parser: MaterialParser): void {
    const validated = validateParser(parser);
    if (this.#byId.has(validated.id)) throw new DuplicateMaterialParserError(validated.id);
    for (const mediaType of validated.accepts) {
      if (this.#byMediaType.has(mediaType)) throw new ConflictingMediaTypeError(mediaType);
    }
    this.#byId.set(validated.id, validated);
    for (const mediaType of validated.accepts) this.#byMediaType.set(mediaType, validated);
  }

  /**
   * Selects only an exact lowercase media-type registration.
   *
   * @param mediaType - Exact media type without parameters.
   * @returns The registered parser, or undefined when unsupported.
   */
  public select(mediaType: string): MaterialParser | undefined {
    return this.#byMediaType.get(mediaType);
  }

  /**
   * Returns an immutable parser list ordered by parser id UTF-8 bytes.
   *
   * @returns Stable parser snapshot for inspection and capability reporting.
   */
  public list(): readonly MaterialParser[] {
    return Object.freeze(
      [...this.#byId.values()].sort((left, right) => compareUtf8(left.id, right.id)),
    );
  }
}
