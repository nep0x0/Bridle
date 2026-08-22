/**
 * bridle M0 demo: two plugins composing through service injection +
 * reversible effects. Run with: node examples/demo.mjs (from packages/kernel,
 * after `pnpm build`).
 *
 *   provider plugin ──provides──> "greeter" service
 *   consumer plugin ──requires──> "greeter" service
 *
 * Unmounting the consumer unwinds ONLY its own registrations.
 */
import { Context } from "../dist/index.js";

const provider = {
  name: "provider",
  setup(ctx) {
    ctx.provide("greeter", {
      greet: (who) => `hello, ${who}!`,
    });
    ctx.emit("log", "provider mounted");
  },
};

const consumer = {
  name: "consumer",
  requires: ["greeter"],
  setup(ctx) {
    const greeter = ctx.requireService("greeter");
    ctx.effect(() => console.log("consumer disposed"));
    console.log(greeter.greet("world"));
  },
};

const ctx = new Context();
// The host application is itself just a plugin.
await ctx.mount({
  name: "host-logger",
  setup(sctx) {
    sctx.on("log", (m) => console.log("[log]", m));
  },
});
await ctx.mount(provider);
await ctx.mount(consumer);

console.log("mounted:", [...ctx.mounted].join(", "));
ctx.unmount("consumer");
console.log("after unmount:", [...ctx.mounted].join(", "));
