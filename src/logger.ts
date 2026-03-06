import pino from "pino";
import { ensureDataDir, logPath } from "./config.js";

// Guarantee ~/.clearclaw/ exists before the file transport opens
ensureDataDir();

const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: {
    targets: [
      {
        target: "pino-pretty",
        options: { destination: 1 },
        level: process.env.LOG_LEVEL ?? "info",
      },
      {
        target: "pino-roll",
        options: {
          file: logPath(),
          frequency: "daily",
          size: "10m",
          limit: { count: 5 },
        },
        level: process.env.LOG_LEVEL ?? "info",
      },
    ],
  },
});

export default log;
