import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { PROVIDERS, DEFAULT_CONFIG, QUEUE_FILTERS } from "./constants.js";
import { getAdapter } from "./adapters/index.js";
import { buildMergedItems, buildQueueItems, computeDailyActivity, computeLeaderboard, computePersonalDailyActivity, computeStats } from "./metrics.js";
import { getYoutubeEmbedUrl } from "./tv-mode.js";
import {
  createId,
  clearToken,
  deleteConfig,
  exportConfig,
  getSelectedConfig,
  importConfig,
  readPanelOrder,
  readConfigs,
  readToken,
  upsertConfig,
  writePanelOrder,
  writeSelectedConfigId,
  writeToken
} from "./storage.js";

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "n/a";
}

function relativeTime(value) {
  if (!value) {
    return "n/a";
  }

  const deltaMs = Date.now() - Date.parse(value);
  const deltaHours = Math.max(0, Math.round(deltaMs / (1000 * 60 * 60)));
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }

  return `${Math.round(deltaHours / 24)}d ago`;
}

function formatDurationHours(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  if (value === 0) {
    return "0h";
  }

  if (value >= 72) {
    return `${Number((value / 24).toFixed(2))}d`;
  }

  return `${Number(value.toFixed(2))}h`;
}

function formatDayLabel(value) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function readCurrentPage() {
  if (window.location.hash === "#activity") {
    return "activity";
  }

  if (window.location.hash === "#tv") {
    return "tv";
  }

  if (window.location.hash === "#config") {
    return "config";
  }

  return "dashboard";
}

function writeCurrentPage(page) {
  const nextHash = page === "activity" ? "#activity" : page === "config" ? "#config" : page === "tv" ? "#tv" : "";
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
  window.history.replaceState({}, "", nextUrl);
}

function getQueueScoreExplanation(pull) {
  const factors = [];

  if (!pull.draft) {
    factors.push("+3 ready for review");
  }

  if (pull.requested_reviewers?.some((reviewer) => reviewer.login === pull.viewerLogin)) {
    factors.push("+7 you are a requested reviewer");
  }

  if (pull.reviewComments.length + pull.issueComments.length === 0) {
    factors.push("+2 no discussion yet");
  }

  if (pull.mergeable_state === "blocked") {
    factors.push("-1 merge is blocked");
  }

  if (pull.isOwnPull) {
    if (pull.ownPullHasAnyApproval) {
      factors.push("+15 your PR has an approval");
    } else {
      factors.push("-5 your PR is still waiting on approval");
    }
  }

  factors.push(`${Math.min(Math.max(1, (Date.now() - Date.parse(pull.created_at)) / (1000 * 60 * 60)) / 12, 10).toFixed(2)} age points`);

  return [`Queue score: ${pull.queueScore}`, ...factors];
}

function getLeaderboardScoreExplanation(user) {
  return [
    `Leaderboard score: ${user.score}`,
    `${user.approvalShare} from approvals (${Math.round(user.approvalShare * 100)}% share)`,
    `${user.commentShare} from comments (${Math.round(user.commentShare * 100)}% share)`,
    `${user.approvalShare} + ${user.commentShare} = ${user.score}`
  ];
}

function pullKey(pull) {
  return `${pull.repoName}#${pull.number}`;
}

