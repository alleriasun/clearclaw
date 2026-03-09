import fs from "node:fs";
import type { Workspace } from "./types.js";

export class WorkspaceStore {
  constructor(private readonly path: string) {
    if (!fs.existsSync(path)) {
      fs.writeFileSync(path, "[]\n");
    }
  }

  private read(): Workspace[] {
    return JSON.parse(fs.readFileSync(this.path, "utf-8")) as Workspace[];
  }

  private write(workspaces: Workspace[]): void {
    fs.writeFileSync(
      this.path,
      JSON.stringify(workspaces, null, 2) + "\n",
    );
  }

  byChat(chatId: string): Workspace | undefined {
    return this.read().find((ws) => ws.chat_id === chatId);
  }

  upsert(ws: Workspace): void {
    const all = this.read();
    const idx = all.findIndex((w) => w.name === ws.name);
    if (idx >= 0) all[idx] = ws;
    else all.push(ws);
    this.write(all);
  }

  setSession(name: string, sessionId: string): void {
    const all = this.read();
    const ws = all.find((w) => w.name === name);
    if (ws) {
      ws.current_session_id = sessionId;
      this.write(all);
    }
  }

  clearSession(name: string): void {
    const all = this.read();
    const ws = all.find((w) => w.name === name);
    if (ws) {
      ws.current_session_id = null;
      this.write(all);
    }
  }
}
