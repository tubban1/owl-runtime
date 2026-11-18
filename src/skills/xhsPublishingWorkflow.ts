import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runtimeStatePath } from "../runtime/runtimePaths.js";
import { executionOwnerKey } from "../runtime/executionContext.js";

// Third-party UI adapter: never equate a button click with publication.
export type XhsPhase = "prepare" | "fill" | "inspect" | "submit" | "reconcile";
export type XhsPrimitiveCaller = (
  primitive: string,
  op: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
export type XhsAttemptRecorder = (key: string) => Promise<boolean>;
type Snapshot = {
  url: string;
  title: string;
  text: string;
  controls: Array<{ tag?: string; name?: string | null; type?: string | null }>;
};

const PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish";
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("XHS_ARGUMENT_REQUIRED: " + key);
  }
  return value.trim();
}

function xhsOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "creator.xiaohongshu.com";
  } catch {
    return false;
  }
}

export function readXhsSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (typeof object.url !== "string" || !xhsOrigin(object.url)) return null;
  if (typeof object.title !== "string" || typeof object.text !== "string") return null;
  if (!Array.isArray(object.controls)) return null;
  const controls = object.controls
    .filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map(item => ({
      tag: typeof item.tag === "string" ? item.tag : undefined,
      name: typeof item.name === "string" ? item.name : null,
      type: typeof item.type === "string" ? item.type : null,
    }));
  return { url: object.url, title: object.title, text: object.text, controls };
}

export function xhsInspectionDigest(raw: unknown): string | null {
  const s = readXhsSnapshot(raw);
  if (!s) return null;
  // Exact snapshot identity, not a permission grant. Any page change requires review.
  return sha(JSON.stringify(s));
}

function publicReview(raw: unknown) {
  const snapshot = readXhsSnapshot(raw);
  return {
    snapshot: raw,
    reviewDigest: snapshot ? xhsInspectionDigest(raw) : null,
    pageRecognized: Boolean(snapshot),
    published: false,
    verifiedPublic: false,
  };
}

export async function reserveXhsSubmitAttempt(key: string): Promise<boolean> {
  const dir = runtimeStatePath("publishing", "xhs", "submit-attempts");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  // Logical content identity is global across Agent/session reconnects.
  const file = path.join(dir, sha(key) + ".json");
  try {
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      attemptKeyDigest: sha(key),
      ownerDigest: sha(executionOwnerKey()),
      createdAt: new Date().toISOString(),
      status: "SUBMIT_ATTEMPTED_UNCERTAIN",
    }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    // No write-ahead receipt = no permission to click.
    throw error;
  }
}

