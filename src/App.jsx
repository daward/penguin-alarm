import { startTransition, useEffect, useMemo, useState } from "react";

import { PROVIDERS, DEFAULT_CONFIG, QUEUE_FILTERS, RATING_OPTIONS } from "./constants.js";
import { getAdapter } from "./adapters/index.js";
import { buildMergedItems, buildQueueItems, computeLeaderboard, computeStats } from "./metrics.js";
import {
  createId,
  clearToken,
  deleteConfig,
  exportConfig,
  getSelectedConfig,
  importConfig,
  readConfigs,
  readRatings,
  readToken,
  upsertConfig,
  writeRating,
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

  useEffect(() => {
    setDidFail(false);
  }, [src]);

  if (!src || didFail) {
    return (
      <div className="avatar-fallback" style={getAvatarFallbackStyle(alt)}>
        {getInitials(alt)}
      </div>
    );
  }


  return <img src={src} alt={alt} loading="lazy" onError={() => setDidFail(true)} />;
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
    ratings: readRatings(),
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

function StatPanel({ stats }) {
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
      label: `${timeMetricMode.firstReview === "median" ? "Median" : "Average"} first review (hrs)`,
      value:
        timeMetricMode.firstReview === "median" ? stats.medianTimeToFirstReview : stats.averageTimeToFirstReview,
      metricKey: "firstReview"
    },
    {
      label: `${timeMetricMode.approval === "median" ? "Median" : "Average"} approval time (hrs)`,
      value: timeMetricMode.approval === "median" ? stats.medianTimeToApproval : stats.averageTimeToApproval,
      metricKey: "approval"
    },
    {
      label: `${timeMetricMode.merge === "median" ? "Median" : "Average"} merge time (hrs)`,
      value: timeMetricMode.merge === "median" ? stats.medianTimeToMerge : stats.averageTimeToMerge,
      metricKey: "merge"
    }
  ];

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Team Stats</h2>
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

function PullMetaRow({ statusLabel, commentCount, approvalCount }) {
  return (
    <div className="meta-row">
      <span className="meta-tag">{statusLabel}</span>
      <span className="meta-tag">{commentCount} comments</span>
      <span className="meta-tag">{approvalCount} approvals</span>
    </div>
  );
}

function PullCard({ pull, subtitle, score, statusLabel, children, token }) {
  return (
    <article className="card">
      <div className="card-top">
        <AvatarImage src={pull.user?.avatar_url} alt={pull.user?.login || "author"} token={token} />
        <div>
          <a href={pull.html_url} target="_blank" rel="noreferrer">
            {pull.title}
          </a>
          <p className="muted">{subtitle}</p>
        </div>
        {typeof score === "number" ? <strong>{score}</strong> : null}
      </div>
      <PullMetaRow
        statusLabel={statusLabel}
        commentCount={pull.commentCount}
        approvalCount={pull.approvalCount}
      />
      {children}
    </article>
  );
}

