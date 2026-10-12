import { buildRelay } from "./relay.ts";

// Binds to localhost by default. Exposing a relay publicly requires TLS in front of it and the
// open items in docs/security.md to be resolved first.
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

const app = await buildRelay({ logger: true });
await app.listen({ host, port });
