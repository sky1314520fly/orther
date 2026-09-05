import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { engineMethodSchemas } from "@distilly/protocol";

const { startPanelServer } = await import("@distilly/panel/server");

const hex = (character, length) => character.repeat(length);
const SUBJECT_ID = `subject_${hex("b", 32)}`;
const OTHER_SUBJECT_ID = `subject_${hex("7", 32)}`;
const SPACE_ID = `space_${hex("1", 32)}`;
const CURRENT_VERSION_ID = `version_${hex("c", 64)}`;
const CANDIDATE_VERSION_ID = `version_${hex("d", 64)}`;
const HISTORICAL_VERSION_ID = `version_${hex("a", 64)}`;
const MATERIAL_ID = `mat_${hex("e", 64)}`;
const PRIVATE_MATERIAL_ID = `mat_${hex("2", 64)}`;
const CLAIM_ID = `claim_${hex("f", 64)}`;
const CHANGED_CLAIM_ID = `claim_${hex("1", 64)}`;
const SOURCE_GROUP_KEY = `sg_${hex("4", 64)}`;
const PRIVATE_SOURCE_GROUP_KEY = `sg_${hex("5", 64)}`;
const CAPTURE_AUDIT_REF = `capture_${hex("3", 32)}`;
const CONVERSATION_SOURCE_KEY = `conversation_${hex("6", 64)}`;
const AT = "2026-08-21T02:03:04.000Z";
const STORED_AT = "2026-08-21T02:04:05.000Z";
const ARTIFACT_LABEL =
  "interview-host · ada-interview-2026 · https://example.com/artifacts/ada-interview";
const REPRESENTATION_LABEL =
  "publisher · ada-source-record · https://example.com/sources/ada-record";

