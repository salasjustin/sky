import {
  type Agent,
  BranchName,
  Environment,
  type RunStatus,
} from "@sky/shared";
import { expect, expectTypeOf, test } from "vitest";

test("resolves @sky/shared through its package exports", () => {
  expectTypeOf<Agent["branch"]>().toEqualTypeOf<`claude/agt_${string}`>();
  expectTypeOf<Agent["remoteBranch"]>().toEqualTypeOf<string | null>();
  expect(BranchName.safeParse("refs/heads/main").success).toBe(false);
  expectTypeOf<"waiting">().toExtend<RunStatus>();
  expect(Environment.shape.concurrency.parse(undefined)).toBe(3);
});
