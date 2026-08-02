import axios from "axios";
import githubHeaders from "./headers";

const getGitHubCommits = async ({ GH_TOKEN }: { GH_TOKEN: string }) => {
  let commitsResponse = await axios.get('https://api.github.com/search/commits?q=author:Im-Fran', {
    headers: githubHeaders(GH_TOKEN),
  })

  let commitsCount = 0;
  if (commitsResponse.status === 200) {
    commitsCount = commitsResponse.data.total_count;
  }

  return commitsCount;
}

export { getGitHubCommits };
