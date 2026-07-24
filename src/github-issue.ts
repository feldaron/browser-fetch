import { readFile } from "node:fs/promises";
import { targetSchema, type FetchTarget, type PriceObservation } from "./types.js";

interface IssueEvent {
  issue: { number: number; body: string | null; title: string };
  repository: { full_name: string };
  sender: { login: string };
}

export async function readIssueTarget(): Promise<{ event: IssueEvent; target: FetchTarget }> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is missing");
  const event = JSON.parse(await readFile(eventPath, "utf8")) as IssueEvent;
  if (!event.issue.title.startsWith("[fetch]")) throw new Error("Issue title must start with [fetch]");
  if (!event.issue.body) throw new Error("Issue body must contain a JSON target object");
  const target = targetSchema.parse(JSON.parse(event.issue.body.trim()));
  return { event, target };
}

async function githubRequest(url: string, init: RequestInit): Promise<Response> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is missing");
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API failed (${response.status}): ${await response.text()}`);
  return response;
}

export async function reportIssueResult(
  event: IssueEvent,
  observation: PriceObservation | null,
  error: string | null,
): Promise<void> {
  const body = observation
    ? [
        "## Browser fetch result",
        "",
        `Status: **${observation.status}**`,
        `Accepted: **${observation.accepted ? "yes" : "no"}**`,
        "",
        "```json",
        JSON.stringify(observation, null, 2),
        "```",
      ].join("\n")
    : `## Browser fetch failed\n\n\`\`\`text\n${error ?? "Unknown error"}\n\`\`\``;

  const base = `https://api.github.com/repos/${event.repository.full_name}/issues/${event.issue.number}`;
  await githubRequest(`${base}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  await githubRequest(base, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
}
