import { readFile } from "node:fs/promises";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function failClosed(message) {
  return { status: "inconclusive", findings: [message] };
}

function normalizeLogin(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseClosingIssueNumbers(body = "") {
  const numbers = new Set();
  const pattern = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+(?:https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/)?#?(\d+)\b/gi;
  for (const match of String(body).matchAll(pattern)) numbers.add(Number(match[1]));
  return [...numbers].filter((number) => Number.isSafeInteger(number) && number > 0);
}

export function parseCoauthorEmails(message = "") {
  const emails = new Set();
  for (const match of String(message).matchAll(/^Co-authored-by:\s*.*?<([^<>\s]+@[^<>\s]+)>\s*$/gim)) {
    emails.add(match[1].trim().toLowerCase());
  }
  return [...emails];
}

function addActor(participants, login, source) {
  if (typeof login !== "string" || !login.trim()) return;
  participants.push({ identity: login.trim(), kind: "login", source });
}

function addEmail(participants, email, source) {
  if (typeof email !== "string" || !email.trim()) return;
  participants.push({ identity: email.trim().toLowerCase(), kind: "email", source });
}

function collectParticipants({ pull, comments, reviews, reviewComments, commits, issueEvents }) {
  const participants = [];
  addActor(participants, pull.user?.login, "pull request author");

  for (const item of comments) addActor(participants, item.user?.login, "conversation comment");
  for (const item of reviews) addActor(participants, item.user?.login, "submitted review");
  for (const item of reviewComments) addActor(participants, item.user?.login, "inline review comment");

  for (const item of commits) {
    addActor(participants, item.author?.login, `commit author (${item.sha?.slice(0, 7) ?? "unknown commit"})`);
    addActor(participants, item.committer?.login, `commit committer (${item.sha?.slice(0, 7) ?? "unknown commit"})`);
    for (const email of parseCoauthorEmails(item.commit?.message)) {
      addEmail(participants, email, `Co-authored-by trailer (${item.sha?.slice(0, 7) ?? "unknown commit"})`);
    }
  }

  for (const event of issueEvents) {
    if (event.event === "review_requested" || event.event === "review_request_removed") {
      addActor(participants, event.actor?.login, `reviewer change requester (${event.event})`);
      addActor(participants, event.requested_reviewer?.login, `reviewer target (${event.event})`);
      if (event.requested_team?.slug) {
        participants.push({
          identity: event.requested_team.slug,
          kind: "team",
          source: `reviewer team target (${event.event})`,
        });
      }
    }
  }

  for (const reviewer of pull.requested_reviewers ?? []) {
    addActor(participants, reviewer.login, "currently requested reviewer");
  }
  for (const team of pull.requested_teams ?? []) {
    if (team.slug) participants.push({ identity: team.slug, kind: "team", source: "currently requested reviewer team" });
  }

  return participants;
}

function validException(exception, participant, now) {
  if (!isRecord(exception) || !exception.login || !exception.reason || !exception.expiresAt) return false;
  if (Date.parse(exception.expiresAt) <= now || !Number.isFinite(Date.parse(exception.expiresAt))) return false;
  return participant.kind === "login"
    && normalizeLogin(exception.login) === normalizeLogin(participant.identity);
}

export function evaluateParticipantData(data, config, now = Date.now()) {
  const findings = [];
  const linkedIssues = parseClosingIssueNumbers(data.pull.body ?? "");
  if (linkedIssues.length === 0) {
    return failClosed("No closing reference to an issue was found in the pull request body; contributor assignment cannot be verified.");
  }

  const assignedLogins = new Set();
  for (const issue of data.linkedIssues ?? []) {
    if (!issue || !Number.isSafeInteger(issue.number) || !Array.isArray(issue.assignees)) {
      return failClosed("Linked issue data is incomplete; assignment could not be verified.");
    }
    for (const assignee of issue.assignees) {
      if (assignee?.login) assignedLogins.add(normalizeLogin(assignee.login));
    }
  }

  const returnedIssueNumbers = new Set((data.linkedIssues ?? []).map((issue) => issue.number));
  const missingIssues = linkedIssues.filter((number) => !returnedIssueNumbers.has(number));
  if (missingIssues.length) {
    return failClosed(`Linked issue data is missing for: ${missingIssues.map((n) => `#${n}`).join(", ")}.`);
  }
  if (assignedLogins.size === 0) {
    return failClosed("The linked issue(s) have no assignees; contributor identity cannot be verified.");
  }

  const maintainers = new Set((config.maintainers ?? []).map(normalizeLogin));
  const approvedBots = new Set((config.approvedBots ?? []).map(normalizeLogin));
  const approvedCoauthorEmails = new Set((config.approvedCoauthorEmails ?? []).map((email) => String(email).trim().toLowerCase()));
  const allowedLogins = new Set([...maintainers, ...assignedLogins, ...approvedBots]);
  const participants = collectParticipants(data);

  if (data.pull.user?.login && !allowedLogins.has(normalizeLogin(data.pull.user.login))) {
    findings.push(`PR author @${data.pull.user.login} is not a configured maintainer or assignee of a linked issue.`);
  }

  for (const participant of participants) {
    const allowed = participant.kind === "email"
      ? approvedCoauthorEmails.has(participant.identity)
      : participant.kind === "team"
        ? (config.approvedReviewerTeams ?? []).map((team) => String(team).toLowerCase()).includes(participant.identity.toLowerCase())
        : allowedLogins.has(normalizeLogin(participant.identity));

    const excepted = (config.exceptions ?? []).some((exception) => validException(exception, participant, now));
    if (!allowed && !excepted) {
      findings.push(`Unexpected ${participant.kind} "${participant.identity}" in ${participant.source}.`);
    }
  }

  const uniqueFindings = [...new Set(findings)];
  return {
    status: uniqueFindings.length ? "failure" : "pass",
    findings: uniqueFindings,
    linkedIssues,
    assignedContributors: [...assignedLogins].sort(),
    participantCount: participants.length,
  };
}

async function readJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "stellarcore-pr-participant-guard",
    },
  });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status} for ${url}`);
  const body = await response.json();
  return { body, link: response.headers.get("link") };
}

export async function readAllPages(url, token) {
  const items = [];
  let next = url;
  let pages = 0;
  while (next) {
    pages += 1;
    if (pages > MAX_PAGES) throw new Error(`Pagination exceeded ${MAX_PAGES} pages for ${url}`);
    const { body, link } = await readJson(next, token);
    if (!Array.isArray(body)) throw new Error(`Expected an array response from ${next}`);
    items.push(...body);
    const nextLink = link?.split(",").map((part) => part.trim()).find((part) => /rel="next"/.test(part));
    next = nextLink?.match(/<([^>]+)>/)?.[1] ?? "";
    if (!link && body.length === PAGE_SIZE) {
      throw new Error(`Pagination response omitted Link header for full page from ${url}`);
    }
  }
  return items;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const pullNumber = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !/^\d+$/.test(pullNumber ?? "") || !token) {
    throw new Error("GITHUB_REPOSITORY, numeric PR_NUMBER, and GITHUB_TOKEN are required.");
  }

  const configPath = new URL("../../.github/pr-participant-guard.json", import.meta.url);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const api = `${API_ROOT}/repos/${repository}`;
  const { body: pull } = await readJson(`${api}/pulls/${pullNumber}`, token);
  if (!pull || !pull.user) {
    throw new Error("Pull request response is incomplete.");
  }

  pull.requested_reviewers ??= [];
  const issueNumbers = parseClosingIssueNumbers(pull.body ?? "");
  const [comments, reviews, reviewComments, commits, issueEvents] = await Promise.all([
    readAllPages(`${api}/issues/${pullNumber}/comments?per_page=${PAGE_SIZE}`, token),
    readAllPages(`${api}/pulls/${pullNumber}/reviews?per_page=${PAGE_SIZE}`, token),
    readAllPages(`${api}/pulls/${pullNumber}/comments?per_page=${PAGE_SIZE}`, token),
    readAllPages(`${api}/pulls/${pullNumber}/commits?per_page=${PAGE_SIZE}`, token),
    readAllPages(`${api}/issues/${pullNumber}/events?per_page=${PAGE_SIZE}`, token),
  ]);
  const linkedIssues = await Promise.all(issueNumbers.map(async (number) => {
    const { body } = await readJson(`${api}/issues/${number}`, token);
    if (body.number !== number || !Array.isArray(body.assignees)) throw new Error(`Issue #${number} response is incomplete.`);
    return { number, assignees: body.assignees };
  }));

  const result = evaluateParticipantData({ pull, comments, reviews, reviewComments, commits, issueEvents, linkedIssues }, config);
  console.log(`PR Participant Guard: ${result.status.toUpperCase()}`);
  for (const finding of result.findings) console.log(`- ${finding}`);
  if (result.status !== "pass") process.exitCode = 1;
  else console.log(`Reviewed ${result.participantCount} participation records across linked issue(s): ${result.linkedIssues.map((n) => `#${n}`).join(", ")}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`PR Participant Guard: INCONCLUSIVE — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
