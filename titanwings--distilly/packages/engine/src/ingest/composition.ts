import { CryptoIdGenerator } from "../defaults/crypto-id-generator.js";
import type { CorrectionServiceHooks } from "../correction/service.js";
import { CorrectionService } from "../correction/service.js";
import { InProcessEventBus } from "../defaults/in-process-event-bus.js";
import type { Clock } from "../defaults/system-clock.js";
import { SystemClock } from "../defaults/system-clock.js";
import type { DistillLeaseServiceHooks } from "../distill/lease-service.js";
import { DistillLeaseService } from "../distill/lease-service.js";
import type { CommitServiceHooks } from "../distill/commit-service.js";
import { CommitService } from "../distill/commit-service.js";
import { PromptCatalog } from "../distill/prompt-catalog.js";
import {
  SqlitePreviewHostMutationAuthority,
  type PreviewHostMutationAuthority,
} from "../host/mutation-authority.js";
import type { EventBus } from "../ports/event-bus.js";
import type { IdGenerator } from "../ports/id-generator.js";
import { SqliteReadService } from "../read/sqlite-read-service.js";
import { ReviewQueryService } from "../review/query-service.js";
import type { ReviewServiceHooks } from "../review/service.js";
import { ReviewService } from "../review/service.js";
import { ContentAddressedBlobStore } from "../storage/content-addressed-blob-store.js";
import { SqliteEngineStore } from "../storage/sqlite-engine-store.js";
import type { SubjectCreateServiceHooks } from "../subject/service.js";
import { SubjectCreateService } from "../subject/service.js";
import { IngestService } from "./service.js";
import type { IngestServiceHooks, TrustedFileLoader } from "./service.js";

/** Trusted seams used only by the package-private SQLite Preview composition. */
export interface InternalEngineCompositionOptions {
  readonly root: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly eventBus?: EventBus;
  readonly subjectHooks?: SubjectCreateServiceHooks;
  readonly ingestHooks?: IngestServiceHooks;
  readonly fileLoader?: TrustedFileLoader;
  readonly leaseHooks?: DistillLeaseServiceHooks;
  readonly commitHooks?: CommitServiceHooks;
  readonly correctionHooks?: CorrectionServiceHooks;
  readonly reviewHooks?: ReviewServiceHooks;
  readonly promptCatalog?: PromptCatalog;
}

/** Runnable SQLite Preview slice without claiming the full EngineRuntime API. */
export interface InternalEngineComposition {
  readonly subjects: {
    readonly create: SubjectCreateService["create"];
    readonly list: SqliteReadService["listSubjects"];
    readonly resolve: SqliteReadService["resolveSubject"];
  };
  readonly materials: {
    readonly list: SqliteReadService["listMaterials"];
    readonly get: SqliteReadService["getMaterial"];
  };
  readonly profiles: {
    readonly get: SqliteReadService["getProfile"];
    readonly prompt: SqliteReadService["prompt"];
    readonly status: SqliteReadService["status"];
  };
  readonly versions: {
    readonly list: SqliteReadService["listVersions"];
    readonly diff: SqliteReadService["diffVersions"];
    readonly lineage: SqliteReadService["lineage"];
  };
  readonly library: {
    readonly list: SqliteReadService["listLibrary"];
  };
  readonly hostMutations: PreviewHostMutationAuthority;
  readonly ingest: IngestService;
  readonly leases: DistillLeaseService;
  readonly commits: CommitService;
  readonly corrections: CorrectionService;
  readonly review: ReviewService;
  readonly reviews: ReviewQueryService;
  readonly blobs: ContentAddressedBlobStore;
  readonly events: EventBus;
  close(): void;
}

/**
 * Opens the current single-writer SQLite business-method slice.
 *
 * @param options - Root path and trusted composition seams.
 * @returns The runnable Preview slice and its owned close operation.
 */
export const createInternalEngineComposition = async (
  options: InternalEngineCompositionOptions,
): Promise<InternalEngineComposition> => {
  const store = await SqliteEngineStore.open(options.root);
  try {
    const blobs = await ContentAddressedBlobStore.open(options.root);
    const eventBus = options.eventBus ?? new InProcessEventBus();
    const ids = options.ids ?? new CryptoIdGenerator();
    const clock = options.clock ?? new SystemClock();
    const promptCatalog = options.promptCatalog ?? new PromptCatalog();
    const subjectCreate = new SubjectCreateService({
      store,
      ids,
      clock,
      eventBus,
      ...(options.subjectHooks === undefined ? {} : { hooks: options.subjectHooks }),
    });
    const ingest = new IngestService({
      store,
      blobs,
      ids,
      clock,
      eventBus,
      ...(options.fileLoader === undefined ? {} : { fileLoader: options.fileLoader }),
      ...(options.ingestHooks === undefined ? {} : { hooks: options.ingestHooks }),
    });
    const leases = new DistillLeaseService({
      store,
      blobs,
      promptCatalog,
      ids,
      clock,
      eventBus,
      ...(options.leaseHooks === undefined ? {} : { hooks: options.leaseHooks }),
    });
    const commits = new CommitService({
      store,
      blobs,
      promptCatalog,
      ids,
      clock,
      eventBus,
      ...(options.commitHooks === undefined ? {} : { hooks: options.commitHooks }),
    });
    const review = new ReviewService({
      store,
      ids,
      clock,
      eventBus,
      ...(options.reviewHooks === undefined ? {} : { hooks: options.reviewHooks }),
    });
    const corrections = new CorrectionService({
      store,
      blobs,
      ids,
      clock,
      eventBus,
      ...(options.correctionHooks === undefined ? {} : { hooks: options.correctionHooks }),
    });
    const reads = new SqliteReadService({ store, blobs });
    const reviews = new ReviewQueryService({ store });
    const hostMutations = new SqlitePreviewHostMutationAuthority({ store, clock });
    return {
      subjects: {
        create: (input, actor, mutation) => subjectCreate.create(input, actor, mutation),
        list: (input) => reads.listSubjects(input),
        resolve: (input) => reads.resolveSubject(input),
      },
      materials: {
        list: (input) => reads.listMaterials(input),
        get: (input) => reads.getMaterial(input),
      },
      profiles: {
        get: (input) => reads.getProfile(input),
        prompt: (input) => reads.prompt(input),
        status: (input) => reads.status(input),
      },
      versions: {
        list: (input) => reads.listVersions(input),
        diff: (input) => reads.diffVersions(input),
        lineage: (input) => reads.lineage(input),
      },
      library: {
        list: (input) => reads.listLibrary(input),
      },
      hostMutations,
      ingest,
      leases,
      commits,
      corrections,
      review,
      reviews,
      blobs,
      events: eventBus,
      close: () => store.close(),
    };
  } catch (error) {
    store.close();
    throw error;
  }
};
