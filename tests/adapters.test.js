import test from "node:test";
import assert from "node:assert/strict";

import { __resetGithubAdapterCache, githubAdapter } from "../src/adapters/github.js";
import { __resetGitlabAdapterCache, gitlabAdapter } from "../src/adapters/gitlab.js";

function createHeaders(values = {}) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    get(name) {
      return normalized.get(String(name).toLowerCase()) || null;
    }
  };
}

function createJsonResponse(data, headers = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: createHeaders(headers),
    async json() {
      return data;
    }
  };
}

test("github snapshot reuses cached pull details when updated_at is unchanged", async () => {
  __resetGithubAdapterCache();

  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url.includes("/pulls?state=open")) {
      return createJsonResponse(
        [
          {
            number: 7,
            state: "open",
            title: "Ship less",
            created_at: "2026-06-10T00:00:00Z",
            updated_at: "2026-06-11T00:00:00Z",
            merged_at: null,
            draft: false,
            user: { login: "author" },
            requested_reviewers: []
          }
        ],
        { link: "" }
      );
    }

    if (url.includes("/pulls?state=closed")) {
      return createJsonResponse([], { link: "" });
    }

    if (url.includes("/pulls/7/reviews")) {
      return createJsonResponse([]);
    }

    if (url.includes("/pulls/7/comments")) {
      return createJsonResponse([]);
    }

    if (url.includes("/issues/7/comments")) {
      return createJsonResponse([]);
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await githubAdapter.fetchRepoSnapshot("owner/repo", "token", 14);
    const firstDetailCalls = calls.filter(
      (url) =>
        url.includes("/pulls/7/reviews") || url.includes("/pulls/7/comments") || url.includes("/issues/7/comments")
    ).length;
    assert.equal(firstDetailCalls, 3);

    await githubAdapter.fetchRepoSnapshot("owner/repo", "token", 14);
    const totalDetailCalls = calls.filter(
      (url) =>
        url.includes("/pulls/7/reviews") || url.includes("/pulls/7/comments") || url.includes("/issues/7/comments")
    ).length;
    assert.equal(totalDetailCalls, 3);
    assert.equal(calls.filter((url) => url.includes("/pulls?state=open")).length, 2);
    assert.equal(calls.filter((url) => url.includes("/pulls?state=closed")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGithubAdapterCache();
  }
});

test("github snapshot fetches only merged pull approvals", async () => {
  __resetGithubAdapterCache();

  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url.includes("/pulls?state=open")) {
      return createJsonResponse([], { link: "" });
    }

    if (url.includes("/pulls?state=closed")) {
      return createJsonResponse(
        [
          {
            number: 9,
            state: "closed",
            title: "Merge me",
            created_at: "2026-06-10T00:00:00Z",
            updated_at: "2026-06-11T00:00:00Z",
            merged_at: "2026-06-11T02:00:00Z",
            draft: false,
            user: { login: "author" },
            requested_reviewers: []
          }
        ],
        { link: "" }
      );
    }

    if (url.includes("/pulls/9/reviews")) {
      return createJsonResponse([{ state: "APPROVED", submitted_at: "2026-06-11T01:00:00Z", user: { login: "lea" } }], {
        link: ""
      });
    }

    if (url.includes("/pulls/9/comments") || url.includes("/issues/9/comments")) {
      throw new Error(`Merged comment endpoint should not be called: ${url}`);
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const snapshot = await githubAdapter.fetchRepoSnapshot("owner/repo", "token", 14);
    assert.equal(snapshot.mergedPulls.length, 1);
    assert.equal(snapshot.mergedPulls[0].hasDetailData, false);
    assert.equal(snapshot.mergedPulls[0].reviews.length, 1);
    assert.equal(calls.filter((url) => url.includes("/pulls/9/reviews")).length, 1);
    assert.equal(
      calls.filter((url) => url.includes("/pulls/9/comments") || url.includes("/issues/9/comments")).length,
      0
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetGithubAdapterCache();
  }
});

test("gitlab snapshot re-fetches merge request details after an update", async () => {
  __resetGitlabAdapterCache();

  const originalFetch = globalThis.fetch;
  const calls = [];
  let openRequestCount = 0;

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url.includes("/merge_requests?state=opened")) {
      openRequestCount += 1;
      return createJsonResponse(
        [
          {
            id: 42,
            iid: 8,
            title: "Tighten polling",
            web_url: "https://gitlab.com/acme/repo/-/merge_requests/8",
            state: "opened",
            draft: false,
            created_at: "2026-06-10T00:00:00Z",
            updated_at: openRequestCount === 1 ? "2026-06-11T00:00:00Z" : "2026-06-12T00:00:00Z",
            merged_at: null,
            detailed_merge_status: "mergeable",
            author: { username: "author" },
            reviewers: []
          }
        ],
        { "x-next-page": "" }
      );
    }

    if (url.includes("/merge_requests?state=merged")) {
      return createJsonResponse([], { "x-next-page": "" });
    }

    if (url.includes("/merge_requests/8/notes")) {
      return createJsonResponse([], { "x-next-page": "" });
    }

    if (url.includes("/merge_requests/8/discussions")) {
      return createJsonResponse([], { "x-next-page": "" });
    }

    if (url.includes("/merge_requests/8/approvals")) {
      return createJsonResponse({ approved_by: [] });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await gitlabAdapter.fetchRepoSnapshot("gitlab.com/acme/repo", "token", 14);
    await gitlabAdapter.fetchRepoSnapshot("gitlab.com/acme/repo", "token", 14);

    assert.equal(calls.filter((url) => url.includes("/merge_requests/8/notes")).length, 2);
    assert.equal(calls.filter((url) => url.includes("/merge_requests/8/discussions")).length, 2);
    assert.equal(calls.filter((url) => url.includes("/merge_requests/8/approvals")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGitlabAdapterCache();
  }
});

test("gitlab snapshot fetches only merged request approvals", async () => {
  __resetGitlabAdapterCache();

  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url.includes("/merge_requests?state=opened")) {
      return createJsonResponse([], { "x-next-page": "" });
    }

    if (url.includes("/merge_requests?state=merged")) {
      return createJsonResponse(
        [
          {
            id: 42,
            iid: 8,
            title: "Tighten polling",
            web_url: "https://gitlab.com/acme/repo/-/merge_requests/8",
            state: "merged",
            draft: false,
            created_at: "2026-06-10T00:00:00Z",
            updated_at: "2026-06-11T00:00:00Z",
            merged_at: "2026-06-12T00:00:00Z",
            detailed_merge_status: "mergeable",
            author: { username: "author" },
            reviewers: []
          }
        ],
        { "x-next-page": "" }
      );
    }

    if (url.includes("/merge_requests/8/approvals")) {
      return createJsonResponse({ approved_by: [{ approved_at: "2026-06-11T01:00:00Z", user: { username: "lea" } }] });
    }

    if (url.includes("/merge_requests/8/notes") || url.includes("/merge_requests/8/discussions")) {
      throw new Error(`Merged comment endpoint should not be called: ${url}`);
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const snapshot = await gitlabAdapter.fetchRepoSnapshot("gitlab.com/acme/repo", "token", 14);
    assert.equal(snapshot.mergedPulls.length, 1);
    assert.equal(snapshot.mergedPulls[0].hasDetailData, false);
    assert.equal(snapshot.mergedPulls[0].reviews.length, 1);
    assert.equal(
      calls.filter(
        (url) =>
          url.includes("/merge_requests/8/approvals")
      ).length,
      1
    );
    assert.equal(
      calls.filter(
        (url) => url.includes("/merge_requests/8/notes") || url.includes("/merge_requests/8/discussions")
      ).length,
      0
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetGitlabAdapterCache();
  }
});
