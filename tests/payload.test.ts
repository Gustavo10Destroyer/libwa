import { describe, expect, it } from "vitest";
import { User } from "../src/entities/User.js";
import { ValidationError } from "../src/errors/index.js";
import { normalizeReplyContent } from "../src/messaging/payload.js";

describe("normalizeReplyContent", () => {
  it("converts plain strings into text content", () => {
    const normalized = normalizeReplyContent("hello");
    expect(normalized.content).toEqual({ kind: "text", text: "hello" });
    expect(normalized.mentions).toEqual([]);
  });

  it("rejects empty strings", () => {
    expect(() => normalizeReplyContent("")).toThrow(ValidationError);
    expect(() => normalizeReplyContent("")).toThrow(/empty string/);
  });

  it("rejects payloads without a body", () => {
    expect(() => normalizeReplyContent({})).toThrow(/needs a body/);
    expect(() => normalizeReplyContent({ caption: "orphan" })).toThrow(ValidationError);
  });

  it("rejects payloads with more than one body", () => {
    expect(() =>
      normalizeReplyContent({ text: "hi", location: { latitude: 1, longitude: 2 } }),
    ).toThrow(/exactly one body/);
  });

  it("rejects captions outside image/video/document", () => {
    expect(() => normalizeReplyContent({ text: "hi", caption: "cap" })).toThrow(
      /caption can only be used/,
    );
    expect(() => normalizeReplyContent({ audio: new Uint8Array([1]), caption: "cap" })).toThrow(
      /caption can only be used/,
    );
  });

  it("normalizes locations", () => {
    const normalized = normalizeReplyContent({ location: { latitude: -23.5, longitude: -46.6 } });
    expect(normalized.content).toEqual({
      kind: "location",
      latitude: -23.5,
      longitude: -46.6,
      address: undefined,
      name: undefined,
    });
  });

  it("applies default mimetypes for media", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const image = normalizeReplyContent({ image: bytes, caption: "cap" });
    expect(image.content).toMatchObject({
      kind: "image",
      mimetype: "image/jpeg",
      caption: "cap",
      voice: false,
      animated: false,
    });

    const audio = normalizeReplyContent({ audio: { data: bytes, voice: true } });
    expect(audio.content).toMatchObject({
      kind: "audio",
      mimetype: "audio/ogg; codecs=opus",
      voice: true,
    });

    const document = normalizeReplyContent({
      document: { data: bytes, fileName: "report.pdf" },
    });
    expect(document.content).toMatchObject({
      kind: "document",
      mimetype: "application/octet-stream",
      fileName: "report.pdf",
    });

    const sticker = normalizeReplyContent({ sticker: bytes });
    expect(sticker.content).toMatchObject({ kind: "sticker", mimetype: "image/webp" });

    const video = normalizeReplyContent({ video: bytes });
    expect(video.content).toMatchObject({ kind: "video", mimetype: "video/mp4" });
  });

  it("honors explicit mimetypes", () => {
    const normalized = normalizeReplyContent({
      image: { data: new Uint8Array([1]), mimetype: "image/png" },
    });
    expect(normalized.content).toMatchObject({ mimetype: "image/png" });
  });

  it("rejects empty media", () => {
    expect(() => normalizeReplyContent({ image: new Uint8Array(0) })).toThrow(/empty/);
  });

  it("collects and deduplicates mentions from payload and options", () => {
    const normalized = normalizeReplyContent(
      {
        text: "hi",
        mentions: ["111@s.whatsapp.net", new User({ id: "222@s.whatsapp.net" })],
      },
      { mentions: ["111@s.whatsapp.net", "333@s.whatsapp.net"] },
    );
    expect(normalized.mentions).toEqual([
      "111@s.whatsapp.net",
      "222@s.whatsapp.net",
      "333@s.whatsapp.net",
    ]);
  });
});
