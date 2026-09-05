import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DISTILLY_MCP_TOOL_NAMES,
  GET_TOOL_SUCCESS_KINDS_BY_ACTION,
  PENDING_TOOL_SUCCESS_KINDS_BY_ACTION,
  distillyMcpTools,
} from "./mcp.js";
import type { JsonSchemaObject } from "./mcp.js";
import { WIRE_LIMITS } from "./json.js";

const HEX_32 = "a".repeat(32);
const HEX_64 = "b".repeat(64);
const REQUEST_ID = `req_${HEX_32}`;
const SUBJECT_ID = `subject_${HEX_32}`;
const SPACE_ID = `space_${HEX_32}`;
const JOB_ID = `job_${HEX_32}`;
const LEASE_ID = `lease_${HEX_32}`;
const LEASE_OWNER_ID = `lease_owner_${HEX_32}`;
const VERSION_ID = `version_${HEX_64}`;
const MATERIAL_ID = `mat_${HEX_64}`;
const CONTENT_DIGEST = `sha256_${HEX_64}`;
const MATERIAL_SET_HASH = `set_sha256_${HEX_64}`;
const BRIEF_CONTRACT_DIGEST = `brief_contract_${HEX_64}`;
const PROMPT_VERSION = `host-distill-v1-sha256_${HEX_64}` as const;
const SOURCE_GROUP_KEY = `sg_${HEX_64}`;
const NOW = "2026-08-20T08:00:00.000Z";

const wireRequest = { wireVersion: "3", requestId: REQUEST_ID } as const;

const subject = {
  id: SUBJECT_ID,
  displayName: "Ada Lovelace",
  aliases: [],
  identityHints: [],
  space: { id: SPACE_ID, displayName: "People", kind: "people" },
  lifecycle: "active",
} as const;

const quality = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 0,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 0,
  diversityEligibleSourceGroupCount: 0,
  unknownSourceGroupCount: 0,
  coveredCoreFacets: [],
  uncoveredCoreFacets: [
    "identity",
    "voice",
    "psyche",
    "relations",
    "boundaries",
    "texture",
    "timeline",
  ],
  maturity: "sparse",
} as const;

const suspendedVersion = {
  id: VERSION_ID,
  subjectId: SUBJECT_ID,
  generation: 1,
  materialSetHash: MATERIAL_SET_HASH,
  creation: {
    kind: "host_distill",
    briefContractDigest: BRIEF_CONTRACT_DIGEST,
    promptVersion: PROMPT_VERSION,
    draftSchemaVersion: 1,
  },
  status: "suspended",
  actor: { kind: "host", id: "host-session", host: "codex" },
  quality,
  createdAt: NOW,
} as const;

const review = {
  ref: { subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID },
  url: `http://127.0.0.1:43123/#${"c".repeat(64)}/review/${SUBJECT_ID}/${VERSION_ID}`,
} as const;

const currentVersion = { ...suspendedVersion, status: "current" } as const;
const correctionVersion = {
  ...suspendedVersion,
  creation: { kind: "correction", correctionMaterialId: MATERIAL_ID },
} as const;
const secondSubject = {
  ...subject,
  id: `subject_${"c".repeat(32)}`,
  displayName: "Augusta Ada King",
} as const;
const profile = {
  subjectId: SUBJECT_ID,
  displayName: "Ada Lovelace",
  versionId: VERSION_ID,
  claims: [],
  core: {
    identity: "Mathematician",
    voice: "Analytical",
    psyche: "Curious",
    relations: "Collaborator",
    boundaries: "Private",
    texture: "Precise",
    timeline: "Nineteenth century",
  },
  domains: {},
  rendered: "# Ada Lovelace",
  quality,
} as const;
const status = {
  subject,
  generation: 1,
  materialSetHash: MATERIAL_SET_HASH,
  pendingJobId: JOB_ID,
  maturity: "sparse",
} as const;
const pendingJob = {
  id: JOB_ID,
  subjectId: SUBJECT_ID,
  generation: 1,
  materialSetHash: MATERIAL_SET_HASH,
  addedMaterialCount: 1,
  totalMaterialCount: 1,
  state: "pending",
  queuedAt: NOW,
} as const;
const leaseExpiresAt = "2026-08-20T08:30:00.000Z";
const leasedJob = {
  ...pendingJob,
  state: "leased",
  leaseExpiresAt,
} as const;
const lease = {
  id: LEASE_ID,
  jobId: JOB_ID,
  generation: 1,
  briefContractDigest: BRIEF_CONTRACT_DIGEST,
  owner: LEASE_OWNER_ID,
  acquiredAt: NOW,
  expiresAt: leaseExpiresAt,
} as const;
const briefing = {
  job: leasedJob,
  lease,
  subject,
  materials: [
    {
      ref: "m001",
      materialId: MATERIAL_ID,
      contentDigest: CONTENT_DIGEST,
      kind: "web",
      content: "Analytical Engine notes",
      source: {
        uri: "https://example.test/ada",
        medium: "webpage",
        access: "public",
        capturedAt: NOW,
        authors: ["Ada Lovelace"],
      },
      derivation: { kind: "native_text" },
      sourceGroup: {
        key: SOURCE_GROUP_KEY,
        bases: ["canonical_uri"],
        diversityStatus: "eligible",
        cautions: [],
      },
      sensitivity: "shareable",
    },
  ],
  contract: {
    digest: BRIEF_CONTRACT_DIGEST,
    sourceGroupingVersion: "source-groups-v1",
    promptVersion: PROMPT_VERSION,
    draftSchemaVersion: 1,
    instructions: "Produce an evidence-bound patch.",
    evidenceRules: ["Quote the supplied material."],
  },
  limits: {
    estimatedInputTokens: 100,
    maximumInputTokens: 1_000,
    maximumOutputBytes: 65_536,
  },
} as const;
const materialInput = {
  clientRef: "source-1",
  kind: "web",
  content: "Analytical Engine notes",
  source: {
    uri: "https://example.test/ada",
    medium: "webpage",
    access: "public",
    capturedAt: NOW,
  },
  derivation: { kind: "native_text" },
} as const;

const resolveLocalRef = (schema: JsonSchemaObject, value: unknown) => {
  let current = value;
  const visited = new Set<string>();
  while (typeof current === "object" && current !== null) {
    const reference = (current as Readonly<Record<string, unknown>>).$ref;
    if (typeof reference !== "string" || !reference.startsWith("#/$defs/")) break;
    expect(visited.has(reference)).toBe(false);
    visited.add(reference);
    const name = reference.slice("#/$defs/".length);
    const definitions = schema.$defs as Readonly<Record<string, unknown>> | undefined;
    current = definitions?.[name];
  }
  return current;
};

