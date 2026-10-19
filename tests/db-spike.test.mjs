import assert from "node:assert/strict";
import test from "node:test";
import {
  SQLITE_VEC_VERSION,
  VECTOR_REASON_CODES,
  classifyVectorResult,
  nearestVector,
  runVectorProbe,
} from "../scripts/db-spike.mjs";

test("vector classification accepts the deterministic sqlite-vec KNN result", () => {
  const result = classifyVectorResult({
    version: SQLITE_VEC_VERSION,
    nearest: { id: "north", rowid: 1, distance: 0.141421377658844 },
  });
  assert.equal(result.status, "QUALIFIED");
  assert.equal(result.mode, "SQLITE_VEC");
  assert.equal(result.version, "v0.1.9");
  assert.equal(result.nearest, "north");
  assert.equal(result.nearest_rowid, "1");
  assert.ok(Math.abs(result.distance - Math.sqrt(0.02)) < 1e-6);
});

test("the deterministic fallback nearest-vector calculation remains north", () => {
  const result = nearestVector([
    { id: "north", values: [1, 0, 0] },
    { id: "east", values: [0, 1, 0] },
    { id: "up", values: [0, 0, 1] },
  ], [0.9, 0.1, 0]);
  assert.deepEqual(result, { id: "north", distance: 0.019999999999999997 });
});

test("an unavailable platform package is a visible unqualified fallback", async () => {
  const result = await runVectorProbe({}, {
    loadExtension: async () => ({
      ok: false,
      reason_code: VECTOR_REASON_CODES.PLATFORM_PACKAGE_UNAVAILABLE,
    }),
  });
  assert.equal(result.status, "UNQUALIFIED");
  assert.equal(result.mode, "FALLBACK");
  assert.equal(result.reason_code, "SQLITE_VEC_PLATFORM_PACKAGE_UNAVAILABLE");
  assert.equal(result.nearest, "north");
  assert.equal(result.distance, 0.019999999999999997);
  assert.equal(JSON.stringify(result).includes(process.cwd()), false);
});
