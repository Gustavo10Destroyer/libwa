import { describe, expect, it, vi } from "vitest";
import type { Interaction } from "../src/interactions/Interaction.js";
import type { Middleware } from "../src/middleware/compose.js";
import { runMiddlewareChain } from "../src/middleware/compose.js";

const interaction = {} as Interaction;

describe("runMiddlewareChain", () => {
  it("runs middlewares in order around the final dispatch", async () => {
    const order: string[] = [];
    const middlewares: Middleware[] = [
      async (_interaction, next) => {
        order.push("a:before");
        await next();
        order.push("a:after");
      },
      async (_interaction, next) => {
        order.push("b:before");
        await next();
        order.push("b:after");
      },
    ];
    await runMiddlewareChain(middlewares, interaction, async () => {
      order.push("dispatch");
    });
    expect(order).toEqual(["a:before", "b:before", "dispatch", "b:after", "a:after"]);
  });

  it("stops dispatch when a middleware skips next()", async () => {
    const dispatch = vi.fn();
    const middlewares: Middleware[] = [
      () => {
        // Intentionally does not call next().
      },
    ];
    await runMiddlewareChain(middlewares, interaction, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects when a middleware calls next() twice", async () => {
    const middlewares: Middleware[] = [
      async (_interaction, next) => {
        await next();
        await next();
      },
    ];
    await expect(
      runMiddlewareChain(middlewares, interaction, async () => undefined),
    ).rejects.toThrow("next() called multiple times");
  });

  it("rejects when a middleware throws", async () => {
    const middlewares: Middleware[] = [
      () => {
        throw new Error("mw boom");
      },
    ];
    await expect(
      runMiddlewareChain(middlewares, interaction, async () => undefined),
    ).rejects.toThrow("mw boom");
  });

  it("passes the interaction through to each middleware", async () => {
    const seen: Interaction[] = [];
    const middlewares: Middleware[] = [
      async (received, next) => {
        seen.push(received);
        await next();
      },
    ];
    const marker = { marker: true } as unknown as Interaction;
    await runMiddlewareChain(middlewares, marker, async () => undefined);
    expect(seen).toEqual([marker]);
  });
});
