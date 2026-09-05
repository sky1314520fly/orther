import { z } from "zod";

import { labelStringSchema, safePositiveIntegerSchema } from "./common.js";
import { hostNameSchema, leaseOwnerIdSchema, requestIdSchema } from "./ids.js";

export const actorContextSchema = z.strictObject({
  kind: z.enum(["user", "host", "sdk", "executor", "system"]),
  id: labelStringSchema,
  host: hostNameSchema.optional(),
});

export const mutationContextSchema = z.strictObject({
  requestId: requestIdSchema,
});

export const briefCapacitySchema = z.strictObject({
  maximumInputTokens: safePositiveIntegerSchema,
  maximumToolResultBytes: safePositiveIntegerSchema,
  source: z.enum(["host_handshake", "binding_fixture", "sdk_explicit"]),
});

export const clientSessionContextSchema = z.strictObject({
  actor: actorContextSchema,
  leaseOwner: leaseOwnerIdSchema,
  capacity: briefCapacitySchema.optional(),
});
