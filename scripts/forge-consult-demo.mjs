#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockAdapter } from "../packages/forge/src/index.ts";
import { Ledger } from "../packages/ledger/src/index.ts";
import { startServer } from "../apps/lpd/src/index.ts";

const home = await mkdtemp(path.join(os.tmpdir(), "lightphysics-forge-consult-"));
let ledger;
let server;

try {
  ledger = new Ledger({ home, now: () => "2026-01-01T00:00:00.000Z" });
  server = await startServer({
    port: 0,
    token: "forge-demo-token",
    ledger,
    forge: { adapters: [new MockAdapter()], ledger },
  });

  const response = await server.dispatcher.dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "forge.create",
    params: {
      capability: "image.generate",
      prompt: "a lighthouse island at dusk",
      fidelity: "sketch",
      seed: 42,
    },
    context: {
      session_id: "forge-demo-session",
      trace_id: "forge-demo-trace",
      idempotency_key: "forge-demo-create-1",
    },
  });

  if (!response || "error" in response) {
    throw new Error("forge.create consult failed");
  }

  const result = response.result;
  console.log(JSON.stringify({
    capability: "image.generate",
    status: result.status,
    artifacts: result.artifacts.map((artifact) => ({
      id: artifact.id,
      state: artifact.state,
      recipe_id: artifact.recipe_id,
      provenance_id: artifact.provenance_id,
    })),
    provenance: result.provenance,
    ledger: {
      records: ledger.listRecords().length,
      chain: ledger.verifyChain().status,
    },
  }));
} finally {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  ledger?.close();
  await rm(home, { recursive: true, force: true });
}
