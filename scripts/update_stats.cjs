#!/usr/bin/env node
/**
 * Update the org profile README stats block using GitHub GraphQL.
 *
 * Env:
 *   ORG        - required, your org login ("kir-rescomp")
 *   GH_TOKEN   - a token; PAT with read:org + repo if you want private repos included,
 *                otherwise the default GITHUB_TOKEN works for public.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const ORG = process.env.ORG || "kir-rescomp";
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!GH_TOKEN) {
  console.error("Missing GH_TOKEN/GITHUB_TOKEN environment variable.");
  process.exit(1);
}

// Tweak filters:
const INCLUDE_FORKS = false;
const INCLUDE_ARCHIVED = false;
// null => both public & private; or "PUBLIC" / "PRIVATE"
const PRIVACY = null;

const README_PATH = path.join(process.cwd(), "profile", "README.md");

const gql = (query, variables) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify({ query, variables });
    const req = https.request(
      {
        method: "POST",
        hostname: "api.github.com",
        path: "/graphql",
        headers: {
          "User-Agent": "org-profile-stats",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Authorization: `Bearer ${GH_TOKEN}`,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            if (json.errors) return reject(json.errors);
            resolve(json.data);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });

const REPO_PAGE_SIZE = 50;

const REPOS_QUERY = `
query($org:String!, $after:String, $isFork:Boolean, $privacy:RepositoryPrivacy, $pageSize:Int!) {
  organization(login: $org) {
    repositories(first: $pageSize, after: $after, isFork: $isFork, privacy: $privacy, ownerAffiliations: OWNER, orderBy:{field:NAME, direction:ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        isFork
        isArchived
        stargazerCount
        forkCount
        issues(states: OPEN) { totalCount }
        issuesClosed: issues(states: CLOSED) { totalCount }
        pullRequests(states: OPEN) { totalCount }
        pullRequestsClosed: pullRequests(states: CLOSED) { totalCount }
        pullRequestsMerged: pullRequests(states: MERGED) { totalCount }
        defaultBranchRef {
          name
          target {
            ... on Commit {
              history {
                totalCount
              }
            }
          }
        }
      }
    }
  }
}
`;

async function fetchAllRepos() {
  let after = null;
  const all = [];
  while (true) {
    const data = await gql(REPOS_QUERY, {
      org: ORG,
      after,
      isFork: INCLUDE_FORKS ? null : false,
      privacy: PRIVACY,
      pageSize: REPO_PAGE_SIZE,
    });
    const page = data?.organization?.repositories;
    if (!page) break;
    let nodes = page.nodes || [];
    if (!INCLUDE_ARCHIVED) nodes = nodes.filter((r) => !r.isArchived);
    all.push(...nodes);
    if (page.pageInfo.hasNextPage) after = page.pageInfo.endCursor;
    else break;
  }
  return all;
}

function formatNumber(n) {
  return new Intl.NumberFormat("en-GB").format(n);
}

function renderBadge(label, value, color = "blue", logo = "", link = "") {
  const badge = `![${label} - ${value}](https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(String(value))}-${color}?style=for-the-badge${logo ? `&logo=${encodeURIComponent(logo)}` : ""})`;
  return link ? `[${badge}](${link})` : badge;
}

function renderMarkdown(stats, topRepos) {
  const {
    repoCount,
    totalCommits,
    openIssues,
    closedIssues,
    openPRs,
    closedPRs,
    mergedPRs,
    stars,
    forks,
  } = stats;

  const fmt = (n) => new Intl.NumberFormat("en-GB").format(n);

  const badges = [
    renderBadge("Repos", fmt(repoCount), "0a84ff", "github", `https://github.com/${ORG}?tab=repositories`),
    renderBadge("Commits", fmt(totalCommits), "10b981"),
    renderBadge("Issues (open)", fmt(openIssues), "f59e0b"),
    renderBadge("PRs (open)", fmt(openPRs), "8b5cf6"),
    renderBadge("Stars", fmt(stars), "14b8a6", "github"),
    renderBadge("Forks", fmt(forks), "06b6d4", "github"),
  ].join(" ");

  const lines = [];
  lines.push(`### 📊 Organisation Stats for **${ORG}**`);
  lines.push("");
  lines.push(`<div align="center">${badges}</div>`);
  lines.push("");
  lines.push(`<table>`);
  lines.push(`<thead>`);
  lines.push(`<tr>`);
  lines.push(`<th align="left">Metric</th><th align="right">Count</th>`);
  lines.push(`</tr>`);
  lines.push(`</thead>`);
  lines.push(`<tbody>`);
  lines.push(`<tr><td>📦 Repositories</td><td align="right"><code>${fmt(repoCount)}</code></td></tr>`);
  lines.push(`<tr><td>🧭 Commits (default branches)</td><td align="right"><code>${fmt(totalCommits)}</code></td></tr>`);
  lines.push(`<tr><td>🐞 Issues — Open</td><td align="right"><code>${fmt(openIssues)}</code></td></tr>`);
  lines.push(`<tr><td>✅ Issues — Closed</td><td align="right"><code>${fmt(closedIssues)}</code></td></tr>`);
  lines.push(`<tr><td>🔁 PRs — Open</td><td align="right"><code>${fmt(openPRs)}</code></td></tr>`);
  lines.push(`<tr><td>🧹 PRs — Closed</td><td align="right"><code>${fmt(closedPRs)}</code></td></tr>`);
  lines.push(`<tr><td>🎉 PRs — Merged</td><td align="right"><code>${fmt(mergedPRs)}</code></td></tr>`);
  lines.push(`<tr><td>⭐ Stars</td><td align="right"><code>${fmt(stars)}</code></td></tr>`);
  lines.push(`<tr><td>🍴 Forks</td><td align="right"><code>${fmt(forks)}</code></td></tr>`);
  lines.push(`</tbody>`);
  lines.push(`</table>`);
  lines.push("");
  lines.push(`<sub>Updated: ${new Date().toISOString().replace("T", " ").replace("Z", " UTC")}</sub>`);
  lines.push("");

  if (topRepos.length) {
    lines.push(`<details>`);
    lines.push(`<summary><b>⭐ Top repositories by commits</b></summary>`);
    lines.push("");
    lines.push(`| Repository | Commits | Open Issues | Open PRs | Stars | Forks |`);
    lines.push(`|---|---:|---:|---:|---:|---:|`);
    for (const r of topRepos) {
      lines.push(
        `| [${r.name}](https://github.com/${ORG}/${r.name}) | ${fmt(r.commits)} | ${fmt(r.issuesOpen)} | ${fmt(r.prsOpen)} | ${fmt(r.stars)} | ${fmt(r.forks)} |`
      );
    }
    lines.push(`</details>`);
    lines.push("");
  }

  return lines.join("\n");
}


function replaceStatsSection(readme, newBlock) {
  const start = "<!-- ORG-STATS:START -->";
  const end = "<!-- ORG-STATS:END -->";
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`, "m");
  const replacement = `${start}\n${newBlock}\n${end}`;
  if (!pattern.test(readme)) return `${readme.trim()}\n\n${replacement}\n`;
  return readme.replace(pattern, replacement);
}

(async () => {
  try {
    const repos = await fetchAllRepos();

    const aggregated = {
      repoCount: 0, totalCommits: 0,
      openIssues: 0, closedIssues: 0,
      openPRs: 0, closedPRs: 0, mergedPRs: 0,
      stars: 0, forks: 0,
    };

    const perRepo = [];

    for (const r of repos) {
      const commits = r.defaultBranchRef?.target?.history?.totalCount ?? 0;
      const issuesOpen = r.issues?.totalCount ?? 0;
      const issuesClosed = r.issuesClosed?.totalCount ?? 0;
      const prsOpen = r.pullRequests?.totalCount ?? 0;
      const prsClosed = r.pullRequestsClosed?.totalCount ?? 0;
      const prsMerged = r.pullRequestsMerged?.totalCount ?? 0;
      const stars = r.stargazerCount ?? 0;
      const forks = r.forkCount ?? 0;

      aggregated.repoCount += 1;
      aggregated.totalCommits += commits;
      aggregated.openIssues += issuesOpen;
      aggregated.closedIssues += issuesClosed;
      aggregated.openPRs += prsOpen;
      aggregated.closedPRs += prsClosed;
      aggregated.mergedPRs += prsMerged;
      aggregated.stars += stars;
      aggregated.forks += forks;

      perRepo.push({ name: r.name, commits, issuesOpen, prsOpen, stars, forks });
    }

    perRepo.sort((a, b) => b.commits - a.commits);
    const topRepos = perRepo.slice(0, 10);

    const mdBlock = renderMarkdown(aggregated, topRepos);

    const readme = fs.readFileSync(README_PATH, "utf8");
    const updated = replaceStatsSection(readme, mdBlock);
    if (updated !== readme) {
      fs.writeFileSync(README_PATH, updated, "utf8");
      console.log("README updated.");
    } else {
      console.log("No change detected.");
    }
  } catch (err) {
    console.error("Failed to update stats:", err);
    process.exit(1);
  }
})();
