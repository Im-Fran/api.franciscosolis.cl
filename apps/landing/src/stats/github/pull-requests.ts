import axios from "axios";
import githubHeaders from "./headers";

const getGitHubPullRequests = async ({ GH_TOKEN }: { GH_TOKEN: string }) => {
  const graphql = `
    query getPullRequestCount($login: String!) {
      user(login: $login) {
        pullRequests {
          totalCount
        }
      }
    }
  `

  const response = await axios.post('https://api.github.com/graphql', {
    query: graphql,
    variables: { login: "Im-Fran" }
  }, {
    headers: githubHeaders(GH_TOKEN),
  });

  return response.data.data.user.pullRequests.totalCount;
}

export {getGitHubPullRequests};