function QueuePanel({ items, token }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Review Queue</h2>
        <span className="badge">{items.length}</span>
      </div>
      <div className="card-list">
        {items.length ? (
          items.map((pull) => (
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

function MergedPanel({ items, ratings, onRate, token }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Recently Merged</h2>
      </div>
      <div className="card-list">
        {items.length ? (
          items.map((pull) => {
            const key = pullKey(pull);
            return (
              <PullCard
                key={key}
                pull={pull}
                subtitle={`${pull.repoName} · merged ${relativeTime(pull.merged_at)}`}
                statusLabel="Merged"
                token={token}
              >
                <div className="rating-row">
                  {RATING_OPTIONS.map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      className={ratings[key] === option.value ? "active" : ""}
                      onClick={() => onRate(key, option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </PullCard>
            );
          })
        ) : (
          <p className="muted">No merged pull requests in the selected window.</p>
        )}
      </div>
    </section>
  );
}

function LeaderboardPanel({ users, token }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Leaderboard</h2>
      </div>
      <div className="card-list">
        {users.length ? (
          users.slice(0, 12).map((user) => (
            <article className="card compact-card" key={user.login}>
              <div className="card-top">
                <AvatarImage src={user.avatarUrl} alt={user.login} token={token} />
                <div>
                  <strong>{user.login}</strong>
                  <p className="muted">
                    {user.approvals} approvals · {user.comments} comments
                  </p>
                </div>
                <strong>{user.score}</strong>
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

export default function App() {
  const initialState = useMemo(() => useBootstrapState(), []);
  const [token, setToken] = useState(initialState.token);
  const [tokenProvider, setTokenProvider] = useState(initialState.selectedConfig?.provider || "github");
  const [tokenDraft, setTokenDraft] = useState(initialState.token);
  const [configs, setConfigs] = useState(initialState.configs);
  const [selectedConfig, setSelectedConfig] = useState(initialState.selectedConfig);
  const [ratings, setRatings] = useState(initialState.ratings);
  const [error, setError] = useState(initialState.error);
  const [isLoading, setIsLoading] = useState(initialState.isLoading);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(initialState.lastUpdatedAt);
  const [rateLimit, setRateLimit] = useState(initialState.rateLimit);
  const [profile, setProfile] = useState(initialState.profile);
  const [queueItems, setQueueItems] = useState(initialState.queueItems);
  const [mergedItems, setMergedItems] = useState(initialState.mergedItems);
  const [stats, setStats] = useState(initialState.stats);
  const [leaderboard, setLeaderboard] = useState(initialState.leaderboard);
  const [isSetupOpen, setIsSetupOpen] = useState(
    () => !(initialState.token && initialState.selectedConfig?.repos?.length)
  );

  const config = selectedConfig || DEFAULT_CONFIG;
  const shareUrl = selectedConfig ? getShareUrl(selectedConfig) : "";
  const adapter = getAdapter(config.provider);
  const tokenAdapter = getAdapter(tokenProvider);
  const repoInput = getRepoInputGuidance(config.provider);

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
    if (!token || !config?.repos.length) {
      setIsSetupOpen(true);
    }
  }, [token, config.id, config.repos.length]);

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
      const scopedOpenPulls = filterPullsByTeam(openPulls, teamMembers);
      const scopedMergedPulls = filterPullsByTeam(mergedPulls, teamMembers);

      startTransition(() => {
        setProfile(viewerProfile);
        setRateLimit(snapshots.at(-1)?.rateLimit || viewerRateLimit);
        setQueueItems(buildQueueItems(scopedOpenPulls, viewerProfile.login, config.queueFilter));
        setMergedItems(buildMergedItems(scopedMergedPulls));
        setStats(computeStats(scopedMergedPulls, scopedOpenPulls));
        setLeaderboard(computeLeaderboard([...scopedOpenPulls, ...scopedMergedPulls]));
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

  function handleSaveToken(event) {
    event.preventDefault();
    writeToken(tokenProvider, tokenDraft, config.id || "");
    const trimmedToken = String(tokenDraft || "").trim();
    setTokenDraft(trimmedToken);

    if (tokenProvider === config.provider) {
      setToken(trimmedToken);
    }

    const activeConfigToken =
      tokenProvider === config.provider ? trimmedToken : readToken(config.provider, config.id || "");
    if (activeConfigToken && config.repos.length) {
      setIsSetupOpen(false);
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
      setLastUpdatedAt("");
    }
  }

  function handleConfigSave(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextConfig = upsertConfig(Object.fromEntries(form.entries()));
    setConfigs(readConfigs());
    setSelectedConfig(nextConfig);
    const configToken = readToken(nextConfig.provider, nextConfig.id || "");
    setToken(configToken);
    setTokenProvider(nextConfig.provider);
    setTokenDraft(configToken);
    if (configToken && nextConfig.repos.length) {
      setIsSetupOpen(false);
    }
  }

  function handleSelectConfig(event) {
    writeSelectedConfigId(event.target.value);
    const nextSelected = getSelectedConfig();
    const nextProvider = nextSelected?.provider || "github";
    const nextToken = readToken(nextProvider, nextSelected?.id || "");

    setSelectedConfig(nextSelected);
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
    setToken(readToken(nextSelected?.provider || "github", nextSelected?.id || ""));
  }

  function handleRate(prKey, rating) {
    writeRating(prKey, rating);
    setRatings(readRatings());
  }

  async function handleCopyShare() {
    if (!selectedConfig) {
      return;
    }

    await navigator.clipboard.writeText(getShareUrl(selectedConfig));
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <h1>Penguin Alarm</h1>
        </div>
        <div className="hero-status">
          <span className="badge">{config.repos.length} repos</span>
          <span className="badge">{lastUpdatedAt ? `Updated ${formatDate(lastUpdatedAt)}` : "Not loaded yet"}</span>
          <button type="button" className="setup-toggle" onClick={() => setIsSetupOpen((value) => !value)}>
            {isSetupOpen ? "Hide setup" : "Show setup"}
          </button>
        </div>
      </header>

      {error ? <div className="banner error">{error}</div> : null}
      {isLoading ? <div className="banner info">Refreshing {adapter.label} data...</div> : null}

      {isSetupOpen ? (
        <section className="layout-top">
          <section className="panel">
          <div className="panel-header">
            <h2>{tokenAdapter.label} Access</h2>
            {profile && tokenProvider === config.provider ? (
              <span className="badge">{profile.login || profile.username}</span>
            ) : null}
          </div>
          <p className="muted">Paste a token for this provider. Data stays in your browser storage.</p>
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

          <section className="panel">
          <div className="panel-header">
            <h2>Monitor Config</h2>
            <div className="row compact">
              <select value={config.id || ""} onChange={handleSelectConfig}>
                {configs.map((savedConfig) => (
                  <option value={savedConfig.id} key={savedConfig.id}>
                    {savedConfig.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost"
                onClick={() => setSelectedConfig({ ...DEFAULT_CONFIG, id: createId() })}
              >
                New
              </button>
            </div>
          </div>
          <form className="stack" key={config.id || "new"} onSubmit={handleConfigSave}>
            <input type="hidden" name="id" value={config.id || ""} />
            <label>
              <span>Name</span>
              <input name="name" defaultValue={config.name} />
            </label>
            <label>
              <span>Platform</span>
              <select name="provider" defaultValue={config.provider}>
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
                defaultValue={config.repos.join("\n")}
                placeholder={repoInput.placeholder}
              />
              <span className="muted">{repoInput.help}</span>
            </label>
            <label>
              <span>Team members</span>
              <textarea
                name="teamMembers"
                rows="4"
                defaultValue={(config.teamMembers || []).join("\n")}
                placeholder="alice\nbob\ncarol"
              />
              <span className="muted">Only PRs opened by these usernames will show up in the dashboard.</span>
            </label>
            <label>
              <span>Repo groups</span>
              <textarea
                name="repoGroups"
                rows="2"
                defaultValue={config.repoGroups.join("\n")}
                placeholder="payments, frontend"
              />
            </label>
            <div className="grid two">
              <label>
                <span>Time window (days)</span>
                <input name="timeWindowDays" type="number" min="1" defaultValue={config.timeWindowDays} />
              </label>
              <label>
                <span>Polling (minutes)</span>
                <input name="pollingMinutes" type="number" min="1" defaultValue={config.pollingMinutes} />
              </label>
            </div>
            <label>
              <span>Queue filter</span>
              <select name="queueFilter" defaultValue={config.queueFilter}>
                {QUEUE_FILTERS.map((filter) => (
                  <option value={filter.value} key={filter.value}>
                    {filter.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <button type="submit">Save config</button>
              <button type="button" className="ghost" disabled={!config.id} onClick={handleDeleteConfig}>
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
      ) : null}

      <section className="layout-main">
        <div className="stack">
          <QueuePanel items={queueItems} token={token} />
          <MergedPanel items={mergedItems} ratings={ratings} onRate={handleRate} token={token} />
        </div>
        <div className="stack">
          <StatPanel stats={stats} />
          <LeaderboardPanel users={leaderboard} token={token} />
        </div>
        <OpsPanel />
      </section>
    </main>
  );
}
