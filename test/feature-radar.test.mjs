import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  auditFeatureInventory,
  buildFeatureCoverageReport,
  buildFeatureInventory,
  buildRadarStatusReport,
  buildFeatureSearchIndex,
  buildFeatureSearchReport,
  buildFeatureSuggestReport,
  buildFeatureTermsReport,
  buildFeatureQueries,
  buildPreviousFeatureSearchResult,
  buildSeedSearchResults,
  findFeatureInSearchIndex,
  findFeatureMatches,
  projectLedgerEntryToRepository,
  renderMarkdown,
  writeFeatureInventory,
} from "../src/feature-radar.mjs";

const now = new Date("2026-05-24T00:00:00.000Z");

const feature = {
  id: "evidence-diagnosis",
  title: "Evidence Diagnosis",
  intent: "Find projects that explain failed runs with logs, traces, reports, or root cause evidence.",
  searchTerms: ["evidence diagnosis", "trace failure report"],
  signals: ["evidence", "trace", "report", "root cause", "observability"],
};

const repo = (overrides) => ({
  full_name: "trace/observer",
  name: "observer",
  html_url: "https://github.com/trace/observer",
  description: "Observability CLI with trace failure reports and root cause evidence",
  stargazers_count: 8000,
  forks_count: 600,
  open_issues_count: 20,
  pushed_at: "2026-05-20T12:00:00Z",
  updated_at: "2026-05-21T12:00:00Z",
  language: "TypeScript",
  topics: ["observability", "cli", "trace"],
  archived: false,
  fork: false,
  license: { spdx_id: "Apache-2.0" },
  owner: { login: "trace" },
  ...overrides,
});

test("buildFeatureQueries starts from feature intent instead of project names", () => {
  const queries = buildFeatureQueries({
    feature,
    minStars: 3000,
    pushedAfter: "2026-02-24",
  });

  assert.deepEqual(queries, [
    {
      featureId: "evidence-diagnosis",
      term: "evidence diagnosis",
      query: "\"evidence diagnosis\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
    },
    {
      featureId: "evidence-diagnosis",
      term: "trace failure report",
      query: "\"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
    },
  ]);
});

test("buildSeedSearchResults lets curated mature projects bootstrap a feature", () => {
  const features = [
    {
      ...feature,
      seedRepositories: ["trace/observer"],
    },
  ];
  const searchResults = buildSeedSearchResults({
    features,
    repositoriesByFullName: {
      "trace/observer": repo(),
    },
  });

  assert.deepEqual(searchResults, [
    {
      featureId: "evidence-diagnosis",
      term: "seed:trace/observer",
      query: "seed repository trace/observer",
      repositories: [repo()],
    },
  ]);
});

test("projectLedgerEntryToRepository reuses the previous inventory when GitHub is rate-limited", () => {
  const previous = {
    fullName: "trace/observer",
    name: "observer",
    owner: "trace",
    url: "https://github.com/trace/observer",
    description: "Previous observability record",
    stars: 9000,
    forks: 700,
    openIssues: 10,
    language: "TypeScript",
    topics: ["observability", "trace"],
    license: "Apache-2.0",
    pushedAt: "2026-05-20T12:00:00Z",
    updatedAt: "2026-05-21T12:00:00Z",
  };

  assert.deepEqual(projectLedgerEntryToRepository(previous), {
    full_name: "trace/observer",
    name: "observer",
    html_url: "https://github.com/trace/observer",
    description: "Previous observability record",
    stargazers_count: 9000,
    forks_count: 700,
    open_issues_count: 10,
    pushed_at: "2026-05-20T12:00:00Z",
    updated_at: "2026-05-21T12:00:00Z",
    language: "TypeScript",
    topics: ["observability", "trace"],
    archived: false,
    fork: false,
    license: { spdx_id: "Apache-2.0" },
    owner: { login: "trace" },
  });
});