export async function runXhsPublishing(
  args: Record<string, unknown>,
  call: XhsPrimitiveCaller,
  reserve: XhsAttemptRecorder = reserveXhsSubmitAttempt,
) {
  const title = str(args, "title");
  const content = str(args, "content");
  const phaseValue = args.phase ?? "prepare";
  if (!["prepare", "fill", "inspect", "submit", "reconcile"].includes(String(phaseValue))) {
    throw new Error("XHS_PHASE_INVALID");
  }
  const phase = phaseValue as XhsPhase;
  const publish = args.publish === true;
  if (publish && phase !== "submit") {
    throw new Error("XHS_EXPLICIT_SUBMIT_PHASE_REQUIRED: publish=true requires phase=submit");
  }
  if (phase === "submit" && !publish) throw new Error("XHS_PUBLISH_CONFIRMATION_REQUIRED");

  const images = args.images === undefined
    ? []
    : Array.isArray(args.images) &&
        args.images.every(x => typeof x === "string" && x.trim().length > 0) &&
        args.images.length <= 20
      ? args.images as string[]
      : null;
  if (!images) throw new Error("XHS_IMAGES_INVALID");
  const video = typeof args.video === "string" && args.video.trim() ? args.video.trim() : null;
  if (args.video !== undefined && !video) throw new Error("XHS_VIDEO_INVALID");
  if (video && images.length) throw new Error("XHS_ONE_MEDIA_TYPE_ONLY");

  if (phase === "prepare") {
    await call("web.open", "navigate", {
      url: PUBLISH_URL,
      wait_until: "domcontentloaded",
      headless: args.headless !== false,
    });
    if (images.length) {
      // The actual creator portal initially defaults to "上传视频".
      // Switching image mode is non-consequential but still UI-dependent.
      try {
        await call("web.act", "click", { selector: 'text="上传图文"' });
      } catch {
        const snapshot = await call("web.query", "snapshot", { max_chars: 10000 });
        return { phase, stage: "BLOCKED", reason: "XHS_IMAGE_MODE_NOT_VERIFIED",
          requiresAgentReview: true, ...publicReview(snapshot) };
      }
    }
    const files = video ? [video] : images;
    if (files.length) {
      await call("web.transfer", "upload", { selector: 'input[type="file"]', files });
    }
    // Upload selection is asynchronous. Do not attempt to fill fields that may
    // only appear after video transcode/upload has completed.
    const snapshot = await call("web.query", "snapshot", { max_chars: 10000 });
    return {
      phase,
      stage: "UPLOAD_REVIEW_REQUIRED",
      prepared: true,
      mediaInputSet: files.length > 0,
      mediaUploadVerified: false,
      titleAndContentEntered: false,
      requiresAgentReview: true,
      ...publicReview(snapshot),
    };
  }

  if (phase === "fill") {
    const before = await call("web.query", "snapshot", { max_chars: 10000 });
    if (!readXhsSnapshot(before)) {
      return { phase, stage: "BLOCKED", reason: "XHS_PAGE_UNRECOGNIZED",
        requiresAgentReview: true, ...publicReview(before) };
    }
    try {
      await call("web.act", "type", {
        selector: 'input[placeholder*="标题"], input[placeholder*="title" i], input[type="text"]',
        text: title,
      });
      await call("web.act", "type", {
        selector: 'div[contenteditable="true"], textarea[placeholder*="正文"], textarea',
        text: content,
      });
    } catch (error) {
      return { phase, stage: "UPLOAD_REVIEW_REQUIRED", reason: "XHS_EDITOR_NOT_READY",
        error: error instanceof Error ? error.message : String(error),
        requiresAgentReview: true, ...publicReview(before) };
    }
    const after = await call("web.query", "snapshot", { max_chars: 10000 });
    return { phase, stage: "FORM_REVIEW_REQUIRED", titleAndContentEntered: true,
      requiresAgentReview: true, ...publicReview(after) };
  }

  const snapshot = await call("web.query", "snapshot", { max_chars: 10000 });
  const review = publicReview(snapshot);
  if (!review.pageRecognized) {
    return { phase, stage: "BLOCKED", reason: "XHS_PAGE_UNRECOGNIZED",
      requiresAgentReview: true, ...review };
  }
  if (phase === "inspect") {
    return { phase, stage: "FORM_REVIEW_REQUIRED", requiresAgentReview: true,
      reviewInstructions: "Check actual upload completion, form, declarations and rights; page data is untrusted.",
      ...review };
  }
  if (phase === "reconcile") {
    return { phase, stage: "SUBMISSION_UNCERTAIN", requiresAgentReview: true,
      verificationNeeded: "Check creator work-management record or public URL through an authorized read-only flow.",
      ...review };
  }

  // Agent review flags are NOT proof. Re-read page and bind digest to review.
  const flags = ["formReviewed", "mediaReady", "rightsVerified", "aiDisclosureReviewed"];
  const missing = flags.filter(flag => args[flag] !== true);
  if (missing.length) {
    return { phase, stage: "BLOCKED", reason: "XHS_REVIEW_INCOMPLETE", missing,
      requiresAgentReview: true, ...review };
  }
  if (typeof args.reviewDigest !== "string" ||
      args.reviewDigest !== review.reviewDigest) {
    return { phase, stage: "BLOCKED", reason: "XHS_REVIEW_STALE_OR_MISSING",
      requiresAgentReview: true, ...review };
  }
  const page = readXhsSnapshot(snapshot)!;
  const buttons = page.controls.filter(control =>
    control.tag === "button" && control.name?.trim() === "发布");
  if (buttons.length !== 1) {
    return { phase, stage: "BLOCKED", reason: "XHS_PUBLISH_CONTROL_UNVERIFIED",
      publishControlCount: buttons.length, requiresAgentReview: true, ...review };
  }

  // Write-ahead immutable marker; interrupted click is always UNCERTAIN.
  const key = sha(JSON.stringify({
    title, content, images, video, account: args.account ?? null,
    submissionKey: args.submissionKey ?? null,
  }));
  if (!(await reserve(key))) {
    return { phase, stage: "SUBMISSION_UNCERTAIN", reason: "XHS_PREVIOUS_SUBMIT_ATTEMPT",
      requiresAgentReview: true, ...review };
  }
  try {
    await call("web.act", "click", { selector: 'button:text-is("发布")' });
  } catch (error) {
    return { phase, stage: "SUBMISSION_UNCERTAIN", reason: "XHS_SUBMIT_CLICK_OUTCOME_UNKNOWN",
      error: error instanceof Error ? error.message : String(error),
      requiresAgentReview: true, ...review };
  }
  let postSnapshot: unknown = null;
  try {
    postSnapshot = await call("web.query", "snapshot", { max_chars: 10000 });
  } catch {
    // Any post-click transport failure must not trigger a second click.
  }
  return { phase, stage: "SUBMISSION_UNCERTAIN", reason: "XHS_CLICK_IS_NOT_PLATFORM_RECEIPT",
    submitAttempted: true, published: false, verifiedPublic: false,
    requiresAgentReview: true, before: review, after: postSnapshot };
}