const waitUntil = async (predicate, message) => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const currentQuality = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 1,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 1,
  diversityEligibleSourceGroupCount: 1,
  unknownSourceGroupCount: 0,
  coveredCoreFacets: ["voice"],
  uncoveredCoreFacets: ["identity", "psyche", "relations", "boundaries", "texture", "timeline"],
  maturity: "sparse",
};
const candidateQuality = {
  ...currentQuality,
  activeClaimCount: 1,
  contestedClaimCount: 1,
  sourceGroupCount: 2,
  coveredCoreFacets: ["identity"],
  uncoveredCoreFacets: ["voice", "psyche", "relations", "boundaries", "texture", "timeline"],
  maturity: "forming",
};
const actor = { kind: "user", id: "panel-e2e" };
const creation = {
  kind: "host_distill",
  briefContractDigest: `brief_contract_${hex("5", 64)}`,
  promptVersion: `host-distill-v1-sha256_${hex("6", 64)}`,
  draftSchemaVersion: 1,
};
const currentVersion = {
  id: CURRENT_VERSION_ID,
  subjectId: SUBJECT_ID,
  generation: 1,
  materialSetHash: `set_sha256_${hex("a", 64)}`,
  creation,
  status: "current",
  actor,
  quality: currentQuality,
  createdAt: "2026-08-21T01:00:00.000Z",
};
const candidateVersion = {
  ...currentVersion,
  id: CANDIDATE_VERSION_ID,
  parentId: CURRENT_VERSION_ID,
  generation: 2,
  materialSetHash: `set_sha256_${hex("b", 64)}`,
  status: "suspended",
  quality: candidateQuality,
  createdAt: AT,
};
const historicalVersion = {
  ...currentVersion,
  id: HISTORICAL_VERSION_ID,
  status: "historical",
  createdAt: "2026-08-21T00:30:00.000Z",
};
const subject = {
  id: SUBJECT_ID,
  displayName: "Ada Example",
  aliases: ["Ada"],
  identityHints: [{ kind: "url", value: "https://example.com/ada" }],
  space: { id: SPACE_ID, displayName: "People", kind: "people" },
  lifecycle: "active",
  currentVersionId: CURRENT_VERSION_ID,
};
const materialRecord = {
  schemaVersion: 1,
  checksum: `fact_sha256_${hex("7", 64)}`,
  id: MATERIAL_ID,
  subjectId: SUBJECT_ID,
  kind: "web",
  contentDigest: `sha256_${hex("8", 64)}`,
  provenanceDigest: `provenance_sha256_${hex("9", 64)}`,
  sourceIdentity: "https://example.com/ada/interview",
  source: {
    uri: "https://example.com/ada/interview",
    title: "Ada interview",
    medium: "article",
    access: "public",
    role: "interview",
    artifact: {
      provider: "interview-host",
      externalId: "ada-interview-2026",
      canonicalUri: "https://example.com/artifacts/ada-interview",
    },
    representationOf: {
      provider: "publisher",
      externalId: "ada-source-record",
      canonicalUri: "https://example.com/sources/ada-record",
    },
    capturedAt: AT,
    authors: ["Reporter"],
  },
  derivation: { kind: "native_text" },
  participants: ["Ada Example"],
  sensitivity: "shareable",
  flags: [],
  storedAt: STORED_AT,
};
const sourceGroup = {
  key: SOURCE_GROUP_KEY,
  bases: ["canonical_uri"],
  diversityStatus: "eligible",
  cautions: [],
};
const grouping = {
  algorithmVersion: "source-groups-v1",
  generation: 2,
  versionId: CANDIDATE_VERSION_ID,
};
const materialSummary = {
  record: materialRecord,
  contentScalarCount: 70,
  rawAvailable: false,
  inCurrentGeneration: true,
  sourceGroup,
  grouping,
};
const materialView = {
  record: materialRecord,
  content: "Interview transcript: Ada builds careful local-first software systems.",
  rawAvailable: false,
  inCurrentGeneration: true,
  sourceGroup,
  grouping,
};
const privateMaterialRecord = {
  ...materialRecord,
  checksum: `fact_sha256_${hex("2", 64)}`,
  id: PRIVATE_MATERIAL_ID,
  kind: "transcript",
  contentDigest: `sha256_${hex("3", 64)}`,
  provenanceDigest: `provenance_sha256_${hex("4", 64)}`,
  sourceIdentity: "private-conversation",
  source: {
    title: "Private capture",
    medium: "conversation",
    access: "private",
    role: "personal_communication",
    capturedAt: AT,
    authors: ["Ada Example"],
  },
  derivation: {
    kind: "host_extract",
    method: "computer_use_transcript",
    producer: "codex",
  },
  sensitivity: "private",
  captureAuditRef: CAPTURE_AUDIT_REF,
  conversationSourceKey: CONVERSATION_SOURCE_KEY,
};
const privateSourceGroup = {
  key: PRIVATE_SOURCE_GROUP_KEY,
  bases: ["same_private_conversation"],
  diversityStatus: "ineligible",
  cautions: ["private_source"],
};
const privateMaterialSummary = {
  record: privateMaterialRecord,
  contentScalarCount: 65,
  rawAvailable: false,
  inCurrentGeneration: true,
  sourceGroup: privateSourceGroup,
  grouping,
};
const privateMaterialView = {
  record: privateMaterialRecord,
  content: "Private transcript: Ada says review work should stay inspectable.",
  rawAvailable: false,
  inCurrentGeneration: true,
  sourceGroup: privateSourceGroup,
  grouping,
};
const addedClaim = {
  id: CLAIM_ID,
  facet: "identity",
  text: "Ada favors careful local-first systems.",
  evidence: [
    {
      materialId: MATERIAL_ID,
      quote: "careful local-first software systems",
      locator: { start: 33, end: 69 },
    },
    {
      materialId: PRIVATE_MATERIAL_ID,
      quote: "review work should stay inspectable",
      locator: { start: 29, end: 64 },
    },
  ],
  status: "active",
  strength: "single_source",
  observedIn: ["2026"],
  createdIn: CANDIDATE_VERSION_ID,
};
const changedBefore = {
  id: CHANGED_CLAIM_ID,
  facet: "voice",
  text: "Ada speaks directly.",
  evidence: [
    {
      materialId: MATERIAL_ID,
      quote: "careful local-first software systems",
      locator: { start: 33, end: 69 },
    },
  ],
  status: "active",
  strength: "single_source",
  observedIn: ["2026"],
  createdIn: CURRENT_VERSION_ID,
};
const changedAfter = {
  ...changedBefore,
  status: "contested",
  strength: "contested",
};
const reviewItem = {
  candidate: candidateVersion,
  current: currentVersion,
  reasons: [{ code: "manual_review_requested", note: "Verify the interview wording." }],
  diff: {
    added: [addedClaim],
    removed: [],
    changed: [{ before: changedBefore, after: changedAfter }],
    changedFacets: ["identity", "voice"],
    beforeQuality: currentQuality,
    afterQuality: candidateQuality,
  },
};
const mismatchedReviewItem = {
  ...reviewItem,
  candidate: { ...candidateVersion, subjectId: OTHER_SUBJECT_ID },
  current: { ...currentVersion, subjectId: OTHER_SUBJECT_ID },
};
const subjectStatus = {
  subject,
  generation: 2,
  materialSetHash: candidateVersion.materialSetHash,
  suspendedVersionId: CANDIDATE_VERSION_ID,
  maturity: "sparse",
};
const libraryEntry = {
  subject,
  status: subjectStatus,
  privacy: "mixed",
  searchTerms: ["active", "mixed", "sparse", "suspended"],
  currentQuality,
  suspendedQuality: candidateQuality,
  pendingJobs: 0,
  suspendedVersions: 1,
  newMaterialCount: 0,
  lastChangedAt: AT,
};
const profile = {
  subjectId: SUBJECT_ID,
  displayName: "Ada Example",
  versionId: CURRENT_VERSION_ID,
  claims: [changedBefore],
  core: {
    identity: "No current identity claim.",
    voice: "Ada speaks directly.",
    psyche: "Unassessed.",
    relations: "Unassessed.",
    boundaries: "Unassessed.",
    texture: "Unassessed.",
    timeline: "Unassessed.",
  },
  domains: {},
  rendered: "# Ada Example\n\nNo current identity claim.",
  quality: currentQuality,
};
const doctorSnapshot = {
  runtime: { productVersion: "0.0.0", wireVersion: "3", promptVersion: "test" },
  storage: {
    rootLabel: "local test root",
    writable: true,
    schemaSupported: true,
    projectionsDirty: false,
    pendingBlobGcCount: 0,
  },
  panel: { loopbackOnly: true, authentication: "enabled" },
  extensions: [],
};

