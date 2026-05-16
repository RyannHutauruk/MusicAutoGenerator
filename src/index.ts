#!/usr/bin/env node
/**
 * Music Generator — entry point.
 *
 * With args: runs CLI mode
 * Without args: starts web UI
 */

import { startServer } from "./web/server";

const args = process.argv.slice(2);

if (args.length > 0) {
  // CLI mode — forward to cli.ts
  require("./cli");
} else {
  // Web UI mode
  startServer();
}
