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

function renderMarkdown(stats, topRepos) {
  const {
    repoCount, totalCommits, openIssues, closedIssues,
    openPRs, closedPRs, mergedPRs, stars, forks,
  } = stats;

  const lines = [];
  lines.push(`### 📊 Organisation Stats for **${ORG}**`);
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|---|---:|");
  lines.push(`| Repositories | ${formatNumber(repoCount)} |`);
  lines.push(`| Commits (default branches) | ${formatNumber(totalCommits)} |`);
  lines.push(`| Issues — Open | ${formatNumber(openIssues)} |`);
  lines.push(`| Issues — Closed | ${formatNumber(closedIssues)} |`);
  lines.push(`| PRs — Open | ${formatNumber(openPRs)} |`);
  lines.push(`| PRs — Closed | ${formatNumber(closedPRs)} |`);
  lines.push(`| PRs — Merged | ${formatNumber(mergedPRs)} |`);
  lines.push(`| Stars | ${formatNumber(stars)} |`);
  lines.push(`| Forks | ${formatNumber(forks)} |`);
  lines.push("");
  lines.push(`<sub>Updated: ${new Date().toISOString().replace("T"," ").replace("Z"," UTC")}</sub>`);
  lines.push("");

  if (topRepos.length) {
    lines.push("#### ⭐ Top repositories by commits (default branch)");
    lines.push("");
    lines.push("| Repository | Commits | Open Issues | Open PRs | Stars | Forks |");
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const r of topRepos) {
      lines.push(
        `| [${r.name}](https://github.com/${ORG}/${r.name}) | ${formatNumber(r.commits)} | ${formatNumber(r.issuesOpen)} | ${formatNumber(r.prsOpen)} | ${formatNumber(r.stars)} | ${formatNumber(r.forks)} |`
      );
    }
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
