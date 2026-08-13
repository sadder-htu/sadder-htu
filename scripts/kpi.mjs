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

const res = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    Authorization: `bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": `${LOGIN}-battle-log`,
  },
  body: JSON.stringify({
    query: QUERY,
    variables: {
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
    },
  }),
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

const d = body.data;
const u = d.user;

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

<sub>Auto-generated from the GitHub GraphQL API — private repositories included. Last muster: ${stamp} UTC.</sub>

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
