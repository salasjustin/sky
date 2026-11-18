import { expect, test } from "vitest";
import {
  FIXTURE,
  FIXTURE_ROOT,
  FIXTURE_SCRATCH,
} from "./auto-approve.fixture.js";
import { autoApproveVerdict } from "./auto-approve.js";

const verdictOf = (command: string) =>
  autoApproveVerdict(
    command,
    { defaults: true, commands: [] },
    { root: FIXTURE_ROOT, scratch: FIXTURE_SCRATCH },
  );

test("the fixture is 30 commands that run and 30 that ask", () => {
  expect(FIXTURE).toHaveLength(60);
  expect(FIXTURE.filter((c) => c.verdict === "approved")).toHaveLength(30);
  expect(new Set(FIXTURE.map((c) => c.command)).size).toBe(60);
});

test.each(FIXTURE.map((c) => [c.command, c.verdict] as const))(
  "replays %j as %s",
  (command, verdict) => {
    expect(verdictOf(command)).toBe(verdict);
  },
);
