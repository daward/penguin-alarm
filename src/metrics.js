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

function hasDetailData(pull) {
  return pull.hasDetailData !== false;
}

export function computeQueueScore(pull, viewerLogin) {
  let score = 0;

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

  if (pull.user?.login === viewerLogin) {
    score -= 5;
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
      queueScore: computeQueueScore(pull, viewerLogin),
      commentCount: pull.reviewComments.length + pull.issueComments.length,
      approvalCount: uniqueByUserAndState(pull.reviews, "APPROVED").length
    }))
    .sort((left, right) => right.queueScore - left.queueScore);
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

export function computeStats(mergedPulls, openPulls) {
  const merged = mergedPulls.length;
  const open = openPulls.length;
  const mergedWithDetails = mergedPulls.filter(hasDetailData);
  const pullsWithDetails = [...mergedPulls, ...openPulls].filter(hasDetailData);
  const firstReviewTimes = mergedWithDetails.map((pull) => {
    const firstReview = [...pull.reviews].sort((left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at))[0];
    return hoursBetween(pull.created_at, firstReview?.submitted_at);
  });
  const firstApprovalTimes = mergedWithDetails.map((pull) => {
    const firstApproval = [...pull.reviews]
      .filter((review) => review.state === "APPROVED")
      .sort((left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at))[0];
    return hoursBetween(pull.created_at, firstApproval?.submitted_at);
  });
  const mergeTimes = mergedPulls.map((pull) => hoursBetween(pull.created_at, pull.merged_at));
  const totalComments = pullsWithDetails.reduce(
    (sum, pull) => sum + pull.reviewComments.length + pull.issueComments.length,
    0
  );

  return {
    openPulls: open,
    mergedPulls: merged,
    commentRate: Number((totalComments / Math.max(1, pullsWithDetails.length)).toFixed(2)),
    mergeRate: Number((merged / Math.max(1, merged + open)).toFixed(2)),
    medianTimeToFirstReview: median(firstReviewTimes),
    averageTimeToFirstReview: average(firstReviewTimes),
    medianTimeToApproval: median(firstApprovalTimes),
    averageTimeToApproval: average(firstApprovalTimes),
    medianTimeToMerge: median(mergeTimes),
    averageTimeToMerge: average(mergeTimes)
  };
}

export function computeLeaderboard(allPulls) {
  const totals = { approvals: 0, comments: 0 };
  const perUser = new Map();

  for (const pull of allPulls) {
    for (const review of uniqueByUserAndState(pull.reviews, "APPROVED")) {
      const login = review.user?.login;
      if (!login) {
        continue;
      }

      totals.approvals += 1;
      const current = perUser.get(login) || { login, avatarUrl: review.user.avatar_url, approvals: 0, comments: 0 };
      current.approvals += 1;
      perUser.set(login, current);
    }

    const comments = [...pull.reviewComments, ...pull.issueComments];
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
        score: Number((approvalShare + commentShare).toFixed(3))
      };
    })
    .sort((left, right) => right.score - left.score);
}
