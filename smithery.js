export default function startCommand(config) {
  return {
    command: "node",
    args: ["build/index.js"],
    env: {
      API_BASE_URL: config.apiBaseUrl ?? "https://us1.pdfgeneratorapi.com/api/v4",
      ...(config.bearerTokenJwt ? { BEARER_TOKEN_JWT: config.bearerTokenJwt } : {}),
    },
  };
}
