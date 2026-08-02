const githubHeaders = (GH_TOKEN: string) => ({
  Authorization: `token ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  "User-Agent": "FranciscoSolis-Portfolio-Api/1.0",
})

export default githubHeaders
