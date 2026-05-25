import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const defaultPolicy = {
  minStars: 3000,
  months: 3,
};

export const normalizeText = (value = "") => String(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

export const cleanText = (value = "") => String(value)
  .replace(/[^\x20-\x7E]/g, "")
  .replace(/\s+/g, " ")
  .trim();

const indexStopWords = new Set([
  "and",
  "are",
  "for",
  "from",
  "into",
  "that",
  "the",
  "then",
  "this",
  "turn",
  "with",
  "find",
]);

export function monthsBefore(date, months) {
  const copy = new Date(date.getTime());
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
}

export function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

export function buildFeatureQueries({ feature, minStars, pushedAfter }) {
  return (feature.searchTerms || []).map((term) => ({
    featureId: feature.id,
    term,
    query: `"${term}" stars:>=${minStars} pushed:>=${pushedAfter} archived:false fork:false`,
  }));
}

export function buildSeedSearchResults({ features, repositoriesByFullName }) {
  return features.flatMap((feature) => (feature.seedRepositories || []).map((fullName) => ({
    featureId: feature.id,
    term: `seed:${fullName}`,
    query: `seed repository ${fullName}`,
    repositories: repositoriesByFullName[fullName] ? [repositoriesByFullName[fullName]] : [],
  })));
}

export function buildPreviousFeatureSearchResult({ previousInventory, featureId, term, query }) {
  const feature = (previousInventory?.features || []).find((item) => item.id === featureId);
  return {
    featureId,
    term: `previous:${term}`,
    query: `previous cache for ${query}`,
    repositories: (feature?.matches || []).map(projectLedgerEntryToRepository),
  };
}

export function projectLedgerEntryToRepository(project) {
  return {
    full_name: project.fullName,
    name: project.name || project.fullName?.split("/").at(-1) || "",
    html_url: project.url,
    description: project.description || "",
    stargazers_count: project.stars || 0,
    forks_count: project.forks || 0,
    open_issues_count: project.openIssues || 0,
    pushed_at: project.pushedAt,
    updated_at: project.updatedAt,
    language: project.language || "",
    topics: project.topics || [],
    archived: false,
    fork: false,
    license: { spdx_id: project.license || "" },
    owner: { login: project.owner || project.fullName?.split("/").at(0) || "" },
  };
}

function isRecent(repository, pushedAfter) {
  return new Date(repository.pushed_at).getTime() >= new Date(`${pushedAfter}T00:00:00.000Z`).getTime();
}

function normalizeRepository(repository) {
  return {
    fullName: repository.full_name,
    name: repository.name || repository.full_name?.split("/").at(-1) || "",
    owner: repository.owner?.login || repository.full_name?.split("/").at(0) || "",
    url: repository.html_url,
    description: cleanText(repository.description),
    stars: repository.stargazers_count || 0,
    forks: repository.forks_count || 0,
    openIssues: repository.open_issues_count || 0,
    language: repository.language || "",
    topics: [...new Set(repository.topics || [])].sort(),
    license: repository.license?.spdx_id || "",
    pushedAt: repository.pushed_at,
    updatedAt: repository.updated_at,
  };
}

function scoreRepositoryForFeature(repository, feature, term) {
  const haystack = normalizeText([
    repository.full_name,
    repository.name,
    repository.description,
    ...(repository.topics || []),
  ].join(" "));
  const signals = [...(feature.signals || []), term].filter(Boolean);
  const reasons = [];
  let score = 0;

  for (const signal of signals) {
    const normalizedSignal = normalizeText(signal);
    if (!normalizedSignal) continue;
    if (haystack.includes(normalizedSignal)) {
      score += normalizedSignal.includes(" ") ? 2 : 1;
      reasons.push(`matches '${signal}'`);
    }
  }

  for (const topic of repository.topics || []) {
    const normalizedTopic = normalizeText(topic);
    if ((feature.signals || []).some((signal) => normalizeText(signal) === normalizedTopic)) {
      score += 2;
      reasons.push(`topic '${topic}'`);
    }
  }

  if (repository.stars >= 10000) {
    score += 1;
    reasons.push("high-star reference");
  }

  return { score, reasons: [...new Set(reasons)] };
}

function rejectReason(repository, minStars, pushedAfter) {
  if (repository.archived) return "archived";
  if (repository.fork) return "fork";
  if ((repository.stargazers_count || 0) < minStars) return "under_min_stars";
  if (!isRecent(repository, pushedAfter)) return "not_pushed_recently";
  return "";
}

function addProjectFeature(ledger, project, featureId) {
  const previous = ledger[project.fullName] || {
    ...project,
    matchedFeatures: [],
  };
  previous.matchedFeatures = [...new Set([...previous.matchedFeatures, featureId])].sort();
  ledger[project.fullName] = previous;
}

function findFeature(features, featureId) {
  const feature = features.find((item) => item.id === featureId);
  if (!feature) throw new Error(`Unknown feature id '${featureId}' in search results`);
  return feature;
}

function buildRefreshSummary(searchResults) {
  const cacheFeatures = [...new Set((searchResults || [])
    .filter((result) => String(result.term || "").startsWith("previous:"))
    .map((result) => result.featureId)
    .filter(Boolean))].sort();
  return {
    resultCount: (searchResults || []).length,
    seedResultCount: (searchResults || []).filter((result) => String(result.term || "").startsWith("seed:")).length,
    cacheResultCount: (searchResults || []).filter((result) => String(result.term || "").startsWith("previous:")).length,
    cacheFeatureCount: cacheFeatures.length,
    cacheFeatures,
  };
}

export function buildFeatureInventory({
  fetchedAt = new Date(),
  minStars = defaultPolicy.minStars,
  months = defaultPolicy.months,
  features = [],
  searchResults = [],
}) {
  const fetchedDate = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);
  const pushedAfter = dateOnly(monthsBefore(fetchedDate, months));
  const matchesByFeature = new Map(features.map((feature) => [feature.id, new Map()]));
  const rejected = [];
  const projectLedger = {};

  for (const result of searchResults) {
    const feature = findFeature(features, result.featureId);
    const featureMatches = matchesByFeature.get(feature.id);

    for (const repository of result.repositories || []) {
      const reason = rejectReason(repository, minStars, pushedAfter);
      if (reason) {
        rejected.push({ featureId: feature.id, fullName: repository.full_name || "", reason });
        continue;
      }

      const normalized = normalizeRepository(repository);
      const scored = scoreRepositoryForFeature(normalized, feature, result.term);
      if (scored.score < 2) {
        rejected.push({ featureId: feature.id, fullName: normalized.fullName, reason: "weak_feature_signal" });
        continue;
      }

      const existing = featureMatches.get(normalized.fullName);
      const merged = existing || {
        ...normalized,
        featureScore: 0,
        matchedTerms: [],
        reasons: [],
        sourceQueries: [],
      };
      merged.featureScore += scored.score;
      merged.matchedTerms = [...new Set([...merged.matchedTerms, result.term])].sort();
      merged.reasons = [...new Set([...merged.reasons, ...scored.reasons])].sort();
      merged.sourceQueries = [...new Set([...merged.sourceQueries, result.query])].sort();
      featureMatches.set(normalized.fullName, merged);
      addProjectFeature(projectLedger, normalized, feature.id);
    }
  }

  const featureRecords = features.map((feature) => ({
    id: feature.id,
    title: feature.title,
    intent: feature.intent,
    aliases: feature.aliases || [],
    searchTerms: feature.searchTerms || [],
    signals: feature.signals || [],
    matches: [...(matchesByFeature.get(feature.id)?.values() || [])].sort((left, right) => {
      if (right.featureScore !== left.featureScore) return right.featureScore - left.featureScore;
      if (right.stars !== left.stars) return right.stars - left.stars;
      return left.fullName.localeCompare(right.fullName);
    }),
  }));

  return {
    schemaVersion: 1,
    fetchedAt: fetchedDate.toISOString(),
    policy: {
      minStars,
      months,
      pushedAfter,
      qualifiers: [
        `stars >= ${minStars}`,
        `pushed_at >= ${pushedAfter}`,
        "archived == false",
        "fork == false",
      ],
    },
    features: featureRecords,
    rejected,
    projectLedger,
    refreshSummary: buildRefreshSummary(searchResults),
  };
}

