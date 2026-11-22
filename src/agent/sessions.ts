import type { ChatMessage } from "./llm.js";

export interface PendingPayment {
  actionId: string;
  month: number;
  year: number;
  amount: number;
  remainingBalance: number;
  transactionId: string;
  expiresAt: number;
}

export interface Session {
  history: ChatMessage[];
  pending?: PendingPayment;
  touchedAt: number;
}

const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 2000;
const MAX_HISTORY = 16;

/** In-memory conversation state, always keyed by authenticated subscriber + conversation id. */
export class SessionStore {
  private sessions = new Map<string, Session>();

  get(subscriberNo: string, conversationId: string, now = Date.now()): Session {
    this.sweep(now);
    const key = `${subscriberNo}:${conversationId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = { history: [], touchedAt: now };
      this.sessions.set(key, session);
    }
    session.touchedAt = now;
    return session;
  }

  remember(session: Session, user: string, assistant: string) {
    session.history.push({ role: "user", content: user }, { role: "assistant", content: assistant });
    if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);
  }

  private sweep(now: number) {
    for (const [key, s] of this.sessions) if (now - s.touchedAt > SESSION_TTL_MS) this.sessions.delete(key);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
  }
}
