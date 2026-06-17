import test from "node:test";
import assert from "node:assert/strict";

import { buildQueueItems, computeLeaderboard, computeStats } from "../src/metrics.js";

function makePull(overrides = {}) {
  return {
    created_at: "2026-06-01T00:00:00Z",
    merged_at: "2026-06-02T12:00:00Z",
    draft: false,
    user: { login: "author", avatar_url: "https://example.com/a.png" },
    requested_reviewers: [],
    reviews: [],
    reviewComments: [],
    issueComments: [],
    repoName: "acme/widget",
    ...overrides
  };
}

test("queue ranking prioritizes requested reviews over passive items", () => {
  const requested = makePull({
    requested_reviewers: [{ login: "sam" }]
  });
  const passive = makePull({
    created_at: "2026-06-10T00:00:00Z"
  });

  const items = buildQueueItems([passive, requested], "sam", "all");
  assert.equal(items[0].requested_reviewers[0].login, "sam");
  assert.equal(items[1].created_at, passive.created_at);
});

test("queue demotes pulls already approved by the viewer", () => {
  const waiting = makePull({
    created_at: "2026-06-10T00:00:00Z",
    requested_reviewers: [{ login: "sam" }]
  });
  const approved = makePull({
    created_at: "2026-06-01T00:00:00Z",
    requested_reviewers: [{ login: "sam" }],
    reviews: [{ state: "APPROVED", submitted_at: "2026-06-11T00:00:00Z", user: { login: "sam" } }]
  });

  const items = buildQueueItems([approved, waiting], "sam", "all");
  assert.equal(items[0].viewerApproved, false);
  assert.equal(items[1].viewerApproved, true);
});

test("queue marks own pull state for accent and approval indicators", () => {
  const ownPull = makePull({
    user: { login: "sam", avatar_url: "https://example.com/sam.png" },
    reviews: [{ state: "APPROVED", submitted_at: "2026-06-11T00:00:00Z", user: { login: "lea" } }]
  });

  const [item] = buildQueueItems([ownPull], "sam", "all");
  assert.equal(item.isOwnPull, true);
  assert.equal(item.viewerApproved, false);
  assert.equal(item.ownPullHasAnyApproval, true);
});

test("queue prioritizes own pull once it has an approval", () => {
  const staleGeneral = makePull({
    created_at: "2023-06-01T00:00:00Z",
    reviewComments: [{ user: { login: "lea" } }],
    issueComments: [{ user: { login: "mo" } }]
  });
  const ownApproved = makePull({
    created_at: "2026-06-10T00:00:00Z",
    user: { login: "sam", avatar_url: "https://example.com/sam.png" },
    reviews: [{ state: "APPROVED", submitted_at: "2026-06-11T00:00:00Z", user: { login: "lea" } }]
  });

  const items = buildQueueItems([staleGeneral, ownApproved], "sam", "all");
  assert.equal(items[0].isOwnPull, true);
  assert.equal(items[0].ownPullHasAnyApproval, true);
  assert.ok(items[0].queueScore > items[1].queueScore);
});

test("queue orders merge-now, needs-attention, then already-approved", () => {
  const mergeNow = makePull({
    created_at: "2026-06-10T00:00:00Z",
    user: { login: "sam", avatar_url: "https://example.com/sam.png" },
    reviews: [{ state: "APPROVED", submitted_at: "2026-06-11T00:00:00Z", user: { login: "lea" } }]
  });
  const needsAttention = makePull({
    created_at: "2026-06-09T00:00:00Z",
    requested_reviewers: [{ login: "sam" }]
  });
  const alreadyHandled = makePull({
    created_at: "2026-06-12T00:00:00Z",
    requested_reviewers: [{ login: "sam" }],
    reviews: [{ state: "APPROVED", submitted_at: "2026-06-13T00:00:00Z", user: { login: "sam" } }]
  });

  const items = buildQueueItems([needsAttention, alreadyHandled, mergeNow], "sam", "all");
  assert.equal(items[0].isOwnPull, true);
  assert.equal(items[0].ownPullHasAnyApproval, true);
  assert.equal(items[1].viewerApproved, false);
  assert.equal(items[1].isOwnPull, false);
  assert.equal(items[2].viewerApproved, true);
});

test("stats return medians, averages, and rates from pull lifecycle data", () => {
  const merged = [
    makePull({
      reviews: [{ state: "APPROVED", submitted_at: "2026-06-01T06:00:00Z", user: { login: "lea" } }]
    }),
    makePull({
      created_at: "2026-06-03T00:00:00Z",
      merged_at: "2026-06-05T00:00:00Z",
      reviews: [{ state: "COMMENTED", submitted_at: "2026-06-03T04:00:00Z", user: { login: "ben" } }],
      reviewComments: [{ user: { login: "ben" } }]
    })
  ];
  const open = [makePull({ merged_at: null })];

  const stats = computeStats(merged, open);
  assert.equal(stats.openPulls, 1);
  assert.equal(stats.mergedPulls, 2);
  assert.equal(stats.commentRate, 0.33);
  assert.equal(stats.medianTimeToFirstReview, 5);
  assert.equal(stats.averageTimeToFirstReview, 5);
  assert.equal(stats.medianTimeToApproval, 6);
  assert.equal(stats.averageTimeToApproval, 6);
  assert.equal(stats.medianTimeToMerge, 42);
  assert.equal(stats.averageTimeToMerge, 42);
});