export function findFeatureMatches(inventory, query) {
  const normalizedQuery = normalizeText(query);
  const scored = (inventory.features || []).map((feature) => {
    const fields = [
      feature.id,
      feature.title,
      feature.intent,
      ...(feature.aliases || []),
      ...(feature.searchTerms || []),
      ...(feature.signals || []),
    ].map(normalizeText);
    let score = 0;
    for (const field of fields) {
      if (field === normalizedQuery) score += 5;
      else if (field.includes(normalizedQuery) || normalizedQuery.includes(field)) score += 2;
      else {
        const queryTerms = normalizedQuery.split(" ").filter(Boolean);
        score += queryTerms.filter((term) => field.includes(term)).length;
      }
    }
    return { feature, score };
  }).sort((left, right) => right.score - left.score);

  if (!scored[0] || scored[0].score <= 0) {
    throw new Error(`No feature matches '${query}'`);
  }
  return scored[0].feature;
}

function tokenCandidates(feature) {
  return [
    feature.id,
    feature.title,
    feature.intent,
    ...(feature.aliases || []),
    ...(feature.searchTerms || []),
    ...(feature.signals || []),
  ].map(normalizeText).filter(Boolean);
}

export function buildFeatureSearchIndex(inventory, { topMatches = 5 } = {}) {
  const tokenIndex = {};
  const features = {};

  for (const feature of inventory.features || []) {
    const tokens = [...new Set(tokenCandidates(feature))].sort();
    features[feature.id] = {
      id: feature.id,
      title: feature.title,
      intent: feature.intent,
      aliases: feature.aliases || [],
      tokens,
      topMatches: (feature.matches || []).slice(0, topMatches).map((match) => ({
        fullName: match.fullName,
        url: match.url,
        stars: match.stars,
        pushedAt: match.pushedAt,
        featureScore: match.featureScore,
        reasons: match.reasons,
      })),
    };

    for (const token of tokens) {
      tokenIndex[token] ||= [];
      tokenIndex[token].push(feature.id);

      for (const part of token.split(" ").filter((value) => value.length >= 3 && !indexStopWords.has(value))) {
        tokenIndex[part] ||= [];
        tokenIndex[part].push(feature.id);
      }
    }
  }

  for (const token of Object.keys(tokenIndex)) {
    tokenIndex[token] = [...new Set(tokenIndex[token])].sort();
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: inventory.fetchedAt,
    policy: inventory.policy,
    tokenIndex,
    features,
    projectIndex: inventory.projectLedger || {},
    refreshSummary: inventory.refreshSummary || {},
  };
}

