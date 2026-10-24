import assert from "node:assert/strict";
import { test } from "node:test";
import { ModuleSignatureMismatch, resolveSemanticModuleIds } from "../client/host-source-bridge";

test("module ids resolve from signatures, and a missing signature throws the cacheable mismatch error", () => {
  const source = "__d(function(){alpha;beta},12,[]);__d(function(){gamma},13,[1]);";
  assert.deepEqual(resolveSemanticModuleIds(source, { first: ["alpha", "beta"], second: ["gamma"] }), { first: 12, second: 13 });
  assert.throws(() => resolveSemanticModuleIds(source, { gone: ["zzz"] }), ModuleSignatureMismatch);
  assert.throws(() => resolveSemanticModuleIds(source + source, { first: ["alpha"] }), ModuleSignatureMismatch);
});
