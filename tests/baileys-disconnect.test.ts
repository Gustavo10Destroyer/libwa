import { describe, expect, it } from "vitest";
import {
  mapDisconnectError,
  providerStatusCode,
} from "../src/backend/baileys/BaileysDisconnect.js";
import { DisconnectReason } from "../src/core/DisconnectReason.js";

function boomError(statusCode: number): Error {
  const error = new Error(`boom ${statusCode}`);
  (error as Error & { output: { statusCode: number } }).output = { statusCode };
  return error;
}

describe("mapDisconnectError", () => {
  it("maps provider status codes to library reasons", () => {
    const cases: readonly [number, DisconnectReason][] = [
      [401, DisconnectReason.LoggedOut],
      [403, DisconnectReason.Forbidden],
      [408, DisconnectReason.ConnectionLost],
      [411, DisconnectReason.BadSession],
      [428, DisconnectReason.ConnectionClosed],
      [429, DisconnectReason.RateLimited],
      [440, DisconnectReason.ConnectionReplaced],
      [500, DisconnectReason.BadSession],
      [503, DisconnectReason.ServiceUnavailable],
      [515, DisconnectReason.RestartRequired],
    ];
    for (const [code, reason] of cases) {
      const mapped = mapDisconnectError(boomError(code));
      expect(mapped.reason, `code ${code}`).toBe(reason);
      expect(mapped.detail).toBe(`boom ${code}`);
    }
  });

  it("reads statusCode from the error itself", () => {
    const error = new Error("direct") as Error & { statusCode: number };
    error.statusCode = 401;
    expect(mapDisconnectError(error).reason).toBe(DisconnectReason.LoggedOut);
  });

  it("maps network errno failures to NetworkError", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"]) {
      const error = new Error(`network ${code}`) as Error & { code: string };
      error.code = code;
      expect(mapDisconnectError(error).reason, code).toBe(DisconnectReason.NetworkError);
    }
  });

  it("falls back to Unknown for unclassifiable errors", () => {
    expect(mapDisconnectError({ weird: true }).reason).toBe(DisconnectReason.Unknown);
    expect(mapDisconnectError(undefined).reason).toBe(DisconnectReason.Unknown);
    const plain = new Error("no code");
    expect(mapDisconnectError(plain).reason).toBe(DisconnectReason.Unknown);
    expect(mapDisconnectError(plain).detail).toBe("no code");
  });

  it("keeps string details", () => {
    const mapped = mapDisconnectError("connection dropped");
    expect(mapped.reason).toBe(DisconnectReason.Unknown);
    expect(mapped.detail).toBe("connection dropped");
  });

  it("ignores non-numeric status codes", () => {
    const error = new Error("weird") as Error & { statusCode: string };
    error.statusCode = "401";
    expect(providerStatusCode(error)).toBeUndefined();
  });
});

describe("providerStatusCode", () => {
  it("extracts output.statusCode and top-level statusCode", () => {
    expect(providerStatusCode(boomError(515))).toBe(515);
    const direct = new Error("x") as Error & { statusCode: number };
    direct.statusCode = 428;
    expect(providerStatusCode(direct)).toBe(428);
  });

  it("returns undefined for non-objects", () => {
    expect(providerStatusCode(null)).toBeUndefined();
    expect(providerStatusCode("401")).toBeUndefined();
    expect(providerStatusCode(new Error("no status"))).toBeUndefined();
  });
});
