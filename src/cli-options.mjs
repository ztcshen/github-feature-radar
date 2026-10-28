import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultPolicy } from "./feature-radar.mjs";

export class CliUsageError extends Error {}
const COMMANDS = {
  refresh: ["features", "out", "index", "markdown", "no-markdown", "fixture", "limit", "min-stars", "months", "token-env", "seed-only", "no-index", "strict-search"],
  lookup: ["out", "index", "feature", "limit", "no-index"],
  features: ["out"],
  terms: ["index", "filter", "limit"],
  suggest: ["index", "query", "feature", "limit"],
  search: ["index", "query", "feature", "limit", "min-references"],
  audit: ["out"],
  coverage: ["out", "limit", "min-references"],
  status: ["out", "limit", "min-references", "max-age-hours"],
  index: ["out", "index"],
};
const BOOLEANS = new Set(["no-markdown", "no-index", "seed-only", "strict-search"]);

export function parseCliOptions(argv, { root, cwd = process.cwd() }) {
  if (!argv.length || ["help", "--help", "-h"].includes(argv[0])) {
    if (argv.length > 1) throw new CliUsageError("help does not accept extra arguments");
    return { command: "help" };
  }
  if (["--version", "-v"].includes(argv[0])) {
    if (argv.length > 1) throw new CliUsageError("--version does not accept extra arguments");
    return { command: "version" };
  }
  const [command, ...args] = argv;
  if (!Object.hasOwn(COMMANDS, command)) throw new CliUsageError(`Unknown command: ${command}. Use --help.`);
  const definitions = Object.fromEntries([...COMMANDS[command], "data-dir"].map(name => [name, { type: BOOLEANS.has(name) ? "boolean" : "string" }]));
  definitions.help = { type: "boolean", short: "h" };
  let parsed;
  try { parsed = parseArgs({ args, options: definitions, allowPositionals: false, strict: true, tokens: true }); }
  catch (error) { throw new CliUsageError(error.message); }
  const { values } = parsed;
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new CliUsageError(`Duplicate option --${token.name}`);
    seen.add(token.name);
    if (typeof token.value === "string" && !token.value.trim()) throw new CliUsageError(`--${token.name} requires a non-empty value`);
  }
  if (values.help) return { command: "help" };
  for (const [first, second] of [["no-markdown", "markdown"], ["no-index", "index"], ["query", "feature"]]) {
    if (seen.has(first) && seen.has(second)) throw new CliUsageError(`Use either --${first} or --${second}`);
  }
  const number = (name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER, integer = true } = {}) => {
    if (values[name] === undefined) return fallback;
    const value = Number(values[name]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
      throw new CliUsageError(`--${name} must be ${integer ? "an integer" : "a finite number"} between ${min} and ${max}`);
    }
    return value;
  };
  const dataDir = values["data-dir"] ? resolve(cwd, values["data-dir"]) : resolve(root, "data");
  const path = (option, fallback) => values[option] ? resolve(cwd, values[option]) : fallback;
  const options = {
    command,
    featuresPath: path("features", resolve(root, "data/features.json")),
    jsonPath: path("out", resolve(dataDir, "feature-radar.json")),
    indexPath: path("index", resolve(dataDir, "feature-index.json")),
    markdownPath: values["no-markdown"] ? "" : path("markdown", resolve(dataDir, "feature-radar.md")),
    fixturePath: values.fixture ? resolve(cwd, values.fixture) : undefined,
    featureQuery: values.feature, query: values.query, filter: values.filter,
    limit: number("limit", 12, { max: 1000 }),
    minStars: number("min-stars", defaultPolicy.minStars, { min: 0 }),
    months: number("months", defaultPolicy.months, { max: 120 }),
    minReferences: number("min-references", 3),
    maxAgeHours: number("max-age-hours", 72, { min: Number.MIN_VALUE, integer: false }),
    tokenEnv: values["token-env"] || "GITHUB_TOKEN",
    seedOnly: Boolean(values["seed-only"]), noIndex: Boolean(values["no-index"]), strictSearch: Boolean(values["strict-search"]),
  };
  if (command === "lookup" && !options.featureQuery) throw new CliUsageError("lookup requires --feature");
  if (["suggest", "search"].includes(command) && !options.query && !options.featureQuery) throw new CliUsageError(`${command} requires --query (or --feature)`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.tokenEnv)) throw new CliUsageError("--token-env must name an environment variable");
  return options;
}

export const HELP = `GitHub Feature Radar

Usage: github-feature-radar <command> [options]

Commands:
  refresh    Fetch references and write the inventory (explicit opt-in)
  features   List maintained features
  lookup     Show references for --feature TEXT
  terms      Browse terms with optional --filter TEXT
  suggest    Suggest feature matches for --query TEXT
  search     Search feature coverage for --query TEXT
  audit      Check inventory policy compliance
  coverage   Check minimum reference coverage
  status     Check freshness, policy, and coverage
  index      Rebuild the search index from the inventory

Common options:
  --data-dir PATH       Keep inventory, Markdown, and index together
  --out PATH           Read/write a specific inventory JSON
  --index PATH         Use a specific search index
  --limit N            Limit results, 1..1000 (default 12)
  --min-references N   Required references per feature (default 3)
  --max-age-hours N    Inventory freshness threshold for status (default 72)

Refresh options:
  --features PATH      Custom feature definitions (defaults to bundled seeds)
  --fixture PATH       Build offline from search-result JSON
  --markdown PATH      Choose Markdown output; --no-markdown disables it
  --min-stars N        Minimum repository stars (default 3000)
  --months N           Activity window, 1..120 months (default 3)
  --token-env NAME     Authentication environment variable (default GITHUB_TOKEN)
  --seed-only         Refresh curated seeds without search
  --strict-search     Fail instead of reusing cached results
  --no-index          Skip index generation; lookup can also bypass the index

--help / -h and --version / -v never access GitHub or modify inventory.
No arguments show this help. Exit codes: 0 success, 1 failed gate/runtime error,
2 usage error. Explicit file paths override --data-dir regardless of argument order.
`;
