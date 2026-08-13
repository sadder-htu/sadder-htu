#!/usr/bin/env node
/**
 * Battle Log generator.
 *
 * Reads real contribution data (including private repos, which anonymous stat
 * cards cannot see) and rewrites the block between the KPI markers in README.md.
 *
 * Env:
 *   GH_TOKEN  required, needs `repo` + `read:user` to count private work
 *   GH_LOGIN  optional, defaults to sadder-htu
 */

import { readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.GH_TOKEN;
const LOGIN = process.env.GH_LOGIN || "sadder-htu";
const README = new URL("../README.md", import.meta.url);
const START = "<!--START:BATTLE_LOG-->";
const END = "<!--END:BATTLE_LOG-->";

if (!TOKEN) {
  console.error("GH_TOKEN is not set");
  process.exit(1);
}

// ---------------------------------------------------------------- date windows

const now = new Date();
const iso = (d) => d.toISOString();
const day = (d) => d.toISOString().slice(0, 10);

// Current ISO week, Monday 00:00 UTC.
const weekStart = new Date(now);
weekStart.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
weekStart.setUTCHours(0, 0, 0, 0);

// Current calendar month.
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

// Rolling 12 months.
const yearStart = new Date(now);
yearStart.setUTCFullYear(now.getUTCFullYear() - 1);

// Delivery-speed sample window.
const cycleStart = new Date(now);
cycleStart.setUTCDate(now.getUTCDate() - 90);

// ---------------------------------------------------------------- graphql

const QUERY = `
query($login:String!, $wFrom:DateTime!, $mFrom:DateTime!, $yFrom:DateTime!, $now:DateTime!,
      $pw:String!, $pm:String!, $py:String!, $iw:String!, $im:String!, $iy:String!) {
  user(login:$login) {
    name
    week:  contributionsCollection(from:$wFrom, to:$now) { ...C }
    month: contributionsCollection(from:$mFrom, to:$now) { ...C }
    year:  contributionsCollection(from:$yFrom, to:$now) {
      ...C
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
      commitContributionsByRepository(maxRepositories:100) {
        contributions { totalCount }
        repository {
          languages(first:10, orderBy:{field:SIZE, direction:DESC}) {
            edges { size node { name } }
          }
        }
      }
    }
  }
  prMergedWeek:  search(query:$pw, type:ISSUE) { issueCount }
  prMergedMonth: search(query:$pm, type:ISSUE) { issueCount }
  prMergedYear:  search(query:$py, type:ISSUE) { issueCount }
  issClosedWeek:  search(query:$iw, type:ISSUE) { issueCount }
  issClosedMonth: search(query:$im, type:ISSUE) { issueCount }
  issClosedYear:  search(query:$iy, type:ISSUE) { issueCount }
}
fragment C on ContributionsCollection {
  totalCommitContributions
  totalPullRequestContributions
  totalIssueContributions
  totalPullRequestReviewContributions
  totalRepositoriesWithContributedCommits
}`;

const merged = (since) => `author:${LOGIN} type:pr is:merged merged:>=${since}`;
const closed = (since) => `author:${LOGIN} type:issue is:closed closed:>=${since}`;

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${LOGIN}-battle-log`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    console.error(`GitHub API ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const body = await res.json();
  if (body.errors) {
    console.error(JSON.stringify(body.errors, null, 2));
    process.exit(1);
  }
  return body.data;
}

const d = await gql(QUERY, {
  login: LOGIN,
  wFrom: iso(weekStart),
  mFrom: iso(monthStart),
  yFrom: iso(yearStart),
  now: iso(now),
  pw: merged(day(weekStart)),
  pm: merged(day(monthStart)),
  py: merged(day(yearStart)),
  iw: closed(day(weekStart)),
  im: closed(day(monthStart)),
  iy: closed(day(yearStart)),
});
const u = d.user;

// ---------------------------------------------------------------- delivery speed

// Search caps at 100 nodes per page, so walk pages until the window is covered.
const CYCLE_QUERY = `
query($q:String!, $after:String) {
  search(query:$q, type:ISSUE, first:100, after:$after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { createdAt mergedAt } }
  }
}`;

const cycleHours = [];
let cursor = null;
let cycleTotal = 0;
for (let page = 0; page < 5; page++) {
  const r = await gql(CYCLE_QUERY, { q: merged(day(cycleStart)), after: cursor });
  cycleTotal = r.search.issueCount;
  for (const n of r.search.nodes) {
    if (!n?.createdAt || !n?.mergedAt) continue;
    const h = (Date.parse(n.mergedAt) - Date.parse(n.createdAt)) / 3.6e6;
    if (h >= 0) cycleHours.push(h);
  }
  if (!r.search.pageInfo.hasNextPage) break;
  cursor = r.search.pageInfo.endCursor;
}

cycleHours.sort((a, b) => a - b);
const pct = (p) =>
  cycleHours.length ? cycleHours[Math.min(cycleHours.length - 1, Math.floor(cycleHours.length * p))] : 0;

const dur = (h) =>
  h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;

const sameDay = cycleHours.length
  ? Math.round((100 * cycleHours.filter((h) => h < 24).length) / cycleHours.length)
  : 0;

// ---------------------------------------------------------------- language mix

// Weight each repository's language mix by this author's share of commits in it.
// Raw byte totals would let a repo touched once outweigh one worked in daily.
const langWeight = new Map();
const repos = u.year.commitContributionsByRepository ?? [];
const commitTotal = repos.reduce((s, r) => s + r.contributions.totalCount, 0) || 1;

