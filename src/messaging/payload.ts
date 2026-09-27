import type { OutboundContent } from "../backend/Backend.js";
import type { UserId } from "../core/ids.js";
import type { User } from "../entities/User.js";
import { ValidationError } from "../errors/index.js";
import type { MediaSource, MessagePayload, ReplyContent, SendOptions } from "./types.js";

/** A validated payload ready to be handed to a backend. */
export interface NormalizedPayload {
  readonly content: OutboundContent;
  readonly mentions: readonly UserId[];
}

const DEFAULT_MIMETYPES = {
  image: "image/jpeg",
  video: "video/mp4",
  audio: "audio/ogg; codecs=opus",
  document: "application/octet-stream",
  sticker: "image/webp",
} as const;

type MediaKindKey = keyof typeof DEFAULT_MIMETYPES;

function mediaBytes(source: MediaSource): { data: Uint8Array; mimetype: string | undefined } {
  if (source instanceof Uint8Array) {
    return { data: source, mimetype: undefined };
  }
  return { data: source.data, mimetype: source.mimetype };
}

function resolveMentions(
  payload: MessagePayload,
  options: SendOptions | undefined,
): readonly UserId[] {
  const ids = new Set<UserId>();
  for (const entry of payload.mentions ?? []) {
    ids.add(typeof entry === "string" ? entry : entry.id);
  }
  for (const entry of options?.mentions ?? []) {
    ids.add(typeof entry === "string" ? entry : entry.id);
  }
  return [...ids];
}

function bodyCount(payload: MessagePayload): number {
  let count = 0;
  if (payload.text !== undefined) count += 1;
  if (payload.image !== undefined) count += 1;
  if (payload.video !== undefined) count += 1;
  if (payload.audio !== undefined) count += 1;
  if (payload.document !== undefined) count += 1;
  if (payload.sticker !== undefined) count += 1;
  if (payload.location !== undefined) count += 1;
  return count;
}

/**
 * Validates and converts a {@link ReplyContent} into the backend's outbound
 * representation. Throws {@link ValidationError} with actionable messages when
 * the payload is empty, ambiguous, or inconsistent.
 */
export function normalizeReplyContent(
  content: ReplyContent,
  options?: SendOptions,
): NormalizedPayload {
  if (typeof content === "string") {
    if (content.length === 0) {
      throw new ValidationError("Cannot send an empty string.", { code: "ERR_EMPTY_MESSAGE" });
    }
    return { content: { kind: "text", text: content }, mentions: [] };
  }

  const count = bodyCount(content);
  if (count === 0) {
    throw new ValidationError(
      "Message payload needs a body: provide one of text, image, video, audio, document, sticker or location.",
      { code: "ERR_EMPTY_MESSAGE" },
    );
  }
  if (count > 1) {
    throw new ValidationError(
      "Message payload must contain exactly one body (text, media or location).",
      { code: "ERR_AMBIGUOUS_MESSAGE" },
    );
  }
  if (
    content.caption !== undefined &&
    content.image === undefined &&
    content.video === undefined &&
    content.document === undefined
  ) {
    throw new ValidationError("A caption can only be used with an image, video or document.", {
      code: "ERR_INVALID_CAPTION",
    });
  }

  const mentions = resolveMentions(content, options);

  if (content.text !== undefined) {
    if (content.text.length === 0) {
      throw new ValidationError("Cannot send an empty text message.", {
        code: "ERR_EMPTY_MESSAGE",
      });
    }
    return { content: { kind: "text", text: content.text }, mentions };
  }

  if (content.location !== undefined) {
    const { latitude, longitude, address, name } = content.location;
    return {
      content: {
        kind: "location",
        latitude,
        longitude,
        address: address ?? undefined,
        name: name ?? undefined,
      },
      mentions,
    };
  }

  const mediaKey = (["image", "video", "audio", "document", "sticker"] as const).find(
    (key) => content[key] !== undefined,
  );
  if (mediaKey === undefined) {
    throw new ValidationError("Message payload needs a body.", { code: "ERR_EMPTY_MESSAGE" });
  }

  const source = content[mediaKey as MediaKindKey];
  if (source === undefined) {
    throw new ValidationError("Message payload needs a body.", { code: "ERR_EMPTY_MESSAGE" });
  }
  const { data, mimetype } = mediaBytes(source as MediaSource);
  if (data.byteLength === 0) {
    throw new ValidationError(`The ${mediaKey} attachment is empty.`, {
      code: "ERR_EMPTY_MEDIA",
    });
  }

  const caption = content.caption ?? undefined;
  const base = {
    data,
    mimetype: mimetype ?? DEFAULT_MIMETYPES[mediaKey],
    caption: caption ?? undefined,
  };

  switch (mediaKey) {
    case "image":
    case "video":
      return {
        content: {
          kind: mediaKey,
          ...base,
          fileName: undefined,
          voice: false,
          durationSeconds: undefined,
          animated: false,
        },
        mentions,
      };
    case "audio": {
      const voice = (content.audio as { voice?: boolean } | undefined)?.voice ?? false;
      return {
        content: {
          kind: "audio",
          ...base,
          fileName: undefined,
          voice,
          durationSeconds: undefined,
          animated: false,
        },
        mentions,
      };
    }
    case "document": {
      const fileName =
        (content.document as { fileName?: string } | undefined)?.fileName ?? "document";
      return {
        content: {
          kind: "document",
          ...base,
          fileName,
          voice: false,
          durationSeconds: undefined,
          animated: false,
        },
        mentions,
      };
    }
    case "sticker":
      return {
        content: {
          kind: "sticker",
          ...base,
          fileName: undefined,
          voice: false,
          durationSeconds: undefined,
          animated: false,
        },
        mentions,
      };
    default: {
      const exhaustive: never = mediaKey;
      throw new ValidationError(`Unsupported media kind: ${String(exhaustive)}`);
    }
  }
}
