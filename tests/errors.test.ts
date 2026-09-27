import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  BackendError,
  ConnectionError,
  MessageError,
  NotFoundError,
  PermissionError,
  UnsupportedOperationError,
  ValidationError,
  WhatsAppError,
  rethrowAsBackendError,
  toError,
} from "../src/errors/index.js";

describe("error hierarchy", () => {
  it("extends WhatsAppError with stable names and default codes", () => {
    const cases: readonly [WhatsAppError, string, string][] = [
      [new ConnectionError("x"), "ConnectionError", "ERR_CONNECTION"],
      [new AuthenticationError("x"), "AuthenticationError", "ERR_AUTHENTICATION"],
      [new MessageError("x"), "MessageError", "ERR_MESSAGE"],
      [new PermissionError("x"), "PermissionError", "ERR_PERMISSION"],
      [new NotFoundError("x"), "NotFoundError", "ERR_NOT_FOUND"],
      [new BackendError("x"), "BackendError", "ERR_BACKEND"],
      [new UnsupportedOperationError("x"), "UnsupportedOperationError", "ERR_UNSUPPORTED"],
      [new ValidationError("x"), "ValidationError", "ERR_VALIDATION"],
      [new WhatsAppError("x"), "WhatsAppError", "ERR_WHATSAPP"],
    ];
    for (const [error, name, code] of cases) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(WhatsAppError);
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error.message).toBe("x");
    }
  });

  it("honors explicit codes and preserves causes", () => {
    const cause = new Error("root");
    const error = new ValidationError("bad", { code: "ERR_CUSTOM", cause });
    expect(error.code).toBe("ERR_CUSTOM");
    expect(error.cause).toBe(cause);
  });

  it("allows subclasses to override their default code", () => {
    expect(new MessageError("x", { code: "ERR_OVERRIDDEN" }).code).toBe("ERR_OVERRIDDEN");
  });
});

describe("toError", () => {
  it("passes errors through", () => {
    const error = new ValidationError("bad");
    expect(toError(error)).toBe(error);
  });

  it("wraps non-error values", () => {
    const wrapped = toError("boom");
    expect(wrapped).toBeInstanceOf(WhatsAppError);
    expect(wrapped.message).toBe("boom");
    expect(wrapped.cause).toBe("boom");
  });
});

describe("rethrowAsBackendError", () => {
  it("preserves WhatsAppError instances unchanged", () => {
    const original = new NotFoundError("gone");
    expect(() => rethrowAsBackendError("op", original)).toThrow(original);
    try {
      rethrowAsBackendError("op", original);
    } catch (error) {
      expect(error).toBe(original);
    }
  });

  it("wraps provider errors as BackendError with cause", () => {
    const cause = new Error("provider exploded");
    try {
      rethrowAsBackendError("Failed to send", cause);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BackendError);
      const backendError = error as BackendError;
      expect(backendError.message).toBe("Failed to send: provider exploded");
      expect(backendError.cause).toBe(cause);
    }
  });

  it("wraps non-error values with String()", () => {
    try {
      rethrowAsBackendError("op", 42);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BackendError);
      expect((error as BackendError).message).toBe("op: 42");
    }
  });
});
