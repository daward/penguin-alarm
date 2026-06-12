const API_ROOT = "https://api.github.com";

function normalizeRepoName(value) {
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

    return `${parts[0]}/${parts[1]}`;
  }

  if (trimmed.startsWith("github.com/")) {
    const path = trimmed.slice("github.com/".length);
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error("GitHub repo must be in owner/repo format.");
    }

    return `${parts[0]}/${parts[1]}`;
  }

  const parts = trimmed.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("GitHub repo must be in owner/repo format.");
  }

  return `${parts[0]}/${parts[1]}`;
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

async function requestJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
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

async function paginate(url, token, pageLimit = 3) {
  const items = [];
  let nextUrl = url;
  let lastRateLimit = null;
  let pages = 0;

  while (nextUrl && pages < pageLimit) {
    const { data, rateLimit, links } = await requestJson(nextUrl, token);
    items.push(...data);
    lastRateLimit = rateLimit;
    nextUrl = links.next;
    pages += 1;
  }

  return { items, rateLimit: lastRateLimit };
}

async function fetchViewer(token) {
  const { data, rateLimit } = await requestJson(`${API_ROOT}/user`, token);
  return { profile: data, rateLimit };
}

async function fetchRepoSnapshot(repoName, token, daysBack) {
  const normalizedRepo = normalizeRepoName(repoName);
  const [openPulls, closedPulls] = await Promise.all([
    paginate(`${API_ROOT}/repos/${normalizedRepo}/pulls?state=open&sort=updated&direction=desc&per_page=30`, token, 2),
    paginate(`${API_ROOT}/repos/${normalizedRepo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`, token, 3)
  ]);

  const mergedSince = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const mergedPulls = closedPulls.items.filter((pull) => pull.merged_at && Date.parse(pull.merged_at) >= mergedSince);
  const candidatePulls = [...openPulls.items, ...mergedPulls];

  const detailResponses = await Promise.all(
    candidatePulls.map(async (pull) => {
      const [reviews, comments, issueComments] = await Promise.all([
        paginate(`${API_ROOT}/repos/${normalizedRepo}/pulls/${pull.number}/reviews?per_page=50`, token, 2),
        paginate(`${API_ROOT}/repos/${normalizedRepo}/pulls/${pull.number}/comments?per_page=50`, token, 2),
        paginate(`${API_ROOT}/repos/${normalizedRepo}/issues/${pull.number}/comments?per_page=50`, token, 2)
      ]);

      return {
        ...pull,
        repoName: normalizedRepo,
        reviews: reviews.items,
        reviewComments: comments.items,
        issueComments: issueComments.items
      };
    })
  );

  return {
    repo: normalizedRepo,
    openPulls: detailResponses.filter((pull) => pull.state === "open"),
    mergedPulls: detailResponses.filter((pull) => pull.merged_at),
    rateLimit: closedPulls.rateLimit || openPulls.rateLimit
  };
}

export const githubAdapter = {
  id: "github",
  label: "GitHub",
  tokenPlaceholder: "github_pat_...",
  docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  fetchViewer,
  fetchRepoSnapshot
};
