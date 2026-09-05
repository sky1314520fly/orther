import type { GetProfileInput, Profile, SubjectRef, SubjectStatus } from "@distilly/protocol";

import { factNotFound, storageCorrupt } from "../internal-errors.js";
import type { CommittedVersionReader } from "../read/committed-version-reader.js";
import { summarizeSubject } from "../subject/service.js";

/** Verified profile, prompt, and subject-status read operations. */
export class ProfileService {
  readonly #committedVersions: CommittedVersionReader;

  /**
   * Creates profile reads over authoritative subject and immutable version facts.
   *
   * @param input - Coordinated committed-version snapshot reader.
   * @param input.committedVersions - Recovery- and lock-coordinated fact reader.
   */
  constructor(input: { readonly committedVersions: CommittedVersionReader }) {
    this.#committedVersions = input.committedVersions;
  }

  private async resolveVersion(input: GetProfileInput) {
    return this.#committedVersions.withSnapshot(input.subjectId, (committed) => {
      const versionId = input.versionId ?? committed.state.currentVersionId;
      if (versionId === undefined) {
        throw factNotFound("The subject does not have a current profile version.");
      }
      const version = committed.versionsById.get(versionId);
      if (version === undefined) {
        throw factNotFound("The selected immutable profile version does not exist.");
      }
      return version;
    });
  }

  /**
   * Reads one current or explicitly selected immutable profile.
   *
   * @param input - Typed subject and optional version locator.
   * @returns The verified immutable profile.
   */
  async get(input: GetProfileInput): Promise<Profile> {
    const stored = await this.resolveVersion(input);
    return stored.profile;
  }

  /**
   * Reads the canonical prompt paired with one verified immutable profile.
   *
   * @param input - Typed subject and optional version locator.
   * @returns The byte-stable prompt stored with the version.
   */
  async prompt(input: GetProfileInput): Promise<string> {
    const stored = await this.resolveVersion(input);
    return stored.prompt;
  }

  /**
   * Aggregates authoritative state and current-version maturity for one subject.
   *
   * @param input - Typed exact subject locator.
   * @returns The verified subject status aggregate.
   */
  async status(input: SubjectRef): Promise<SubjectStatus> {
    const result = await this.#committedVersions.withSnapshot(
      input.subjectId,
      (committed): SubjectStatus => {
        const { state } = committed;
        const subject = summarizeSubject(committed.subject, committed.space, state);
        const maturity =
          state.currentVersionId === undefined
            ? undefined
            : committed.versionsById.get(state.currentVersionId)?.version.quality.maturity;
        if (state.currentVersionId !== undefined && maturity === undefined) {
          throw storageCorrupt("Subject state references a missing committed current profile.");
        }
        return {
          subject,
          generation: state.generation,
          ...(state.materialSetHash === undefined
            ? {}
            : { materialSetHash: state.materialSetHash }),
          ...(state.pending === undefined ? {} : { pendingJobId: state.pending.jobId }),
          ...(state.suspendedVersionId === undefined
            ? {}
            : { suspendedVersionId: state.suspendedVersionId }),
          ...(maturity === undefined ? {} : { maturity }),
        };
      },
    );
    return result;
  }
}