for (const [method, result] of [
  ["library.list", { items: [libraryEntry] }],
  ["reviews.list", { items: [reviewItem] }],
  ["profiles.status", subjectStatus],
  ["profiles.get", profile],
  ["versions.list", { items: [currentVersion, historicalVersion] }],
  ["materials.list", { items: [privateMaterialSummary, materialSummary] }],
  ["materials.get", materialView],
  ["system.doctor", doctorSnapshot],
]) {
  engineMethodSchemas[method].result.parse(result);
}
engineMethodSchemas["reviews.list"].result.parse({ items: [mismatchedReviewItem] });

const reserve = createNetServer();
await new Promise((resolve, reject) => {
  reserve.once("error", reject);
  reserve.listen(0, "127.0.0.1", resolve);
});
const address = reserve.address();
assert.notEqual(address, null);
assert.equal(typeof address, "object");
const port = address.port;
await new Promise((resolve, reject) =>
  reserve.close((error) => (error ? reject(error) : resolve())),
);

const calls = [];
const watchers = new Set();
let activeReview = true;
let returnMismatchedReview = false;
let borrowedCloseCalls = 0;
const groupingFor = (atVersionId) => ({
  algorithmVersion: grouping.algorithmVersion,
  generation: atVersionId === CURRENT_VERSION_ID ? currentVersion.generation : grouping.generation,
  ...(atVersionId === undefined ? {} : { versionId: atVersionId }),
});
const client = {
  async call(method, params, context) {
    const parsedParams = engineMethodSchemas[method].params.parse(params);
    calls.push({ method, params: parsedParams, ...(context === undefined ? {} : { context }) });
    let result;
    if (method === "library.list") result = { items: [libraryEntry] };
    else if (method === "reviews.list") {
      result = {
        items: activeReview ? [returnMismatchedReview ? mismatchedReviewItem : reviewItem] : [],
      };
    } else if (method === "system.doctor") result = doctorSnapshot;
    else if (method === "profiles.status") result = subjectStatus;
    else if (method === "profiles.get") result = profile;
    else if (method === "versions.list") result = { items: [currentVersion, historicalVersion] };
    else if (method === "materials.list") {
      const summaries =
        parsedParams.atVersionId === CURRENT_VERSION_ID
          ? [materialSummary]
          : [privateMaterialSummary, materialSummary];
      result = {
        items: summaries.map((summary) => ({
          ...summary,
          grouping: groupingFor(parsedParams.atVersionId),
        })),
      };
    } else if (method === "materials.get") {
      const material =
        parsedParams.materialId === PRIVATE_MATERIAL_ID ? privateMaterialView : materialView;
      result = {
        ...material,
        grouping: groupingFor(parsedParams.atVersionId),
      };
    } else if (method === "versions.promote") {
      activeReview = false;
      result = { ...candidateVersion, status: "current" };
    } else if (method === "versions.reject") {
      activeReview = false;
      result = { ...candidateVersion, status: "rejected" };
    } else if (method === "versions.rollback") {
      result = { ...currentVersion, id: `version_${hex("2", 64)}` };
    } else {
      throw new Error(`Unexpected browser E2E call: ${method}`);
    }
    return engineMethodSchemas[method].result.parse(result);
  },
  async watch(handler) {
    watchers.add(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      watchers.delete(handler);
    };
  },
  async close() {
    borrowedCloseCalls += 1;
  },
};
const handle = await startPanelServer({
  client,
  assetsDir: fileURLToPath(new URL("../web", import.meta.url)),
  port,
});
const panelOrigin = handle.url.slice(0, handle.url.indexOf("/#"));
const token = handle.url.slice(-64);
assert.match(handle.url, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#[0-9a-f]{64}$/u);
assert.match(token, /^[0-9a-f]{64}$/u);
const browser = await chromium.launch({ headless: true });
let completedBrowserScenarios = 0;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const requests = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(new Error(message.text()));
  });
  page.on("request", (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      postData: request.postData(),
    });
  });

  const reviewLaunch = `${handle.url}/review/${SUBJECT_ID}/${CANDIDATE_VERSION_ID}`;
  await page.goto(reviewLaunch);
  await page.getByRole("heading", { name: "Review" }).waitFor();
  await page.getByRole("heading", { name: CANDIDATE_VERSION_ID }).waitFor();
  assert.equal(page.url(), `${panelOrigin}/#/review/${SUBJECT_ID}/${CANDIDATE_VERSION_ID}`);
  assert.equal(await page.locator("nav a").count(), 4);
  assert.equal(
    await page
      .locator("body")
      .textContent()
      .then((text) => text.includes("Discover")),
    false,
  );
  await page.getByText("manual_review_requested: Verify the interview wording.").waitFor();
  await page.getByText("Ada favors careful local-first systems.", { exact: true }).waitFor();
  await page
    .getByRole("heading", { name: "Changed before · voice" })
    .locator("xpath=..")
    .getByText("active · single_source", { exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "Changed after · voice" })
    .locator("xpath=..")
    .getByText("contested · contested", { exact: true })
    .waitFor();
  const evidenceQuotes = page.getByText("careful local-first software systems", { exact: true });
  await evidenceQuotes.first().waitFor();
  assert.equal(await evidenceQuotes.count(), 3);
  const materialContents = page.getByText(materialView.content, { exact: true });
  await materialContents.first().waitFor();
  assert.equal(await materialContents.count(), 3);
  const privateEvidence = page
    .getByText("review work should stay inspectable", { exact: true })
    .locator("xpath=..");
  await privateEvidence.getByText(privateMaterialView.content, { exact: true }).waitFor();
  for (const [label, value] of [
    ["Captured at", AT],
    ["Stored at", STORED_AT],
    ["Derivation", "host_extract · computer_use_transcript · codex"],
    ["Raw available", "no"],
    ["Capture audit", CAPTURE_AUDIT_REF],
  ]) {
    assert.equal(
      await privateEvidence
        .getByText(label, { exact: true })
        .locator("xpath=following-sibling::dd[1]")
        .textContent(),
      value,
    );
  }
  await page.getByText("native_text", { exact: true }).first().waitFor();
  await page.getByText(SOURCE_GROUP_KEY).first().waitFor();
  for (const atVersionId of [CURRENT_VERSION_ID, CANDIDATE_VERSION_ID]) {
    assert.ok(
      calls.some(
        (call) => call.method === "materials.list" && call.params.atVersionId === atVersionId,
      ),
      `Review UI did not read evidence at ${atVersionId}.`,
    );
  }

  const browserState = await page.evaluate(() => ({
    url: location.href,
    historyState: JSON.stringify(history.state),
    localStorage: Object.entries(localStorage),
    sessionStorage: Object.entries(sessionStorage),
    cookie: document.cookie,
    html: document.documentElement.outerHTML,
    resourceUrls: performance.getEntriesByType("resource").map((entry) => entry.name),
  }));
  assert.equal(browserState.url.includes(token), false);
  assert.equal(browserState.historyState.includes(token), false);
  assert.deepEqual(browserState.localStorage, []);
  assert.deepEqual(browserState.sessionStorage, []);
  assert.equal(browserState.cookie.includes(token), false);
  assert.equal(browserState.html.includes(token), false);
  assert.equal(
    browserState.resourceUrls.some((url) => url.includes(token)),
    false,
  );

  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("heading", { name: "Library" }).waitFor();
  for (const [label, value] of [
    ["Privacy", "mixed"],
    ["Current quality", "sparse"],
    ["Suspended quality", "forming"],
    ["Pending jobs", "0"],
    ["Suspended versions", "1"],
    ["New materials", "0"],
    ["Last changed", AT],
  ]) {
    assert.equal(
      await page
        .getByText(label, { exact: true })
        .locator("xpath=following-sibling::dd[1]")
        .textContent(),
      value,
    );
  }
  await page.getByRole("link", { name: "Ada Example" }).click();
  await page.getByRole("heading", { name: "Subject" }).waitFor();
  const subjectEvidence = page
    .getByRole("heading", { name: "Claims & evidence" })
    .locator("xpath=..")
    .getByText("careful local-first software systems", { exact: true })
    .locator("xpath=..");
  await subjectEvidence.getByText(materialView.content, { exact: true }).waitFor();
  await subjectEvidence.getByRole("link", { name: "https://example.com/ada/interview" }).waitFor();
  for (const [label, value] of [
    ["Medium", "article"],
    ["Access", "public"],
    ["Role", "interview"],
    ["Artifact", ARTIFACT_LABEL],
    ["Representation of", REPRESENTATION_LABEL],
    ["Source group", SOURCE_GROUP_KEY],
    ["Diversity", "eligible"],
    ["Basis", "canonical_uri"],
    ["Cautions", "none"],
    ["Captured at", AT],
    ["Stored at", STORED_AT],
    ["Sensitivity", "shareable"],
    ["Derivation", "native_text"],
    ["Raw available", "no"],
    ["Capture audit", "none"],
  ]) {
    assert.equal(
      await subjectEvidence
        .getByText(label, { exact: true })
        .locator("xpath=following-sibling::dd[1]")
        .textContent(),
      value,
    );
  }
  const subjectMaterial = page.getByRole("heading", { name: "Ada interview" }).locator("xpath=..");
  for (const [label, value] of [
    ["Artifact", ARTIFACT_LABEL],
    ["Representation of", REPRESENTATION_LABEL],
  ]) {
    assert.equal(
      await subjectMaterial
        .getByText(label, { exact: true })
        .locator("xpath=following-sibling::dd[1]")
        .textContent(),
      value,
    );
  }
  const rawAvailabilityLabels = page.getByText("Raw available", { exact: true });
  await rawAvailabilityLabels.first().waitFor();
  const rawAvailabilityCount = await rawAvailabilityLabels.count();
  assert.ok(rawAvailabilityCount > 0);
  for (let index = 0; index < rawAvailabilityCount; index += 1) {
    assert.equal(
      await rawAvailabilityLabels
        .nth(index)
        .locator("xpath=following-sibling::dd[1]")
        .textContent(),
      "no",
    );
  }
  const rollbackDialog = async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept("E2E rollback reason");
    else if (dialog.type() === "confirm") await dialog.accept();
    else throw new Error(`Unexpected rollback dialog type: ${dialog.type()}`);
  };
  page.on("dialog", rollbackDialog);
  try {
    await page.getByRole("button", { name: "Rollback to this version" }).click();
    await waitUntil(
      () => calls.some((call) => call.method === "versions.rollback"),
      "Rollback UI did not invoke versions.rollback.",
    );
  } finally {
    page.off("dialog", rollbackDialog);
  }

  await page.getByRole("link", { name: "Review" }).click();
  await page.getByRole("heading", { name: "Review" }).waitFor();
  await page.getByText(SOURCE_GROUP_KEY).first().waitFor();
  await page.getByText("canonical_uri").first().waitFor();
  await page.getByRole("link", { name: "https://example.com/ada/interview" }).first().waitFor();

  const beforeCancelledNonceCount = requests.filter(
    (request) => new URL(request.url).pathname === "/action-nonces",
  ).length;
  page.once("dialog", async (dialog) => await dialog.dismiss());
  await page.getByRole("button", { name: "Promote candidate" }).click();
  await page.waitForTimeout(30);
  assert.equal(
    requests.filter((request) => new URL(request.url).pathname === "/action-nonces").length,
    beforeCancelledNonceCount,
  );

  const acceptAction = async (buttonName, reason) => {
    const listener = async (dialog) => {
      if (dialog.type() === "confirm") await dialog.accept();
      else if (dialog.type() === "prompt") await dialog.accept(reason);
      else throw new Error(`Unexpected dialog type: ${dialog.type()}`);
    };
    page.on("dialog", listener);
    try {
      await page.getByRole("button", { name: buttonName }).click();
      await page.getByText("No active suspended candidates.").waitFor();
    } finally {
      page.off("dialog", listener);
    }
  };

  await acceptAction("Promote candidate", "E2E promote reason");
  activeReview = true;
  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("heading", { name: "Library" }).waitFor();
  await page.getByRole("link", { name: "Review" }).click();
  await page.getByRole("button", { name: "Reject candidate" }).waitFor();
  await acceptAction("Reject candidate", "E2E reject reason");

  const mutationCalls = calls.filter(
    (call) =>
      call.method === "versions.rollback" ||
      call.method === "versions.promote" ||
      call.method === "versions.reject",
  );
  assert.deepEqual(
    mutationCalls.map((call) => ({ method: call.method, params: call.params })),
    [
      {
        method: "versions.rollback",
        params: {
          subjectId: SUBJECT_ID,
          targetVersionId: HISTORICAL_VERSION_ID,
          reason: "E2E rollback reason",
        },
      },
      {
        method: "versions.promote",
        params: {
          subjectId: SUBJECT_ID,
          candidateVersionId: CANDIDATE_VERSION_ID,
          reason: "E2E promote reason",
        },
      },
      {
        method: "versions.reject",
        params: {
          subjectId: SUBJECT_ID,
          candidateVersionId: CANDIDATE_VERSION_ID,
          reason: "E2E reject reason",
        },
      },
    ],
  );
  for (const call of mutationCalls) {
    assert.match(call.context.requestId, /^req_[0-9a-f]{32}$/u);
    assert.equal("actionNonce" in call.context, false);
  }

  const nonceRequests = requests.filter(
    (request) => new URL(request.url).pathname === "/action-nonces",
  );
  const mutationRpcRequests = requests.filter((request) => {
    if (new URL(request.url).pathname !== "/rpc" || request.postData === null) return false;
    const body = JSON.parse(request.postData);
    return (
      body.method === "versions.rollback" ||
      body.method === "versions.promote" ||
      body.method === "versions.reject"
    );
  });
  assert.equal(nonceRequests.length, 3);
  assert.equal(mutationRpcRequests.length, 3);
  for (const [index, nonceRequest] of nonceRequests.entries()) {
    const nonceBody = JSON.parse(nonceRequest.postData);
    const rpcBody = JSON.parse(mutationRpcRequests[index].postData);
    assert.deepEqual(nonceBody, {
      wireVersion: "3",
      method: rpcBody.method,
      params: rpcBody.params,
      requestId: rpcBody.requestId,
    });
    assert.match(rpcBody.actionNonce, /^panel_action_[0-9a-f]{64}$/u);
    assert.equal(mutationCalls[index].context.requestId, rpcBody.requestId);
  }

  await page.getByRole("link", { name: "Settings & Doctor" }).click();
  await page.getByRole("heading", { name: "Settings & Doctor" }).waitFor();
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let interceptNextEventStream = true;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (interceptNextEventStream && url.pathname === "/events") {
        interceptNextEventStream = false;
        const headers = new Headers(init?.headers);
        window.__panelSseEvidence = {
          url: url.href,
          method: init?.method,
          authorization: headers.get("authorization"),
          origin: headers.get("origin"),
          body: init?.body,
        };
        const stream = new ReadableStream({
          start(controller) {
            window.__panelSseController = controller;
            controller.enqueue(
              new TextEncoder().encode('event: ready\ndata:{"wireVersion":"3"}\n\n'),
            );
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/event-stream; charset=utf-8",
          },
        });
      }
      return await originalFetch(input, init);
    };
  });

  const countsBeforeDisconnect = {
    library: calls.filter((call) => call.method === "library.list").length,
    reviews: calls.filter((call) => call.method === "reviews.list").length,
    doctor: calls.filter((call) => call.method === "system.doctor").length,
  };
  for (const watcher of [...watchers]) {
    watcher({ kind: "future.event", subjectId: SUBJECT_ID, at: AT });
  }
  await waitUntil(
    () =>
      calls.filter((call) => call.method === "library.list").length ===
        countsBeforeDisconnect.library + 1 &&
      calls.filter((call) => call.method === "reviews.list").length ===
        countsBeforeDisconnect.reviews + 1 &&
      calls.filter((call) => call.method === "system.doctor").length ===
        countsBeforeDisconnect.doctor + 2,
    "SSE disconnect did not reconnect before one library/review/doctor recovery reread.",
  );
  assert.deepEqual(await page.evaluate(() => window.__panelSseEvidence), {
    url: `${panelOrigin}/events`,
    method: "POST",
    authorization: `Bearer ${token}`,
    origin: panelOrigin,
    body: '{"wireVersion":"3"}',
  });

  const countsBeforeUnknownFrame = {
    library: calls.filter((call) => call.method === "library.list").length,
    reviews: calls.filter((call) => call.method === "reviews.list").length,
    doctor: calls.filter((call) => call.method === "system.doctor").length,
  };
  await page.evaluate(
    ({ subjectId, at }) => {
      window.__panelSseController.enqueue(
        new TextEncoder().encode(
          `event: engine\ndata:${JSON.stringify({ kind: "future.event", subjectId, at })}\n\n`,
        ),
      );
    },
    { subjectId: SUBJECT_ID, at: AT },
  );
  await waitUntil(
    () =>
      calls.filter((call) => call.method === "library.list").length ===
        countsBeforeUnknownFrame.library + 1 &&
      calls.filter((call) => call.method === "reviews.list").length ===
        countsBeforeUnknownFrame.reviews + 1 &&
      calls.filter((call) => call.method === "system.doctor").length ===
        countsBeforeUnknownFrame.doctor + 2,
    "Unknown browser SSE frame did not cause one full reread without known-event dispatch.",
  );

  const eventRequests = requests.filter((request) => new URL(request.url).pathname === "/events");
  assert.ok(eventRequests.length >= 1, "Panel must establish POST /events over a real socket");
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, panelOrigin);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.hash, "");
  }
  for (const request of requests.filter((entry) =>
    ["/rpc", "/events", "/action-nonces"].includes(new URL(entry.url).pathname),
  )) {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
  }
  for (const request of eventRequests) {
    assert.equal(request.method, "POST");
    assert.deepEqual(JSON.parse(request.postData), { wireVersion: "3" });
  }
  assert.equal(pageErrors.length, 0, pageErrors.map((error) => error.stack).join("\n"));
  completedBrowserScenarios += 1;
  await context.close();

  activeReview = true;
  returnMismatchedReview = true;
  const mismatchCallStart = calls.length;
  const mismatchContext = await browser.newContext();
  const mismatchPage = await mismatchContext.newPage();
  const mismatchPageErrors = [];
  mismatchPage.on("pageerror", (error) => mismatchPageErrors.push(error));
  mismatchPage.on("console", (message) => {
    if (message.type() === "error") mismatchPageErrors.push(new Error(message.text()));
  });
  await mismatchPage.goto(reviewLaunch);
  await mismatchPage.getByText("This review link is stale.", { exact: true }).waitFor();
  const mismatchCalls = calls.slice(mismatchCallStart);
  assert.ok(
    mismatchCalls.some(
      (call) => call.method === "reviews.list" && call.params.subjectId === SUBJECT_ID,
    ),
    "Mismatch fixture did not exercise the subject-filtered review route.",
  );
  assert.deepEqual(
    mismatchCalls.filter(
      (call) =>
        call.method === "materials.list" ||
        call.method === "materials.get" ||
        call.method === "versions.promote" ||
        call.method === "versions.reject" ||
        call.method === "versions.rollback",
    ),
    [],
    "A subject-mismatched review route reached material reads or a mutation.",
  );
  assert.equal(
    mismatchPageErrors.length,
    0,
    mismatchPageErrors.map((error) => error.stack).join("\n"),
  );
  completedBrowserScenarios += 1;
  await mismatchContext.close();
} finally {
  await browser.close();
  await handle.close();
}

assert.equal(
  completedBrowserScenarios,
  2,
  "Panel Chromium gate must execute both browser scenarios",
);
assert.equal(borrowedCloseCalls, 0, "Panel server must not close its borrowed EngineClient");
