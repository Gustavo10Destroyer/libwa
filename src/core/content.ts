/**
 * Normalized message content.
 *
 * Incoming provider messages are flattened into this discriminated union by
 * the backend adapter. Consumers switch on `content.kind` — never on provider
 * payload structures — and every optional provider field is normalized to a
 * stable shape here.
 */

/** Kinds of media that can be attached to a message. */
export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

/** A contact card embedded in a message. */
export interface ContactCard {
  /** Display name of the contact. */
  readonly name: string;
  /** Phone number in international format when available. */
  readonly phone: string | undefined;
}

/** Metadata + lazy download handle for a media payload. */
export interface MediaInfo {
  /** MIME type of the media (e.g. `image/jpeg`). */
  readonly mimeType: string;
  /** Size in bytes when known by the provider. */
  readonly size: number | undefined;
  /** Original file name for documents, `undefined` otherwise. */
  readonly fileName: string | undefined;
  /** Duration in seconds for audio/video when known. */
  readonly durationSeconds: number | undefined;
  /** True for voice notes (WhatsApp "push to talk" audio). */
  readonly isVoiceNote: boolean;
  /** True for animated stickers. */
  readonly isAnimated: boolean;
  /** Downloads the raw bytes of this media. */
  download(): Promise<Uint8Array>;
}

/** An attached media file together with its media kind. */
export interface Attachment extends MediaInfo {
  readonly kind: MediaKind;
}

export interface TextContent {
  readonly kind: "text";
  /** Full text of the message. */
  readonly text: string;
}

export interface ImageContent {
  readonly kind: "image";
  /** Caption (empty string when the provider sent none). */
  readonly caption: string;
  readonly attachment: Attachment;
}

export interface VideoContent {
  readonly kind: "video";
  readonly caption: string;
  readonly attachment: Attachment;
}

export interface AudioContent {
  readonly kind: "audio";
  readonly attachment: Attachment;
}

export interface DocumentContent {
  readonly kind: "document";
  /** Caption (empty string when the provider sent none). */
  readonly caption: string;
  readonly attachment: Attachment;
}

export interface StickerContent {
  readonly kind: "sticker";
  readonly attachment: Attachment;
}

export interface LocationContent {
  readonly kind: "location";
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string | undefined;
  readonly name: string | undefined;
}

export interface ContactContent {
  readonly kind: "contact";
  readonly cards: readonly ContactCard[];
}

export interface PollContent {
  readonly kind: "poll";
  readonly name: string;
  readonly options: readonly string[];
  readonly selectableCount: number;
}

export interface ButtonReplyContent {
  readonly kind: "buttonReply";
  /** Provider-defined identifier of the selected button. */
  readonly buttonId: string;
  /** Title of the button list/prompt the user replied to. */
  readonly title: string;
  /** Text shown on the selected button. */
  readonly displayText: string;
  /** Whether the reply targets a template or a plain button message. */
  readonly variant: "template" | "plain";
}

export interface ListReplyContent {
  readonly kind: "listReply";
  /** Provider-defined identifier of the selected row. */
  readonly rowId: string;
  /** Title of the selected row. */
  readonly title: string;
  /** Description of the selected row when provided. */
  readonly description: string | undefined;
}

/** Normalized fallback for content the library does not model explicitly. */
export interface UnknownContent {
  readonly kind: "unknown";
  /** Short human-readable description of what was received. */
  readonly description: string;
}

/**
 * Discriminated union of every supported message content shape.
 *
 * Media contents always expose an {@link Attachment}; text-like contents never
 * do. `unknown` guarantees that unusual provider payloads still arrive as a
 * well-typed value instead of `undefined` fields.
 */
export type MessageContent =
  | TextContent
  | ImageContent
  | VideoContent
  | AudioContent
  | DocumentContent
  | StickerContent
  | LocationContent
  | ContactContent
  | PollContent
  | ButtonReplyContent
  | ListReplyContent
  | UnknownContent;

/** Content kinds that carry an attachment. */
export type MediaMessageContent = Extract<MessageContent, { readonly attachment: Attachment }>;

/** Returns the plain text associated with a content (`text`, caption, or `""`). */
export function contentText(content: MessageContent): string {
  switch (content.kind) {
    case "text":
      return content.text;
    case "image":
    case "video":
    case "document":
      return content.caption;
    case "buttonReply":
      return content.displayText;
    case "listReply":
      return content.title;
    case "poll":
      return content.name;
    default:
      return "";
  }
}

/** Returns the attachments of a content as a list (0 or 1 items). */
export function contentAttachments(content: MessageContent): readonly Attachment[] {
  return "attachment" in content ? [content.attachment] : [];
}
