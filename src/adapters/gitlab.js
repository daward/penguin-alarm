const viewerCache = new Map();
const detailCache = new Map();

function parseRepoTarget(value) {
  const input = String(value || "").trim();
  if (!input) {
    throw new Error("Repo path is empty.");
  }

  if (input.startsWith("http://") || input.startsWith("https://")) {
    const url = new URL(input);
    const repoPath = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    return {
      host: url.host,
      projectPath: repoPath,
      label: `${url.host}/${repoPath}`
    };
  }

  const withScheme = input.includes("/") && input.includes(".") && !input.startsWith("/") ? `https://${input}` : null;
  if (withScheme) {
    const url = new URL(withScheme);
    const repoPath = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (repoPath.includes("/")) {
      return {
        host: url.host,
        projectPath: repoPath,
        label: `${url.host}/${repoPath}`
      };
    }
  }

  return {
    host: "gitlab.com",
    projectPath: input.replace(/^\/+/, "").replace(/\/+$/, ""),
    label: input.replace(/^\/+/, "").replace(/\/+$/, "")
  };
}

function parseRateLimit(headers) {
  return {
    limit: Number(headers.get("ratelimit-limit") || headers.get("x-ratelimit-limit") || 0),
    remaining: Number(headers.get("ratelimit-remaining") || headers.get("x-ratelimit-remaining") || 0),
    resetAt: Number(headers.get("ratelimit-reset") || headers.get("x-ratelimit-reset") || 0)
  };
}

async function requestJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "PRIVATE-TOKEN": token
    }
  });

  const rateLimit = parseRateLimit(response.headers);
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload.message || payload.error || "";
    } catch {
      detail = response.statusText;
    }

    const error = new Error(detail || `GitLab request failed with ${response.status}`);
    error.status = response.status;
    error.rateLimit = rateLimit;
    throw error;
  }

  const nextPage = response.headers.get("x-next-page") || "";
  return {
    data: await response.json(),
    rateLimit,
    nextPage
  };
}

async function paginate(url, token, pageLimit = 3) {
  const items = [];
  let page = 1;
  let lastRateLimit = null;

  while (page <= pageLimit) {
    const separator = url.includes("?") ? "&" : "?";
    const { data, rateLimit, nextPage } = await requestJson(`${url}${separator}per_page=100&page=${page}`, token);
    items.push(...data);
    lastRateLimit = rateLimit;
    if (!nextPage) {
      break;
    }

    page = Number(nextPage);
    if (!Number.isFinite(page) || page <= 0) {
      break;
    }
  }

  return {
    items,
    rateLimit: lastRateLimit
  };
}

function toUser(user) {
  return {
    login: user?.username || user?.name || "unknown",
    avatar_url: user?.avatar_url || ""
  };
}

function toApprovalReviews(approvedBy = []) {
  return approvedBy.map((entry) => ({
    state: "APPROVED",
    submitted_at: entry?.approved_at || new Date().toISOString(),
    user: toUser(entry?.user)
  }));
}

function toCommentItems(notes = []) {
  return notes
    .filter((note) => !note.system)
    .map((note) => ({
      id: note.id,
      body: note.body,
      created_at: note.created_at,
      user: toUser(note.author)
    }));
}

function normalizeMergeRequest(mergeRequest, repoLabel, detail) {
  const noteComments = toCommentItems(detail.notes);
  const diffComments = toCommentItems(detail.discussionNotes);
  const approvalReviews = toApprovalReviews(detail.approvedBy);

  return {
    id: mergeRequest.id,
    number: mergeRequest.iid,
    title: mergeRequest.title,
    html_url: mergeRequest.web_url,
    state: mergeRequest.state === "opened" ? "open" : "closed",
    draft: Boolean(mergeRequest.draft || mergeRequest.work_in_progress),
    created_at: mergeRequest.created_at,
    merged_at: mergeRequest.merged_at,
    mergeable_state: /cannot_be_merged|broken_status/i.test(mergeRequest.detailed_merge_status || "")
      ? "blocked"
      : "clean",
    repoName: repoLabel,
    hasDetailData: true,
    user: toUser(mergeRequest.author),
    requested_reviewers: (mergeRequest.reviewers || []).map(toUser),
    reviews: approvalReviews,
    reviewComments: diffComments,
    issueComments: noteComments
  };
}

