#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchGitHubRepository, fetchGitHubSearch } from "./github-client.mjs";
import {
  auditFeatureInventory,
  buildFeatureCoverageReport,
  buildFeatureInventory,
  buildFeatureQueries,
  buildPreviousFeatureSearchResult,
  buildFeatureSearchReport,
  buildFeatureSuggestReport,
  buildFeatureTermsReport,
  buildSeedSearchResults,
  dateOnly,
  defaultPolicy,
  findFeatureInSearchIndex,
  findFeatureMatches,
  monthsBefore,
  projectLedgerEntryToRepository,
  readJSON,
  writeFeatureInventory,
  buildFeatureSearchIndex,
  buildRadarStatusReport,
} from "./feature-radar.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const defaultFeaturesPath = resolve(root, "data/features.json");
const defaultJsonPath = resolve(root, "data/feature-radar.json");
const defaultIndexPath = resolve(root, "data/feature-index.json");
const defaultMarkdownPath = resolve(root, "data/feature-radar.md");

function parseArgs(argv) {
  const options = {
    command: "refresh",
    featuresPath: defaultFeaturesPath,
    jsonPath: defaultJsonPath,
    indexPath: defaultIndexPath,
    markdownPath: defaultMarkdownPath,
    minStars: defaultPolicy.minStars,
    months: defaultPolicy.months,
    limit: 12,
    minReferences: 3,
    maxAgeHours: 72,
    tokenEnv: "GITHUB_TOKEN",
  };

  const args = [...argv];
  if (["refresh", "lookup", "features", "terms", "suggest", "search", "audit", "coverage", "status", "index"].includes(args[0])) options.command = args.shift();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => args[++index];
    if (arg === "--features") options.featuresPath = resolve(process.cwd(), next());
    else if (arg === "--out") options.jsonPath = resolve(process.cwd(), next());
    else if (arg === "--index") options.indexPath = resolve(process.cwd(), next());
    else if (arg === "--markdown") options.markdownPath = resolve(process.cwd(), next());
    else if (arg === "--no-markdown") options.markdownPath = "";
    else if (arg === "--fixture") options.fixturePath = resolve(process.cwd(), next());
    else if (arg === "--feature") options.featureQuery = next();
    else if (arg === "--query") options.query = next();
    else if (arg === "--filter") options.filter = next();
    else if (arg === "--limit") options.limit = Number(next());
    else if (arg === "--min-references") options.minReferences = Number(next());
    else if (arg === "--max-age-hours") options.maxAgeHours = Number(next());
    else if (arg === "--min-stars") options.minStars = Number(next());
    else if (arg === "--months") options.months = Number(next());
    else if (arg === "--token-env") options.tokenEnv = next();
    else if (arg === "--seed-only") options.seedOnly = true;
    else if (arg === "--no-index") options.noIndex = true;
    else if (arg === "--strict-search") options.strictSearch = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function loadFeatures(path) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  return Array.isArray(payload) ? payload : payload.features;
}