test("buildPreviousFeatureSearchResult preserves feature references when GitHub search is unavailable", () => {
  const previousInventory = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [feature],
    searchResults: [
      {
        featureId: "evidence-diagnosis",
        term: "trace failure report",
        query: "\"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [repo()],
      },
    ],
  });

  const fallback = buildPreviousFeatureSearchResult({
    previousInventory,
    featureId: "evidence-diagnosis",
    term: "trace failure report",
    query: "\"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
  });

  assert.equal(fallback.featureId, "evidence-diagnosis");
  assert.equal(fallback.term, "previous:trace failure report");
  assert.equal(fallback.query, "previous cache for \"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false");
  assert.equal(fallback.repositories[0].full_name, "trace/observer");
  assert.equal(fallback.repositories[0].stargazers_count, 8000);
  assert.equal(fallback.repositories[0].pushed_at, "2026-05-20T12:00:00Z");
});

test("buildFeatureInventory exposes previous-cache usage for refresh health checks", () => {
  const previousInventory = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [feature],
    searchResults: [
      {
        featureId: "evidence-diagnosis",
        term: "trace failure report",
        query: "\"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [repo()],
      },
    ],
  });
  const fallback = buildPreviousFeatureSearchResult({
    previousInventory,
    featureId: "evidence-diagnosis",
    term: "trace failure report",
    query: "\"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
  });

  const inventory = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [feature],
    searchResults: [fallback],
  });
  const index = buildFeatureSearchIndex(inventory);

  assert.equal(inventory.refreshSummary.resultCount, 1);
  assert.equal(inventory.refreshSummary.cacheResultCount, 1);
  assert.equal(inventory.refreshSummary.cacheFeatureCount, 1);
  assert.deepEqual(inventory.refreshSummary.cacheFeatures, ["evidence-diagnosis"]);
  assert.equal(index.refreshSummary.cacheResultCount, 1);
});

test("buildFeatureInventory ranks references inside feature records and keeps projects secondary", () => {
  const inventory = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [
      feature,
      {
        id: "workflow-runner",
        title: "Workflow Runner",
        intent: "Find projects that run automation workflows.",
        searchTerms: ["workflow automation"],
        signals: ["workflow", "automation", "runner"],
      },
    ],
    searchResults: [
      {
        featureId: "evidence-diagnosis",
        term: "evidence diagnosis",
        query: "\"evidence diagnosis\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [
          repo(),
          repo({
            full_name: "popular/unrelated",
            description: "A very popular UI component system",
            topics: ["design-system"],
            stargazers_count: 90000,
          }),
          repo({ full_name: "old/trace", pushed_at: "2025-12-01T00:00:00Z" }),
          repo({ full_name: "small/trace", stargazers_count: 1200 }),
        ],
      },
      {
        featureId: "workflow-runner",
        term: "workflow automation",
        query: "\"workflow automation\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [
          repo({
            full_name: "flow/runner",
            html_url: "https://github.com/flow/runner",
            description: "Workflow automation runner with CLI reports",
            topics: ["workflow", "automation", "cli"],
            stargazers_count: 12000,
          }),
          repo({
            full_name: "trace/observer",
            description: "Observability workflow report CLI",
            topics: ["observability", "workflow", "report"],
          }),
        ],
      },
    ],
  });

  assert.equal(inventory.policy.pushedAfter, "2026-02-24");
  assert.deepEqual(
    inventory.features.map((item) => item.id),
    ["evidence-diagnosis", "workflow-runner"],
  );
  assert.deepEqual(
    inventory.features[0].matches.map((match) => match.fullName),
    ["trace/observer"],
  );
  assert.equal(inventory.features[0].matches[0].featureScore >= 4, true);
  assert.match(inventory.features[0].matches[0].reasons.join(" "), /evidence/);
  assert.equal(inventory.projectLedger["trace/observer"].matchedFeatures.length, 2);
});

