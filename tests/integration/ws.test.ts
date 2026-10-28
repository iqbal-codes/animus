import { describe, expect, test, vi } from "vitest";
import {
  BoundedRingBuffer,
  WebSocketConnectionManager,
  type WebSocketLike,
  type WsEvent,
} from "@labq/client";

class MockWebSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = "normal"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  simulateError(): void {
    this.onerror?.({});
    this.close(1006, "abnormal");
  }
}

describe("AC2 / P4: BoundedRingBuffer", () => {
  test("enforces positive integer capacity", () => {
    expect(() => new BoundedRingBuffer(0)).toThrow();
    expect(() => new BoundedRingBuffer(-5)).toThrow();
    expect(() => new BoundedRingBuffer(1.5)).toThrow();
    const buf = new BoundedRingBuffer<number>(3);
    expect(buf.capacity).toBe(3);
    expect(buf.size).toBe(0);
  });

  test("bounded FIFO behavior overwrites oldest item when full", () => {
    const buf = new BoundedRingBuffer<string>(3);
    buf.push("A");
    buf.push("B");
    expect(buf.size).toBe(2);
    expect(buf.toArray()).toEqual(["A", "B"]);

    buf.push("C");
    expect(buf.size).toBe(3);
    expect(buf.isFull).toBe(true);
    expect(buf.toArray()).toEqual(["A", "B", "C"]);

    // Push 4th: drops A, preserves B, C, D
    buf.push("D");
    expect(buf.size).toBe(3);
    expect(buf.toArray()).toEqual(["B", "C", "D"]);
    expect(buf.get(0)).toBe("B");
    expect(buf.get(1)).toBe("C");
    expect(buf.get(2)).toBe("D");
    expect(buf.get(3)).toBeUndefined();

    // Push 5th: drops B, preserves C, D, E
    buf.push("E");
    expect(buf.toArray()).toEqual(["C", "D", "E"]);

    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });
});

