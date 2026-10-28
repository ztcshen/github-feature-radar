import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseCliOptions } from "../src/cli-options.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "src/cli.mjs");
function run(args, cwd) { return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 10000, env: { ...process.env, GITHUB_TOKEN: "" } }); }

test("help, version, and missing command are read-only from an unrelated directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feature-radar-help-"));
  try {
    for (const args of [[], ["--help"], ["-h"], ["help"], ["refresh", "--help"], ["--version"]]) {
      const child = run(args, directory);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stderr, "");
      assert.match(child.stdout, args.includes("--version") ? /^0\.2\.0\n$/ : /Usage: github-feature-radar/);
    }
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const args of [
  ["typo"], ["--seed-only"], ["refresh", "--fixture"], ["refresh", "--fixture", ""],
  ["refresh", "--limit", "NaN"], ["refresh", "--limit", "Infinity"], ["refresh", "--limit", "0"],
  ["refresh", "--limit", "1.5"], ["refresh", "--limit", "1001"], ["refresh", "--months=-1"],
  ["status", "--max-age-hours", "0"], ["coverage", "--min-references", "0"],
  ["refresh", "--limit", "1", "--limit", "2"], ["refresh", "--unknown"],
  ["lookup"], ["search"], ["features", "--strict-search"],
  ["refresh", "--no-markdown", "--markdown", "x.md"], ["lookup", "--feature", "x", "--index", "x.json", "--no-index"],
]) {
  test(`invalid arguments fail before data or network access: ${args.join(" ")}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "feature-radar-invalid-"));
    try {
      const child = run(args, directory);
      assert.equal(child.status, 2, child.stderr);
      assert.equal(child.stdout, "");
      assert(!child.stderr.includes("ENOENT"), child.stderr);
      assert.deepEqual(await readdir(directory), []);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("data-directory paths are coherent and explicit paths win in any argument order", () => {
  const context = { root: "/package", cwd: "/project" };
  const first = parseCliOptions(["refresh", "--data-dir", "cache", "--out", "custom.json"], context);
  const second = parseCliOptions(["refresh", "--out=custom.json", "--data-dir=cache"], context);
  assert.deepEqual(first, second);
  assert.equal(first.featuresPath, "/package/data/features.json");
  assert.equal(first.jsonPath, "/project/custom.json");
  assert.equal(first.indexPath, "/project/cache/feature-index.json");
  assert.equal(first.markdownPath, "/project/cache/feature-radar.md");
});

test("offline refresh, lookup, and status share a writable data directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feature-radar-offline-"));
  try {
    const feature = { id: "example", title: "Example", intent: "A fixture CLI", searchTerms: ["cli"], signals: ["cli"] };
    await writeFile(join(directory, "features.json"), JSON.stringify([feature]));
    const now = new Date().toISOString();
    const repository = { full_name: "example/cli", html_url: "https://github.com/example/cli", name: "cli", description: "Fixture CLI", stargazers_count: 4000, pushed_at: now, updated_at: now, archived: false, fork: false, owner: { login: "example" }, topics: ["cli"] };
    await writeFile(join(directory, "fixture.json"), JSON.stringify([{ featureId: "example", term: "cli", repositories: [repository] }]));
    const args = ["refresh", "--data-dir", "generated data", "--features", "features.json", "--fixture", "fixture.json"];
    const refresh = run(args, directory);assert.equal(refresh.status, 0, refresh.stderr);
    for (const filename of ["feature-radar.json", "feature-index.json", "feature-radar.md"]) assert((await readFile(join(directory, "generated data", filename))).length);
    const lookup = run(["lookup", "--data-dir", "generated data", "--feature", "example"], directory);
    assert.equal(lookup.status, 0, lookup.stderr);assert.equal(JSON.parse(lookup.stdout).matches[0].fullName, "example/cli");
    const status = run(["status", "--data-dir", "generated data", "--min-references", "1"], directory);
    assert.equal(status.status, 0, status.stderr);assert.equal(JSON.parse(status.stdout).ok, true);
    const failed = run(["status", "--data-dir", "generated data", "--min-references", "2"], directory);
    assert.equal(failed.status, 1);assert.equal(JSON.parse(failed.stdout).ok, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
