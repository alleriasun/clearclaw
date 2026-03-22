import pino from "pino";

let log = pino({ level: "silent" });

export function initLogger(logPath: string): void {
  log = pino({
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
            file: logPath,
            frequency: "daily",
            size: "10m",
            limit: { count: 5, removeOtherLogFiles: true },
          },
          level: process.env.LOG_LEVEL ?? "info",
        },
      ],
    },
  });
}

export { log as default };