test("findFeatureMatches supports ids, aliases, and free-text feature search", () => {
  const inventory = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [
      {
        ...feature,
        aliases: ["root cause", "failure evidence"],
      },
    ],
    searchResults: [
      {
        featureId: "evidence-diagnosis",
        term: "trace failure report",
        query: "\"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [repo()],
      },
    ],
  });

  assert.equal(findFeatureMatches(inventory, "evidence-diagnosis").matches[0].fullName, "trace/observer");
  assert.equal(findFeatureMatches(inventory, "root cause").id, "evidence-diagnosis");
  assert.equal(findFeatureMatches(inventory, "failure report").id, "evidence-diagnosis");
});

test("buildFeatureSearchIndex creates a compact local lookup surface", () => {
  const inventory = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [
      {
        ...feature,
        aliases: ["root cause", "failure evidence"],
      },
    ],
    searchResults: [
      {
        featureId: "evidence-diagnosis",
        term: "trace failure report",
        query: "\"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [repo()],
      },
    ],
  });
  const index = buildFeatureSearchIndex(inventory);

  assert.equal(index.features["evidence-diagnosis"].topMatches[0].fullName, "trace/observer");
  assert.deepEqual(index.tokenIndex["root cause"], ["evidence-diagnosis"]);
  assert.deepEqual(index.tokenIndex.trace, ["evidence-diagnosis"]);
  assert.equal(index.tokenIndex.find, undefined);
  assert.equal(index.projectIndex["trace/observer"].matchedFeatures[0], "evidence-diagnosis");
});

test("feature search index routes performance queries to the radar-generation feature", async () => {
  const featureCatalog = JSON.parse(await readFile(new URL("../data/features.json", import.meta.url), "utf8"));
  const radarFeature = featureCatalog.features.find((item) => item.id === "github-radar-generation");
  const inventory = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [
      radarFeature,
      {
        ...feature,
        aliases: ["root cause", "failure evidence"],
      },
    ],
    searchResults: [
      {
        featureId: "github-radar-generation",
        term: "github ranking",
        query: "\"github ranking\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [
          repo({
            full_name: "radar/generator",
            html_url: "https://github.com/radar/generator",
            description: "GitHub metadata ranking generator with static indexes",
            topics: ["github", "ranking", "index"],
            stargazers_count: 15000,
          }),
        ],
      },
    ],
  });
  const index = buildFeatureSearchIndex(inventory);

  assert.equal(findFeatureInSearchIndex(index, "feature search performance").id, "github-radar-generation");
});

test("feature radar owns searchable terms, suggestions, and ranked feature search", () => {
  const inventory = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [
      {
        id: "quality-gates",
        title: "Quality Gates",
        intent: "Find projects that gate releases with policy checks.",
        searchTerms: ["release gate", "quality gate"],
        signals: ["gate", "release", "quality"],
      },
      {
        id: "workflow-orchestration",
        title: "Workflow Orchestration",
        intent: "Find projects that model workflow automation.",
        searchTerms: ["workflow runner"],
        signals: ["workflow", "runner"],
      },
    ],
    searchResults: [
      {
        featureId: "quality-gates",
        term: "release gate",
        query: "\"release gate\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [
          repo({
            full_name: "quality/gatekeeper",
            html_url: "https://github.com/quality/gatekeeper",
            description: "Release quality gate policy checks",
            topics: ["quality", "release", "gate"],
            stargazers_count: 12000,
          }),
        ],
      },
      {
        featureId: "workflow-orchestration",
        term: "workflow runner",
        query: "\"workflow runner\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [
          repo({
            full_name: "flow/runner",
            html_url: "https://github.com/flow/runner",
            description: "Workflow automation runner",
            topics: ["workflow", "runner"],
            stargazers_count: 14000,
          }),
        ],
      },
    ],
  });
  const index = buildFeatureSearchIndex(inventory);

  const terms = buildFeatureTermsReport(index, { filter: "gate", limit: 2 });
  assert.equal(terms.ok, true);
  assert.equal(terms.terms[0].term, "gate");
  assert.equal(terms.terms[0].features[0].id, "quality-gates");
  assert.match(terms.terms[0].searchCommand, /github-feature-radar search --query 'gate'/);

  const suggestions = buildFeatureSuggestReport(index, { query: "relese gatte wrkflow", limit: 2 });
  assert.equal(suggestions.ok, true);
  assert.deepEqual(suggestions.suggestions.map((item) => item.term), ["release gate", "workflow"]);
  assert.deepEqual(suggestions.suggestions[0].matchedQueryTerms, ["gatte", "relese"]);
  assert.match(suggestions.nextCommands.join("\n"), /github-feature-radar search --query 'release gate'/);

  const search = buildFeatureSearchReport(index, { query: "release gate", limit: 2, minReferences: 1 });
  assert.equal(search.ok, true);
  assert.equal(search.candidates[0].id, "quality-gates");
  assert.equal(search.candidates[0].gate, "passed");
  assert.match(search.nextCommands.join("\n"), /github-feature-radar lookup --feature 'quality-gates'/);
});

