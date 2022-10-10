// @ts-check
import * as dotenv from "dotenv";
import githubUsernameRegex from "github-username-regex";
import { calculateRank } from "../calculateRank.js";
import { retryer } from "../common/retryer.js";
import {
  CustomError,
  logger,
  MissingParamError,
  request,
  wrapTextMultiline,
} from "../common/utils.js";

dotenv.config();

/**
 * Stats fetcher object.
 *
 * @param {import('axios').AxiosRequestHeaders} variables Fetcher variables.
 * @param {string} token Github token.
 * @returns {Promise<import('../common/types').StatsFetcherResponse>} Stats fetcher response.
 */
const fetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!) {
        user(login: $login) {
          name
          login
          contributionsCollection {
            totalCommitContributions
            restrictedContributionsCount
            contributionYears
          }
          repositoriesContributedTo(contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
            totalCount
          }
          pullRequests {
            totalCount
          }
          openIssues: issues(states: OPEN) {
            totalCount
          }
          closedIssues: issues(states: CLOSED) {
            totalCount
          }
          followers {
            totalCount
          }
          repositories(ownerAffiliations: OWNER) {
            totalCount
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * Fetch first 100 repositories for a given username.
 *
 * @param {import('axios').AxiosRequestHeaders} variables Fetcher variables.
 * @param {string} token Github token.
 * @returns {Promise<import('../common/types').StatsFetcherResponse>} Repositories fetcher response.
 */
const repositoriesFetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!, $after: String) {
        user(login: $login) {
          repositories(first: 100, ownerAffiliations: OWNER, orderBy: {direction: DESC, field: STARGAZERS}, after: $after) {
            nodes {
              name
              stargazers {
                totalCount
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

const fetchYearCommits = (variables, token) => {
  return request({
    query: `
      query userInfo($login: String!, $from_time: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from_time) {
            totalCommitContributions
            restrictedContributionsCount
          }
        }
      }
      `, variables,
  }, {
    Authorization: `bearer ${token}`,
  },);
};

/**
 * Fetch all the commits for all the repositories of a given username.
 *
 * @param {*} username Github username.
 * @returns {Promise<number>} Total commits.
 *
 * @description Done like this because the Github API does not provide a way to fetch all the commits. See
 * #92#issuecomment-661026467 and #211 for more information.
 */
const totalCommitsFetcher = async (username, contributionYears) => {
  if (!githubUsernameRegex.test(username)) {
    logger.log("Invalid username");
    return 0;
  }

  let totalPublicCommits = 0;
  let totalPrivateCommits = 0;

  try {
    await Promise.all(contributionYears.map(async (year) => {
          let variables = {
            login: username,
            from_time: `${year}-01-01T00:00:00.000Z`,
          };
          let res = await retryer(fetchYearCommits, variables);
          totalPublicCommits += res.data.data.user.contributionsCollection.totalCommitContributions;
          totalPrivateCommits += res.data.data.user.contributionsCollection.restrictedContributionsCount;
        })
    );
    return {
      totalPublicCommits,
      totalPrivateCommits,
    };
  } catch (err) {
    logger.log(err);
  }
  // just return 0 if there is something wrong so that
  // we don't break the whole app
  return {
      totalPublicCommits: 0,
      totalPrivateCommits: 0,
    };
};

/**
 * Fetch all the stars for all the repositories of a given username.
 *
 * @param {string} username Github username.
 * @param {array} repoToHide Repositories to hide.
 * @returns {Promise<number>} Total stars.
 */
const totalStarsFetcher = async (username, repoToHide) => {
  let nodes = [];
  let hasNextPage = true;
  let endCursor = null;
  while (hasNextPage) {
    const variables = { login: username, first: 100, after: endCursor };
    let res = await retryer(repositoriesFetcher, variables);

    if (res.data.errors) {
      logger.error(res.data.errors);
      throw new CustomError(
        res.data.errors[0].message || "Could not fetch user",
        CustomError.USER_NOT_FOUND,
      );
    }

    const allNodes = res.data.data.user.repositories.nodes;
    const nodesWithStars = allNodes.filter(
      (node) => node.stargazers.totalCount !== 0,
    );
    nodes.push(...nodesWithStars);
    // hasNextPage =
    //   allNodes.length === nodesWithStars.length &&
    //   res.data.data.user.repositories.pageInfo.hasNextPage;
    hasNextPage = false; // NOTE: Temporarily disable fetching of multiple pages. Done because of #2130.
    endCursor = res.data.data.user.repositories.pageInfo.endCursor;
  }

  return nodes
    .filter((data) => !repoToHide[data.name])
    .reduce((prev, curr) => prev + curr.stargazers.totalCount, 0);
};

/**
 * Fetch stats for a given username.
 *
 * @param {string} username Github username.
 * @param {boolean} count_private Include private contributions.
 * @param {boolean} include_all_commits Include all commits.
 * @returns {Promise<import("./types").StatsData>} Stats data.
 */
async function fetchStats(
  username,
  count_private = false,
  include_all_commits = false,
  exclude_repo = [],
) {
  if (!username) throw new MissingParamError(["username"]);

  const stats = {
    name: "",
    totalPRs: 0,
    totalCommits: 0,
    totalIssues: 0,
    totalStars: 0,
    contributedTo: 0,
    rank: { level: "C", score: 0 },
  };

  let res = await retryer(fetcher, { login: username });

  // Catch GraphQL errors.
  if (res.data.errors) {
    logger.error(res.data.errors);
    if (res.data.errors[0].type === "NOT_FOUND") {
      throw new CustomError(
        res.data.errors[0].message || "Could not fetch user.",
        CustomError.USER_NOT_FOUND,
      );
    }
    if (res.data.errors[0].message) {
      throw new CustomError(
        wrapTextMultiline(res.data.errors[0].message, 90, 1)[0],
        res.statusText,
      );
    }
    throw new CustomError(
      "Something went while trying to retrieve the stats data using the GraphQL API.",
      CustomError.GRAPHQL_ERROR,
    );
  }

  const user = res.data.data.user;

  // populate repoToHide map for quick lookup
  // while filtering out
  let repoToHide = {};
  if (exclude_repo) {
    exclude_repo.forEach((repoName) => {
      repoToHide[repoName] = true;
    });
  }

  stats.name = user.name || user.login;
  stats.totalIssues = user.openIssues.totalCount + user.closedIssues.totalCount;

  // normal commits
  stats.totalCommits = user.contributionsCollection.totalCommitContributions;

  let privateCommits = user.contributionsCollection.restrictedContributionsCount;

  // if include_all_commits then just get that,
  // since totalCommitsFetcher already sends totalCommits no need to +=
  if (include_all_commits) {
    const { totalPublicCommits, totalPrivateCommits } = await totalCommitsFetcher(username, user.contributionsCollection.contributionYears);
    stats.totalCommits = totalPublicCommits;
    privateCommits = totalPrivateCommits;
  }

  // if count_private then add private commits to totalCommits so far.
  if (count_private) {
    stats.totalCommits += privateCommits;
  }

  stats.totalPRs = user.pullRequests.totalCount;
  stats.contributedTo = user.repositoriesContributedTo.totalCount;

  // Retrieve stars while filtering out repositories to be hidden
  stats.totalStars = await totalStarsFetcher(username, repoToHide);

  stats.rank = calculateRank({
    totalCommits: stats.totalCommits,
    totalRepos: user.repositories.totalCount,
    followers: user.followers.totalCount,
    contributions: stats.contributedTo,
    stargazers: stats.totalStars,
    prs: stats.totalPRs,
    issues: stats.totalIssues,
  });

  return stats;
}

export { fetchStats };
export default fetchStats;