async function refresh(options) {
  const features = await loadFeatures(options.featuresPath);
  const fetchedAt = new Date();
  const pushedAfter = dateOnly(monthsBefore(fetchedAt, options.months));
  let searchResults;
  let previousInventory;

  try {
    previousInventory = await readJSON(options.jsonPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (options.fixturePath) {
    const fixture = await readJSON(options.fixturePath);
    searchResults = Array.isArray(fixture) ? fixture : fixture.searchResults;
  } else {
    const token = process.env[options.tokenEnv] || "";
    const seedNames = [...new Set(features.flatMap((feature) => feature.seedRepositories || []))].sort();
    const seedRepositories = {};
    for (const fullName of seedNames) {
      try {
        seedRepositories[fullName] = await fetchGitHubRepository({ fullName, token });
      } catch (error) {
        const previous = previousInventory?.projectLedger?.[fullName];
        if (!previous) {
          if (options.strictSearch) throw error;
          process.stderr.write(`warning: ${error.message}; no previous cache for ${fullName}\n`);
          continue;
        }
        process.stderr.write(`warning: ${error.message}; using previous cache for ${fullName}\n`);
        seedRepositories[fullName] = projectLedgerEntryToRepository(previous);
      }
    }
    const seedResults = buildSeedSearchResults({ features, repositoriesByFullName: seedRepositories });
    const queries = options.seedOnly ? [] : features.flatMap((feature) => buildFeatureQueries({
      feature,
      minStars: options.minStars,
      pushedAfter,
    }));
    const queryResults = [];
    const fallbackFeatureIds = new Set();
    for (const query of queries) {
      try {
        queryResults.push({
          ...query,
          repositories: await fetchGitHubSearch({ query: query.query, limit: options.limit, token }),
        });
      } catch (error) {
        if (options.strictSearch) throw error;
        const fallback = buildPreviousFeatureSearchResult({
          previousInventory,
          featureId: query.featureId,
          term: query.term,
          query: query.query,
        });
        if (fallback.repositories.length > 0 && !fallbackFeatureIds.has(query.featureId)) {
          fallbackFeatureIds.add(query.featureId);
          queryResults.push(fallback);
          process.stderr.write(`warning: ${error.message}; using previous feature cache for ${query.featureId}\n`);
        } else {
          process.stderr.write(`warning: ${error.message}; continuing with available seed results\n`);
        }
      }
    }
    searchResults = [...seedResults, ...queryResults];
  }

  const inventory = buildFeatureInventory({
    fetchedAt,
    minStars: options.minStars,
    months: options.months,
    features,
    searchResults,
  });
  await writeFeatureInventory({
    inventory,
    jsonPath: options.jsonPath,
    markdownPath: options.markdownPath,
    indexPath: options.noIndex ? "" : options.indexPath,
  });
  process.stdout.write(`Indexed ${inventory.features.length} features and ${Object.keys(inventory.projectLedger).length} projects into ${options.jsonPath}\n`);
}

async function lookup(options) {
  if (!options.featureQuery) throw new Error("lookup requires --feature");
  let feature;
  let matches;
  if (!options.noIndex) {
    try {
      const index = await readJSON(options.indexPath);
      feature = findFeatureInSearchIndex(index, options.featureQuery);
      matches = feature.topMatches.slice(0, options.limit);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (!feature) {
    const inventory = await readJSON(options.jsonPath);
    feature = findFeatureMatches(inventory, options.featureQuery);
    matches = feature.matches.slice(0, options.limit);
  }
  process.stdout.write(`${JSON.stringify({ feature: { id: feature.id, title: feature.title, intent: feature.intent }, matches }, null, 2)}\n`);
}

async function listFeatures(options) {
  const inventory = await readJSON(options.jsonPath);
  const features = inventory.features.map((feature) => ({
    id: feature.id,
    title: feature.title,
    aliases: feature.aliases,
    matches: feature.matches.length,
  }));
  process.stdout.write(`${JSON.stringify({ features }, null, 2)}\n`);
}

async function terms(options) {
  const index = await readJSON(options.indexPath);
  const report = buildFeatureTermsReport(index, {
    filter: options.filter || "",
    limit: options.limit,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function suggest(options) {
  const query = options.query || options.featureQuery;
  if (!query) throw new Error("suggest requires --query");
  const index = await readJSON(options.indexPath);
  const report = buildFeatureSuggestReport(index, {
    query,
    limit: options.limit,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function search(options) {
  const query = options.query || options.featureQuery;
  if (!query) throw new Error("search requires --query");
  const index = await readJSON(options.indexPath);
  const report = buildFeatureSearchReport(index, {
    query,
    limit: options.limit,
    minReferences: options.minReferences,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function audit(options) {
  const inventory = await readJSON(options.jsonPath);
  const report = auditFeatureInventory(inventory);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function coverage(options) {
  const inventory = await readJSON(options.jsonPath);
  const report = buildFeatureCoverageReport(inventory, {
    minReferences: options.minReferences,
    topReferences: options.limit,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function status(options) {
  const inventory = await readJSON(options.jsonPath);
  const report = buildRadarStatusReport(inventory, {
    maxAgeHours: options.maxAgeHours,
    minReferences: options.minReferences,
    topReferences: options.limit,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function writeIndex(options) {
  const inventory = await readJSON(options.jsonPath);
  const index = buildFeatureSearchIndex(inventory);
  await import("node:fs/promises").then(({ mkdir, writeFile }) => (
    mkdir(dirname(options.indexPath), { recursive: true })
      .then(() => writeFile(options.indexPath, `${JSON.stringify(index, null, 2)}\n`))
  ));
  process.stdout.write(`Wrote feature index to ${options.indexPath}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "lookup") return lookup(options);
  if (options.command === "features") return listFeatures(options);
  if (options.command === "terms") return terms(options);
  if (options.command === "suggest") return suggest(options);
  if (options.command === "search") return search(options);
  if (options.command === "audit") return audit(options);
  if (options.command === "coverage") return coverage(options);
  if (options.command === "status") return status(options);
  if (options.command === "index") return writeIndex(options);
  return refresh(options);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