function normalizeMergeRequestSummary(mergeRequest, repoLabel) {
  return {
    id: mergeRequest.id,
    number: mergeRequest.iid,
    title: mergeRequest.title,
    html_url: mergeRequest.web_url,
    state: mergeRequest.state === "opened" ? "open" : "closed",
    draft: Boolean(mergeRequest.draft || mergeRequest.work_in_progress),
    created_at: mergeRequest.created_at,
    merged_at: mergeRequest.merged_at,
    mergeable_state: /cannot_be_merged|broken_status/i.test(mergeRequest.detailed_merge_status || "")
      ? "blocked"
      : "clean",
    repoName: repoLabel,
    hasDetailData: false,
    user: toUser(mergeRequest.author),
    requested_reviewers: (mergeRequest.reviewers || []).map(toUser),
    reviews: [],
    reviewComments: [],
    issueComments: []
  };
}

async function fetchMergeRequestDetails(apiRoot, projectPath, mergeRequestIid, token) {
  const projectId = encodeURIComponent(projectPath);
  const [notes, discussions, approvals] = await Promise.all([
    paginate(`${apiRoot}/projects/${projectId}/merge_requests/${mergeRequestIid}/notes?sort=desc`, token, 2),
    paginate(`${apiRoot}/projects/${projectId}/merge_requests/${mergeRequestIid}/discussions`, token, 2),
    requestJson(`${apiRoot}/projects/${projectId}/merge_requests/${mergeRequestIid}/approvals`, token)
  ]);

  const discussionNotes = discussions.items.flatMap((discussion) => discussion.notes || []).filter((note) => !note.system);

  return {
    notes: notes.items,
    discussionNotes,
    approvedBy: approvals.data.approved_by || []
  };
}

export async function fetchViewer(token, config) {
  const repo = config?.repos?.[0] || "gitlab.com/gitlab-org/gitlab";
  const target = parseRepoTarget(repo);
  const apiRoot = `https://${target.host}/api/v4`;
  const cacheKey = `${apiRoot}|${token}`;
  const cached = viewerCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const { data, rateLimit } = await requestJson(`${apiRoot}/user`, token);
  const result = {
    profile: {
      login: data.username,
      username: data.username,
      name: data.name,
      avatar_url: data.avatar_url
    },
    rateLimit
  };

  viewerCache.set(cacheKey, result);
  return result;
}

function buildDetailCacheKey(apiRoot, projectPath, mergeRequestIid) {
  return `${apiRoot}|${projectPath}|${mergeRequestIid}`;
}

function buildDetailCacheMarker(mergeRequest) {
  return [
    mergeRequest.updated_at,
    mergeRequest.state,
    mergeRequest.merged_at,
    mergeRequest.draft,
    mergeRequest.work_in_progress,
    mergeRequest.detailed_merge_status
  ].join("|");
}

async function fetchCachedMergeRequestDetails(apiRoot, projectPath, mergeRequest, token) {
  const cacheKey = buildDetailCacheKey(apiRoot, projectPath, mergeRequest.iid);
  const marker = buildDetailCacheMarker(mergeRequest);
  const cached = detailCache.get(cacheKey);

  if (cached?.marker === marker) {
    return cached.value;
  }

  const value = await fetchMergeRequestDetails(apiRoot, projectPath, mergeRequest.iid, token);
  detailCache.set(cacheKey, { marker, value });
  return value;
}

export async function fetchRepoSnapshot(repoName, token, daysBack) {
  const target = parseRepoTarget(repoName);
  const apiRoot = `https://${target.host}/api/v4`;
  const projectId = encodeURIComponent(target.projectPath);

  const [openMergeRequests, mergedMergeRequests] = await Promise.all([
    paginate(`${apiRoot}/projects/${projectId}/merge_requests?state=opened&order_by=updated_at&sort=desc`, token, 2),
    paginate(`${apiRoot}/projects/${projectId}/merge_requests?state=merged&order_by=updated_at&sort=desc`, token, 3)
  ]);

  const mergedSince = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const mergedRecent = mergedMergeRequests.items.filter(
    (mergeRequest) => mergeRequest.merged_at && Date.parse(mergeRequest.merged_at) >= mergedSince
  );

  const detailedOpenPulls = await Promise.all(
    openMergeRequests.items.map(async (mergeRequest) => {
      const detail = await fetchCachedMergeRequestDetails(apiRoot, target.projectPath, mergeRequest, token);
      return normalizeMergeRequest(mergeRequest, target.label, detail);
    })
  );
  const summarizedMergedPulls = mergedRecent.map((mergeRequest) => normalizeMergeRequestSummary(mergeRequest, target.label));

  return {
    repo: target.label,
    openPulls: detailedOpenPulls,
    mergedPulls: summarizedMergedPulls,
    rateLimit: mergedMergeRequests.rateLimit || openMergeRequests.rateLimit
  };
}

export function __resetGitlabAdapterCache() {
  viewerCache.clear();
  detailCache.clear();
}

export const gitlabAdapter = {
  id: "gitlab",
  label: "GitLab",
  tokenPlaceholder: "glpat-...",
  docsUrl: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
  fetchViewer,
  fetchRepoSnapshot
};
