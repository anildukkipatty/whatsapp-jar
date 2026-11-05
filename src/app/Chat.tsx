"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

type Quoted = { id: number; role: "user" | "assistant"; content: string; createdAt: string };

type ChatMessage = {
  id: number | null; // null until the server has stored it
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  clientId: string | null;
  replyTo: Quoted | null;
  failed?: boolean;
};

const PAGE_SIZE = 50;
const POLL_MS = 1500;

/** Updates known messages, adds new ones, and keeps unsent ones at the bottom. */
function merge(current: ChatMessage[], incoming: ChatMessage[]) {
  const byKey = new Map<string, ChatMessage>();
  const keyOf = (m: ChatMessage) => m.clientId ?? `id:${m.id}`;
  for (const message of [...current, ...incoming]) byKey.set(keyOf(message), message);
  return [...byKey.values()].sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity));
}

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function dayOf(iso: string) {
  const date = new Date(iso);
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}

export function Chat({ userName, tenantName }: { userName: string; tenantName: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [typing, setTyping] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(messages);
  latest.current = messages;
  const loadingOlder = useRef(false);
  const hasOlderRef = useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  const stickToBottom = useRef(true);
  const heightBeforePrepend = useRef<number | null>(null);
  // Sends go out strictly one after another so a burst arrives in typed order.
  const sendQueue = useRef<Promise<void>>(Promise.resolve());

  const fetchMessages = useCallback(async (query: string) => {
    const response = await fetch(`/api/messages?${query}`);
    if (response.status === 401) {
      window.location.href = "/login";
      return null;
    }
    if (!response.ok) return null;
    return (await response.json()) as { messages: ChatMessage[]; typing: boolean };
  }, []);

  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasOlderRef.current) return;
    const oldest = latest.current.find((m) => m.id !== null)?.id;
    if (!oldest) return;
    loadingOlder.current = true;
    const page = await fetchMessages(`before=${oldest}&limit=${PAGE_SIZE}`);
    if (page) {
      heightBeforePrepend.current = scroller.current?.scrollHeight ?? null;
      hasOlderRef.current = page.messages.length === PAGE_SIZE;
      setHasOlder(hasOlderRef.current);
      setMessages((current) => merge(current, page.messages));
    }
    loadingOlder.current = false;
  }, [fetchMessages]);

  // First page, then poll for anything newer.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const newest = latest.current.reduce((max, m) => Math.max(max, m.id ?? 0), 0);
      const page = await fetchMessages(`after=${newest}&limit=200`).catch(() => null);
      if (stopped) return;
      if (page) {
        setTyping(page.typing);
        if (page.messages.length) setMessages((current) => merge(current, page.messages));
      }
      timer = setTimeout(poll, POLL_MS);
    };
    fetchMessages(`limit=${PAGE_SIZE}`)
      .catch(() => null)
      .then((page) => {
        if (stopped) return;
        if (page) {
          setMessages(page.messages);
          setHasOlder(page.messages.length === PAGE_SIZE);
          setTyping(page.typing);
        }
        setLoaded(true);
        timer = setTimeout(poll, POLL_MS);
      });
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [fetchMessages]);

  // Keep the view in place when older messages load, and follow new ones at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (heightBeforePrepend.current !== null) {
      element.scrollTop += element.scrollHeight - heightBeforePrepend.current;
      heightBeforePrepend.current = null;
    } else if (stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, typing]);

  function onScroll() {
    const element = scroller.current!;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (element.scrollTop < 120) void loadOlder();
  }

  function post(message: ChatMessage) {
    sendQueue.current = sendQueue.current.then(async () => {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: message.content,
          clientId: message.clientId,
          replyToId: message.replyTo?.id ?? null,
        }),
      }).catch(() => null);
      const stored = response?.ok ? ((await response.json()).message as ChatMessage) : null;
      setMessages((current) => merge(current, [stored ?? { ...message, failed: true }]));
    });
  }

  function send() {
    const text = draft.trim();
    if (!text) return;
    const message: ChatMessage = {
      id: null,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
      clientId: crypto.randomUUID(),
      replyTo:
        replyTo?.id != null
          ? {
              id: replyTo.id,
              role: replyTo.role as Quoted["role"],
              content: replyTo.content,
              createdAt: replyTo.createdAt,
            }
          : null,
    };
    setDraft("");
    setReplyTo(null);
    stickToBottom.current = true;
    setMessages((current) => merge(current, [message]));
    post(message);
    input.current?.focus();
  }

  function retry(message: ChatMessage) {
    const pending = { ...message, failed: false };
    setMessages((current) => merge(current, [pending]));
    post(pending);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape") {
      setReplyTo(null);
    }
  }

  function startReply(message: ChatMessage) {
    setReplyTo(message);
    input.current?.focus();
  }

  async function jumpTo(id: number) {
    const find = () => document.getElementById(`msg-${id}`);
    while (!find() && hasOlderRef.current) {
      await loadOlder();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    stickToBottom.current = false;
    find()?.scrollIntoView({ block: "center" });
    setHighlight(id);
    setTimeout(() => setHighlight(null), 1500);
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <div className="chat">
      <header>
        <div className="avatar">J</div>
        <div className="who">
          <strong>Jar</strong>
          <span>{typing ? "typing…" : `${userName} · ${tenantName}`}</span>
        </div>
        <button className="logout" onClick={logout}>
          Switch user
        </button>
      </header>

      <div className="messages" ref={scroller} onScroll={onScroll}>
        {hasOlder && (
          <button className="older" onClick={() => void loadOlder()}>
            Load earlier messages
          </button>
        )}
        {loaded && messages.length === 0 && <div className="notice">Say hello to start your chat.</div>}
        {messages.map((message, index) => {
          const day = dayOf(message.createdAt);
          const newDay = index === 0 || dayOf(messages[index - 1].createdAt) !== day;
          return (
            <div key={message.clientId ?? message.id}>
              {newDay && <div className="day">{day}</div>}
              {message.role === "system" ? (
                <div className="notice" id={`msg-${message.id}`}>
                  {message.content}
                </div>
              ) : (
                <div
                  id={message.id ? `msg-${message.id}` : undefined}
                  className={`row ${message.role} ${highlight === message.id ? "highlight" : ""}`}
                >
                  <div className="bubble">
                    {message.replyTo && (
                      <button className="quote" onClick={() => void jumpTo(message.replyTo!.id)}>
                        <strong>{message.replyTo.role === "assistant" ? "Jar" : "You"}</strong>
                        <span>{message.replyTo.content}</span>
                      </button>
                    )}
                    <div className="text">{message.content}</div>
                    <div className="meta">
                      {message.failed ? (
                        <button className="retry" onClick={() => retry(message)}>
                          Not sent. Tap to retry
                        </button>
                      ) : (
                        <>
                          {timeOf(message.createdAt)}
                          {message.role === "user" && (message.id === null ? " 🕓" : " ✓")}
                        </>
                      )}
                    </div>
                  </div>
                  {message.id !== null && (
                    <button
                      className="reply"
                      aria-label="Reply to this message"
                      title="Reply"
                      onClick={() => startReply(message)}
                    >
                      ↩
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {typing && (
          <div className="row assistant">
            <div className="bubble typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>

      <footer>
        {replyTo && (
          <div className="replying">
            <div>
              <strong>{replyTo.role === "assistant" ? "Jar" : "You"}</strong>
              <span>{replyTo.content}</span>
            </div>
            <button aria-label="Cancel reply" onClick={() => setReplyTo(null)}>
              ✕
            </button>
          </div>
        )}
        <div className="composer">
          <textarea
            ref={input}
            rows={1}
            maxLength={16000}
            placeholder="Type a message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <button className="send" aria-label="Send" onClick={send} disabled={!draft.trim()}>
            ➤
          </button>
        </div>
      </footer>
    </div>
  );
}
