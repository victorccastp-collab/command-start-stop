import { describe, expect, jest, test } from "@jest/globals";
import { handleTaskLimitChecks } from "../src/handlers/start/helpers/check-assignments";
import { Context } from "../src/types/context";
import { AssignedIssueScope, Role } from "../src/types/plugin-input";

const OWNER = "ubiquity";
const REPO = "test-repo";
const USERNAME = "alice";
const NOW = new Date("2026-05-28T12:00:00.000Z");

function daysAgo(days: number) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function createAssignedIssue(number: number) {
  return {
    title: `Assigned issue ${number}`,
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${number}`,
    assignee: { login: USERNAME },
    assignees: [{ login: USERNAME }],
    repository: { archived: false },
  };
}

function createPullRequest(number: number, createdAt: string) {
  return {
    number,
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
    created_at: createdAt,
    requested_reviewers: [],
  };
}

function createContext({
  assignedIssues,
  pullRequests,
  reviews = [],
  reviewThreads = [],
}: {
  assignedIssues: unknown[];
  pullRequests: unknown[];
  reviews?: unknown[];
  reviewThreads?: unknown[];
}) {
  const issuesAndPullRequests = jest.fn();
  const listReviews = jest.fn();
  const listEventsForTimeline = jest.fn();
  const listEvents = jest.fn();
  const listComments = jest.fn();

  const octokit = {
    rest: {
      search: { issuesAndPullRequests },
      pulls: { listReviews },
      issues: { listEventsForTimeline, listEvents, listComments },
    },
    paginate: jest.fn(async (method, params?: { q?: string; pull_number?: number }) => {
      if (method === issuesAndPullRequests) {
        if (params?.q?.includes("is:issue")) {
          return assignedIssues;
        }
        if (params?.q?.includes("is:pr")) {
          return pullRequests;
        }
      }
      if (method === listReviews) {
        return reviews.filter((review) => (review as { pull_number?: number }).pull_number === params?.pull_number);
      }
      return [];
    }),
    graphql: {
      paginate: jest.fn(async () => ({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: reviewThreads,
            },
          },
        },
      })),
    },
  };

  const logger = {
    warn: jest.fn((message: string) => ({ logMessage: { raw: message } })),
    debug: jest.fn(),
    error: jest.fn((message: string) => ({ logMessage: { raw: message } })),
  };

  return {
    context: {
      payload: {
        issue: {
          number: 1,
          html_url: `https://github.com/${OWNER}/${REPO}/issues/1`,
        },
        repository: {
          full_name: `${OWNER}/${REPO}`,
          owner: { login: OWNER },
          name: REPO,
        },
      },
      config: {
        assignedIssueScope: AssignedIssueScope.ORG,
        reviewDelayTolerance: "1 Day",
        rolesWithReviewAuthority: [Role.OWNER, Role.ADMIN, Role.MEMBER],
      },
      organizations: [OWNER],
      octokit,
      installOctokit: octokit,
      logger,
    } as unknown as Context & { installOctokit: Context["octokit"] },
    logger: logger as unknown as Context["logger"],
  };
}

describe("task limit review delay handling", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("offsets an assigned issue when an open pull request has no reviews after the tolerance", async () => {
    const { context, logger } = createContext({
      assignedIssues: [createAssignedIssue(101)],
      pullRequests: [createPullRequest(201, daysAgo(2))],
    });

    const result = await handleTaskLimitChecks({
      context,
      logger,
      sender: USERNAME,
      username: USERNAME,
      roleAndLimit: { role: "contributor", limit: 1 },
    });

    expect(result.isWithinLimit).toBe(true);
    expect(result.openedPullRequests).toHaveLength(1);
  });

  test("keeps a fresh pull request counted against the task limit while it is still within tolerance", async () => {
    const { context, logger } = createContext({
      assignedIssues: [createAssignedIssue(101)],
      pullRequests: [createPullRequest(201, daysAgo(0.5))],
    });

    const result = await handleTaskLimitChecks({
      context,
      logger,
      sender: USERNAME,
      username: USERNAME,
      roleAndLimit: { role: "contributor", limit: 1 },
    });

    expect(result.isWithinLimit).toBe(false);
    expect(result.openedPullRequests).toHaveLength(0);
  });

  test("keeps a reviewed pull request counted when changes were requested", async () => {
    const { context, logger } = createContext({
      assignedIssues: [createAssignedIssue(101)],
      pullRequests: [createPullRequest(201, daysAgo(2))],
      reviews: [
        {
          id: 1,
          pull_number: 201,
          state: "CHANGES_REQUESTED",
          submitted_at: daysAgo(1.5),
          author_association: Role.MEMBER,
          user: { id: 7 },
        },
      ],
    });

    const result = await handleTaskLimitChecks({
      context,
      logger,
      sender: USERNAME,
      username: USERNAME,
      roleAndLimit: { role: "contributor", limit: 1 },
    });

    expect(result.isWithinLimit).toBe(false);
    expect(result.openedPullRequests).toHaveLength(0);
  });

  test("offsets a reviewed pull request when the assignee is the last commenter on every unresolved thread after tolerance", async () => {
    const { context, logger } = createContext({
      assignedIssues: [createAssignedIssue(101)],
      pullRequests: [createPullRequest(201, daysAgo(3))],
      reviews: [
        {
          id: 1,
          pull_number: 201,
          state: "CHANGES_REQUESTED",
          submitted_at: daysAgo(2.5),
          author_association: Role.MEMBER,
          user: { id: 7 },
        },
      ],
      reviewThreads: [
        {
          isResolved: false,
          comments: {
            nodes: [
              { author: { login: "reviewer" }, createdAt: daysAgo(2.5) },
              { author: { login: USERNAME }, createdAt: daysAgo(2) },
            ],
          },
        },
      ],
    });

    const result = await handleTaskLimitChecks({
      context,
      logger,
      sender: USERNAME,
      username: USERNAME,
      roleAndLimit: { role: "contributor", limit: 1 },
    });

    expect(result.isWithinLimit).toBe(true);
    expect(result.openedPullRequests).toHaveLength(1);
  });
});