test("average time stats differ from median when data is skewed", () => {
  const merged = [
    makePull({
      created_at: "2026-06-01T00:00:00Z",
      merged_at: "2026-06-01T02:00:00Z",
      reviews: [{ state: "COMMENTED", submitted_at: "2026-06-01T02:00:00Z", user: { login: "lea" } }]
    }),
    makePull({
      created_at: "2026-06-02T00:00:00Z",
      merged_at: "2026-06-02T04:00:00Z",
      reviews: [{ state: "APPROVED", submitted_at: "2026-06-02T04:00:00Z", user: { login: "ben" } }]
    }),
    makePull({
      created_at: "2026-06-03T00:00:00Z",
      merged_at: "2026-06-03T20:00:00Z",
      reviews: [{ state: "APPROVED", submitted_at: "2026-06-03T20:00:00Z", user: { login: "mo" } }]
    })
  ];

  const stats = computeStats(merged, []);
  assert.equal(stats.medianTimeToFirstReview, 4);
  assert.equal(stats.averageTimeToFirstReview, 8.67);
  assert.equal(stats.medianTimeToMerge, 4);
  assert.equal(stats.averageTimeToMerge, 8.67);
});

test("leaderboard combines approval and comment share", () => {
  const pulls = [
    makePull({
      reviews: [
        { state: "APPROVED", user: { login: "lea", avatar_url: "a" } },
        { state: "APPROVED", user: { login: "mo", avatar_url: "b" } }
      ],
      reviewComments: [{ user: { login: "lea", avatar_url: "a" } }],
      issueComments: [{ user: { login: "lea", avatar_url: "a" } }, { user: { login: "mo", avatar_url: "b" } }]
    })
  ];

  const board = computeLeaderboard(pulls);
  assert.equal(board[0].login, "lea");
  assert.equal(board[0].approvalShare, 0.5);
  assert.equal(board[0].commentShare, 0.667);
  assert.equal(board[0].score, 1.167);
  assert.equal(board[1].login, "mo");
});

test("stats ignore missing merged detail for review and comment metrics", () => {
  const merged = [
    makePull({
      hasDetailData: false,
      reviewComments: [{ user: { login: "hidden" } }],
      reviews: [{ state: "APPROVED", submitted_at: "2026-06-01T06:00:00Z", user: { login: "hidden" } }]
    }),
    makePull({
      created_at: "2026-06-03T00:00:00Z",
      merged_at: "2026-06-05T00:00:00Z",
      hasDetailData: true,
      reviews: [{ state: "COMMENTED", submitted_at: "2026-06-03T04:00:00Z", user: { login: "ben" } }],
      reviewComments: [{ user: { login: "ben" } }]
    })
  ];
  const open = [makePull({ merged_at: null, hasDetailData: true })];

  const stats = computeStats(merged, open);
  assert.equal(stats.commentRate, 0.5);
  assert.equal(stats.medianTimeToFirstReview, 4);
  assert.equal(stats.averageTimeToFirstReview, 4);
  assert.equal(stats.medianTimeToApproval, 0);
  assert.equal(stats.averageTimeToApproval, 0);
  assert.equal(stats.medianTimeToMerge, 42);
});

test("stats include approval timing from open pulls", () => {
  const open = [
    makePull({
      merged_at: null,
      created_at: "2026-06-10T00:00:00Z",
      reviews: [{ state: "APPROVED", submitted_at: "2026-06-10T06:00:00Z", user: { login: "lea" } }]
    })
  ];

  const stats = computeStats([], open, { includeOpenInReviewStats: true });
  assert.equal(stats.openPulls, 1);
  assert.equal(stats.medianTimeToFirstReview, 6);
  assert.equal(stats.averageTimeToFirstReview, 6);
  assert.equal(stats.medianTimeToApproval, 6);
  assert.equal(stats.averageTimeToApproval, 6);
  assert.equal(stats.medianTimeToMerge, 0);
});

test("stats default to merged-only review timing", () => {
  const merged = [
    makePull({
      created_at: "2026-06-01T00:00:00Z",
      merged_at: "2026-06-01T06:00:00Z",
      reviews: [{ state: "APPROVED", submitted_at: "2026-06-01T03:00:00Z", user: { login: "lea" } }]
    })
  ];
  const open = [
    makePull({
      merged_at: null,
      created_at: "2026-06-10T00:00:00Z",
      reviews: [{ state: "APPROVED", submitted_at: "2026-06-10T12:00:00Z", user: { login: "mo" } }]
    })
  ];

  const mergedOnly = computeStats(merged, open);
  const includeOpen = computeStats(merged, open, { includeOpenInReviewStats: true });

  assert.equal(mergedOnly.medianTimeToFirstReview, 3);
  assert.equal(mergedOnly.medianTimeToApproval, 3);
  assert.equal(includeOpen.medianTimeToFirstReview, 7.5);
  assert.equal(includeOpen.medianTimeToApproval, 7.5);
});
