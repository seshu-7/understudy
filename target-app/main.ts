import { DEFAULT_PORT, createServicingServer } from "./server.js";

createServicingServer().listen(DEFAULT_PORT, "127.0.0.1", () => {
  process.stdout.write(
    `[target-app] CoreVantage Servicing on http://127.0.0.1:${DEFAULT_PORT}/servicing/\n`,
  );
});
