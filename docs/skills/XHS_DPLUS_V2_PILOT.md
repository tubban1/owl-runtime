# D+ v2 — Xiaohongshu publishing pilot

Status: **implemented locally; not deployed; platform live E2E not yet accepted**
Baseline: owl-runtime `b2d65c1`, owl-desktop `edf6af1`.

## Architectural ownership

- Planner chooses and reads guidance, writes copy, checks rights/AI disclosures, and handles dynamic page decisions.
- Desktop MCP exposes a single **read-only** `guidance` discovery/read tool. Guidance records have independent id, immutable version and SHA-256 pinned content; a guidance document may apply to several executable Skills or none.
- Runtime retains the existing canonical built-in/User Skill catalog, approval policy, execution ownership and Primitive ABI v1.
- `xhs.publish` remains a built-in Runtime Skill; new implementation is in `src/skills/xhsPublishingWorkflow.ts` (`skillVersion=0.4.0`). No User Skill Manifest v1 or store schema changes.

## Staged protocol

- `phase=prepare` (default): navigate and set the image/video input, capture snapshot. Current live creator portal defaults to an **upload-video screen without title/body inputs**. Result is `UPLOAD_REVIEW_REQUIRED` with `mediaUploadVerified=false`.
- `phase=fill`: after upload/transcode is visibly complete, fill title and body **without navigating/re-uploading**. Returns `FORM_REVIEW_REQUIRED`, or `UPLOAD_REVIEW_REQUIRED` if the editor is not ready.
- `phase=cover_review`, `topic_review`, `declaration_review`: **read-only** specialized checkpoints. Cover preparation (9:16 and 16:9), exact topic popup selection after each hashtag, original switch and applicable AI content type must be separately checked. Current browser controls do not expose all of these operations, so these phases return review/unverified states and cannot claim success.
- `phase=inspect`: **read-only** current browser snapshot; returns `reviewDigest` tied to current origin, title, page text and control labels.
- `phase=submit`: only if `publish=true`, `formReviewed=true`, `mediaReady=true`, `rightsVerified=true`, `aiDisclosureReviewed=true`, and `reviewDigest` equals fresh snapshot. Requires one exact visible publish button and existing Runtime high-risk approval. A write-ahead marker is recorded before the single click, blocking another attempt on the same logical content identity even after an interrupted request.
- `phase=reconcile`: **read-only** snapshot. Current release intentionally cannot mark public success without independently verified publication evidence. Always returns `SUBMISSION_UNCERTAIN`.

All phases return `published=false` unless a separate, independently proven public-post receipt is implemented in a later revision. A selector failure, click timeout, or network interruption must never cause an automatic second click. Current code does **not** claim platform acceptance or public visibility.

## Test evidence

- `npm run build` in Runtime and Desktop
- `npm run verify:xhs-publishing-dplus`: mock adapter verifies prepare/inspect/stale review/incorrect origin/one click/uncertain result/duplicate attempt and no live publication
- `verify:skill-abi`: built-in Skill ABI remains compatible with Primitive ABI v1; use isolated test state root
- Desktop `tests/guidance-library.test.mjs` and `tests/mcp-tool-surface.test.mjs`: guidance integrity/versioning, genuine MCP tools/list + tool call (after dependency install)

## Known limitations requiring later acceptance

1. Fixed title/body/input selectors still exist in the prepare/fill phases. A real upload variation, login dialog or changed UI can fail. Agent uses current browser snapshot and appropriate authorized browser controls; there is no automatic selector repair.
2. Current snapshots do not prove field values or correct checkbox state. Review flags are Agent/user attestations, not machine checks. Stale digest catches recorded page/controls changes, not all hidden field changes.
3. Platform acceptance and public-post receipt are not yet implemented. Add read-only creator work-management/public URL reconciliation and check status `PLATFORM_ACCEPTED` versus `PUBLIC_VERIFIED` without guessing.
4. Playbook `guidance` digest is verified on read but is not yet cryptographically bound to individual Runtime execution receipts; v1.1.0 adds real Windows page observations and explicit limits. This traceability is a separate gate.
5. The write-ahead attempt marker is stored in Runtime's owned state. It guards replay for the same logical content key but does not replace the broader Runtime request replay/approval or full transaction semantics; changing content or logical key may represent a new submission, and must be authorized separately.
6. The normal Adapter does not yet expose an explicit video-processing status and may fail for a video tab without Agent intervention. This first pilot is a fail-closed foundation, **not** a claim of production-ready auto-publishing.

## Acceptance gate before deployment

Run against a controlled test account with explicit authorization and an intentionally non-public/draft workflow where possible. Verify: upload/media completion, title/body and disclosure states, intermediate page changes, lost connection after submit, no duplicate post, platform submission acknowledgement, actual publicly visible URL, immutable evidence receipts, and a client compatibility matrix for ChatGPT/Claude/Codex. Never use real publishing as an automated smoke test without a clear user request.
