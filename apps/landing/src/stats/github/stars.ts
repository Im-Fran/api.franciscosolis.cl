import axios from "axios";
import githubHeaders from "./headers";

const getGitHubStars = async ({ GH_TOKEN }: { GH_TOKEN: string }) => {
  const graphql = `
    query getAllStars($login: String!, $after: String) {
      user(login: $login) {
        repositories(first: 100, after: $after, ownerAffiliations: OWNER, orderBy: {direction: DESC, field: STARGAZERS}) {
          nodes {
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
  `

  let stars_earned = 0;
  let after: string | null = null;
  while (true) {
    const response: any = await axios.post('https://api.github.com/graphql', {
      query: graphql,
      variables: { login: "Im-Fran", after }
    }, {
      headers: githubHeaders(GH_TOKEN),
    });

    const repositories = response.data.data.user.repositories;
    repositories.nodes.forEach((repo: any) => stars_earned += repo.stargazers.totalCount)

    if (!repositories.pageInfo.hasNextPage) break;
    after = repositories.pageInfo.endCursor;
  }

  return stars_earned;
}

export {getGitHubStars};