export function findFeatureInSearchIndex(index, query) {
  const normalizedQuery = normalizeText(query);
  const queryTerms = normalizedQuery.split(" ").filter(Boolean);
  const scores = new Map();

  for (const [token, featureIds] of Object.entries(index.tokenIndex || {})) {
    let score = 0;
    if (token === normalizedQuery) score = 8;
    else if (token.includes(normalizedQuery) || normalizedQuery.includes(token)) score = 4;
    else score = queryTerms.filter((term) => token.includes(term)).length;

    if (score <= 0) continue;
    for (const featureId of featureIds) {
      scores.set(featureId, (scores.get(featureId) || 0) + score);
    }
  }

  const [featureId] = [...scores.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  })[0] || [];

  if (!featureId) throw new Error(`No feature matches '${query}'`);
  return index.features[featureId];
}

function quoteCommandValue(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function displayToken(token) {
  return token.length >= 3 && token.length <= 48 && !token.startsWith("find ") && !indexStopWords.has(token);
}

function featureReferenceCount(feature) {
  return (feature?.topMatches || []).length;
}

function termFeatures(index, token, featureIds) {
  const features = [...new Set(featureIds || [])]
    .map((id) => index.features?.[id])
    .filter(Boolean)
    .map((feature) => ({
      id: feature.id,
      title: feature.title,
      references: featureReferenceCount(feature),
    }))
    .sort((left, right) => {
      if (right.references !== left.references) return right.references - left.references;
      return left.id.localeCompare(right.id);
    });
  return {
    term: token,
    featureCount: features.length,
    referenceCount: features.reduce((total, feature) => total + feature.references, 0),
    features,
    searchCommand: `github-feature-radar search --query ${quoteCommandValue(token)}`,
  };
}

export function buildFeatureTermsReport(index, { filter = "", limit = 20 } = {}) {
  const normalizedFilter = normalizeText(filter);
  const terms = Object.entries(index.tokenIndex || {})
    .map(([token, featureIds]) => [normalizeText(token), featureIds])
    .filter(([token]) => token && displayToken(token))
    .map(([token, featureIds]) => termFeatures(index, token, featureIds))
    .filter((item) => item.featureCount > 0)
    .filter((item) => {
      if (!normalizedFilter) return true;
      const haystack = normalizeText([
        item.term,
        ...item.features.flatMap((feature) => [feature.id, feature.title]),
      ].join(" "));
      return haystack.includes(normalizedFilter);
    })
    .sort((left, right) => {
      const leftDirect = normalizedFilter && normalizeText(left.term).includes(normalizedFilter);
      const rightDirect = normalizedFilter && normalizeText(right.term).includes(normalizedFilter);
      if (leftDirect !== rightDirect) return leftDirect ? -1 : 1;
      if (right.featureCount !== left.featureCount) return right.featureCount - left.featureCount;
      if (right.referenceCount !== left.referenceCount) return right.referenceCount - left.referenceCount;
      return left.term.localeCompare(right.term);
    })
    .slice(0, limit);
  return {
    ok: terms.length > 0,
    filter,
    count: terms.length,
    policy: index.policy,
    sourceGeneratedAt: index.sourceGeneratedAt,
    terms,
    nextCommands: terms.length > 0 ? [
      terms[0].searchCommand,
      `github-feature-radar lookup --feature ${quoteCommandValue(terms[0].features[0].id)}`,
    ] : ["github-feature-radar features"],
  };
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return limit;
}

function editDistanceWithin(left, right, limit) {
  if (limit <= 0) return left === right;
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return false;
    previous = current;
  }
  return previous[right.length] <= limit;
}

