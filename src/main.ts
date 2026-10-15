import { readFileSync } from "node:fs";
import { Relay, type RelayConfig } from "./relay.js";

const source = process.env.RELAY_CONFIG_JSON ?? readFileSync(process.env.RELAY_CONFIG ?? "relay.config.json", "utf8");
const config = JSON.parse(source) as RelayConfig;
config.adminToken ??= process.env.RELAY_ADMIN_TOKEN;

const relay = new Relay(config); // throws on an invalid config, so a bad setup never starts
const port = Number(process.env.PORT ?? 8787);
const server = relay.createServer().listen(port, () => {
  console.log(`webhook-relay listening on :${port} with routes: ${Object.keys(config.routes).join(", ")}`);
});

process.on("SIGTERM", () => {
  server.close();
  void relay.drain().then(() => process.exit(0));
});
