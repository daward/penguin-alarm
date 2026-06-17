function hoursBetween(start, end) {
  if (!start || !end) {
    return null;
  }

  return (Date.parse(end) - Date.parse(start)) / (1000 * 60 * 60);
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) {
    return 0;
  }

  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[midpoint - 1] + sorted[midpoint]) / 2).toFixed(2))
    : Number(sorted[midpoint].toFixed(2));
}

function average(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) {
    return 0;
  }

  const total = finiteValues.reduce((sum, value) => sum + value, 0);
  return Number((total / finiteValues.length).toFixed(2));
}

function uniqueByUserAndState(reviews, state) {
  const seen = new Set();
  return reviews.filter((review) => {
    if (review.state !== state || !review.user?.login) {
      return false;
    }

    const key = `${state}:${review.user.login}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function hasReviewFromUser(reviews, state, viewerLogin) {
  if (!viewerLogin) {
    return false;
  }

  return reviews.some((review) => review.state === state && review.user?.login === viewerLogin);
}

function getQueuePriority(item) {
  if (item.isOwnPull && item.ownPullHasAnyApproval) {
    return 0;
  }

  if (item.viewerApproved) {
    return 2;
  }

  return 1;
}

function hasReviewData(pull) {
  return pull.hasReviewData !== false;
}

function hasCommentData(pull) {
  return pull.hasCommentData !== false;
}

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function createBotUserSet(botUsers = []) {
  return new Set(botUsers.map(normalizeLogin).filter(Boolean));
}

function isBotUser(login, botUsers) {
  return botUsers.has(normalizeLogin(login));
}

function filterReviews(reviews, botUsers) {
  return reviews.filter((review) => !isBotUser(review.user?.login, botUsers));
}

function filterComments(comments, botUsers) {
  return comments.filter((comment) => !isBotUser(comment.user?.login, botUsers));
}

function getFirstReviewActivityAt(pull) {
  const timestamps = [
    ...pull.reviews.map((review) => review.submitted_at),
    ...pull.reviewComments.map((comment) => comment.created_at),
    ...pull.issueComments.map((comment) => comment.created_at)
  ].filter(Boolean);

  if (!timestamps.length) {
    return null;
  }

  return timestamps.sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

export function computeQueueScore(pull, viewerLogin) {
  let score = 0;
  const approvalCount = uniqueByUserAndState(pull.reviews, "APPROVED").length;
  const isOwnPull = pull.user?.login === viewerLogin;

  const ageHours = Math.max(1, hoursBetween(pull.created_at, new Date().toISOString()) || 0);
  score += Math.min(ageHours / 12, 10);

  if (!pull.draft) {
    score += 3;
  }

  if (pull.requested_reviewers?.some((reviewer) => reviewer.login === viewerLogin)) {
    score += 7;
  }

  if (pull.reviewComments.length + pull.issueComments.length === 0) {
    score += 2;
  }

  if (pull.mergeable_state === "blocked") {
    score -= 1;
  }

  if (isOwnPull) {
    if (approvalCount > 0) {
      score += 15;
    } else {
      score -= 5;
    }
  }

  return Number(score.toFixed(2));
}

export function buildQueueItems(openPulls, viewerLogin, queueFilter) {
  return openPulls
    .filter((pull) => {
      if (queueFilter === "requested") {
        return pull.requested_reviewers?.some((reviewer) => reviewer.login === viewerLogin);
      }

      if (queueFilter === "participating") {
        const issueParticipant = pull.issueComments.some((comment) => comment.user?.login === viewerLogin);
        const reviewParticipant = pull.reviews.some((review) => review.user?.login === viewerLogin);
        return issueParticipant || reviewParticipant;
      }

      return true;
    })
    .map((pull) => ({
      ...pull,
      viewerLogin,
      queueScore: computeQueueScore(pull, viewerLogin),
      commentCount: pull.reviewComments.length + pull.issueComments.length,
      approvalCount: uniqueByUserAndState(pull.reviews, "APPROVED").length,
      isOwnPull: pull.user?.login === viewerLogin,
      viewerApproved: hasReviewFromUser(pull.reviews, "APPROVED", viewerLogin),
      ownPullHasAnyApproval: pull.user?.login === viewerLogin && uniqueByUserAndState(pull.reviews, "APPROVED").length > 0
    }))
    .sort((left, right) => {
      const leftPriority = getQueuePriority(left);
      const rightPriority = getQueuePriority(right);

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return right.queueScore - left.queueScore;
    });
}

export function buildMergedItems(mergedPulls) {
  return [...mergedPulls]
    .sort((left, right) => Date.parse(right.merged_at) - Date.parse(left.merged_at))
    .slice(0, 20)
    .map((pull) => ({
      ...pull,
      commentCount: pull.reviewComments.length + pull.issueComments.length,
      approvalCount: uniqueByUserAndState(pull.reviews, "APPROVED").length
    }));
}

export function computeStats(mergedPulls, openPulls, options = {}) {
  const { includeOpenInReviewStats = false, botUsers = [] } = options;
  const botUserSet = createBotUserSet(botUsers);
  const merged = mergedPulls.length;
  const open = openPulls.length;
  const reviewStatsPulls = includeOpenInReviewStats ? [...mergedPulls, ...openPulls] : mergedPulls;
  const reviewStatsWithDetails = reviewStatsPulls.filter(hasReviewData);
  const pullsWithCommentDetails = [...mergedPulls, ...openPulls].filter(hasCommentData);
  const firstReviewTimes = reviewStatsWithDetails.map((pull) => {
    return hoursBetween(pull.created_at, getFirstReviewActivityAt({
      ...pull,
      reviews: filterReviews(pull.reviews, botUserSet),
      reviewComments: filterComments(pull.reviewComments, botUserSet),
      issueComments: filterComments(pull.issueComments, botUserSet)
    }));
  });
  const firstApprovalTimes = reviewStatsWithDetails.map((pull) => {
    const firstApproval = filterReviews(pull.reviews, botUserSet)
      .filter((review) => review.state === "APPROVED")
      .sort((left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at))[0];
    return hoursBetween(pull.created_at, firstApproval?.submitted_at);
  });
  const mergeTimes = mergedPulls.map((pull) => hoursBetween(pull.created_at, pull.merged_at));
  const totalComments = pullsWithCommentDetails.reduce(
    (sum, pull) => sum + filterComments(pull.reviewComments, botUserSet).length + filterComments(pull.issueComments, botUserSet).length,
    0
  );

  return {
    openPulls: open,
    mergedPulls: merged,
    commentRate: Number((totalComments / Math.max(1, pullsWithCommentDetails.length)).toFixed(2)),
    mergeRate: Number((merged / Math.max(1, merged + open)).toFixed(2)),
    medianTimeToFirstReview: median(firstReviewTimes),
    averageTimeToFirstReview: average(firstReviewTimes),
    medianTimeToApproval: median(firstApprovalTimes),
    averageTimeToApproval: average(firstApprovalTimes),
    medianTimeToMerge: median(mergeTimes),
    averageTimeToMerge: average(mergeTimes)
  };
}

export function computeLeaderboard(allPulls, botUsers = []) {
  const botUserSet = createBotUserSet(botUsers);
  const totals = { approvals: 0, comments: 0 };
  const perUser = new Map();

  for (const pull of allPulls) {
    for (const review of uniqueByUserAndState(filterReviews(pull.reviews, botUserSet), "APPROVED")) {
      const login = review.user?.login;
      if (!login) {
        continue;
      }

      totals.approvals += 1;
      const current = perUser.get(login) || { login, avatarUrl: review.user.avatar_url, approvals: 0, comments: 0 };
      current.approvals += 1;
      perUser.set(login, current);
    }

    const comments = [...filterComments(pull.reviewComments, botUserSet), ...filterComments(pull.issueComments, botUserSet)];
    for (const comment of comments) {
      const login = comment.user?.login;
      if (!login) {
        continue;
      }

      totals.comments += 1;
      const current = perUser.get(login) || { login, avatarUrl: comment.user.avatar_url, approvals: 0, comments: 0 };
      current.comments += 1;
      perUser.set(login, current);
    }
  }

  return [...perUser.values()]
    .map((user) => {
      const approvalShare = totals.approvals ? user.approvals / totals.approvals : 0;
      const commentShare = totals.comments ? user.comments / totals.comments : 0;
      return {
        ...user,
        approvalShare: Number(approvalShare.toFixed(3)),
        commentShare: Number(commentShare.toFixed(3)),
        score: Number((approvalShare + commentShare).toFixed(3))
      };
    })
    .sort((left, right) => right.score - left.score);
}

function startOfUtcDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatUtcDayKey(value) {
  const day = startOfUtcDay(value);
  return day ? day.toISOString().slice(0, 10) : null;
}

function enumerateUtcDaysInRange(start, end) {
  const days = [];

  for (let current = new Date(start); current <= end; current.setUTCDate(current.getUTCDate() + 1)) {
    days.push(current.toISOString().slice(0, 10));
  }

  return days;
}

export function computeDailyActivity(openPulls, mergedPulls, botUsers = [], daysBack = 14, now = new Date()) {
  const botUserSet = createBotUserSet(botUsers);
  const counters = new Map();
  const safeDaysBack = Math.max(1, Number(daysBack) || 1);
  const end = startOfUtcDay(now);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (safeDaysBack - 1));
  const rangeStartMs = start.getTime();
  const rangeEndMs = end.getTime() + 24 * 60 * 60 * 1000;

  function ensureDay(dayKey) {
    if (!dayKey) {
      return null;
    }

    if (!counters.has(dayKey)) {
      counters.set(dayKey, {
        day: dayKey,
        approvals: 0,
        comments: 0,
        merges: 0
      });
    }

    return counters.get(dayKey);
  }

  function isWithinRange(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp >= rangeStartMs && timestamp < rangeEndMs;
  }

  function addApprovalEvents(pulls) {
    for (const pull of pulls) {
      for (const review of filterReviews(pull.reviews, botUserSet)) {
        if (review.state !== "APPROVED" || !isWithinRange(review.submitted_at)) {
          continue;
        }

        const day = ensureDay(formatUtcDayKey(review.submitted_at));
        if (day) {
          day.approvals += 1;
        }
      }
    }
  }

  function addCommentEvents(pulls) {
    for (const pull of pulls) {
      const comments = [...filterComments(pull.reviewComments, botUserSet), ...filterComments(pull.issueComments, botUserSet)];
      for (const comment of comments) {
        if (!isWithinRange(comment.created_at)) {
          continue;
        }

        const day = ensureDay(formatUtcDayKey(comment.created_at));
        if (day) {
          day.comments += 1;
        }
      }
    }
  }

  addApprovalEvents(openPulls);
  addApprovalEvents(mergedPulls);
  addCommentEvents(openPulls);
  addCommentEvents(mergedPulls);

  for (const pull of mergedPulls) {
    if (!isWithinRange(pull.merged_at)) {
      continue;
    }

    const day = ensureDay(formatUtcDayKey(pull.merged_at));
    if (day) {
      day.merges += 1;
    }
  }

  const allDayKeys = enumerateUtcDaysInRange(start, end);
  return allDayKeys.map((dayKey) => counters.get(dayKey) || { day: dayKey, approvals: 0, comments: 0, merges: 0 });
}