for (const r of repos) {
  const edges = r.repository.languages?.edges ?? [];
  const repoBytes = edges.reduce((s, e) => s + e.size, 0);
  if (!repoBytes) continue;
  const share = r.contributions.totalCount / commitTotal;
  for (const e of edges) {
    const w = (e.size / repoBytes) * share;
    langWeight.set(e.node.name, (langWeight.get(e.node.name) ?? 0) + w);
  }
}

const langTotal = [...langWeight.values()].reduce((s, v) => s + v, 0) || 1;
const langs = [...langWeight.entries()]
  .map(([name, w]) => ({ name, pct: (100 * w) / langTotal }))
  .sort((a, b) => b.pct - a.pct)
  .slice(0, 6);

const langChart = langs
  .map((l) => {
    const filled = Math.round((l.pct / 100) * 20);
    return `${l.name.padEnd(12)} ${"█".repeat(filled)}${"░".repeat(20 - filled)}  ${l.pct.toFixed(1).padStart(5)}%`;
  })
  .join("\n");

// ---------------------------------------------------------------- streaks

const days = u.year.contributionCalendar.weeks
  .flatMap((w) => w.contributionDays)
  .filter((x) => x.date <= day(now));

let longest = 0;
let run = 0;
for (const x of days) {
  run = x.contributionCount > 0 ? run + 1 : 0;
  if (run > longest) longest = run;
}

// Current streak walks backwards; today counting as 0 does not break it yet.
let current = 0;
for (let i = days.length - 1; i >= 0; i--) {
  if (days[i].contributionCount > 0) current++;
  else if (i === days.length - 1) continue;
  else break;
}

const best = days.reduce(
  (a, b) => (b.contributionCount > a.contributionCount ? b : a),
  { date: "-", contributionCount: 0 },
);
const active = days.filter((x) => x.contributionCount > 0).length;

// ---------------------------------------------------------------- 12-week chart

const weeks = u.year.contributionCalendar.weeks.slice(-12).map((w) => ({
  label: w.contributionDays[0].date.slice(5),
  total: w.contributionDays
    .filter((x) => x.date <= day(now))
    .reduce((s, x) => s + x.contributionCount, 0),
}));

const peak = Math.max(...weeks.map((w) => w.total), 1);
const chart = weeks
  .map((w) => {
    const filled = Math.round((w.total / peak) * 24);
    const bar = "█".repeat(filled) + "░".repeat(24 - filled);
    return `${w.label}  ${bar}  ${String(w.total).padStart(4)}`;
  })
  .join("\n");

// ---------------------------------------------------------------- render

const row = (label, c, prOpen, prMerged, iss, rev, repos) =>
  `| **${label}** | ${c} | ${prOpen} | ${prMerged} | ${iss} | ${rev} | ${repos} |`;

const table = [
  "| Window | Commits | PRs opened | PRs merged | Issues closed | Reviews | Repos touched |",
  "| :--- | ---: | ---: | ---: | ---: | ---: | ---: |",
  row(
    "This week",
    u.week.totalCommitContributions,
    u.week.totalPullRequestContributions,
    d.prMergedWeek.issueCount,
    d.issClosedWeek.issueCount,
    u.week.totalPullRequestReviewContributions,
    u.week.totalRepositoriesWithContributedCommits,
  ),
  row(
    "This month",
    u.month.totalCommitContributions,
    u.month.totalPullRequestContributions,
    d.prMergedMonth.issueCount,
    d.issClosedMonth.issueCount,
    u.month.totalPullRequestReviewContributions,
    u.month.totalRepositoriesWithContributedCommits,
  ),
  row(
    "Last 12 months",
    u.year.totalCommitContributions,
    u.year.totalPullRequestContributions,
    d.prMergedYear.issueCount,
    d.issClosedYear.issueCount,
    u.year.totalPullRequestReviewContributions,
    u.year.totalRepositoriesWithContributedCommits,
  ),
].join("\n");

const stamp = now.toISOString().slice(0, 16).replace("T", " ");

const block = `${START}

${table}

<samp>

\`\`\`text
CONTRIBUTIONS — LAST 12 WEEKS
${chart}
\`\`\`

</samp>

| 🔥 Current streak | 🏆 Longest streak | ⚔️ Best day | 📅 Active days (1y) | Σ Contributions (1y) |
| :---: | :---: | :---: | :---: | :---: |
| **${current}** days | **${longest}** days | **${best.contributionCount}** on ${best.date} | **${active}** / 365 | **${u.year.contributionCalendar.totalContributions}** |

### 🏹 Delivery speed

| Median time to merge | p90 | Merged within a day | Sample |
| :---: | :---: | :---: | :---: |
| **${dur(pct(0.5))}** | ${dur(pct(0.9))} | ${sameDay}% | ${cycleHours.length} of ${cycleTotal} PRs, last 90d |

### 🗡️ Languages

<samp>

\`\`\`text
${langChart}
\`\`\`

</samp>

<sub>Weighted by share of commits per repository, not raw bytes — a repo touched once
should not outrank one worked in daily.</sub>

<sub>Auto-generated from the GitHub GraphQL API — private repositories included, names withheld. Last muster: ${stamp} UTC.</sub>

${END}`;

const md = await readFile(README, "utf8");
const s = md.indexOf(START);
const e = md.indexOf(END);
if (s === -1 || e === -1) {
  console.error(`Markers ${START} / ${END} not found in README.md`);
  process.exit(1);
}

await writeFile(README, md.slice(0, s) + block + md.slice(e + END.length), "utf8");
console.log(`Battle Log updated — ${u.year.contributionCalendar.totalContributions} contributions, streak ${current}d.`);
