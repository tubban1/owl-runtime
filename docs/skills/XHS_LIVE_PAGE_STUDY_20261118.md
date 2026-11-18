# Xiaohongshu creator UI field study — 2026-11-18

Environment: Windows OWL LAB `1.0.0-rc.4`, signed-in Chrome Native Messaging, XHS creator page `https://creator.xiaohongshu.com/publish/publish`, account display `world2`. Draft media: `rough-cut-v2.mp4`, 77.82s H.264/AAC, 720x1280, 49,031,498 bytes, SHA-256 `FA517A87FDDCD0A0CBFF96D1A6798C10A3BD1B275728D2AAA13FC2484285C05D`. This was **not** submitted.

## Confirmed UI observations

1. Initial page is video upload, hidden `input[type=file]`, no title/body fields.
2. File-attach attempt returned `UPLOAD_INPUT_OR_UI_CONFIRMATION_MISSING` but snapshot then showed file uploading at 82%. On next observation the percentage disappeared and the filename plus video-resolution warning appeared. **This must be treated as an uncertain tool outcome until independently reconciled, never auto-retried.**
3. Title `重庆这座城，居然是活的？` was filled successfully. Body rich-editor insertion returned `EDITOR_FRAMEWORK_UPDATE_NOT_CONFIRMED` even though the full AI-disclosed draft appeared in the editor and preview. Again, read actual state before any retry.
4. Under `设置封面`, creator page showed thumbnail, `默认截取第一帧`, three `AI生成` cover suggestions, `已应用`, `封面效果评估通过`. Custom cover editor/upload path was **not** verified because currently exposed controls could not be safely clicked.
5. After text containing `#AI生成` was inserted, a floating topic suggestion list appeared with exact and related names plus view counts. No proof any specific suggestion was selected; merely typed hashtag text is insufficient.
6. Content Settings displayed `原创声明` with an off switch and a separate `添加内容类型声明` row. Neither produced an observed native checkbox/switch UID via `browser_agent_form_controls`. Modal text and final checked state therefore remain **unverified**.
7. Browser cursor/safe click returned `CURSOR_TARGET_OCCLUDED` for some observed cover/topic elements. Never substitute unverified coordinates, bypass approval, or click the final `发布` button.
8. Source production video is AI generated and already has the `AI 生成` watermark, but the site-level AI content declaration remains a **separate required control**.

## Assets created outside repositories

Directory: `C:\Users\i95i\mcp-workspace\publish-assets\personaOps\covers`

- `cq-v2-cover-vertical-9x16.jpg` 720×1280 from original ~62s frame.
- `cq-v2-cover-horizontal-16x9.jpg` 1280×720 with blurred flanking regions derived from the same frame.
- The vertical variant is the intended XHS candidate; no custom cover was attached to the creator draft.

## Specific future Browser Adapter acceptance gates

- Make creator's **cover preview/editor**, its picker/dialog and selected preview observable via safe, Agent-owned UIDs; verify selected file against prepared cover identity.
- Support a targeted **caret-after-exact-tag** operation within the editor, with popup option enumeration, exact-match choice and selected topic receipt. Avoid arbitrary JavaScript/DOM injection and direct screen coordinates.
- Expose the **original declaration switch** state and **AI content-type dropdown** as verified controls; require rights evidence, user instruction and current modal text before setting. Observe postcondition after any modal.
- Keep modal operations as `OPEN → SNAPSHOT → SELECT EXACT → CONFIRM IF AUTHORIZED → VERIFY`; when anything is inaccessible, report `BLOCKED` with evidence.
- Only after these three real-site gates pass can the Runtime Agent Skill report the form ready. This study did not verify submission or publication.

## Implemented source scope

- Desktop guidance `xiaohongshu-publishing@1.1.0`: independently versioned read-only instructions with observed/unverified labels.
- Runtime `xhs.publish@0.4.0`: read-only cover/topic/declaration checkpoints, video cover and exact-topic input hints, fail-closed submission review requirements; still does **not** perform site-specific modal operations.
- No change to User Skill Manifest v1, Primitive ISA, Registry execution authority, or production user authorization.

**Do not merge or deploy as production-ready auto-publishing until actual custom controls are handled and verified in a controlled site test.**
