import { Cron } from "croner";
import log from "./logger.js";
import type { Config, ScheduleEntry } from "./config.js";
import type { InboundMessage } from "./types.js";

export class Scheduler {
  private jobs = new Map<string, Cron>();

  constructor(
    private config: Config,
    private inject: (prompt: Pick<InboundMessage, "user" | "text">) => void,
  ) {}

  start(): void {
    const schedules = this.config.listSchedules();
    let started = 0;
    for (const entry of schedules) {
      if (entry.enabled) {
        this.createJob(entry);
        started++;
      }
    }
    if (started > 0) {
      log.info("[scheduler] started %d schedule(s)", started);
    }
  }

  stop(): void {
    for (const [id, job] of this.jobs) {
      job.stop();
      log.info("[scheduler] stopped job %s", id);
    }
    this.jobs.clear();
  }

  add(entry: ScheduleEntry): void {
    this.config.addSchedule(entry);
    if (entry.enabled) {
      this.createJob(entry);
    }
    log.info("[scheduler] added %s: %s → %s", entry.id, entry.cron, entry.prompt.slice(0, 60));
  }

  remove(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }
    this.config.removeSchedule(id);
    log.info("[scheduler] removed %s", id);
  }

  toggle(id: string, enabled: boolean): void {
    this.config.updateSchedule(id, { enabled });
    if (enabled) {
      const entry = this.config.listSchedules().find((s) => s.id === id);
      if (entry && !this.jobs.has(id)) {
        this.createJob(entry);
      }
    } else {
      const job = this.jobs.get(id);
      if (job) {
        job.stop();
        this.jobs.delete(id);
      }
    }
    log.info("[scheduler] %s → %s", id, enabled ? "enabled" : "disabled");
  }

  list(): ScheduleEntry[] {
    return this.config.listSchedules();
  }

  private isDate(value: string): boolean {
    const d = new Date(value);
    return !isNaN(d.getTime());
  }

  private createJob(entry: ScheduleEntry): void {
    const opts: Record<string, unknown> = {};
    if (entry.timezone) opts.timezone = entry.timezone;

    const pattern = this.isDate(entry.cron) ? new Date(entry.cron) : entry.cron;

    const job = new Cron(pattern, opts, () => {
      log.info("[scheduler] firing %s: %s", entry.id, entry.prompt.slice(0, 60));
      this.inject({
        user: { id: `system:schedule:${entry.id}`, name: "Scheduler" },
        text: entry.prompt,
      });

      if (pattern instanceof Date) {
        this.remove(entry.id);
        log.info("[scheduler] date-based %s auto-deleted", entry.id);
      }
    });

    this.jobs.set(entry.id, job);
  }
}
