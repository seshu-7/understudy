import { DEFAULT_PORT, createServicingServer } from "./server.js";
import { MERIDIAN, TENANTS } from "./tenants.js";

const tenantId = process.env["TARGET_APP_TENANT"] ?? MERIDIAN.id;
const tenant = TENANTS[tenantId];
if (!tenant) {
  throw new Error(`unknown TARGET_APP_TENANT "${tenantId}" - known tenants: ${Object.keys(TENANTS).join(", ")}`);
}

createServicingServer(tenant).listen(DEFAULT_PORT, "127.0.0.1", () => {
  process.stdout.write(
    `[target-app] CoreVantage Servicing (${tenant.id}) on http://127.0.0.1:${DEFAULT_PORT}/servicing/\n`,
  );
});
