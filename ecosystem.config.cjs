module.exports = {
  apps: [
    {
      name: "dwif-api",
      script: "./server.mjs",
      interpreter: "node",
      env: {
        HOST: "0.0.0.0",
        PORT: "8867",
        ROUTE_PREFIX: "/dwif",
        RATE_LIMIT_MAX: "5",
        RATE_LIMIT_MAX_GIFSKI: "1",
        RATE_LIMIT_WINDOW_MS: "60000"
      }
    }
  ]
};
