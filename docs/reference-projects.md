# Reference Projects

This project is feature-first, but the crawler design is grounded in mature
open-source projects instead of starting from a blank slate.

## Borrowed Patterns

| Project | Current signal | Pattern reused here |
| --- | --- | --- |
| [EvanLi/Github-Ranking](https://github.com/EvanLi/Github-Ranking) | 11K+ stars, pushed on 2026-05-24 | Generate durable static rankings from GitHub metadata and refresh them automatically. |
| [star-history/star-history](https://github.com/star-history/star-history) | 9K+ stars, pushed on 2026-04-30 | Treat star growth and time windows as part of the evidence, not just total stars. |
| [gayanvoice/top-github-users](https://github.com/gayanvoice/top-github-users) | 4K+ stars, pushed on 2026-05-24 | Maintain generated JSON/Markdown indexes that are cheap to browse and diff. |

## Feature-First Rule

The primary lookup key is a feature such as `workflow report`,
`evidence tasks`, `case run`, or `quality gate`. Projects are secondary
evidence records. This keeps future AgentTestBench CLI design work from
degenerating into a generic project leaderboard.

The crawler uses GitHub repository search qualifiers compatible with GitHub
Search syntax:

- `stars:>=3000`
- `pushed:>=YYYY-MM-DD`
- `archived:false`
- `fork:false`

The generated inventory keeps the exact search query beside each match, so a
feature recommendation can be audited later.

## Local Search Surface

`data/feature-index.json` is the fast path for feature search. It stores
normalized feature ids, aliases, search terms, signals, top matches, and a
secondary project index. `lookup` reads that file first, so repeated
AgentTestBench CLI design sessions can search features without scanning the
larger inventory or calling GitHub.

`npm run audit` is the publish gate. It rejects empty features, projects under
the star threshold, and projects outside the configured activity window.
