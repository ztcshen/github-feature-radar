# GitHub Feature Radar

Feature-first GitHub reference radar for AgentTestBench CLI capability research.

The goal is not to build another generic "top repositories" list. The goal is
to ask a feature question first, then return mature, active, high-star projects
that are useful references for that feature.

## Policy

- GitHub stars: `>= 3000`
- Activity window: pushed in the last 3 months
- Exclusions: archived repositories and forks
- Primary lookup: feature id, feature alias, or feature text
- Secondary store: de-duplicated project ledger

## Usage

```sh
npm test
npm run refresh
npm run refresh -- --seed-only
npm run features
npm run terms -- --filter "gate"
npm run suggest -- --query "relese gatte wrkflow"
npm run search -- --query "release gate" --min-references 3
npm run lookup -- --feature "workflow report" --limit 5
npm run audit
npm run coverage -- --min-references 3
npm run status -- --max-age-hours 72 --min-references 3
npm run index
```

Set `GITHUB_TOKEN` for higher rate limits:

```sh
GITHUB_TOKEN=ghp_xxx npm run refresh -- --limit 20
```

The default outputs are:

- `data/feature-radar.json`
- `data/feature-radar.md`
- `data/feature-index.json`

The JSON outputs include `refreshSummary`, which records total query result
records, seed records, previous-cache fallback records, and the feature ids
that used cached references during a best-effort refresh.

`--seed-only` refreshes the curated high-star references in `data/features.json`
without using GitHub repository search. It is useful when unauthenticated search
rate limits are exhausted; a normal refresh should be used with `GITHUB_TOKEN`
for broader discovery.

Normal `refresh` is best-effort by default: when GitHub repository search or
repository metadata calls hit rate limits, the CLI keeps moving with the
previous local ledger where possible. Seed repository metadata falls back by
project name; failed feature search queries fall back to the previous matches
for that feature so a transient GitHub search outage does not erase useful
references from the maintained list. Use `--strict-search` when CI should fail
instead of falling back.

`terms`, `suggest`, and `search` are the feature-search surface. They use
`data/feature-index.json` so callers can browse maintained terms, recover from
fuzzy or misspelled feature questions, and rank feature candidates before
looking at reference projects. `lookup` uses the same index first, so feature
searches do not need to scan the full inventory. Use `--no-index` to force a
full JSON lookup.

`audit` verifies every published match against the policy before the generated
inventory is used by AgentTestBench CLI design work.

`coverage` verifies every feature has enough qualifying references. The default
gate is `--min-references 3`, which means every feature should have at least
three active 3K+ star repositories before it is used as a design source.

`status` is the maintenance gate for automation. It summarizes inventory
freshness, audit status, coverage status, feature/reference/project counts, and
cached refresh usage in one JSON report, then exits non-zero when the radar is
stale or the maintained feature set is not covered by enough references.

## Automation

`.github/workflows/refresh.yml` runs tests, refreshes the feature inventory,
checks radar status, audits the generated matches, checks feature coverage,
writes the local search index, and commits changed `data/feature-radar.json`,
`data/feature-radar.md`, and `data/feature-index.json`. The workflow uses the
repository `GITHUB_TOKEN` and can also be triggered manually.

## Seed Features

Feature seeds live in `data/features.json`. They are intentionally phrased as
capability questions for AgentTestBench CLI work:

- `cli-command-ux`
- `api-test-runner`
- `workflow-orchestration`
- `evidence-diagnosis`
- `quality-gates`
- `github-radar-generation`

## Design References

See `docs/reference-projects.md`.