function editLimit(left, right) {
  const shorter = Math.min(left.length, right.length);
  if (shorter < 4) return 0;
  if (shorter <= 7) return 1;
  return 2;
}

function suggestionTermScore(queryTerm, tokenWords, tokenText, featureText) {
  let best = 0;
  if (tokenText.includes(queryTerm) || queryTerm.includes(tokenText)) best = Math.max(best, 40);
  for (const word of tokenWords) {
    if (word === queryTerm) best = Math.max(best, 50);
    else if (word.includes(queryTerm) || queryTerm.includes(word)) best = Math.max(best, 35);
    else if (editDistanceWithin(queryTerm, word, editLimit(queryTerm, word))) best = Math.max(best, 28);
    else if (commonPrefixLength(queryTerm, word) >= 3) best = Math.max(best, 16);
  }
  if (best === 0 && featureText.includes(queryTerm)) best = 10;
  return best;
}

function suggestionScore(item, normalizedQuery, queryTerms) {
  const tokenText = normalizeText(item.term);
  const tokenWords = tokenText.split(" ").filter(Boolean);
  const featureText = normalizeText(item.features.flatMap((feature) => [feature.id, feature.title]).join(" "));
  let score = 0;
  if (normalizedQuery === tokenText) score += 120;
  else if (normalizedQuery.includes(tokenText) || tokenText.includes(normalizedQuery)) score += 60;
  const matchedQueryTerms = [];
  for (const queryTerm of [...new Set(queryTerms)].sort()) {
    const termScore = suggestionTermScore(queryTerm, tokenWords, tokenText, featureText);
    if (termScore <= 0) continue;
    score += termScore;
    matchedQueryTerms.push(queryTerm);
  }
  if (score <= 0 && matchedQueryTerms.length === 0) return null;
  return {
    score: score + item.featureCount * 3 + item.referenceCount,
    matchedQueryTerms,
  };
}

