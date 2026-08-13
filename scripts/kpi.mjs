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

// ---------------------------------------------------------------- streak

const days = u.year.contributionCalendar.weeks
  .flatMap((w) => w.contributionDays)
  .filter((x) => x.date <= day(now));

// Walks backwards; today counting as 0 does not break the streak yet.
let current = 0;
for (let i = days.length - 1; i >= 0; i--) {
  if (days[i].contributionCount > 0) current++;
  else if (i === days.length - 1) continue;
  else break;
}

// ---------------------------------------------------------------- render

// shields.io reserves - and _ , so they need doubling.
const enc = (s) =>
  String(s).replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "%20");

const badge = (label, value) =>
  `<img src="https://img.shields.io/badge/${enc(label)}-${enc(value)}-8B0000?style=for-the-badge&labelColor=0d1117" alt="${label}: ${value}" />`;

const stats = [
  badge("commits", u.year.totalCommitContributions.toLocaleString()),
  badge("pull requests", d.prMergedYear.issueCount.toLocaleString()),
  badge("issues closed", d.issClosedYear.issueCount.toLocaleString()),
  badge("streak", `${current}d`),
].join("\n  ");

const row = (label, c, prOpen, prMerged, iss, repos) =>
  `| ${label} | ${c.toLocaleString()} | ${prOpen} | ${prMerged} | ${iss} | ${repos} |`;

const table = [
  "| | Commits | PRs opened | PRs merged | Issues closed | Repos |",
  "| :--- | ---: | ---: | ---: | ---: | ---: |",
  row(
    "**This week**",
    u.week.totalCommitContributions,
    u.week.totalPullRequestContributions,
    d.prMergedWeek.issueCount,
    d.issClosedWeek.issueCount,
    u.week.totalRepositoriesWithContributedCommits,
  ),
  row(
    "**This month**",
    u.month.totalCommitContributions,
    u.month.totalPullRequestContributions,
    d.prMergedMonth.issueCount,
    d.issClosedMonth.issueCount,
    u.month.totalRepositoriesWithContributedCommits,
  ),
  row(
    "**Last 12 months**",
    u.year.totalCommitContributions,
    u.year.totalPullRequestContributions,
    d.prMergedYear.issueCount,
    d.issClosedYear.issueCount,
    u.year.totalRepositoriesWithContributedCommits,
  ),
].join("\n");

const block = `${START}

<p align="center">
  ${stats}
</p>

${table}

${END}`;

const md = await readFile(README, "utf8");
const s = md.indexOf(START);
const e = md.indexOf(END);
if (s === -1 || e === -1) {
  console.error(`Markers ${START} / ${END} not found in README.md`);
  process.exit(1);
}

await writeFile(README, md.slice(0, s) + block + md.slice(e + END.length), "utf8");
console.log(`Battle Log updated — ${u.year.totalCommitContributions} commits, streak ${current}d.`);