test("auditFeatureInventory proves policy compliance before publishing", () => {
  const good = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [feature],
    searchResults: [
      {
        featureId: "evidence-diagnosis",
        term: "trace failure report",
        query: "\"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [repo()],
      },
    ],
  });

  assert.deepEqual(auditFeatureInventory(good).violations, []);

  const bad = {
    ...good,
    features: [
      {
        ...good.features[0],
        matches: [
          { ...good.features[0].matches[0], stars: 2999 },
          { ...good.features[0].matches[0], fullName: "old/observer", pushedAt: "2025-12-01T00:00:00Z" },
        ],
      },
      {
        id: "empty-feature",
        title: "Empty Feature",
        matches: [],
      },
    ],
  };

  assert.deepEqual(
    auditFeatureInventory(bad).violations.map((violation) => violation.reason),
    ["under_min_stars", "not_pushed_recently", "empty_feature"],
  );
});

test("buildFeatureCoverageReport proves every feature has enough references", () => {
  const inventory = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [
      feature,
      {
        id: "workflow-runner",
        title: "Workflow Runner",
        intent: "Find projects that run automation workflows.",
        searchTerms: ["workflow automation"],
        signals: ["workflow", "automation", "runner"],
      },
    ],
    searchResults: [
      {
        featureId: "evidence-diagnosis",
        term: "trace failure report",
        query: "\"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [
          repo(),
          repo({
            full_name: "trace/inspector",
            html_url: "https://github.com/trace/inspector",
            description: "Trace evidence inspector",
            stargazers_count: 6200,
          }),
        ],
      },
      {
        featureId: "workflow-runner",
        term: "workflow automation",
        query: "\"workflow automation\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [
          repo({
            full_name: "flow/runner",
            html_url: "https://github.com/flow/runner",
            description: "Workflow automation runner with CLI reports",
            topics: ["workflow", "automation", "cli"],
            stargazers_count: 12000,
          }),
        ],
      },
    ],
  });

  const report = buildFeatureCoverageReport(inventory, { minReferences: 2 });

  assert.equal(report.ok, false);
  assert.deepEqual(report.referenceGate, { required: 2, passed: 1, failed: 1 });
  assert.deepEqual(
    report.features.map((item) => ({
      id: item.id,
      references: item.references,
      gate: item.gate,
      topReference: item.topReferences[0].fullName,
    })),
    [
      {
        id: "evidence-diagnosis",
        references: 2,
        gate: "passed",
        topReference: "trace/observer",
      },
      {
        id: "workflow-runner",
        references: 1,
        gate: "failed",
        topReference: "flow/runner",
      },
    ],
  );
  assert.equal(report.policy.minStars, 3000);
  assert.equal(report.features[0].topReferences[0].stars >= 3000, true);
});