function getInitials(value) {
  const parts = String(value || "")
    .trim()
    .split(/\s+|[._-]+/)
    .filter(Boolean);

  if (!parts.length) {
    return "?";
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function getAvatarFallbackStyle(value) {
  const palette = [
    { background: "rgba(88, 208, 255, 0.18)", color: "#d8f6ff" },
    { background: "rgba(246, 196, 83, 0.18)", color: "#fff0c4" },
    { background: "rgba(152, 230, 168, 0.18)", color: "#e3ffe9" },
    { background: "rgba(191, 128, 255, 0.18)", color: "#f0e4ff" },
    { background: "rgba(255, 147, 122, 0.18)", color: "#ffe4df" }
  ];

  return palette[hashString(String(value || "").toLowerCase()) % palette.length];
}

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function shouldFetchAvatarWithToken(src) {
  if (!src) {
    return false;
  }

  try {
    const { protocol, hostname } = new URL(src);
    if (!/^https?:$/.test(protocol)) {
      return false;
    }

    return hostname !== "avatars.githubusercontent.com" && !hostname.endsWith(".githubusercontent.com");
  } catch {
    return false;
  }
}

function filterPullsByTeam(pulls, teamMembers) {
  const members = teamMembers.map(normalizeLogin).filter(Boolean);
  if (!members.length) {
    return pulls;
  }

  const memberSet = new Set(members);
  return pulls.filter((pull) => memberSet.has(normalizeLogin(pull.user?.login)));
}

function AvatarImage({ src, alt, token }) {
  const [didFail, setDidFail] = useState(false);
  const [resolvedSrc, setResolvedSrc] = useState(src || "");

  useEffect(() => {
    setDidFail(false);
    setResolvedSrc(src || "");

    if (!src || !token || !shouldFetchAvatarWithToken(src)) {
      return undefined;
    }

    const controller = new AbortController();
    let objectUrl = "";

    startTransition(() => {
      fetch(src, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Avatar request failed with ${response.status}`);
          }
          return response.blob();
        })
        .then((blob) => {
          objectUrl = URL.createObjectURL(blob);
          setResolvedSrc(objectUrl);
        })
        .catch((error) => {
          if (error.name !== "AbortError") {
            setDidFail(true);
          }
        });
    });

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [src, token]);

  if (!src || didFail) {
    return (
      <div className="avatar-fallback" style={getAvatarFallbackStyle(alt)}>
        {getInitials(alt)}
      </div>
    );
  }

  return <img src={resolvedSrc} alt={alt} loading="lazy" onError={() => setDidFail(true)} />;
}

function getRepoInputGuidance(provider) {
  if (provider === "gitlab") {
    return {
      placeholder: "group/project OR gitlab.example.com/group/project",
      help: "GitLab format: group/project, gitlab.example.com/group/project, or full https URL."
    };
  }

  if (provider === "bitbucket") {
    return {
      placeholder: "workspace/repo",
      help: "Bitbucket format: workspace/repo (adapter wiring still pending)."
    };
  }

  return {
    placeholder: "owner/repo OR github.enterprise.com/owner/repo",
    help: "GitHub format: owner/repo, github.com/owner/repo, github.enterprise.com/owner/repo, or a full https URL."
  };
}

function getTokenGuidance(provider) {
  if (provider === "gitlab") {
    return "Use a personal access token with API access to the target projects.";
  }

  if (provider === "bitbucket") {
    return "Use a personal access token with read access to pull requests and comments.";
  }

  return "For GitHub and GitHub Enterprise, use a fine-grained PAT with repository access to the selected repos and `Pull requests: Read`. For a classic PAT, use `repo` for private repos or `public_repo` for public-only repos.";
}

function getShareUrl(config) {
  const url = new URL(window.location.href);
  url.searchParams.set("config", exportConfig(config));
  return url.toString();
}

function readSharedConfig() {
  const url = new URL(window.location.href);
  const encoded = url.searchParams.get("config");
  if (!encoded) {
    return null;
  }

  try {
    const config = importConfig(encoded);
    url.searchParams.delete("config");
    window.history.replaceState({}, "", url);
    return config;
  } catch {
    return "invalid";
  }
}

function createBlankConfigDraft() {
  return {
    ...DEFAULT_CONFIG,
    id: createId(),
    name: ""
  };
}

const PANEL_ORDER_DEFAULTS = {
  dashboard: ["queue", "merged", "stats", "leaderboard", "ops"],
  activity: ["team-activity", "my-activity"]
};

function useBootstrapState() {
  const sharedConfig = readSharedConfig();
  if (sharedConfig && sharedConfig !== "invalid") {
    upsertConfig(sharedConfig);
  }

  const selectedConfig = getSelectedConfig();
  const token = readToken(selectedConfig?.provider || "github", selectedConfig?.id || "");

  return {
    token,
    configs: readConfigs(),
    selectedConfig,
    error: sharedConfig === "invalid" ? "Shared config link is invalid." : "",
    isLoading: false,
    lastUpdatedAt: "",
    rateLimit: null,
    profile: null,
    queueItems: [],
    mergedItems: [],
    stats: null,
    leaderboard: []
  };
}

function StatPanel({ stats, includeOpenInStats, onToggleIncludeOpen }) {
  const [timeMetricMode, setTimeMetricMode] = useState({
    firstReview: "median",
    approval: "median",
    merge: "median"
  });

  if (!stats) {
    return (
      <section className="panel">
        <div className="panel-header">
          <h2>Team Stats</h2>
          <button type="button" className="toggle-chip" onClick={onToggleIncludeOpen}>
            {includeOpenInStats ? "Include open" : "Merged only"}
          </button>
        </div>
        <p className="muted">Add a token and repos to load metrics.</p>
      </section>
    );
  }

  function toggleMetric(metricKey) {
    setTimeMetricMode((current) => ({
      ...current,
      [metricKey]: current[metricKey] === "median" ? "average" : "median"
    }));
  }

  const rows = [
    { label: "Comment rate", value: stats.commentRate },
    { label: "Merge rate", value: stats.mergeRate },
    {
      label: `${timeMetricMode.firstReview === "median" ? "Median" : "Average"} first review`,
      value: formatDurationHours(
        timeMetricMode.firstReview === "median" ? stats.medianTimeToFirstReview : stats.averageTimeToFirstReview
      ),
      metricKey: "firstReview"
    },
    {
      label: `${timeMetricMode.approval === "median" ? "Median" : "Average"} approval time`,
      value: formatDurationHours(
        timeMetricMode.approval === "median" ? stats.medianTimeToApproval : stats.averageTimeToApproval
      ),
      metricKey: "approval"
    },
    {
      label: `${timeMetricMode.merge === "median" ? "Median" : "Average"} merge time`,
      value: formatDurationHours(timeMetricMode.merge === "median" ? stats.medianTimeToMerge : stats.averageTimeToMerge),
      metricKey: "merge"
    }
  ];

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Team Stats</h2>
        <button type="button" className="toggle-chip" onClick={onToggleIncludeOpen}>
          {includeOpenInStats ? "Include open" : "Merged only"}
        </button>
      </div>
      <div className="stats-list">
        {rows.map((row) => {
          if (!row.metricKey) {
            return (
              <div className="stat-row" key={row.label}>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            );
          }

          return (
            <button
              type="button"
              className="stat-row stat-row-toggle"
              key={row.metricKey}
              onClick={() => toggleMetric(row.metricKey)}
            >
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PullMetaRow({ statusLabel, commentCount, approvalCount, isOwnPull, ownPullHasAnyApproval }) {
  return (
    <div className="meta-row">
      <span className="meta-tag">{statusLabel}</span>
      <span className="meta-tag">{commentCount} comments</span>
      <span className="meta-tag">{approvalCount} approvals</span>
      {isOwnPull && ownPullHasAnyApproval ? <span className="meta-tag meta-tag-approval">Approved</span> : null}
    </div>
  );
}

function PullCard({ pull, subtitle, score, statusLabel, children, token }) {
  const topRightLabel =
    pull.isOwnPull && pull.ownPullHasAnyApproval
      ? <strong className="card-state-ready">Ready</strong>
      : pull.viewerApproved
        ? <strong className="card-state-done">Done</strong>
      : typeof score === "number"
        ? (
            <span className="score-tooltip">
              <strong className="card-score" tabIndex="0" aria-describedby={`score-tooltip-${pull.repoName}-${pull.number}`}>
                {score}
              </strong>
              <span className="score-tooltip-popover" role="tooltip" id={`score-tooltip-${pull.repoName}-${pull.number}`}>
                {getQueueScoreExplanation(pull).map((line) => (
                  <span key={line} className="score-tooltip-line">
                    {line}
                  </span>
                ))}
              </span>
            </span>
          )
        : null;

  return (
    <article className={`card${pull.isOwnPull ? " card-own-pull" : ""}${pull.viewerApproved ? " card-viewer-approved" : ""}`}>
      <div className="card-top">
        <AvatarImage src={pull.user?.avatar_url} alt={pull.user?.login || "author"} token={token} />
        <div>
          <a href={pull.html_url} target="_blank" rel="noreferrer">
            {pull.title}
          </a>
          <p className="muted">{subtitle}</p>
        </div>
        {topRightLabel}
      </div>
      <PullMetaRow
        statusLabel={statusLabel}
        commentCount={pull.commentCount}
        approvalCount={pull.approvalCount}
        isOwnPull={pull.isOwnPull}
        ownPullHasAnyApproval={pull.ownPullHasAnyApproval}
      />
      {children}
    </article>
  );
}

function ListPager({ page, pageCount, onPrevious, onNext, label }) {
  if (pageCount <= 1) {
    return null;
  }

  return (
    <div className="list-pager" aria-label={label}>
      <button type="button" className="ghost" onClick={onPrevious} disabled={page === 0}>
        {"<"}
      </button>
      <span className="muted">
        {page + 1}/{pageCount}
      </span>
      <button type="button" className="ghost" onClick={onNext} disabled={page >= pageCount - 1}>
        {">"}
      </button>
    </div>
  );
}

function SortablePanelSlot({ item, span, masonryEnabled, isArranging, registerBodyRef }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !isArranging });

  return (
    <div
      ref={setNodeRef}
      className={isDragging ? "panel-slot is-dragging" : "panel-slot"}
      style={{
        ...(masonryEnabled ? { gridRowEnd: `span ${span || 1}` } : undefined),
        transform: CSS.Transform.toString(transform),
        transition
      }}
    >
      <div
        className={isArranging ? "panel-slot-shell is-arranging" : "panel-slot-shell"}
        data-panel-id={item.id}
        ref={registerBodyRef}
      >
        {isArranging ? (
          <button
            type="button"
            className="panel-drag-handle"
            aria-label={`Drag ${item.title} panel`}
            title={`Drag ${item.title}`}
            {...attributes}
            {...listeners}
          >
            <span aria-hidden="true">::</span>
          </button>
        ) : null}
        {item.node}
      </div>
    </div>
  );
}

function PanelBoard({ layoutClassName, items, order, isArranging, onReorder }) {
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const orderedItems = order.map((id) => itemMap.get(id)).filter(Boolean);
  const slotBodyRefs = useRef({});
  const [slotSpans, setSlotSpans] = useState({});
  const masonryEnabled = layoutClassName.includes("layout-main-board");
  const orderedItemIdsKey = orderedItems.map((item) => item.id).join("|");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function areSpanMapsEqual(left, right) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key) => left[key] === right[key]);
  }

  useLayoutEffect(() => {
    if (!masonryEnabled) {
      setSlotSpans((current) => (Object.keys(current).length ? {} : current));
      return undefined;
    }

    const rowHeight = 8;
    const gap = 24;
    const nextSpans = {};

    function updateSpan(id, element) {
      if (!element) {
        return;
      }

      const height = element.getBoundingClientRect().height;
      nextSpans[id] = Math.max(1, Math.ceil((height + gap) / (rowHeight + gap)));
    }

    const resizeObserver = new ResizeObserver((entries) => {
      setSlotSpans((current) => {
        const updated = { ...current };
        let changed = false;

        for (const entry of entries) {
          const id = entry.target.dataset.panelId;
          if (!id) {
            continue;
          }

          const height = entry.contentRect.height;
          const nextSpan = Math.max(1, Math.ceil((height + gap) / (rowHeight + gap)));
          if (updated[id] !== nextSpan) {
            updated[id] = nextSpan;
            changed = true;
          }
        }

        return changed ? updated : current;
      });
    });

    for (const item of orderedItems) {
      const element = slotBodyRefs.current[item.id];
      if (!element) {
        continue;
      }

      updateSpan(item.id, element);
      resizeObserver.observe(element);
    }

    setSlotSpans((current) => (areSpanMapsEqual(current, nextSpans) ? current : nextSpans));

    return () => resizeObserver.disconnect();
  }, [masonryEnabled, orderedItemIdsKey]);

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!isArranging || !over || active.id === over.id) {
      return;
    }

    const oldIndex = order.indexOf(active.id);
    const newIndex = order.indexOf(over.id);
    if (oldIndex === -1 || newIndex === -1) {
      return;
    }

    onReorder(arrayMove(order, oldIndex, newIndex));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={order} strategy={rectSortingStrategy}>
        <section className={`${layoutClassName} panel-board${isArranging ? " is-arranging" : ""}`}>
          {orderedItems.map((item) => (
            <SortablePanelSlot
              key={item.id}
              item={item}
              span={slotSpans[item.id]}
              masonryEnabled={masonryEnabled}
              isArranging={isArranging}
              registerBodyRef={(element) => {
                slotBodyRefs.current[item.id] = element;
              }}
            />
          ))}
        </section>
      </SortableContext>
    </DndContext>
  );
}

function QueuePanel({ items, token }) {
  const pageSize = 10;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const visibleItems = items.slice(page * pageSize, (page + 1) * pageSize);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount - 1));
  }, [pageCount]);

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Review Queue</h2>
        <div className="activity-totals">
          <span className="badge">{items.length}</span>
          <ListPager
            page={page}
            pageCount={pageCount}
            label="Review queue pages"
            onPrevious={() => setPage((currentPage) => currentPage - 1)}
            onNext={() => setPage((currentPage) => currentPage + 1)}
          />
        </div>
      </div>
      <div className="card-list">
        {items.length ? (
          visibleItems.map((pull) => (
            <PullCard
              key={pullKey(pull)}
              pull={pull}
              subtitle={`${pull.repoName} · ${pull.user?.login} · ${relativeTime(pull.created_at)}`}
              score={pull.queueScore}
              statusLabel={pull.draft ? "Draft" : "Ready"}
              token={token}
            />
          ))
        ) : (
          <p className="muted">No matching pull requests.</p>
        )}
      </div>
    </section>
  );
}

function TvModePrItem({ pull, index }) {
  return (
    <li className="tv-mode-pr-item">
      <div className="tv-mode-pr-avatar">
        <AvatarImage src={pull.user?.avatar_url} alt={pull.user?.login || "author"} />
      </div>
      <div className="tv-mode-pr-copy">
        <strong>{pull.title}</strong>
        <span>{`${pull.repoName} · ${pull.user?.login || "unknown"} · ${relativeTime(pull.created_at)}`}</span>
      </div>
      <span className={pull.draft ? "tv-mode-pr-state is-draft" : "tv-mode-pr-state"}>
        {pull.draft ? "Draft" : "Ready"}
      </span>
    </li>
  );
}

function TvMode({ configName, streamUrl, queueItems }) {
  const embedUrl = getYoutubeEmbedUrl(streamUrl);
  const iframeRef = useRef(null);

  useEffect(() => {
    if (!embedUrl || !iframeRef.current) {
      return undefined;
    }

    function commandPlayer(func, args = []) {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({
          event: "command",
          func,
          args
        }),
        "https://www.youtube.com"
      );
    }

    function keepPlayerRunning() {
      commandPlayer("mute");
      commandPlayer("playVideo");
    }

    keepPlayerRunning();
    const timer = window.setInterval(keepPlayerRunning, 1500);
    return () => window.clearInterval(timer);
  }, [embedUrl]);

  return (
    <main className="tv-mode-shell">
      {embedUrl ? (
        <>
          <iframe
            ref={iframeRef}
            className="tv-mode-stream"
            src={embedUrl}
            title={`${configName || "Penguin Alarm"} livestream`}
            allow="autoplay; encrypted-media; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
          />
          <div className="tv-mode-stream-shield" aria-hidden="true" />
        </>
      ) : (
        <div className="tv-mode-stream tv-mode-stream-fallback">
          <div>
            <p className="tv-mode-kicker">TV Mode</p>
            <h1>Add a YouTube livestream URL in config</h1>
            <p>The PR overlay is ready, but this config does not have a valid YouTube livestream yet.</p>
          </div>
        </div>
      )}
      <section
        className={queueItems.length ? "tv-mode-overlay is-active" : "tv-mode-overlay"}
      >
        <ol className="tv-mode-pr-list">
          {queueItems.map((pull, index) => (
            <TvModePrItem key={pullKey(pull)} pull={pull} index={index} />
          ))}
        </ol>
      </section>
    </main>
  );
}

function MergedPanel({ items, token }) {
  const pageSize = 10;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const visibleItems = items.slice(page * pageSize, (page + 1) * pageSize);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount - 1));
  }, [pageCount]);

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Recently Merged</h2>
        <ListPager
          page={page}
          pageCount={pageCount}
          label="Recently merged pages"
          onPrevious={() => setPage((currentPage) => currentPage - 1)}
          onNext={() => setPage((currentPage) => currentPage + 1)}
        />
      </div>
      <div className="card-list">
        {items.length ? (
          visibleItems.map((pull) => (
              <PullCard
                key={pullKey(pull)}
                pull={pull}
                subtitle={`${pull.repoName} · merged ${relativeTime(pull.merged_at)}`}
                statusLabel="Merged"
                token={token}
              />
          ))
        ) : (
          <p className="muted">No merged pull requests in the selected window.</p>
        )}
      </div>
    </section>
  );
}

function LeaderboardPanel({ users, token }) {
  const pageSize = 10;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(users.length / pageSize));
  const visibleUsers = users.slice(page * pageSize, (page + 1) * pageSize);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount - 1));
  }, [pageCount]);

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Leaderboard</h2>
        <ListPager
          page={page}
          pageCount={pageCount}
          label="Leaderboard pages"
          onPrevious={() => setPage((currentPage) => currentPage - 1)}
          onNext={() => setPage((currentPage) => currentPage + 1)}
        />
      </div>
      <div className="card-list">
        {users.length ? (
          visibleUsers.map((user) => (
            <article className="card compact-card" key={user.login}>
              <div className="card-top">
                <AvatarImage src={user.avatarUrl} alt={user.login} token={token} />
                <div>
                  <strong>{user.login}</strong>
                  <p className="muted">
                    {user.approvals} approvals · {user.comments} comments
                  </p>
                </div>
                <span className="score-tooltip">
                  <strong
                    className="card-score"
                    tabIndex="0"
                    aria-describedby={`leaderboard-score-tooltip-${user.login}`}
                  >
                    {user.score}
                  </strong>
                  <span
                    className="score-tooltip-popover"
                    role="tooltip"
                    id={`leaderboard-score-tooltip-${user.login}`}
                  >
                    {getLeaderboardScoreExplanation(user).map((line) => (
                      <span key={line} className="score-tooltip-line">
                        {line}
                      </span>
                    ))}
                  </span>
                </span>
              </div>
            </article>
          ))
        ) : (
          <p className="muted">Leaderboard data appears after loading repos.</p>
        )}
      </div>
    </section>
  );
}

function OpsPanel() {
  const services = ["custom-calendars-components", "routing-configuration-ui"];

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Production</h2>
      </div>
      <div className="stack">
        <div className="card compact-card">
          <strong>Open Violations</strong>
          <p className="muted">The sky is not falling. Wire New Relic and PagerDuty endpoints when ready.</p>
        </div>
        <div className="card compact-card">
          <strong>Recent Deployments</strong>
          <p className="muted">Deploy stream will appear here when provider integrations are configured.</p>
        </div>
        <div className="card compact-card">
          <strong>Services</strong>
          <p className="muted">{services.join(" · ")}</p>
        </div>
      </div>
    </section>
  );
}

function ActivityChart({ data, emptyMessage = "Load repos to see daily approvals, comments, and merges." }) {
  if (!data.length) {
    return <p className="muted">{emptyMessage}</p>;
  }

  const height = 260;
  const width = 860;
  const leftPad = 52;
  const rightPad = 20;
  const topPad = 16;
  const bottomPad = 42;
  const innerWidth = width - leftPad - rightPad;
  const innerHeight = height - topPad - bottomPad;
  const maxValue = Math.max(1, ...data.map((item) => item.approvals + item.comments + item.merges));
  const tickCount = Math.min(5, maxValue + 1);
  const yTicks = Array.from({ length: tickCount }, (_, index) => {
    const divisor = tickCount - 1 || 1;
    const value = Math.round((maxValue * (divisor - index)) / divisor);
    return { value, y: topPad + (innerHeight * index) / divisor };
  });
  const series = [
    { key: "merges", label: "Merges", color: "#58d0ff" },
    { key: "approvals", label: "Approvals", color: "#7fe0a3" },
    { key: "comments", label: "Comments", color: "#f6c453" }
  ];
  const columnWidth = innerWidth / Math.max(data.length, 1);
  const barWidth = Math.min(18, Math.max(8, columnWidth * 0.45));
  const labelStep = Math.max(1, Math.ceil(data.length / 6));
  const xLabels = data
    .map((item, index) => ({ ...item, index }))
    .filter((item, index) => index === 0 || index === data.length - 1 || index % labelStep === 0);

  function getGroupX(index) {
    return leftPad + columnWidth * index + columnWidth / 2;
  }

  function getBarHeight(value) {
    return (value / maxValue) * innerHeight;
  }

  return (
    <div className="activity-chart">
      <div className="activity-legend" aria-hidden="true">
        {series.map((item) => (
          <span className="activity-legend-item" key={item.key}>
            <span className="activity-legend-swatch" style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily approvals, comments, and merges">
        {yTicks.map((tick) => (
          <g key={`${tick.value}-${tick.y}`}>
            <line className="activity-grid-line" x1={leftPad} y1={tick.y} x2={width - rightPad} y2={tick.y} />
            <text className="activity-axis-label" x={leftPad - 10} y={tick.y + 4} textAnchor="end">
              {tick.value}
            </text>
          </g>
        ))}
        {xLabels.map((item) => (
          <text
            className="activity-axis-label"
            key={item.day}
            x={getGroupX(item.index)}
            y={height - 10}
            textAnchor="middle"
          >
            {formatDayLabel(item.day)}
          </text>
        ))}
        <line className="activity-grid-line" x1={leftPad} y1={topPad + innerHeight} x2={width - rightPad} y2={topPad + innerHeight} />
        {data.flatMap((day, index) => {
          const groupX = getGroupX(index);
          const x = groupX - barWidth / 2;
          let cumulativeHeight = 0;

          return series.map((item) => {
            const value = day[item.key];
            const barHeight = getBarHeight(value);
            const y = topPad + innerHeight - cumulativeHeight - barHeight;
            cumulativeHeight += barHeight;

            if (value === 0) {
              return null;
            }

            return (
              <rect
                key={`${item.key}-${day.day}`}
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx="2"
                fill={item.color}
              >
                <title>{`${formatDayLabel(day.day)}: ${item.label} ${value}`}</title>
              </rect>
            );
          });
        })}
      </svg>
    </div>
  );
}

function ActivityPanel({ title, activity, emptyMessage }) {
  const totals = activity.reduce(
    (summary, day) => ({
      approvals: summary.approvals + day.approvals,
      comments: summary.comments + day.comments,
      merges: summary.merges + day.merges
    }),
    { approvals: 0, comments: 0, merges: 0 }
  );

  return (
    <section className="panel activity-panel">
      <div className="panel-header">
        <h2>{title}</h2>
        <div className="activity-totals">
          <span className="badge">{totals.approvals} approvals</span>
          <span className="badge">{totals.comments} comments</span>
          <span className="badge">{totals.merges} merges</span>
        </div>
      </div>
      <ActivityChart data={activity} emptyMessage={emptyMessage} />
    </section>
  );
}

export default function App() {
  const initialState = useMemo(() => useBootstrapState(), []);
  const [page, setPage] = useState(() => readCurrentPage());
  const [token, setToken] = useState(initialState.token);
  const [tokenProvider, setTokenProvider] = useState(initialState.selectedConfig?.provider || "github");
  const [tokenDraft, setTokenDraft] = useState(initialState.token);
  const [configs, setConfigs] = useState(initialState.configs);
  const [selectedConfig, setSelectedConfig] = useState(initialState.selectedConfig);
  const [configDraft, setConfigDraft] = useState(initialState.selectedConfig || createBlankConfigDraft());
  const [isCreatingConfig, setIsCreatingConfig] = useState(!initialState.selectedConfig);
  const [isEditingConfig, setIsEditingConfig] = useState(false);
  const [error, setError] = useState(initialState.error);
  const [isLoading, setIsLoading] = useState(initialState.isLoading);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(initialState.lastUpdatedAt);
  const [rateLimit, setRateLimit] = useState(initialState.rateLimit);
  const [profile, setProfile] = useState(initialState.profile);
  const [queueItems, setQueueItems] = useState(initialState.queueItems);
  const [mergedItems, setMergedItems] = useState(initialState.mergedItems);
  const [stats, setStats] = useState(initialState.stats);
  const [leaderboard, setLeaderboard] = useState(initialState.leaderboard);
  const [statsOpenPulls, setStatsOpenPulls] = useState([]);
  const [statsMergedPulls, setStatsMergedPulls] = useState([]);
  const [includeOpenInStats, setIncludeOpenInStats] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [panelOrders, setPanelOrders] = useState(() => ({
    dashboard: readPanelOrder("dashboard", PANEL_ORDER_DEFAULTS.dashboard),
    activity: readPanelOrder("activity", PANEL_ORDER_DEFAULTS.activity)
  }));
  const [isArrangingPanels, setIsArrangingPanels] = useState(false);
  const configSaveTimerRef = useRef(null);

  const config = selectedConfig || DEFAULT_CONFIG;
  const formConfig = configDraft || DEFAULT_CONFIG;
  const isConfigFormEditable = isCreatingConfig || isEditingConfig;
  const needsSetup = !(token && config?.repos.length);
  const headerConfigOptions = configs;
  const shareUrl = !isCreatingConfig && selectedConfig ? getShareUrl(selectedConfig) : "";
  const adapter = getAdapter(config.provider);
  const tokenAdapter = getAdapter(tokenProvider);
  const repoInput = getRepoInputGuidance(formConfig.provider);
  const tokenGuidance = getTokenGuidance(tokenProvider);
  const activity = useMemo(
    () => computeDailyActivity(statsOpenPulls, statsMergedPulls, config.botUsers || [], config.timeWindowDays),
    [config.botUsers, config.timeWindowDays, statsMergedPulls, statsOpenPulls]
  );
  const tvQueueItems = useMemo(
    () => buildQueueItems(statsOpenPulls, "", "all"),
    [statsOpenPulls]
  );
  const personalActivity = useMemo(
    () =>
      computePersonalDailyActivity(
        statsOpenPulls,
        statsMergedPulls,
        profile?.login,
        config.botUsers || [],
        config.timeWindowDays
      ),
    [config.botUsers, config.timeWindowDays, profile?.login, statsMergedPulls, statsOpenPulls]
  );

  useEffect(() => {
    function handleHashChange() {
      setPage(readCurrentPage());
    }

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    const activeToken = readToken(config.provider, config.id || "");
    setToken(activeToken);
    setTokenProvider(config.provider);
    setTokenDraft(activeToken);
  }, [config.provider, config.id]);

  useEffect(() => {
    setTokenDraft(readToken(tokenProvider, config.id || ""));
  }, [tokenProvider, config.id]);

  useEffect(() => {
    if (!isCreatingConfig) {
      setConfigDraft(selectedConfig || createBlankConfigDraft());
    }
  }, [isCreatingConfig, selectedConfig]);

  useEffect(() => () => {
    if (configSaveTimerRef.current) {
      window.clearTimeout(configSaveTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (page === "config") {
      setIsArrangingPanels(false);
    }
  }, [page]);

  useEffect(() => {
    if (needsSetup && page !== "config") {
      setPage("config");
      writeCurrentPage("config");
    }
  }, [needsSetup, page]);

  async function loadDashboard() {
    if (!token || !config?.repos.length) {
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const { profile: viewerProfile, rateLimit: viewerRateLimit } = await adapter.fetchViewer(token, config);
      const snapshotResults = await Promise.allSettled(
        config.repos.map((repo) => adapter.fetchRepoSnapshot(repo, token, config.timeWindowDays))
      );
      const snapshots = snapshotResults.filter((result) => result.status === "fulfilled").map((result) => result.value);
      const failures = snapshotResults.filter((result) => result.status === "rejected");

      if (!snapshots.length && failures.length) {
        throw failures[0].reason;
      }

      const openPulls = snapshots.flatMap((snapshot) => snapshot.openPulls);
      const mergedPulls = snapshots.flatMap((snapshot) => snapshot.mergedPulls);
      const teamMembers = config.teamMembers || [];
      const botUsers = config.botUsers || [];
      const scopedOpenPulls = filterPullsByTeam(openPulls, teamMembers);
      const scopedMergedPulls = filterPullsByTeam(mergedPulls, teamMembers);

      startTransition(() => {
        setProfile(viewerProfile);
        setRateLimit(snapshots.at(-1)?.rateLimit || viewerRateLimit);
        setQueueItems(buildQueueItems(scopedOpenPulls, viewerProfile.login, config.queueFilter));
        setMergedItems(buildMergedItems(scopedMergedPulls));
        setStatsOpenPulls(scopedOpenPulls);
        setStatsMergedPulls(scopedMergedPulls);
        setStats(
          computeStats(scopedMergedPulls, scopedOpenPulls, {
            includeOpenInReviewStats: includeOpenInStats,
            botUsers
          })
        );
        setLeaderboard(computeLeaderboard([...scopedOpenPulls, ...scopedMergedPulls], botUsers));
        setLastUpdatedAt(new Date().toISOString());
        if (failures.length) {
          setError(`Loaded ${snapshots.length}/${config.repos.length} repos. Some ${adapter.label} requests failed.`);
        }
      });
    } catch (loadError) {
      setError(loadError.message || String(loadError));
      setRateLimit(loadError.rateLimit || null);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!token || !config?.repos.length) {
      return undefined;
    }

    void loadDashboard();
    const timer = window.setInterval(() => {
      void loadDashboard();
    }, config.pollingMinutes * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [token, config.id, config.provider, config.pollingMinutes, config.repos.length]);

  useEffect(() => {
    if (!statsOpenPulls.length && !statsMergedPulls.length) {
      return;
    }

    setStats(
      computeStats(statsMergedPulls, statsOpenPulls, {
        includeOpenInReviewStats: includeOpenInStats,
        botUsers: config.botUsers || []
      })
    );
  }, [config.botUsers, includeOpenInStats, statsMergedPulls, statsOpenPulls]);

  function handleSaveToken(event) {
    event.preventDefault();
    writeToken(tokenProvider, tokenDraft, config.id || "");
    const trimmedToken = String(tokenDraft || "").trim();
    setTokenDraft(trimmedToken);

    if (tokenProvider === config.provider) {
      setToken(trimmedToken);
    }

  }

  function handleClearToken() {
    clearToken(tokenProvider, config.id || "");
    setTokenDraft("");

    if (tokenProvider === config.provider) {
      setToken("");
      setProfile(null);
      setQueueItems([]);
      setMergedItems([]);
      setLeaderboard([]);
      setStats(null);
      setStatsOpenPulls([]);
      setStatsMergedPulls([]);
      setLastUpdatedAt("");
    }
  }

  function handleConfigSave(event) {
    event.preventDefault();
    setIsSavingConfig(true);
    if (configSaveTimerRef.current) {
      window.clearTimeout(configSaveTimerRef.current);
    }
    const form = new FormData(event.currentTarget);
    const nextConfig = upsertConfig({
      ...Object.fromEntries(form.entries()),
      id: isCreatingConfig ? "" : formConfig.id || ""
    });
    setConfigs(readConfigs());
    setSelectedConfig(nextConfig);
    setConfigDraft(nextConfig);
    setIsCreatingConfig(false);
    setIsEditingConfig(false);
    const configToken = readToken(nextConfig.provider, nextConfig.id || "");
    setToken(configToken);
    setTokenProvider(nextConfig.provider);
    setTokenDraft(configToken);
    configSaveTimerRef.current = window.setTimeout(() => {
      setIsSavingConfig(false);
      configSaveTimerRef.current = null;
    }, 450);
  }

  function handleSelectConfig(event) {
    writeSelectedConfigId(event.target.value);
    const nextSelected = getSelectedConfig();
    const nextProvider = nextSelected?.provider || "github";
    const nextToken = readToken(nextProvider, nextSelected?.id || "");

    setSelectedConfig(nextSelected);
    setConfigDraft(nextSelected || createBlankConfigDraft());
    setIsCreatingConfig(!nextSelected);
    setIsEditingConfig(false);
    setToken(nextToken);
    setTokenProvider(nextProvider);
    setTokenDraft(nextToken);
  }

  function handleDeleteConfig() {
    if (!selectedConfig?.id) {
      return;
    }

    deleteConfig(selectedConfig.id);
    const nextSelected = getSelectedConfig();
    setConfigs(readConfigs());
    setSelectedConfig(nextSelected);
    setConfigDraft(nextSelected || createBlankConfigDraft());
    setIsCreatingConfig(!nextSelected);
    setIsEditingConfig(false);
    setToken(readToken(nextSelected?.provider || "github", nextSelected?.id || ""));
  }

  function handleStartNewConfig() {
    setConfigDraft(createBlankConfigDraft());
    setIsCreatingConfig(true);
    setIsEditingConfig(false);
  }

  function handleEditSelectedConfig() {
    setConfigDraft(selectedConfig || DEFAULT_CONFIG);
    setIsCreatingConfig(false);
    setIsEditingConfig(true);
  }

  async function handleCopyShare() {
    if (!selectedConfig) {
      return;
    }

    await navigator.clipboard.writeText(getShareUrl(selectedConfig));
  }

  function handleNavigate(nextPage) {
    setPage(nextPage);
    writeCurrentPage(nextPage);
  }

  function handlePanelReorder(pageKey, nextOrder) {
    setPanelOrders((current) => ({ ...current, [pageKey]: nextOrder }));
    writePanelOrder(pageKey, nextOrder);
  }

  const dashboardPanels = [
    { id: "queue", title: "Review Queue", node: <QueuePanel items={queueItems} token={token} /> },
    { id: "merged", title: "Recently Merged", node: <MergedPanel items={mergedItems} token={token} /> },
    {
      id: "stats",
      title: "Team Stats",
      node: (
        <StatPanel
          stats={stats}
          includeOpenInStats={includeOpenInStats}
          onToggleIncludeOpen={() => setIncludeOpenInStats((value) => !value)}
        />
      )
    },
    { id: "leaderboard", title: "Leaderboard", node: <LeaderboardPanel users={leaderboard} token={token} /> },
    { id: "ops", title: "Production", node: <OpsPanel /> }
  ];

  const activityPanels = [
    {
      id: "team-activity",
      title: "Daily Activity",
      node: (
        <ActivityPanel
          title="Daily Activity"
          activity={activity}
          emptyMessage="Load repos to see daily approvals, comments, and merges."
        />
      )
    },
    {
      id: "my-activity",
      title: "My Activity",
      node: (
        <ActivityPanel
          title="My Activity"
          activity={personalActivity}
          emptyMessage="Load repos to see your daily approvals, comments, and merged PRs."
        />
      )
    }
  ];

  if (page === "tv") {
    return (
      <TvMode
        configName={config.name}
        streamUrl={config.youtubeLivestreamUrl}
        queueItems={tvQueueItems}
      />
    );
  }

  return (
    <main className="shell">
      <header className="hero">
        <div className="hero-brand">
          <h1>Penguin Alarm</h1>
          <nav className="hero-view-switcher" aria-label="Primary">
            <button
              type="button"
              className={page === "dashboard" ? "hero-view-link is-active" : "hero-view-link"}
              onClick={() => handleNavigate("dashboard")}
            >
              Dashboard
            </button>
            <button
              type="button"
              className={page === "activity" ? "hero-view-link is-active" : "hero-view-link"}
              onClick={() => handleNavigate("activity")}
            >
              Activity
            </button>
            <button
              type="button"
              className={page === "config" ? "hero-view-link is-active" : "hero-view-link"}
              onClick={() => handleNavigate("config")}
            >
              Config
            </button>
            <button
              type="button"
              className={page === "tv" ? "hero-view-link is-active" : "hero-view-link"}
              onClick={() => handleNavigate("tv")}
            >
              TV Mode
            </button>
          </nav>
        </div>
        <div className="hero-status">
          {(page === "dashboard" || page === "activity") ? (
            <button
              type="button"
              className={isArrangingPanels ? "toggle-chip is-active" : "toggle-chip"}
              onClick={() => setIsArrangingPanels((value) => !value)}
            >
              {isArrangingPanels ? "Done arranging" : "Arrange panels"}
            </button>
          ) : null}
          {isLoading ? (
            <span className="header-refresh-status" aria-live="polite">
              <span className="header-refresh-dot" aria-hidden="true" />
              Refreshing
            </span>
          ) : null}
          <span>{config.repos.length} repos</span> | 
          <span >{lastUpdatedAt ? `Updated ${formatDate(lastUpdatedAt)}` : "Not loaded yet"}</span>
          <label className="header-config-switcher" aria-label="Switch monitor configuration">
            <select value={config.id || ""} onChange={handleSelectConfig} disabled={!headerConfigOptions.length}>
              {headerConfigOptions.map((savedConfig) => (
                <option value={savedConfig.id} key={savedConfig.id}>
                  {savedConfig.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {error ? <div className="banner error">{error}</div> : null}

      {page === "config" ? (
        <section className="layout-top">
          <section className="panel">
          <div className="panel-header">
            <h2>{tokenAdapter.label} Access</h2>
            {profile && tokenProvider === config.provider ? (
              <span className="badge">{profile.login || profile.username}</span>
            ) : null}
          </div>
          <p className="muted">Paste a token for this provider. Data stays in your browser storage.</p>
          <p className="muted">{tokenGuidance}</p>
          <form className="stack" onSubmit={handleSaveToken}>
            <label>
              <span>Provider</span>
              <select value={tokenProvider} onChange={(event) => setTokenProvider(event.target.value)}>
                {PROVIDERS.map((provider) => (
                  <option value={provider.value} key={provider.value}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Personal access token</span>
              <input
                name="token"
                type="password"
                placeholder={tokenAdapter.tokenPlaceholder}
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
              />
            </label>
            <div className="row">
              <button type="submit">Save token</button>
              <button type="button" className="ghost" onClick={handleClearToken}>
                Clear token
              </button>
            </div>
          </form>
          {rateLimit && tokenProvider === config.provider ? (
            <p className="muted">
              Rate limit: {rateLimit.remaining}/{rateLimit.limit} remaining
            </p>
          ) : null}
          <a href={tokenAdapter.docsUrl} target="_blank" rel="noreferrer" className="muted">
            Token setup docs
          </a>
          </section>

          <section className={isCreatingConfig ? "panel config-panel is-new" : isEditingConfig ? "panel config-panel is-editing" : "panel config-panel"}>
          <div className="panel-header">
            <h2>Monitor Config</h2>
            <div className="row compact">
              <button
                type="button"
                className={isCreatingConfig ? "ghost config-new-trigger is-active" : "ghost config-new-trigger"}
                onClick={handleStartNewConfig}
              >
                New
              </button>
              <button
                type="button"
                className={isEditingConfig ? "ghost config-new-trigger is-active" : "ghost config-new-trigger"}
                onClick={handleEditSelectedConfig}
                disabled={!selectedConfig}
              >
                Edit
              </button>
            </div>
          </div>
          <form className={isCreatingConfig ? "stack config-form is-new" : "stack config-form"} key={`${formConfig.id || "new"}-${isCreatingConfig ? "create" : "edit"}`} onSubmit={handleConfigSave}>
            <input type="hidden" name="id" value={formConfig.id || ""} />
            <label>
              <span>Name</span>
              <input name="name" defaultValue={formConfig.name} placeholder="Untitled config" disabled={!isConfigFormEditable} />
            </label>
            <label>
              <span>Platform</span>
              <select name="provider" defaultValue={formConfig.provider} disabled={!isConfigFormEditable}>
                {PROVIDERS.map((provider) => (
                  <option value={provider.value} key={provider.value}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Repos</span>
              <textarea
                name="repos"
                rows="5"
                defaultValue={formConfig.repos.join("\n")}
                placeholder={repoInput.placeholder}
                disabled={!isConfigFormEditable}
              />
              <span className="muted">{repoInput.help}</span>
            </label>
            <label>
              <span>Team members</span>
              <textarea
                name="teamMembers"
                rows="4"
                defaultValue={(formConfig.teamMembers || []).join("\n")}
                placeholder="alice\nbob\ncarol"
                disabled={!isConfigFormEditable}
              />
              <span className="muted">Only PRs opened by these usernames will show up in the dashboard.</span>
            </label>
            <label>
              <span>Bot users</span>
              <textarea
                name="botUsers"
                rows="3"
                defaultValue={(formConfig.botUsers || []).join("\n")}
                placeholder="devops-org-admin\nrenovate[bot]"
                disabled={!isConfigFormEditable}
              />
              <span className="muted">These usernames are excluded from review timing stats and the leaderboard.</span>
            </label>
            <label>
              <span>Repo groups</span>
              <textarea
                name="repoGroups"
                rows="2"
                defaultValue={formConfig.repoGroups.join("\n")}
                placeholder="payments, frontend"
                disabled={!isConfigFormEditable}
              />
            </label>
            <label>
              <span>YouTube livestream URL</span>
              <input
                name="youtubeLivestreamUrl"
                type="url"
                defaultValue={formConfig.youtubeLivestreamUrl || ""}
                placeholder="https://www.youtube.com/watch?v=..."
                disabled={!isConfigFormEditable}
              />
              <span className="muted">Used by TV mode. Supports standard YouTube watch, live, embed, and youtu.be links.</span>
            </label>
            <div className="grid two">
              <label>
                <span>Time window (days)</span>
                <input name="timeWindowDays" type="number" min="1" defaultValue={formConfig.timeWindowDays} disabled={!isConfigFormEditable} />
              </label>
              <label>
                <span>Polling (minutes)</span>
                <input name="pollingMinutes" type="number" min="1" defaultValue={formConfig.pollingMinutes} disabled={!isConfigFormEditable} />
              </label>
            </div>
            <label>
              <span>Queue filter</span>
              <select name="queueFilter" defaultValue={formConfig.queueFilter} disabled={!isConfigFormEditable}>
                {QUEUE_FILTERS.map((filter) => (
                  <option value={filter.value} key={filter.value}>
                    {filter.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <button type="submit" className={isSavingConfig ? "button-with-spinner is-saving" : "button-with-spinner"} disabled={isSavingConfig || !isConfigFormEditable}>
                <span className="button-label">{isCreatingConfig ? "Create config" : "Save config"}</span>
                {isSavingConfig ? <span className="button-spinner" aria-hidden="true" /> : null}
              </button>
              <button type="button" className="ghost" disabled={!selectedConfig?.id || !isEditingConfig} onClick={handleDeleteConfig}>
                Delete
              </button>
              <button type="button" className="ghost" onClick={() => void loadDashboard()}>
                Refresh
              </button>
            </div>
          </form>
          {shareUrl ? (
            <div className="share-box">
              <label>
                <span>Share link</span>
                <input readOnly value={shareUrl} />
              </label>
              <button type="button" onClick={handleCopyShare}>
                Copy link
              </button>
            </div>
          ) : (
            <p className="muted">Save a config to generate a shareable link.</p>
          )}
          </section>
        </section>
      ) : page === "dashboard" ? (
        <PanelBoard
          layoutClassName="layout-main layout-main-board"
          items={dashboardPanels}
          order={panelOrders.dashboard}
          isArranging={isArrangingPanels}
          onReorder={(nextOrder) => handlePanelReorder("dashboard", nextOrder)}
        />
      ) : (
        <PanelBoard
          layoutClassName="layout-activity"
          items={activityPanels}
          order={panelOrders.activity}
          isArranging={isArrangingPanels}
          onReorder={(nextOrder) => handlePanelReorder("activity", nextOrder)}
        />
      )}
    </main>
  );
}
