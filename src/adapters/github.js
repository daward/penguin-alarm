const PUBLIC_API_ROOT = "https://api.github.com";
const viewerCache = new Map();
const detailCache = new Map();

function normalizeRepoTarget(value) {
  const input = String(value || "").trim();
  if (!input) {
    throw new Error("Repo path is empty.");
  }

  const trimmed = input.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error("GitHub repo must be in owner/repo format.");
    }

    return {
      repoName: `${parts[0]}/${parts[1]}`,
      host: url.host
    };
  }

  if (trimmed.startsWith("github.com/")) {
    const path = trimmed.slice("github.com/".length);
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error("GitHub repo must be in owner/repo format.");
    }

    return {
      repoName: `${parts[0]}/${parts[1]}`,
      host: "github.com"
    };
  }

  const parts = trimmed.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("GitHub repo must be in owner/repo format.");
  }

  if (parts[0].includes(".")) {
    return {
      host: parts[0],
      repoName: `${parts[1]}/${parts[2] || ""}`.replace(/\/$/, "")
    };
  }

  return {
    repoName: `${parts[0]}/${parts[1]}`,
    host: "github.com"
  };
}

function buildApiRoot(host) {
  if (!host || host === "github.com") {
    return PUBLIC_API_ROOT;
  }

  if (host === "api.github.com") {
    return PUBLIC_API_ROOT;
  }

  return `https://${host}/api/v3`;
}

function parseLinkHeader(value) {
  if (!value) {
    return {};
  }

  return value.split(",").reduce((links, part) => {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      links[match[2]] = match[1];
    }
    return links;
  }, {});
}

async function requestJson(url, token, apiVersionHeader = true) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      ...(apiVersionHeader ? { "X-GitHub-Api-Version": "2022-11-28" } : {})
    }
  });

  const rateLimit = {
    limit: Number(response.headers.get("x-ratelimit-limit") || 0),
    remaining: Number(response.headers.get("x-ratelimit-remaining") || 0),
    resetAt: Number(response.headers.get("x-ratelimit-reset") || 0)
  };

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload.message || "";
    } catch {
      detail = response.statusText;
    }

    const error = new Error(detail || `GitHub request failed with ${response.status}`);
    error.status = response.status;
    error.rateLimit = rateLimit;
    throw error;
  }

  return {
    data: await response.json(),
    rateLimit,
    links: parseLinkHeader(response.headers.get("link"))
  };
}

async function paginate(url, token, pageLimit = 3, apiVersionHeader = true) {
  const items = [];
  let nextUrl = url;
  let lastRateLimit = null;
  let pages = 0;

  while (nextUrl && pages < pageLimit) {
    const { data, rateLimit, links } = await requestJson(nextUrl, token, apiVersionHeader);
    items.push(...data);
    lastRateLimit = rateLimit;
    nextUrl = links.next;
    pages += 1;
  }

  return { items, rateLimit: lastRateLimit };
}

async function fetchViewer(token, config) {
  const target = normalizeRepoTarget(config?.repos?.[0] || "owner/repo");
  const apiRoot = buildApiRoot(target.host);
  const useApiVersionHeader = apiRoot === PUBLIC_API_ROOT;
  const cacheKey = `${apiRoot}|${token}`;
  const cached = viewerCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const { data, rateLimit } = await requestJson(`${apiRoot}/user`, token, useApiVersionHeader);
  const result = { profile: data, rateLimit };
  viewerCache.set(cacheKey, result);
  return result;
}

function buildDetailCacheKey(apiRoot, repoName, pullNumber) {
  return `${apiRoot}|${repoName}|${pullNumber}`;
}

function buildDetailCacheMarker(pull) {
  return [pull.updated_at, pull.state, pull.merged_at, pull.draft].join("|");
}

async function fetchPullReviews(apiRoot, repoName, pull, token, useApiVersionHeader) {
  const cacheKey = `${buildDetailCacheKey(apiRoot, repoName, pull.number)}|reviews-only`;
  const marker = buildDetailCacheMarker(pull);
  const cached = detailCache.get(cacheKey);

  if (cached?.marker === marker) {
    return cached.value;
  }

  const reviews = await paginate(
    `${apiRoot}/repos/${repoName}/pulls/${pull.number}/reviews?per_page=50`,
    token,
    2,
    useApiVersionHeader
  );

  const value = reviews.items;
  detailCache.set(cacheKey, { marker, value });
  return value;
}

async function fetchPullDetails(apiRoot, repoName, pull, token, useApiVersionHeader) {
  const cacheKey = buildDetailCacheKey(apiRoot, repoName, pull.number);
  const marker = buildDetailCacheMarker(pull);
  const cached = detailCache.get(cacheKey);

  if (cached?.marker === marker) {
    return cached.value;
  }

  const [reviews, comments, issueComments] = await Promise.all([
    paginate(`${apiRoot}/repos/${repoName}/pulls/${pull.number}/reviews?per_page=50`, token, 2, useApiVersionHeader),
    paginate(`${apiRoot}/repos/${repoName}/pulls/${pull.number}/comments?per_page=50`, token, 2, useApiVersionHeader),
    paginate(`${apiRoot}/repos/${repoName}/issues/${pull.number}/comments?per_page=50`, token, 2, useApiVersionHeader)
  ]);

  const value = {
    reviews: reviews.items,
    reviewComments: comments.items,
    issueComments: issueComments.items
  };

  detailCache.set(cacheKey, { marker, value });
  return value;
}

async function normalizePullSummary(apiRoot, repoName, pull, token, useApiVersionHeader) {
  const reviews = await fetchPullReviews(apiRoot, repoName, pull, token, useApiVersionHeader);
  return {
    ...pull,
    repoName,
    reviews,
    reviewComments: [],
    issueComments: [],
    hasDetailData: false
  };
}

async function fetchRepoSnapshot(repoName, token, daysBack) {
  const { repoName: normalizedRepo, host } = normalizeRepoTarget(repoName);
  const apiRoot = buildApiRoot(host);
  const useApiVersionHeader = apiRoot === PUBLIC_API_ROOT;
  const [openPulls, closedPulls] = await Promise.all([
    paginate(`${apiRoot}/repos/${normalizedRepo}/pulls?state=open&sort=updated&direction=desc&per_page=30`, token, 2, useApiVersionHeader),
    paginate(`${apiRoot}/repos/${normalizedRepo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`, token, 3, useApiVersionHeader)
  ]);

  const mergedSince = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const mergedPulls = closedPulls.items.filter((pull) => pull.merged_at && Date.parse(pull.merged_at) >= mergedSince);
  const detailedOpenPulls = await Promise.all(
    openPulls.items.map(async (pull) => {
      const details = await fetchPullDetails(apiRoot, normalizedRepo, pull, token, useApiVersionHeader);

      return {
        ...pull,
        repoName: normalizedRepo,
        hasDetailData: true,
        ...details
      };
    })
  );
  const summarizedMergedPulls = await Promise.all(
    mergedPulls.map((pull) => normalizePullSummary(apiRoot, normalizedRepo, pull, token, useApiVersionHeader))
  );

  return {
    repo: normalizedRepo,
    openPulls: detailedOpenPulls,
    mergedPulls: summarizedMergedPulls,
    rateLimit: closedPulls.rateLimit || openPulls.rateLimit
  };
}

export function __resetGithubAdapterCache() {
  viewerCache.clear();
  detailCache.clear();
}

export const githubAdapter = {
  id: "github",
  label: "GitHub",
  tokenPlaceholder: "github_pat_...",
  docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  fetchViewer,
  fetchRepoSnapshot
};