test("buildRadarStatusReport summarizes freshness, audit, coverage, and cached refresh counts", () => {
  const inventory = buildFeatureInventory({
    fetchedAt: now,
    minStars: 3000,
    months: 3,
    features: [
      feature,
      {
        id: "workflow-runner",
        title: "Workflow Runner",
        intent: "Find projects that run automation workflows.",
        searchTerms: ["workflow automation"],
        signals: ["workflow", "automation", "runner"],
      },
    ],
    searchResults: [
      {
        featureId: "evidence-diagnosis",
        term: "trace failure report",
        query: "\"trace failure report\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
        repositories: [repo(), repo({ full_name: "trace/inspector", stargazers_count: 6200 })],
      },
      buildPreviousFeatureSearchResult({
        previousInventory: buildFeatureInventory({
          fetchedAt: now,
          minStars: 3000,
          months: 3,
          features: [{
            id: "workflow-runner",
            title: "Workflow Runner",
            intent: "Find projects that run automation workflows.",
            searchTerms: ["workflow automation"],
            signals: ["workflow", "automation", "runner"],
          }],
          searchResults: [{
            featureId: "workflow-runner",
            term: "workflow automation",
            query: "\"workflow automation\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
            repositories: [repo({
              full_name: "flow/runner",
              html_url: "https://github.com/flow/runner",
              description: "Workflow automation runner with CLI reports",
              topics: ["workflow", "automation", "cli"],
              stargazers_count: 12000,
            })],
          }],
        }),
        featureId: "workflow-runner",
        term: "workflow automation",
        query: "\"workflow automation\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
      }),
    ],
  });

  const report = buildRadarStatusReport(inventory, {
    now: new Date("2026-05-25T00:00:00.000Z"),
    maxAgeHours: 48,
    minReferences: 1,
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.gates, { fresh: true, audit: true, coverage: true });
  assert.equal(report.ageHours, 24);
  assert.deepEqual(report.counts, {
    features: 2,
    references: 3,
    projects: 3,
    cachedResults: 1,
    cachedFeatures: 1,
  });
  assert.equal(report.coverage.referenceGate.failed, 0);
  assert.deepEqual(report.reasons, []);

  const stale = buildRadarStatusReport(inventory, {
    now: new Date("2026-05-27T02:00:00.000Z"),
    maxAgeHours: 24,
    minReferences: 2,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.gates.fresh, false);
  assert.equal(stale.gates.coverage, false);
  assert.match(stale.reasons.join("\n"), /older than 24h/);
  assert.match(stale.reasons.join("\n"), /1 feature\(s\) below 2 references/);
});

test("writeFeatureInventory persists feature-first JSON and Markdown indexes", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "github-feature-radar-"));
  const jsonPath = join(tmp, "radar.json");
  const markdownPath = join(tmp, "radar.md");

  try {
    const inventory = buildFeatureInventory({
      fetchedAt: now,
      minStars: 3000,
      months: 3,
      features: [feature],
      searchResults: [
        {
          featureId: "evidence-diagnosis",
          term: "evidence diagnosis",
          query: "\"evidence diagnosis\" stars:>=3000 pushed:>=2026-02-24 archived:false fork:false",
          repositories: [repo()],
        },
      ],
    });

    await writeFeatureInventory({ inventory, jsonPath, markdownPath });

    const json = JSON.parse(await readFile(jsonPath, "utf8"));
    const markdown = await readFile(markdownPath, "utf8");
    assert.equal(json.features[0].id, "evidence-diagnosis");
    assert.match(markdown, /Feature-First GitHub Radar/);
    assert.match(markdown, /Evidence Diagnosis/);
    assert.match(markdown, /trace\/observer/);
    assert.match(renderMarkdown(inventory), /stars >= 3000/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
