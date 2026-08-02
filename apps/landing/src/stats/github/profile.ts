import axios from "axios";
import githubHeaders from "./headers";

const getGitHubProfile = async ({ GH_TOKEN }: { GH_TOKEN: string }) => {
  let response = await axios.get('https://api.github.com/users/Im-Fran', {
    headers: githubHeaders(GH_TOKEN),
  });

  if (response.status !== 200) {
    throw new Error(`Failed to fetch GitHub profile: ${response.status} ${response.statusText}`);
  }

  const data = response.data;

  return {
    avatar: data.avatar_url,
    profile_url: data.html_url,
    repos: {
      public: data.public_repos,
      private: data.total_private_repos,
      total: data.public_repos + data.total_private_repos,
    },
    followers: data.followers,
    location: data.location,
  }
}

export {getGitHubProfile};