const schemaSummary = (schema: JsonSchemaObject) => {
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : [schema];
  return {
    dialect: schema.$schema,
    type: schema.type,
    alternatives: alternatives.map((alternative) => {
      const object = resolveLocalRef(schema, alternative) as Readonly<Record<string, unknown>>;
      const properties =
        typeof object.properties === "object" && object.properties !== null
          ? (object.properties as Readonly<Record<string, unknown>>)
          : {};
      const action = properties.action as Readonly<Record<string, unknown>> | undefined;
      const ok = properties.ok as Readonly<Record<string, unknown>> | undefined;
      return {
        discriminant: action?.const ?? ok?.const,
        properties: Object.keys(properties).sort(),
        required: object.required,
        additionalProperties: object.additionalProperties,
      };
    }),
  };
};

type JsonSchemaNode = Readonly<Record<string, unknown>>;
type RuntimeParser = { parse(value: unknown): unknown };

const MAX_UTF8_BYTES_KEY = "x-distilly-maxUtf8Bytes";
const MAX_CANONICAL_JSON_UTF8_BYTES_KEY = "x-distilly-maxCanonicalJsonUtf8Bytes";
const MAX_COMBINED_ARRAY_ITEMS_KEY = "x-distilly-maxCombinedArrayItems";
const PROPERTY_LESS_THAN_KEY = "x-distilly-propertyLessThan";
const PROPERTY_LESS_THAN_OR_EQUAL_KEY = "x-distilly-propertyLessThanOrEqual";
const PROPERTY_PATHS_EQUAL_KEY = "x-distilly-propertyPathsEqual";

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

const isJsonSchemaNode = (value: unknown): value is JsonSchemaNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asJsonSchemaNodes = (value: unknown): readonly JsonSchemaNode[] =>
  Array.isArray(value) ? value.filter(isJsonSchemaNode) : [];

const resolveJsonSchemaRef = (
  root: JsonSchemaObject,
  schema: JsonSchemaNode,
): JsonSchemaNode | undefined => {
  const reference = schema.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/$defs/")) return undefined;
  const definitions = root.$defs;
  if (!isJsonSchemaNode(definitions)) return undefined;
  const target = definitions[reference.slice("#/$defs/".length)];
  return isJsonSchemaNode(target) ? target : undefined;
};

const standardJsonSchemaAccepts = (
  root: JsonSchemaObject,
  schema: JsonSchemaNode,
  value: unknown,
): boolean => {
  const referenced = resolveJsonSchemaRef(root, schema);
  if (referenced !== undefined && !standardJsonSchemaAccepts(root, referenced, value)) return false;

  const type = schema.type;
  if (typeof type === "string") {
    const typeMatches =
      (type === "object" && isJsonSchemaNode(value)) ||
      (type === "array" && Array.isArray(value)) ||
      (type === "string" && typeof value === "string") ||
      (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
      (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (type === "boolean" && typeof value === "boolean") ||
      (type === "null" && value === null);
    if (!typeMatches) return false;
  }

  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
  ) {
    return false;
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      return false;
    }
    if (schema.format === "uri" && !z.url().safeParse(value).success) return false;
    if (
      schema.format === "date-time" &&
      !z.iso.datetime({ offset: true }).safeParse(value).success
    ) {
      return false;
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
      return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
      return false;
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;

    const prefixItems = asJsonSchemaNodes(schema.prefixItems);
    for (const [index, itemSchema] of prefixItems.entries()) {
      if (index < value.length && !standardJsonSchemaAccepts(root, itemSchema, value[index])) {
        return false;
      }
    }
    if (schema.items === false && value.length > prefixItems.length) return false;
    if (isJsonSchemaNode(schema.items)) {
      for (const item of value.slice(prefixItems.length)) {
        if (!standardJsonSchemaAccepts(root, schema.items, item)) return false;
      }
    }

    if (isJsonSchemaNode(schema.contains)) {
      const containsSchema = schema.contains;
      const matches = value.filter((item) => standardJsonSchemaAccepts(root, containsSchema, item));
      const minimumContains = typeof schema.minContains === "number" ? schema.minContains : 1;
      if (matches.length < minimumContains) return false;
      if (typeof schema.maxContains === "number" && matches.length > schema.maxContains)
        return false;
    }
  }

  if (isJsonSchemaNode(value)) {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties)
      return false;
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties)
      return false;

    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((property) => typeof property === "string" && !(property in value))) {
      return false;
    }

    const properties = isJsonSchemaNode(schema.properties) ? schema.properties : {};
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (
        property in value &&
        isJsonSchemaNode(propertySchema) &&
        !standardJsonSchemaAccepts(root, propertySchema, value[property])
      ) {
        return false;
      }
    }

    const additionalProperties = keys.filter((property) => !(property in properties));
    if (schema.additionalProperties === false && additionalProperties.length > 0) return false;
    if (isJsonSchemaNode(schema.additionalProperties)) {
      for (const property of additionalProperties) {
        if (!standardJsonSchemaAccepts(root, schema.additionalProperties, value[property])) {
          return false;
        }
      }
    }
    if (isJsonSchemaNode(schema.propertyNames)) {
      for (const property of keys) {
        if (!standardJsonSchemaAccepts(root, schema.propertyNames, property)) return false;
      }
    }
  }

  const allOf = asJsonSchemaNodes(schema.allOf);
  if (!allOf.every((branch) => standardJsonSchemaAccepts(root, branch, value))) return false;
  const anyOf = asJsonSchemaNodes(schema.anyOf);
  if (anyOf.length > 0 && !anyOf.some((branch) => standardJsonSchemaAccepts(root, branch, value))) {
    return false;
  }
  const oneOf = asJsonSchemaNodes(schema.oneOf);
  if (
    oneOf.length > 0 &&
    oneOf.filter((branch) => standardJsonSchemaAccepts(root, branch, value)).length !== 1
  ) {
    return false;
  }
  if (isJsonSchemaNode(schema.not) && standardJsonSchemaAccepts(root, schema.not, value)) {
    return false;
  }
  if (isJsonSchemaNode(schema.if)) {
    const selected = standardJsonSchemaAccepts(root, schema.if, value) ? schema.then : schema.else;
    if (isJsonSchemaNode(selected) && !standardJsonSchemaAccepts(root, selected, value))
      return false;
  }

  return true;
};