describe("AC2 / P4: WebSocketConnectionManager", () => {
  test("maintains project/lap-scoped subscriptions and lifecycle status", () => {
    let mockSocket!: MockWebSocket;
    const statuses: string[] = [];

    const mgr = new WebSocketConnectionManager({
      url: "ws://127.0.0.1:4000/api/v1/ws",
      webSocketFactory: () => {
        mockSocket = new MockWebSocket();
        return mockSocket;
      },
      onStatusChange: (s) => statuses.push(s),
    });

    expect(mgr.getStatus()).toBe("disconnected");

    mgr.connect();
    expect(mgr.getStatus()).toBe("connecting");

    mockSocket.simulateOpen();
    expect(mgr.getStatus()).toBe("connected");
    expect(statuses).toEqual(["connecting", "connected"]);

    mgr.subscribe("proj-1", "lap-100");
    expect(mockSocket.sent).toContain(
      JSON.stringify({ action: "subscribe", projectId: "proj-1", lapId: "lap-100" }),
    );

    mgr.unsubscribe("proj-1", "lap-100");
    expect(mockSocket.sent).toContain(
      JSON.stringify({ action: "unsubscribe", projectId: "proj-1", lapId: "lap-100" }),
    );

    mgr.disconnect();
    expect(mgr.getStatus()).toBe("disconnected");
  });

  test("deduplication drops already-seen event IDs and out-of-order sequence numbers", () => {
    let mockSocket!: MockWebSocket;
    const receivedEvents: WsEvent[] = [];

    const mgr = new WebSocketConnectionManager({
      url: "ws://127.0.0.1:4000/api/v1/ws",
      webSocketFactory: () => {
        mockSocket = new MockWebSocket();
        return mockSocket;
      },
      onEvent: (e) => receivedEvents.push(e),
    });

    mgr.connect();
    mockSocket.simulateOpen();

    const ev1: WsEvent = {
      id: "ev-1",
      seq: 1,
      type: "log",
      projectId: "proj-1",
      timestamp: new Date().toISOString(),
      payload: { line: "first line" },
    };
    mockSocket.simulateMessage(ev1);
    expect(receivedEvents).toHaveLength(1);

    // Duplicate by ID: ignored
    mockSocket.simulateMessage(ev1);
    expect(receivedEvents).toHaveLength(1);

    // Duplicate by seq (out-of-order / late write): ignored
    const evLate: WsEvent = {
      id: "ev-late",
      seq: 1,
      type: "log",
      projectId: "proj-1",
      timestamp: new Date().toISOString(),
      payload: { line: "late write" },
    };
    mockSocket.simulateMessage(evLate);
    expect(receivedEvents).toHaveLength(1);

    // Valid next seq: accepted
    const ev2: WsEvent = {
      id: "ev-2",
      seq: 2,
      type: "log",
      projectId: "proj-1",
      timestamp: new Date().toISOString(),
      payload: { line: "second line" },
    };
    mockSocket.simulateMessage(ev2);
    expect(receivedEvents).toHaveLength(2);
    expect(mgr.getLogs({ projectId: "proj-1" })).toEqual(["first line", "second line"]);

    mgr.disconnect();
  });

  test("gap recovery signaling triggers when sequence gap is detected", () => {
    let mockSocket!: MockWebSocket;
    const gapSignals: any[] = [];
    const invalidationHints: any[] = [];

    const mgr = new WebSocketConnectionManager({
      url: "ws://127.0.0.1:4000/api/v1/ws",
      webSocketFactory: () => {
        mockSocket = new MockWebSocket();
        return mockSocket;
      },
      onGapDetected: (gap) => gapSignals.push(gap),
      onInvalidationHint: (hint) => invalidationHints.push(hint),
    });

    mgr.connect();
    mockSocket.simulateOpen();

    // Message 1
    mockSocket.simulateMessage({
      id: "msg-1",
      seq: 1,
      type: "log",
      projectId: "proj-1",
      timestamp: new Date().toISOString(),
      payload: { line: "hello" },
    });
    expect(gapSignals).toHaveLength(0);

    // Message 5 (gap: missed 2, 3, 4)
    mockSocket.simulateMessage({
      id: "msg-5",
      seq: 5,
      type: "log",
      projectId: "proj-1",
      timestamp: new Date().toISOString(),
      payload: { line: "world" },
    });

    expect(gapSignals).toHaveLength(1);
    expect(gapSignals[0]).toEqual({
      channel: "proj-1:",
      expectedSeq: 2,
      receivedSeq: 5,
      projectId: "proj-1",
      lapId: undefined,
    });
    // Triggers invalidation hint for snapshot recovery
    expect(invalidationHints).toContainEqual({
      scope: "gap_recovery",
      projectId: "proj-1",
      lapId: undefined,
    });

    mgr.disconnect();
  });

  test("automatic reconnect with exponential backoff and snapshot query resubscription", async () => {
    vi.useFakeTimers();
    try {
      const sockets: MockWebSocket[] = [];
      const invalidations: any[] = [];

      const mgr = new WebSocketConnectionManager({
        url: "ws://127.0.0.1:4000/api/v1/ws",
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 1000,
        webSocketFactory: () => {
          const s = new MockWebSocket();
          sockets.push(s);
          return s;
        },
        onInvalidationHint: (hint) => invalidations.push(hint),
      });

      mgr.connect();
      expect(sockets).toHaveLength(1);
      sockets[0].simulateOpen();

      mgr.subscribe("proj-alpha", "lap-1");
      expect(sockets[0].sent).toHaveLength(1);

      // Simulate unexpected disconnect / server crash
      sockets[0].simulateError();
      expect(mgr.getStatus()).toBe("reconnecting");

      // Advance time for exponential backoff (100ms)
      await vi.advanceTimersByTimeAsync(100);
      expect(sockets).toHaveLength(2);

      // Reconnection opens
      sockets[1].simulateOpen();
      expect(mgr.getStatus()).toBe("connected");

      // Verifies automatic resubscription to proj-alpha
      expect(sockets[1].sent).toContain(
        JSON.stringify({ action: "subscribe", projectId: "proj-alpha", lapId: "lap-1" }),
      );
      // Verifies snapshot invalidation hint fired upon reconnect
      expect(invalidations).toContainEqual({
        scope: "reconnect",
        projectId: "proj-alpha",
        lapId: "lap-1",
      });

      mgr.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  test("events serve as invalidation hints and ring buffer bounds total logs", () => {
    let mockSocket!: MockWebSocket;
    const hints: any[] = [];

    const mgr = new WebSocketConnectionManager({
      url: "ws://127.0.0.1:4000/api/v1/ws",
      maxRingBufferSize: 3,
      webSocketFactory: () => {
        mockSocket = new MockWebSocket();
        return mockSocket;
      },
      onInvalidationHint: (h) => hints.push(h),
    });

    mgr.connect();
    mockSocket.simulateOpen();

    // Lifecycle / invalidation hints
    mockSocket.simulateMessage({
      id: "ev-inv-1",
      seq: 1,
      type: "invalidation",
      projectId: "proj-1",
      timestamp: new Date().toISOString(),
      payload: { scope: "intake" },
    });
    expect(hints).toEqual([{ scope: "intake", projectId: "proj-1", lapId: undefined }]);

    // Push 4 logs into ring buffer with capacity 3
    for (let i = 1; i <= 4; i++) {
      mockSocket.simulateMessage({
        id: `log-${i}`,
        seq: i + 1,
        type: "log",
        projectId: "proj-1",
        timestamp: new Date().toISOString(),
        payload: { line: `line-${i}` },
      });
    }

    expect(mgr.getBuffer().size).toBe(3);
    expect(mgr.getLogs()).toEqual(["line-2", "line-3", "line-4"]);

    mgr.disconnect();
  });
});
