export async function fetchGitHubSearch({ query, limit, token = "", userAgent = "github-feature-radar" }) {
  const repositories = [];
  let page = 1;

  while (repositories.length < limit) {
    const perPage = Math.min(100, limit - repositories.length);
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", query);
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));

    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": userAgent,
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(url, { headers });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`GitHub search failed (${response.status}): ${payload.message || "unknown error"}`);
    }

    repositories.push(...(payload.items || []));
    if ((payload.items || []).length < perPage) break;
    page += 1;
  }

  return repositories;
}

export async function fetchGitHubRepository({ fullName, token = "", userAgent = "github-feature-radar" }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": userAgent,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`GitHub repository fetch failed for ${fullName} (${response.status}): ${payload.message || "unknown error"}`);
  }
  return payload;
}
