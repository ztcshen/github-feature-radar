import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("project exposes feature-first automation wiring", async () => {
  const [readme, features, workflow, pkg, cli] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("data/features.json", "utf8"),
    readFile(".github/workflows/refresh.yml", "utf8"),
    readFile("package.json", "utf8"),
    readFile("src/cli.mjs", "utf8"),
  ]);

  assert.match(readme, /feature question first/i);
  assert.match(readme, /npm run status/);
  assert.match(readme, /npm run coverage/);
  assert.match(features, /workflow-orchestration/);
  assert.match(features, /seedRepositories/);
  assert.match(workflow, /cron:/);
  assert.match(workflow, /npm run refresh/);
  assert.match(workflow, /npm run status/);
  assert.match(workflow, /npm run audit/);
  assert.match(workflow, /npm run coverage/);
  assert.match(workflow, /GITHUB_TOKEN/);
  assert.match(pkg, /"audit"/);
  assert.match(pkg, /"coverage"/);
  assert.match(pkg, /"index"/);
  assert.match(pkg, /"status"/);
  assert.match(cli, /buildPreviousFeatureSearchResult/);
  assert.match(cli, /buildRadarStatusReport/);
  assert.match(cli, /using previous feature cache/);
});
