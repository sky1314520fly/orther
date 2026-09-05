import type { DistillPatch } from "@distilly/protocol";

import { canonicalJsonBytes } from "../facts/canonical-json.js";
import { invalidInput } from "../internal-errors.js";

/** Maximum accepted canonical host patch size in UTF-8 bytes. */
export const MAX_ACCEPTED_PATCH_BYTES = 65_536;

/**
 * Rejects non-Step-7 relation fields and returns exact canonical accepted patch bytes.
 *
 * @param patch - Schema-validated Step 7 host patch.
 * @returns Exact compact canonical JSON UTF-8 bytes.
 */
export const validateAcceptedPatchBytes = (patch: DistillPatch): Uint8Array => {
  if (Object.prototype.hasOwnProperty.call(patch, "relationOperations")) {
    throw invalidInput(
      "relationOperations is not supported by the Step 7 distillation patch.",
      "patch.relationOperations",
    );
  }
  const bytes = canonicalJsonBytes(patch);
  if (bytes.byteLength > MAX_ACCEPTED_PATCH_BYTES) {
    throw invalidInput(
      `Canonical patch exceeds ${String(MAX_ACCEPTED_PATCH_BYTES)} UTF-8 bytes.`,
      "patch",
    );
  }
  return bytes;
};