const jsonSchemaExtensionsAccept = (
  root: JsonSchemaObject,
  schema: JsonSchemaNode,
  value: unknown,
  activeReferences: ReadonlySet<string> = new Set(),
): boolean => {
  const reference = schema.$ref;
  if (typeof reference === "string" && reference.startsWith("#/$defs/")) {
    if (activeReferences.has(reference)) return true;
    const target = resolveJsonSchemaRef(root, schema);
    if (target === undefined) return false;
    const nextReferences = new Set(activeReferences);
    nextReferences.add(reference);
    if (!jsonSchemaExtensionsAccept(root, target, value, nextReferences)) return false;
  }

  const maximumUtf8Bytes = schema[MAX_UTF8_BYTES_KEY];
  if (
    typeof maximumUtf8Bytes === "number" &&
    (typeof value !== "string" || utf8ByteLength(value) > maximumUtf8Bytes)
  ) {
    return false;
  }

  const maximumCanonicalJsonUtf8Bytes = schema[MAX_CANONICAL_JSON_UTF8_BYTES_KEY];
  if (typeof maximumCanonicalJsonUtf8Bytes === "number") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || utf8ByteLength(serialized) > maximumCanonicalJsonUtf8Bytes) {
      return false;
    }
  }

  const combinedArrayConstraint = schema[MAX_COMBINED_ARRAY_ITEMS_KEY];
  if (isJsonSchemaNode(combinedArrayConstraint) && isJsonSchemaNode(value)) {
    const properties = combinedArrayConstraint.properties;
    const maximum = combinedArrayConstraint.maximum;
    if (Array.isArray(properties) && typeof maximum === "number") {
      let count = 0;
      for (const property of properties as readonly unknown[]) {
        if (typeof property === "string" && Array.isArray(value[property])) {
          count += value[property].length;
        }
      }
      if (count > maximum) return false;
    }
  }

  const propertyOrderConstraint = schema[PROPERTY_LESS_THAN_KEY];
  if (isJsonSchemaNode(propertyOrderConstraint) && isJsonSchemaNode(value)) {
    const left = propertyOrderConstraint.left;
    const right = propertyOrderConstraint.right;
    if (
      typeof left === "string" &&
      typeof right === "string" &&
      typeof value[left] === "number" &&
      typeof value[right] === "number" &&
      value[left] >= value[right]
    ) {
      return false;
    }
  }

  const inclusivePropertyOrderConstraint = schema[PROPERTY_LESS_THAN_OR_EQUAL_KEY];
  if (isJsonSchemaNode(inclusivePropertyOrderConstraint) && isJsonSchemaNode(value)) {
    const left = inclusivePropertyOrderConstraint.left;
    const right = inclusivePropertyOrderConstraint.right;
    if (typeof left === "string" && typeof right === "string") {
      const leftValue = value[left];
      const rightValue = value[right];
      if (
        ((typeof leftValue === "number" && typeof rightValue === "number") ||
          (typeof leftValue === "string" && typeof rightValue === "string")) &&
        leftValue > rightValue
      ) {
        return false;
      }
    }
  }

  const equalPathConstraints = schema[PROPERTY_PATHS_EQUAL_KEY];
  if (Array.isArray(equalPathConstraints) && isJsonSchemaNode(value)) {
    const readPath = (path: readonly unknown[]) => {
      let current: unknown = value;
      for (const segment of path) {
        if (typeof segment !== "string" || !isJsonSchemaNode(current) || !(segment in current)) {
          return { found: false, value: undefined } as const;
        }
        current = current[segment];
      }
      return { found: true, value: current } as const;
    };

    for (const constraint of equalPathConstraints) {
      if (!isJsonSchemaNode(constraint)) continue;
      const leftPath = constraint.left;
      const rightPath = constraint.right;
      if (!Array.isArray(leftPath) || !Array.isArray(rightPath)) continue;
      const left = readPath(leftPath);
      const right = readPath(rightPath);
      if (left.found && right.found && JSON.stringify(left.value) !== JSON.stringify(right.value)) {
        return false;
      }
    }
  }

  if (
    !asJsonSchemaNodes(schema.allOf).every((branch) =>
      jsonSchemaExtensionsAccept(root, branch, value, activeReferences),
    )
  ) {
    return false;
  }

  const conditional = schema.if;
  if (isJsonSchemaNode(conditional) && standardJsonSchemaAccepts(root, conditional, value)) {
    const thenSchema = schema.then;
    if (
      isJsonSchemaNode(thenSchema) &&
      !jsonSchemaExtensionsAccept(root, thenSchema, value, activeReferences)
    ) {
      return false;
    }
  }

  for (const alternatives of [asJsonSchemaNodes(schema.oneOf), asJsonSchemaNodes(schema.anyOf)]) {
    if (alternatives.length === 0) continue;
    const matching = alternatives.filter((branch) =>
      standardJsonSchemaAccepts(root, branch, value),
    );
    if (
      matching.length > 0 &&
      !matching.some((branch) => jsonSchemaExtensionsAccept(root, branch, value, activeReferences))
    ) {
      return false;
    }
  }

  if (isJsonSchemaNode(value) && isJsonSchemaNode(schema.properties)) {
    for (const [property, propertySchema] of Object.entries(schema.properties)) {
      if (
        property in value &&
        isJsonSchemaNode(propertySchema) &&
        !jsonSchemaExtensionsAccept(root, propertySchema, value[property], activeReferences)
      ) {
        return false;
      }
    }
  }

  if (Array.isArray(value)) {
    if (isJsonSchemaNode(schema.items)) {
      for (const item of value) {
        if (!jsonSchemaExtensionsAccept(root, schema.items, item, activeReferences)) return false;
      }
    }
    const prefixItems = asJsonSchemaNodes(schema.prefixItems);
    for (const [index, itemSchema] of prefixItems.entries()) {
      if (
        index < value.length &&
        !jsonSchemaExtensionsAccept(root, itemSchema, value[index], activeReferences)
      ) {
        return false;
      }
    }
  }

  return true;
};

const exportedJsonSchemaAccepts = (schema: JsonSchemaObject, value: unknown): boolean =>
  standardJsonSchemaAccepts(schema, schema, value) &&
  jsonSchemaExtensionsAccept(schema, schema, value);

const runtimeSchemaAccepts = (schema: RuntimeParser, value: unknown): boolean => {
  try {
    schema.parse(value);
    return true;
  } catch {
    return false;
  }
};

const expectRuntimeAndJsonSchema = (
  runtimeSchema: RuntimeParser,
  jsonSchema: JsonSchemaObject,
  value: unknown,
  accepted: boolean,
) => {
  expect(runtimeSchemaAccepts(runtimeSchema, value)).toBe(accepted);
  expect(exportedJsonSchemaAccepts(jsonSchema, value)).toBe(accepted);
};

