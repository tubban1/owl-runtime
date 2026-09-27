export type RuntimeSessionState = {
  id: string;
  connectedAt: string;
  lastActivityAt: string;
  disconnectedAt?: string;
  activeCalls: number;
  totalCalls: number;
  userAgent?: string;
};

class RuntimeSessionManager {
  private readonly sessions = new Map<string, RuntimeSessionState>();

  register(id: string, metadata?: { userAgent?: string }) {
    const now = new Date().toISOString();
    const existing = this.sessions.get(id);
    if (existing) {
      existing.lastActivityAt = now;
      existing.disconnectedAt = undefined;
      if (metadata?.userAgent) existing.userAgent = metadata.userAgent;
      return { ...existing };
    }

    const state: RuntimeSessionState = {
      id,
      connectedAt: now,
      lastActivityAt: now,
      activeCalls: 0,
      totalCalls: 0,
      ...(metadata?.userAgent ? { userAgent: metadata.userAgent } : {}),
    };
    this.sessions.set(id, state);
    return { ...state };
  }

  beginCall(id: string, metadata?: { userAgent?: string }) {
    const state = this.sessions.get(id) ?? this.register(id, metadata);
    const live = this.sessions.get(id)!;
    live.lastActivityAt = new Date().toISOString();
    live.disconnectedAt = undefined;
    live.activeCalls += 1;
    live.totalCalls += 1;
    if (metadata?.userAgent) live.userAgent = metadata.userAgent;
    return { ...live };
  }

  endCall(id: string) {
    const state = this.sessions.get(id);
    if (!state) return;
    state.lastActivityAt = new Date().toISOString();
    state.activeCalls = Math.max(0, state.activeCalls - 1);
  }

  disconnect(id: string) {
    const state = this.sessions.get(id);
    if (!state) return;
    state.disconnectedAt = new Date().toISOString();
    state.lastActivityAt = state.disconnectedAt;
    state.activeCalls = 0;
  }

  list() {
    return [...this.sessions.values()]
      .map((state) => ({ ...state }))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  status(id: string) {
    const state = this.sessions.get(id);
    return state ? { ...state } : null;
  }

  summary() {
    const sessions = this.list();
    return {
      activeSessions: sessions.filter((item) => !item.disconnectedAt).length,
      knownSessions: sessions.length,
      activeCalls: sessions.reduce((sum, item) => sum + item.activeCalls, 0),
    };
  }
}

export const runtimeSessionManager = new RuntimeSessionManager();
