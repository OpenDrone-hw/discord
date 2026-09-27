/**
 * Text and Components V2 builders for everything this module posts.
 *
 * Titles, branch names, logins and PR or review bodies come from anyone who
 * can open a pull request, including forks, so they are escaped or reduced to
 * plain text before they reach Discord. Mentions are suppressed separately by
 * allowed_mentions {parse: []} (src/discord.ts); escaping here stops them and
 * other markdown from even rendering.
 */
import { MessageFlags, type MessagePayload } from "../types.ts";

export const Colors = {
  open: 0x2da44e,
  draft: 0x6e7781,
  merged: 0x8250df,
  closed: 0xcf222e,
  success: 0x2da44e,
  failure: 0xcf222e,
  warning: 0xbf8700,
  neutral: 0x6e7781,
  release: 0x0969da,
} as const;

/** Component type numbers (Components V2). */
export const Component = {
  ACTION_ROW: 1,
  BUTTON: 2,
  TEXT_DISPLAY: 10,
  SEPARATOR: 14,
  CONTAINER: 17,
} as const;

const BUTTON_LINK = 5;
/** Discord caps displayable text across all components of a message at 4000. */
export const MAX_TEXT = 3800;

/** Collapses whitespace, newlines included, into single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/** Escapes Discord markdown in inline text (titles, logins, file names). */
export function escapeMarkdown(text: string): string {
  return oneLine(text)
    .replace(/[\\`*_~|[\]()<>]/g, "\\$&")
    .replace(/^[#>-]/, "\\$&");
}

/** Inline code span; backticks inside are dropped because they cannot be escaped there. */
export function code(text: string): string {
  const clean = oneLine(text).replace(/`/g, "");
  return clean ? `\`${clean}\`` : "`?`";
}

/** True for URLs the bot links to: GitHub pages and GitHub release downloads. */
export function isGitHubUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[^\s()<>]+$/.test(url);
}

/** Masked link with escaped text, or the escaped text alone for a URL that is not GitHub's. */
export function link(text: string, url: string): string {
  const label = escapeMarkdown(text);
  return isGitHubUrl(url) ? `[${label}](${url})` : label;
}

/** HTML tags by real tag name; "<https://...>", "<t:...>" and "<@id>" do not match. */
const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g;
/**
 * Masked link "[label](url optional-title)". Every group excludes the
 * characters that end it and the groups never overlap, so a failed match
 * costs linear time: no catastrophic backtracking on hostile input.
 */
const MASKED_LINK = /\[([^[\]]*)\]\(([^()\s]*)(?:\s[^()]*)?\)/g;
/** Image "![alt](src)", with the same non-overlapping groups as MASKED_LINK. */
const IMAGE = /!\[[^[\]]*\]\([^()]*\)/g;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
/** Raw input scanned for HTML comments, so a long PR template comment does not eat the excerpt. */
const MAX_RAW_INPUT = 20_000;
/** Input left after comments are removed; 4 times the largest excerpt the bot posts (800). */
const MAX_EXCERPT_INPUT = 3200;
const MAX_LINK_PASSES = 20;

/**
 * Untrusted markdown (PR descriptions, review bodies) reduced to plain,
 * readable text: HTML comments and tags removed, images dropped, masked
 * links shown with their real URL (repeated so nested links unwrap too),
 * then every remaining "\\", "[", "]", "<" and ">" escaped. No masked link can
 * survive, and "<@id>", "<t:...>" and "<https://...>" show as text.
 * Blank-line runs are collapsed and the result is truncated.
 */
export function plainExcerpt(markdown: string, max: number): string {
  let text = markdown
    .slice(0, MAX_RAW_INPUT)
    .replace(HTML_COMMENT, "")
    .slice(0, MAX_EXCERPT_INPUT)
    .replace(/\r\n?/g, "\n")
    .replace(IMAGE, "")
    .replace(HTML_TAG, "");
  for (let pass = 0; pass < MAX_LINK_PASSES; pass++) {
    const next = text.replace(MASKED_LINK, (_, label: string, url: string) => (label ? `${label} (${url})` : url));
    if (next === text) break;
    text = next;
  }
  text = text
    .replace(/[\\[\]<>]/g, "\\$&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncate(text, max);
}

/** Release notes are written by maintainers: markdown kept, HTML comments removed. */
export function releaseNotes(markdown: string, max: number): string {
  const text = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncate(text, max);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function formatBytes(size: number | undefined): string {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export interface CardOptions {
  color: number;
  /** Text Display blocks, in order. Empty strings are skipped. */
  blocks: string[];
  button?: { label: string; url: string };
}

/**
 * A compact Components V2 card: one Container with an accent colour, its
 * text blocks and an optional "open on GitHub" link button.
 */
export function card(options: CardOptions): MessagePayload {
  let budget = MAX_TEXT;
  const children: unknown[] = [];
  for (const block of options.blocks) {
    if (!block || budget <= 0) continue;
    const content = truncate(block, budget);
    budget -= content.length;
    children.push({ type: Component.TEXT_DISPLAY, content });
  }
  if (options.button && isGitHubUrl(options.button.url)) {
    children.push({
      type: Component.ACTION_ROW,
      components: [{ type: Component.BUTTON, style: BUTTON_LINK, label: options.button.label, url: options.button.url }],
    });
  }
  return {
    flags: MessageFlags.IS_COMPONENTS_V2,
    components: [{ type: Component.CONTAINER, accent_color: options.color, components: children }],
    allowed_mentions: { parse: [] },
  };
}

/** One-line Components V2 message for #git-feed. */
export function feedLine(text: string): MessagePayload {
  return {
    flags: MessageFlags.IS_COMPONENTS_V2,
    components: [{ type: Component.TEXT_DISPLAY, content: truncate(text, MAX_TEXT) }],
    allowed_mentions: { parse: [] },
  };
}