describe("MCP tool inventory", () => {
  it("pins exactly five names and their complete MCP annotation hints", () => {
    expect(DISTILLY_MCP_TOOL_NAMES).toEqual(distillyMcpTools.map((tool) => tool.name));
    expect(
      distillyMcpTools.map(
        ({ name, title, description, annotations, inputSchema, outputSchema }) => ({
          name,
          title,
          description,
          annotations,
          inputSchemaType: inputSchema.type,
          outputSchemaType: outputSchema.type,
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Resolve a local subject or read its saved profile, prompt, or status.",
          "inputSchemaType": "object",
          "name": "distilly_get",
          "outputSchemaType": "object",
          "title": "Read local person memory",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Store supplied text and provenance for an existing or new local subject.",
          "inputSchemaType": "object",
          "name": "distilly_ingest",
          "outputSchemaType": "object",
          "title": "Store local source material",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "List local pending jobs or brief, renew, or release a distillation lease.",
          "inputSchemaType": "object",
          "name": "distilly_pending",
          "outputSchemaType": "object",
          "title": "Manage local distillation jobs",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Validate and commit an evidence-bounded claim patch to local profile memory.",
          "inputSchemaType": "object",
          "name": "distilly_commit",
          "outputSchemaType": "object",
          "title": "Commit local distilled claims",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Store a relayed correction and open local review for its candidate version.",
          "inputSchemaType": "object",
          "name": "distilly_correct",
          "outputSchemaType": "object",
          "title": "Correct local person memory",
        },
      ]
    `);
  });

  it("pins action-specific success kinds", () => {
    expect(GET_TOOL_SUCCESS_KINDS_BY_ACTION).toEqual({
      resolve: ["resolved", "not_found", "ambiguous"],
      profile: ["profile", "not_found", "ambiguous"],
      prompt: ["prompt", "not_found", "ambiguous"],
      status: ["status", "not_found", "ambiguous"],
    });
    expect(PENDING_TOOL_SUCCESS_KINDS_BY_ACTION).toEqual({
      list: ["jobs", "nothing_pending"],
      brief: ["briefing", "nothing_pending"],
      renew: ["lease_renewed"],
      release: ["released"],
    });
  });

  it("pins the MCP JSON Schema dialect, discriminants, and strict object surfaces", () => {
    expect(
      distillyMcpTools.map(({ name, inputSchema, outputSchema }) => ({
        name,
        input: schemaSummary(inputSchema),
        output: schemaSummary(outputSchema),
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "input": {
            "alternatives": [
              {
                "additionalProperties": false,
                "discriminant": "resolve",
                "properties": [
                  "action",
                  "requestId",
                  "subject",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "subject",
                  "action",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": "profile",
                "properties": [
                  "action",
                  "requestId",
                  "subject",
                  "versionId",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "subject",
                  "action",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": "prompt",
                "properties": [
                  "action",
                  "requestId",
                  "subject",
                  "versionId",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "subject",
                  "action",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": "status",
                "properties": [
                  "action",
                  "requestId",
                  "subject",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "subject",
                  "action",
                ],
              },
            ],
            "dialect": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
          },
          "name": "distilly_get",
          "output": {
            "alternatives": [
              {
                "additionalProperties": false,
                "discriminant": true,
                "properties": [
                  "ok",
                  "value",
                  "wireVersion",
                ],
                "required": [
                  "ok",
                  "wireVersion",
                  "value",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": false,
                "properties": [
                  "error",
                  "ok",
                  "wireVersion",
                ],
                "required": [
                  "ok",
                  "wireVersion",
                  "error",
                ],
              },
            ],
            "dialect": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
          },
        },
        {
          "input": {
            "alternatives": [
              {
                "additionalProperties": false,
                "discriminant": undefined,
                "properties": [
                  "enqueue",
                  "materials",
                  "requestId",
                  "subject",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "subject",
                  "materials",
                  "enqueue",
                ],
              },
            ],
            "dialect": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
          },
          "name": "distilly_ingest",
          "output": {
            "alternatives": [
              {
                "additionalProperties": false,
                "discriminant": true,
                "properties": [
                  "ok",
                  "value",
                  "wireVersion",
                ],
                "required": [
                  "ok",
                  "wireVersion",
                  "value",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": false,
                "properties": [
                  "error",
                  "ok",
                  "wireVersion",
                ],
                "required": [
                  "ok",
                  "wireVersion",
                  "error",
                ],
              },
            ],
            "dialect": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
          },
        },
        {
          "input": {
            "alternatives": [
              {
                "additionalProperties": false,
                "discriminant": "list",
                "properties": [
                  "action",
                  "requestId",
                  "subjectId",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "action",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": "brief",
                "properties": [
                  "action",
                  "jobId",
                  "requestId",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "action",
                  "jobId",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": "renew",
                "properties": [
                  "action",
                  "jobId",
                  "leaseId",
                  "requestId",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "action",
                  "jobId",
                  "leaseId",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": "release",
                "properties": [
                  "action",
                  "jobId",
                  "leaseId",
                  "reason",
                  "requestId",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "action",
                  "jobId",
                  "leaseId",
                ],
              },
            ],
            "dialect": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
          },
          "name": "distilly_pending",
          "output": {
            "alternatives": [
              {
                "additionalProperties": false,
                "discriminant": true,
                "properties": [
                  "ok",
                  "value",
                  "wireVersion",
                ],
                "required": [
                  "ok",
                  "wireVersion",
                  "value",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": false,
                "properties": [
                  "error",
                  "ok",
                  "wireVersion",
                ],
                "required": [
                  "ok",
                  "wireVersion",
                  "error",
                ],
              },
            ],
            "dialect": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
          },
        },
        {
          "input": {
            "alternatives": [
              {
                "additionalProperties": false,
                "discriminant": undefined,
                "properties": [
                  "baseVersionId",
                  "briefContractDigest",
                  "generation",
                  "jobId",
                  "leaseId",
                  "materialSetHash",
                  "patch",
                  "requestId",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "jobId",
                  "generation",
                  "leaseId",
                  "briefContractDigest",
                  "materialSetHash",
                  "patch",
                ],
              },
            ],
            "dialect": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
          },
          "name": "distilly_commit",
          "output": {
            "alternatives": [
              {
                "additionalProperties": false,
                "discriminant": true,
                "properties": [
                  "ok",
                  "value",
                  "wireVersion",
                ],
                "required": [
                  "ok",
                  "wireVersion",
                  "value",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": false,
                "properties": [
                  "error",
                  "ok",
                  "wireVersion",
                ],
                "required": [
                  "ok",
                  "wireVersion",
                  "error",
                ],
              },
            ],
            "dialect": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
          },
        },
        {
          "input": {
            "alternatives": [
              {
                "additionalProperties": false,
                "discriminant": undefined,
                "properties": [
                  "baseCandidateVersionId",
                  "facet",
                  "requestId",
                  "subjectId",
                  "supersedes",
                  "text",
                  "wireVersion",
                ],
                "required": [
                  "wireVersion",
                  "requestId",
                  "subjectId",
                  "text",
                ],
              },
            ],
            "dialect": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
          },
          "name": "distilly_correct",
          "output": {
            "alternatives": [
              {
                "additionalProperties": false,
                "discriminant": true,
                "properties": [
                  "ok",
                  "value",
                  "wireVersion",
                ],
                "required": [
                  "ok",
                  "wireVersion",
                  "value",
                ],
              },
              {
                "additionalProperties": false,
                "discriminant": false,
                "properties": [
                  "error",
                  "ok",
                  "wireVersion",
                ],
                "required": [
                  "ok",
                  "wireVersion",
                  "error",
                ],
              },
            ],
            "dialect": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
          },
        },
      ]
    `);
  });
});

describe("MCP input schemas", () => {
  it("accepts each tool input and rejects unknown fields at every boundary", () => {
    const [get, ingest, pending, commit, correct] = distillyMcpTools;
    const getInput = {
      ...wireRequest,
      action: "profile",
      subject: { kind: "id", subjectId: SUBJECT_ID },
      versionId: VERSION_ID,
    };
    const ingestInput = {
      ...wireRequest,
      subject: { kind: "existing", subjectId: SUBJECT_ID },
      materials: [materialInput],
      enqueue: "now",
    };
    const pendingInput = { ...wireRequest, action: "renew", jobId: JOB_ID, leaseId: LEASE_ID };
    const commitInput = {
      ...wireRequest,
      jobId: JOB_ID,
      generation: 1,
      leaseId: LEASE_ID,
      briefContractDigest: BRIEF_CONTRACT_DIGEST,
      materialSetHash: MATERIAL_SET_HASH,
      patch: { operations: [] },
    };
    const correctInput = {
      ...wireRequest,
      subjectId: SUBJECT_ID,
      text: "The date should be 1843.",
      facet: "timeline.publication",
    };

    for (const [tool, input] of [
      [get, getInput],
      [ingest, ingestInput],
      [pending, pendingInput],
      [commit, commitInput],
      [correct, correctInput],
    ] as const) {
      expect(tool.input.parse(input)).toEqual(input);
      expect(() => tool.input.parse({ ...input, unknown: true })).toThrow();
    }

    expect(() =>
      ingest.input.parse({
        ...ingestInput,
        materials: [{ ...ingestInput.materials[0], unknown: true }],
      }),
    ).toThrow();
  });

  it("accepts every action and subject-target input branch", () => {
    const [get, ingest, pending, commit, correct] = distillyMcpTools;
    const selector = { kind: "id", subjectId: SUBJECT_ID } as const;

    for (const input of [
      { ...wireRequest, action: "resolve", subject: selector },
      { ...wireRequest, action: "profile", subject: selector, versionId: VERSION_ID },
      { ...wireRequest, action: "prompt", subject: selector, versionId: VERSION_ID },
      { ...wireRequest, action: "status", subject: selector },
    ] as const) {
      expect(get.input.parse(input)).toEqual(input);
    }

    for (const input of [
      {
        ...wireRequest,
        subject: { kind: "existing", subjectId: SUBJECT_ID },
        materials: [materialInput],
        enqueue: "auto",
      },
      {
        ...wireRequest,
        subject: {
          kind: "create",
          input: {
            displayName: "Ada Lovelace",
            spaceId: SPACE_ID,
            aliases: ["Ada"],
          },
        },
        materials: [materialInput],
        enqueue: "now",
      },
    ] as const) {
      expect(ingest.input.parse(input)).toEqual(input);
    }

    for (const input of [
      { ...wireRequest, action: "list", subjectId: SUBJECT_ID },
      { ...wireRequest, action: "brief", jobId: JOB_ID },
      { ...wireRequest, action: "renew", jobId: JOB_ID, leaseId: LEASE_ID },
      {
        ...wireRequest,
        action: "release",
        jobId: JOB_ID,
        leaseId: LEASE_ID,
        reason: "return to queue",
      },
    ] as const) {
      expect(pending.input.parse(input)).toEqual(input);
    }

    const commitInput = {
      ...wireRequest,
      jobId: JOB_ID,
      generation: 1,
      leaseId: LEASE_ID,
      briefContractDigest: BRIEF_CONTRACT_DIGEST,
      materialSetHash: MATERIAL_SET_HASH,
      patch: {
        operations: [
          {
            op: "add",
            claim: {
              facet: "identity.occupation",
              text: "Mathematician",
              evidence: [
                {
                  kind: "brief_material",
                  materialRef: "m001",
                  quote: "Analytical Engine notes",
                },
              ],
            },
          },
        ],
      },
    } as const;
    expect(commit.input.parse(commitInput)).toEqual(commitInput);

    const correctInput = {
      ...wireRequest,
      subjectId: SUBJECT_ID,
      text: "The date should be 1843.",
      facet: "timeline.publication",
      supersedes: [`claim_${HEX_64}`],
      baseCandidateVersionId: VERSION_ID,
    } as const;
    expect(correct.input.parse(correctInput)).toEqual(correctInput);
  });

  it("enforces action discriminants and model-boundary invariants", () => {
    const [get, ingest, pending, , correct] = distillyMcpTools;

    for (const action of ["resolve", "status"] as const) {
      expect(() =>
        get.input.parse({
          ...wireRequest,
          action,
          subject: { kind: "id", subjectId: SUBJECT_ID },
          versionId: VERSION_ID,
        }),
      ).toThrow();
    }
    expect(() =>
      pending.input.parse({
        ...wireRequest,
        action: "list",
        jobId: JOB_ID,
      }),
    ).toThrow();
    expect(() =>
      ingest.input.parse({
        ...wireRequest,
        subject: { kind: "existing", subjectId: SUBJECT_ID },
        materials: [],
        enqueue: "auto",
      }),
    ).toThrow();
    expect(() =>
      ingest.input.parse({
        ...wireRequest,
        subject: { kind: "existing", subjectId: SUBJECT_ID },
        materials: [
          {
            clientRef: "source-1",
            kind: "web",
            content: "missing URI",
            source: { medium: "webpage", access: "public", capturedAt: NOW },
            derivation: { kind: "native_text" },
          },
        ],
        enqueue: "auto",
      }),
    ).toThrow();
    expect(() =>
      correct.input.parse({
        ...wireRequest,
        subjectId: SUBJECT_ID,
        text: "correction",
        facet: "Not A Facet",
      }),
    ).toThrow();
  });

  it("enforces UTF-8 byte, collection, and whole-tool limits", () => {
    const [, ingest, , , correct] = distillyMcpTools;
    const correction = {
      ...wireRequest,
      subjectId: SUBJECT_ID,
      text: "é".repeat(WIRE_LIMITS.correctionTextBytes / 2),
    };
    expect(correct.input.parse(correction)).toEqual(correction);
    expect(() => correct.input.parse({ ...correction, text: `${correction.text}é` })).toThrow();

    expect(() =>
      ingest.input.parse({
        ...wireRequest,
        subject: { kind: "existing", subjectId: SUBJECT_ID },
        materials: Array.from({ length: 33 }, (_, index) => ({
          ...materialInput,
          clientRef: `source-${index}`,
        })),
        enqueue: "auto",
      }),
    ).toThrow();

    expect(() =>
      ingest.input.parse({
        ...wireRequest,
        subject: { kind: "existing", subjectId: SUBJECT_ID },
        materials: Array.from({ length: 5 }, (_, index) => ({
          ...materialInput,
          clientRef: `source-${index}`,
          content: "x".repeat(1_000_000),
        })),
        enqueue: "auto",
      }),
    ).toThrow();
  });

  it("keeps runtime and exported JSON Schema semantics aligned for MCP inputs", () => {
    const [get, ingest, pending, commit, correct] = distillyMcpTools;
    const expectInput = (
      tool: (typeof distillyMcpTools)[number],
      value: unknown,
      accepted: boolean,
    ) => expectRuntimeAndJsonSchema(tool.input, tool.inputSchema, value, accepted);
    const ingestInput = (material: unknown, subjectTarget: unknown = undefined) => ({
      ...wireRequest,
      subject: subjectTarget ?? { kind: "existing", subjectId: SUBJECT_ID },
      materials: [material],
      enqueue: "auto",
    });
    const commitInput = (patch: unknown) => ({
      ...wireRequest,
      jobId: JOB_ID,
      generation: 1,
      leaseId: LEASE_ID,
      briefContractDigest: BRIEF_CONTRACT_DIGEST,
      materialSetHash: MATERIAL_SET_HASH,
      patch,
    });

    const selector = { kind: "id", subjectId: SUBJECT_ID } as const;
    for (const input of [
      { ...wireRequest, action: "resolve", subject: selector },
      { ...wireRequest, action: "profile", subject: selector, versionId: VERSION_ID },
      { ...wireRequest, action: "prompt", subject: selector, versionId: VERSION_ID },
      { ...wireRequest, action: "status", subject: selector },
    ] as const) {
      expectInput(get, input, true);
    }
    for (const input of [
      { ...wireRequest, action: "resolve", subject: selector, versionId: VERSION_ID },
      { ...wireRequest, action: "status", subject: selector, versionId: VERSION_ID },
    ] as const) {
      expectInput(get, input, false);
    }

    for (const input of [
      { ...wireRequest, action: "list", subjectId: SUBJECT_ID },
      { ...wireRequest, action: "brief", jobId: JOB_ID },
      { ...wireRequest, action: "renew", jobId: JOB_ID, leaseId: LEASE_ID },
      { ...wireRequest, action: "release", jobId: JOB_ID, leaseId: LEASE_ID, reason: "done" },
    ] as const) {
      expectInput(pending, input, true);
    }
    for (const input of [
      { ...wireRequest, action: "list", jobId: JOB_ID },
      { ...wireRequest, action: "brief", jobId: JOB_ID, leaseId: LEASE_ID },
      { ...wireRequest, action: "renew", jobId: JOB_ID },
      { ...wireRequest, action: "release", jobId: JOB_ID },
    ] as const) {
      expectInput(pending, input, false);
    }

    const inlineSpace = { displayName: "People", kind: "people" } as const;
    expectInput(
      ingest,
      ingestInput(materialInput, {
        kind: "create",
        input: { displayName: "Ada Lovelace", space: inlineSpace },
      }),
      true,
    );
    expectInput(
      ingest,
      ingestInput(materialInput, {
        kind: "create",
        input: { displayName: "Ada Lovelace", spaceId: SPACE_ID, space: inlineSpace },
      }),
      false,
    );

    const leapDayMaterial = {
      ...materialInput,
      source: { ...materialInput.source, capturedAt: "2024-02-29T08:00:00.000Z" },
    };
    expectInput(ingest, ingestInput(leapDayMaterial), true);
    expectInput(
      ingest,
      ingestInput({
        ...leapDayMaterial,
        source: { ...leapDayMaterial.source, capturedAt: "2026-02-29T08:00:00.000Z" },
      }),
      false,
    );
    expectInput(
      ingest,
      ingestInput({
        ...materialInput,
        kind: "document",
        source: { ...materialInput.source, uri: "relative/path" },
      }),
      false,
    );
    expectInput(
      ingest,
      ingestInput({
        ...materialInput,
        kind: "document",
        source: { ...materialInput.source, uri: "ftp://example.test/ada" },
      }),
      false,
    );
    expectInput(
      ingest,
      ingestInput({
        ...materialInput,
        source: { ...materialInput.source, uri: "HTTPS://example.test/ada" },
      }),
      true,
    );
    expectInput(
      ingest,
      ingestInput({
        ...materialInput,
        source: {
          medium: materialInput.source.medium,
          access: materialInput.source.access,
          capturedAt: materialInput.source.capturedAt,
        },
      }),
      false,
    );
    expectInput(
      ingest,
      ingestInput({
        ...materialInput,
        source: { ...materialInput.source, uri: "ftp://example.test/ada" },
      }),
      false,
    );

    const exactLabel = "😀".repeat(WIRE_LIMITS.labelBytes / 4);
    expectInput(
      ingest,
      ingestInput(materialInput, {
        kind: "create",
        input: { displayName: exactLabel },
      }),
      true,
    );
    expectInput(
      ingest,
      ingestInput(materialInput, {
        kind: "create",
        input: { displayName: `${exactLabel}😀` },
      }),
      false,
    );

    const exactQuery = "x".repeat(WIRE_LIMITS.queryBytes);
    expectInput(
      get,
      { ...wireRequest, action: "resolve", subject: { kind: "query", query: exactQuery } },
      true,
    );
    expectInput(
      get,
      { ...wireRequest, action: "resolve", subject: { kind: "query", query: `${exactQuery}x` } },
      false,
    );

    const uriPrefix = "https://example.test/";
    const exactUri = `${uriPrefix}${"x".repeat(WIRE_LIMITS.uriBytes - uriPrefix.length)}`;
    expectInput(
      ingest,
      ingestInput({ ...materialInput, source: { ...materialInput.source, uri: exactUri } }),
      true,
    );
    expectInput(
      ingest,
      ingestInput({ ...materialInput, source: { ...materialInput.source, uri: `${exactUri}x` } }),
      false,
    );

    const exactReason = "x".repeat(WIRE_LIMITS.reasonBytes);
    expectInput(
      pending,
      { ...wireRequest, action: "release", jobId: JOB_ID, leaseId: LEASE_ID, reason: exactReason },
      true,
    );
    expectInput(
      pending,
      {
        ...wireRequest,
        action: "release",
        jobId: JOB_ID,
        leaseId: LEASE_ID,
        reason: `${exactReason}x`,
      },
      false,
    );

    const exactMaterialContent = "x".repeat(WIRE_LIMITS.materialContentBytes);
    expectInput(ingest, ingestInput({ ...materialInput, content: exactMaterialContent }), true);
    expectInput(
      ingest,
      ingestInput({ ...materialInput, content: `${exactMaterialContent}x` }),
      false,
    );

    const exactCorrection = {
      ...wireRequest,
      subjectId: SUBJECT_ID,
      text: "é".repeat(WIRE_LIMITS.correctionTextBytes / 2),
    };
    expectInput(correct, exactCorrection, true);
    expectInput(correct, { ...exactCorrection, text: `${exactCorrection.text}é` }, false);

    const canonicalSizeBase = {
      ...wireRequest,
      subject: { kind: "existing", subjectId: SUBJECT_ID },
      materials: Array.from({ length: 5 }, (_, index) => ({
        ...materialInput,
        clientRef: `source-${index}`,
        content: "x".repeat(800_000),
      })),
      enqueue: "auto",
    } as const;
    const remainingBytes = WIRE_LIMITS.toolInputBytes - JSON.stringify(canonicalSizeBase).length;
    expect(remainingBytes).toBeGreaterThan(0);
    const exactToolInput = {
      ...canonicalSizeBase,
      materials: canonicalSizeBase.materials.map((material, index) =>
        index === canonicalSizeBase.materials.length - 1
          ? { ...material, content: `${material.content}${"x".repeat(remainingBytes)}` }
          : material,
      ),
    };
    expect(JSON.stringify(exactToolInput).length).toBe(WIRE_LIMITS.toolInputBytes);
    expectInput(ingest, exactToolInput, true);
    const overToolInput = {
      ...exactToolInput,
      materials: exactToolInput.materials.map((material, index) =>
        index === exactToolInput.materials.length - 1
          ? { ...material, content: `${material.content}x` }
          : material,
      ),
    };
    expectInput(ingest, overToolInput, false);

    const evidence = {
      kind: "brief_material",
      materialRef: "m001",
      quote: "Analytical Engine notes",
    } as const;
    const claimOperation = {
      op: "add",
      claim: {
        facet: "identity.occupation",
        text: "Mathematician",
        evidence: [evidence],
      },
    } as const;
    const exactClaimText = "x".repeat(WIRE_LIMITS.claimTextBytes);
    expectInput(
      commit,
      commitInput({
        operations: [
          {
            ...claimOperation,
            claim: {
              ...claimOperation.claim,
              text: exactClaimText,
            },
          },
        ],
      }),
      true,
    );
    expectInput(
      commit,
      commitInput({
        operations: [
          {
            ...claimOperation,
            claim: { ...claimOperation.claim, text: `${exactClaimText}x` },
          },
        ],
      }),
      false,
    );

    const patchSizeBase = {
      operations: [
        {
          ...claimOperation,
          claim: {
            ...claimOperation.claim,
            evidence: [{ ...evidence, quote: "" }],
          },
        },
      ],
    } as const;
    const patchBytesRemaining = 65_536 - JSON.stringify(patchSizeBase).length;
    expect(patchBytesRemaining).toBeGreaterThan(0);
    const exactPatch = {
      operations: [
        {
          ...claimOperation,
          claim: {
            ...claimOperation.claim,
            evidence: [{ ...evidence, quote: "x".repeat(patchBytesRemaining) }],
          },
        },
      ],
    } as const;
    expect(JSON.stringify(exactPatch).length).toBe(65_536);
    expectInput(commit, commitInput(exactPatch), true);
    expectInput(
      commit,
      commitInput({
        ...exactPatch,
        operations: exactPatch.operations.map((operation) => ({
          ...operation,
          claim: {
            ...operation.claim,
            evidence: operation.claim.evidence.map((item) => ({
              ...item,
              quote: `${item.quote}x`,
            })),
          },
        })),
      }),
      false,
    );
    expectInput(
      commit,
      commitInput({
        operations: Array.from({ length: WIRE_LIMITS.patchOperations }, () => claimOperation),
      }),
      true,
    );
    expectInput(
      commit,
      commitInput({
        operations: Array.from({ length: WIRE_LIMITS.patchOperations + 1 }, () => claimOperation),
      }),
      false,
    );
    expectInput(
      commit,
      commitInput({
        operations: [],
        relationOperations: [],
      }),
      false,
    );
    expectInput(
      commit,
      commitInput({
        operations: [
          {
            ...claimOperation,
            claim: {
              ...claimOperation.claim,
              evidence: [{ ...evidence, locator: { start: 2, end: 1 } }],
            },
          },
        ],
      }),
      false,
    );
    expectInput(
      commit,
      commitInput({
        operations: [
          {
            ...claimOperation,
            claim: {
              ...claimOperation.claim,
              evidence: [{ ...evidence, locator: { start: 2, end: 2 } }],
            },
          },
        ],
      }),
      false,
    );
    expectInput(
      commit,
      commitInput({
        operations: [
          {
            ...claimOperation,
            claim: {
              ...claimOperation.claim,
              validFrom: "2026-08-21T00:00:00.000Z",
              validTo: "2026-08-20T00:00:00.000Z",
            },
          },
        ],
      }),
      false,
    );

    const serializedSchemas = JSON.stringify(distillyMcpTools);
    for (const keyword of [
      MAX_UTF8_BYTES_KEY,
      MAX_CANONICAL_JSON_UTF8_BYTES_KEY,
      PROPERTY_LESS_THAN_KEY,
      PROPERTY_LESS_THAN_OR_EQUAL_KEY,
      PROPERTY_PATHS_EQUAL_KEY,
    ]) {
      expect(serializedSchemas).toContain(keyword);
    }
  });
});

describe("MCP output schemas", () => {
  it("accepts every successful value branch", () => {
    const [get, ingest, pending, commit, correct] = distillyMcpTools;
    const success = (value: unknown) => ({ ok: true, wireVersion: "3", value }) as const;
    const item = {
      clientRef: "source-1",
      kind: "duplicate",
      materialId: MATERIAL_ID,
      contentDigest: CONTENT_DIGEST,
    } as const;
    const acceptedItem = { ...item, kind: "accepted" } as const;

    for (const value of [
      { kind: "resolved", subject },
      { kind: "profile", subject, profile },
      { kind: "prompt", subject, prompt: "# Ada Lovelace" },
      { kind: "status", subject, status },
      { kind: "not_found", query: "Nobody" },
      { kind: "ambiguous", candidates: [subject, secondSubject] },
    ] as const) {
      expect(get.output.parse(success(value))).toEqual(success(value));
    }

    for (const value of [
      {
        kind: "ingested",
        subject,
        created: false,
        items: [acceptedItem],
        materialSetHash: MATERIAL_SET_HASH,
        generation: 1,
        job: pendingJob,
      },
      {
        kind: "unchanged",
        subject,
        items: [item],
        materialSetHash: MATERIAL_SET_HASH,
        generation: 1,
      },
    ] as const) {
      expect(ingest.output.parse(success(value))).toEqual(success(value));
    }

    for (const value of [
      { kind: "jobs", jobs: [pendingJob] },
      { kind: "briefing", briefing },
      { kind: "lease_renewed", lease },
      { kind: "released", jobId: JOB_ID },
      { kind: "nothing_pending" },
    ] as const) {
      expect(pending.output.parse(success(value))).toEqual(success(value));
    }

    for (const value of [
      { kind: "current", version: currentVersion, profile },
      {
        kind: "suspended",
        candidate: suspendedVersion,
        reasons: [{ code: "manual_review_requested", note: "check" }],
        review,
      },
    ] as const) {
      expect(commit.output.parse(success(value))).toEqual(success(value));
    }

    const correctedValue = {
      kind: "suspended",
      candidate: correctionVersion,
      reasons: [{ code: "relayed_correction", actorKind: "host" }],
      review,
    } as const;
    const corrected = success(correctedValue);
    expect(correct.output.parse(corrected)).toEqual(corrected);
    expect(() => correct.output.parse(success({ ...correctedValue, reasons: [] }))).toThrow();
    expect(() =>
      get.output.parse(success({ kind: "resolved", subject: { ...subject, unknown: true } })),
    ).toThrow();
    expect(() => get.output.parse(success({ kind: "ambiguous", candidates: [subject] }))).toThrow();
    expect(() => pending.output.parse(success({ kind: "jobs", jobs: [] }))).toThrow();
  });

  it("shares one strict failure envelope and rejects a third envelope", () => {
    const failure = {
      ok: false,
      wireVersion: "3",
      error: { code: "invalid_input", message: "bad input", retryable: false },
    } as const;

    for (const tool of distillyMcpTools) {
      expect(tool.output.parse(failure)).toEqual(failure);
      expect(() => tool.output.parse({ ...failure, unknown: true })).toThrow();
      expect(() => tool.output.parse({ ok: "partial", wireVersion: "3", value: null })).toThrow();
    }
  });

  it("enforces code-correlated subject resolution on identity conflicts", () => {
    const alreadyExists = {
      ok: false,
      wireVersion: "3",
      error: {
        code: "already_exists",
        message: "identity already exists",
        retryable: false,
        subjectResolution: { kind: "found", subject },
      },
    } as const;
    const ambiguous = {
      ok: false,
      wireVersion: "3",
      error: {
        code: "ambiguous_subject",
        message: "multiple subjects match",
        retryable: false,
        subjectResolution: {
          kind: "ambiguous",
          candidates: [subject, secondSubject],
        },
      },
    } as const;

    for (const tool of distillyMcpTools) {
      expect(tool.output.parse(alreadyExists)).toEqual(alreadyExists);
      expect(tool.output.parse(ambiguous)).toEqual(ambiguous);
      expect(() =>
        tool.output.parse({
          ...alreadyExists,
          error: { code: "already_exists", message: "missing subject", retryable: false },
        }),
      ).toThrow();
      expect(() =>
        tool.output.parse({
          ...ambiguous,
          error: {
            ...ambiguous.error,
            subjectResolution: { kind: "ambiguous", candidates: [subject] },
          },
        }),
      ).toThrow();
    }
  });

  it("keeps runtime and exported JSON Schema semantics aligned for MCP outputs", () => {
    const ingest = distillyMcpTools[1];
    const correct = distillyMcpTools[4];
    const success = (value: unknown) => ({ ok: true, wireVersion: "3", value }) as const;
    const acceptedItem = {
      clientRef: "source-1",
      kind: "accepted",
      materialId: MATERIAL_ID,
      contentDigest: CONTENT_DIGEST,
    } as const;
    const duplicateItem = { ...acceptedItem, kind: "duplicate" } as const;
    const ingestedValue = {
      kind: "ingested",
      subject,
      created: false,
      items: [acceptedItem],
      materialSetHash: MATERIAL_SET_HASH,
      generation: 1,
    } as const;
    const unchangedValue = {
      kind: "unchanged",
      subject,
      items: [duplicateItem],
      materialSetHash: MATERIAL_SET_HASH,
      generation: 1,
    } as const;
    const correctedValue = {
      kind: "suspended",
      candidate: correctionVersion,
      reasons: [{ code: "relayed_correction", actorKind: "host" }],
      review,
    } as const;

    expectRuntimeAndJsonSchema(ingest.output, ingest.outputSchema, success(ingestedValue), true);
    expectRuntimeAndJsonSchema(
      ingest.output,
      ingest.outputSchema,
      success({ ...ingestedValue, items: [duplicateItem] }),
      false,
    );
    expectRuntimeAndJsonSchema(ingest.output, ingest.outputSchema, success(unchangedValue), true);
    expectRuntimeAndJsonSchema(
      ingest.output,
      ingest.outputSchema,
      success({ ...unchangedValue, items: [acceptedItem] }),
      false,
    );
    const pendingJobWith = (overrides: Readonly<Record<string, unknown>>) => ({
      ...pendingJob,
      ...overrides,
    });
    for (const job of [
      pendingJobWith({ subjectId: secondSubject.id }),
      pendingJobWith({ generation: 2 }),
      pendingJobWith({ materialSetHash: `set_sha256_${"c".repeat(64)}` }),
    ]) {
      expectRuntimeAndJsonSchema(
        ingest.output,
        ingest.outputSchema,
        success({ ...ingestedValue, job }),
        false,
      );
    }
    expectRuntimeAndJsonSchema(correct.output, correct.outputSchema, success(correctedValue), true);
    expectRuntimeAndJsonSchema(
      correct.output,
      correct.outputSchema,
      success({
        ...correctedValue,
        reasons: [{ code: "manual_review_requested", note: "host review" }],
      }),
      false,
    );
    expectRuntimeAndJsonSchema(
      correct.output,
      correct.outputSchema,
      success({
        ...correctedValue,
        candidate: { ...correctionVersion, createdAt: "2026-02-29T08:00:00.000Z" },
      }),
      false,
    );
    expectRuntimeAndJsonSchema(
      correct.output,
      correct.outputSchema,
      success({ ...correctedValue, review: { ...review, url: "ftp://127.0.0.1/review" } }),
      false,
    );
  });
});