function primaryFeature(suggestion) {
  return suggestion.features[0]?.id || "";
}

function diversifySuggestions(suggestions, limit) {
  const selected = [];
  const seenFeatures = new Set();
  for (const suggestion of suggestions) {
    const primary = primaryFeature(suggestion);
    if (primary && seenFeatures.has(primary)) continue;
    selected.push(suggestion);
    if (primary) seenFeatures.add(primary);
    if (selected.length >= limit) return selected;
  }
  for (const suggestion of suggestions) {
    if (selected.some((item) => item.term === suggestion.term)) continue;
    selected.push(suggestion);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function buildFeatureSuggestReport(index, { query = "", limit = 5 } = {}) {
  const normalizedQuery = normalizeText(query);
  const queryTerms = normalizedQuery.split(" ").filter(Boolean);
  const suggestions = Object.entries(index.tokenIndex || {})
    .map(([token, featureIds]) => [normalizeText(token), featureIds])
    .filter(([token]) => token && displayToken(token))
    .map(([token, featureIds]) => termFeatures(index, token, featureIds))
    .map((item) => {
      const scored = suggestionScore(item, normalizedQuery, queryTerms);
      return scored ? { ...item, ...scored } : null;
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.referenceCount !== left.referenceCount) return right.referenceCount - left.referenceCount;
      return left.term.localeCompare(right.term);
    });
  const limited = diversifySuggestions(suggestions, limit);
  return {
    ok: limited.length > 0,
    query,
    normalizedQuery,
    count: limited.length,
    policy: index.policy,
    sourceGeneratedAt: index.sourceGeneratedAt,
    suggestions: limited,
    nextCommands: limited.length > 0 ? [
      ...limited.slice(0, 3).map((item) => item.searchCommand),
      `github-feature-radar terms --filter ${quoteCommandValue(limited[0].term)} --limit 10`,
    ] : ["github-feature-radar terms --limit 20"],
  };
}

function tokenScore(token, normalizedQuery, queryTerms) {
  if (token === normalizedQuery) return 8;
  if (token.includes(normalizedQuery) || normalizedQuery.includes(token)) return 4;
  return queryTerms.filter((term) => token.includes(term)).length;
}

export function buildFeatureSearchReport(index, { query = "", limit = 5, minReferences = 3 } = {}) {
  const normalizedQuery = normalizeText(query);
  const queryTerms = normalizedQuery.split(" ").filter(Boolean);
  const scores = new Map();
  const matchedTokens = new Map();
  for (const [token, featureIds] of Object.entries(index.tokenIndex || {})) {
    const score = tokenScore(normalizeText(token), normalizedQuery, queryTerms);
    if (score <= 0) continue;
    for (const featureId of featureIds) {
      if (!index.features?.[featureId]) continue;
      scores.set(featureId, (scores.get(featureId) || 0) + score);
      const tokens = matchedTokens.get(featureId) || [];
      if (displayToken(token)) tokens.push(token);
      matchedTokens.set(featureId, tokens);
    }
  }
  const candidates = [...scores.entries()]
    .map(([featureId, score]) => {
      const feature = index.features[featureId];
      const references = featureReferenceCount(feature);
      return {
        id: feature.id,
        title: feature.title,
        intent: feature.intent,
        score,
        matchedTokens: [...new Set(matchedTokens.get(featureId) || [])].sort(),
        references,
        gate: references >= minReferences ? "passed" : "failed",
        topReferences: feature.topMatches || [],
        lookupCommand: `github-feature-radar lookup --feature ${quoteCommandValue(feature.id)}`,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.references !== left.references) return right.references - left.references;
      return left.id.localeCompare(right.id);
    })
    .slice(0, limit);
  return {
    ok: candidates.length > 0,
    query,
    normalizedQuery,
    count: candidates.length,
    policy: index.policy,
    sourceGeneratedAt: index.sourceGeneratedAt,
    candidates,
    nextCommands: candidates.length > 0 ? [
      `github-feature-radar lookup --feature ${quoteCommandValue(candidates[0].id)}`,
      `github-feature-radar suggest --query ${quoteCommandValue(query)} --limit 5`,
      "github-feature-radar coverage --min-references 3",
    ] : [
      `github-feature-radar suggest --query ${quoteCommandValue(query)} --limit 5`,
      "github-feature-radar terms --limit 20",
    ],
  };
}

export function auditFeatureInventory(inventory) {
  const violations = [];
  const minStars = inventory.policy?.minStars || defaultPolicy.minStars;
  const pushedAfter = inventory.policy?.pushedAfter;
  const cutoff = pushedAfter ? new Date(`${pushedAfter}T00:00:00.000Z`) : null;

  for (const feature of inventory.features || []) {
    if (!feature.matches || feature.matches.length === 0) {
      violations.push({ featureId: feature.id, reason: "empty_feature" });
      continue;
    }

    for (const match of feature.matches) {
      if ((match.stars || 0) < minStars) {
        violations.push({ featureId: feature.id, fullName: match.fullName, reason: "under_min_stars" });
      }
      if (cutoff && new Date(match.pushedAt) < cutoff) {
        violations.push({ featureId: feature.id, fullName: match.fullName, reason: "not_pushed_recently" });
      }
    }
  }

  return {
    ok: violations.length === 0,
    checkedAt: new Date().toISOString(),
    policy: inventory.policy,
    featureCount: (inventory.features || []).length,
    projectCount: Object.keys(inventory.projectLedger || {}).length,
    violations,
  };
}

export function buildFeatureCoverageReport(inventory, { minReferences = 3, topReferences = 3 } = {}) {
  const features = (inventory.features || []).map((feature) => {
    const matches = feature.matches || [];
    const passed = matches.length >= minReferences;
    return {
      id: feature.id,
      title: feature.title,
      intent: feature.intent,
      references: matches.length,
      gate: passed ? "passed" : "failed",
      topReferences: matches.slice(0, topReferences).map((match) => ({
        fullName: match.fullName,
        url: match.url,
        stars: match.stars,
        pushedAt: match.pushedAt,
        featureScore: match.featureScore,
      })),
    };
  });
  const passed = features.filter((feature) => feature.gate === "passed").length;
  const failed = features.length - passed;

  return {
    ok: failed === 0,
    checkedAt: new Date().toISOString(),
    policy: inventory.policy,
    referenceGate: {
      required: minReferences,
      passed,
      failed,
    },
    features,
  };
}

function inventoryGeneratedAt(inventory) {
  return inventory.fetchedAt || inventory.sourceGeneratedAt || inventory.generatedAt || "";
}

function countReferences(inventory) {
  return (inventory.features || []).reduce((total, feature) => total + (feature.matches || []).length, 0);
}

export function buildRadarStatusReport(inventory, {
  now = new Date(),
  maxAgeHours = 72,
  minReferences = 3,
  topReferences = 3,
} = {}) {
  const checkedAt = now instanceof Date ? now : new Date(now);
  const generatedAt = inventoryGeneratedAt(inventory);
  const generatedTime = generatedAt ? new Date(generatedAt) : null;
  const ageMs = generatedTime && !Number.isNaN(generatedTime.getTime())
    ? Math.max(0, checkedAt.getTime() - generatedTime.getTime())
    : Number.POSITIVE_INFINITY;
  const ageHours = Number.isFinite(ageMs) ? Math.floor(ageMs / (60 * 60 * 1000)) : null;
  const fresh = Number.isFinite(ageMs) && ageMs <= maxAgeHours * 60 * 60 * 1000;
  const audit = auditFeatureInventory(inventory);
  const coverage = buildFeatureCoverageReport(inventory, { minReferences, topReferences });
  const reasons = [];

  if (!fresh) {
    reasons.push(generatedAt
      ? `feature radar is older than ${maxAgeHours}h`
      : "feature radar is missing a generated timestamp");
  }
  if (!audit.ok) {
    reasons.push(`${audit.violations.length} policy violation(s)`);
  }
  if (!coverage.ok) {
    reasons.push(`${coverage.referenceGate.failed} feature(s) below ${minReferences} references`);
  }

  return {
    ok: fresh && audit.ok && coverage.ok,
    checkedAt: checkedAt.toISOString(),
    generatedAt,
    maxAgeHours,
    ageHours,
    policy: inventory.policy,
    gates: {
      fresh,
      audit: audit.ok,
      coverage: coverage.ok,
    },
    counts: {
      features: (inventory.features || []).length,
      references: countReferences(inventory),
      projects: Object.keys(inventory.projectLedger || {}).length,
      cachedResults: inventory.refreshSummary?.cacheResultCount || 0,
      cachedFeatures: inventory.refreshSummary?.cacheFeatureCount || 0,
    },
    audit: {
      violationCount: audit.violations.length,
      violations: audit.violations,
    },
    coverage: {
      referenceGate: coverage.referenceGate,
      failedFeatures: coverage.features.filter((feature) => feature.gate !== "passed"),
    },
    reasons,
  };
}

export function renderMarkdown(inventory) {
  const featureSections = (inventory.features || []).map((feature) => {
    const rows = feature.matches.map((match) => (
      `| [${match.fullName}](${match.url}) | ${match.featureScore} | ${match.stars} | ${match.pushedAt.slice(0, 10)} | ${match.matchedTerms.join(", ")} | ${match.reasons.join("; ")} |`
    ));
    return [
      `## ${feature.title}`,
      "",
      feature.intent,
      "",
      `Feature id: \`${feature.id}\``,
      "",
      "| Reference | Feature score | Stars | Last push | Matched terms | Evidence reasons |",
      "| --- | ---: | ---: | --- | --- | --- |",
      rows.join("\n") || "| _none_ | 0 | 0 | - | - | - |",
    ].join("\n");
  });

  return [
    "# Feature-First GitHub Radar",
    "",
    "This project is optimized for feature search, not generic project search.",
    "Each feature keeps its own GitHub queries, relevance signals, ranked references,",
    "and local evidence so AgentTestBench CLI work can start from mature OSS patterns.",
    "",
    `Generated at: ${inventory.fetchedAt}`,
    `Policy: stars >= ${inventory.policy.minStars}, pushed in the last ${inventory.policy.months} months, non-archived, non-fork.`,
    `Cutoff: ${inventory.policy.pushedAfter}`,
    "",
    ...featureSections,
    "",
    "## Secondary Project Ledger",
    "",
    "The project ledger is only a de-duplicated backing store. The primary lookup surface is feature id, alias, or feature text.",
    "",
  ].join("\n");
}

export async function writeFeatureInventory({ inventory, jsonPath, markdownPath, indexPath }) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(inventory, null, 2)}\n`);
  if (markdownPath) {
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, renderMarkdown(inventory));
  }
  if (indexPath) {
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, `${JSON.stringify(buildFeatureSearchIndex(inventory), null, 2)}\n`);
  }
}

export async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
