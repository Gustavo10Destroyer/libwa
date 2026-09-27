import { describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "../src/events/TypedEventEmitter.js";

interface TestEvents {
  ping: [value: number];
  empty: [];
  async: [value: string];
}

describe("TypedEventEmitter", () => {
  it("delivers events to registered listeners", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener = vi.fn();
    emitter.on("ping", listener);
    emitter.emit("ping", 42);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(42);
  });

  it("supports unsubscribe functions from on()", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener = vi.fn();
    const off = emitter.on("ping", listener);
    off();
    emitter.emit("ping", 1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("fires once() listeners exactly once", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener = vi.fn();
    emitter.once("ping", listener);
    emitter.emit("ping", 1);
    emitter.emit("ping", 2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1);
  });

  it("removes specific listeners with off(event, listener)", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const first = vi.fn();
    const second = vi.fn();
    emitter.on("ping", first);
    emitter.on("ping", second);
    emitter.off("ping", first);
    emitter.emit("ping", 1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("removes all listeners of an event when called without a listener", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    emitter.on("ping", vi.fn());
    emitter.on("ping", vi.fn());
    emitter.off("ping");
    emitter.emit("ping", 1);
    expect(emitter.hasListeners("ping")).toBe(false);
  });

  it("reports listener presence", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    expect(emitter.hasListeners("ping")).toBe(false);
    const off = emitter.on("ping", () => undefined);
    expect(emitter.hasListeners("ping")).toBe(true);
    off();
    expect(emitter.hasListeners("ping")).toBe(false);
    emitter.once("ping", () => undefined);
    expect(emitter.hasListeners("ping")).toBe(true);
  });

  it("exposes a snapshot via listenersOf", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const first = vi.fn();
    const second = vi.fn();
    emitter.on("ping", first);
    emitter.once("ping", second);
    const listeners = emitter.listenersOf("ping");
    expect(listeners).toHaveLength(2);
    expect(listeners[0]).toBe(first);
    expect(listeners[1]).toBe(second);
  });

  it("clears everything with removeAllListeners()", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener = vi.fn();
    emitter.on("ping", listener);
    emitter.on("empty", listener);
    emitter.removeAllListeners();
    emitter.emit("ping", 1);
    emitter.emit("empty");
    expect(listener).not.toHaveBeenCalled();
  });

  it("routes synchronous listener throws to onListenerError", async () => {
    const onListenerError = vi.fn();
    const emitter = new TypedEventEmitter<TestEvents>({ onListenerError });
    emitter.on("ping", () => {
      throw new Error("sync boom");
    });
    emitter.emit("ping", 1);
    await vi.waitFor(() => expect(onListenerError).toHaveBeenCalledTimes(1));
    const [error, event] = onListenerError.mock.calls[0] ?? [];
    expect((error as Error).message).toBe("sync boom");
    expect(event).toBe("ping");
  });

  it("routes async listener rejections to onListenerError and keeps emitting", async () => {
    const onListenerError = vi.fn();
    const emitter = new TypedEventEmitter<TestEvents>({ onListenerError });
    const survivor = vi.fn();
    emitter.on("async", async () => {
      throw new Error("async boom");
    });
    emitter.on("async", survivor);
    await emitter.emitAsync("async", "hi");
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledWith("hi");
  });

  it("awaits async listeners in registration order with emitAsync", async () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const order: string[] = [];
    emitter.on("async", async () => {
      await Promise.resolve();
      order.push("first");
    });
    emitter.on("async", () => {
      order.push("second");
    });
    await emitter.emitAsync("async", "x");
    expect(order).toEqual(["first", "second"]);
  });
});
