module.exports = {
  apps: [
    {
      name: "dwif-api",
      script: "./server.mjs",
      interpreter: "node",
      env: {
        HOST: "0.0.0.0",
        PORT: "8867",
        ROUTE_PREFIX: "/dwif"
      }
    }
  ]
};
