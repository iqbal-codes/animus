import type { WsEvent, WsSubscriptionMessage } from "@animus/contracts/operator";

export class BoundedRingBuffer<T> {
  private buffer: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private count = 0;

  constructor(public readonly capacity: number = 1000) {
    if (capacity <= 0 || !Number.isInteger(capacity)) {
      throw new Error("BoundedRingBuffer capacity must be a positive integer");
    }
    this.buffer = Array.from({ length: capacity });
  }

  get size(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this.count) return undefined;
    const actualIndex = (this.head + index) % this.capacity;
    return this.buffer[actualIndex];
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(this.head + i) % this.capacity] as T);
    }
    return result;
  }

  clear(): void {
    this.buffer = Array.from({ length: this.capacity });
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
}

export interface WebSocketManagerOptions {
  url: string;
  maxRingBufferSize?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMaxAttempts?: number;
  webSocketFactory?: (url: string) => WebSocketLike;
  onGapDetected?: (gap: {
    channel: string;
    expectedSeq: number;
    receivedSeq: number;
    projectId?: string;
    lapId?: string;
  }) => void;
  onInvalidationHint?: (hint: { scope: string; projectId?: string; lapId?: string }) => void;
  onEvent?: (event: WsEvent) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export class WebSocketConnectionManager {
  private status: ConnectionStatus = "disconnected";
  private ws: WebSocketLike | null = null;
  private ringBuffer: BoundedRingBuffer<WsEvent>;
  private seenIds = new Map<string, boolean>();
  private lastSeqByChannel = new Map<string, number>();
  private activeSubscriptions = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(private readonly options: WebSocketManagerOptions) {
    this.ringBuffer = new BoundedRingBuffer<WsEvent>(options.maxRingBufferSize ?? 1000);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getBuffer(): BoundedRingBuffer<WsEvent> {
    return this.ringBuffer;
  }

  getEvents(): WsEvent[] {
    return this.ringBuffer.toArray();
  }

  getLogs(filter?: { projectId?: string; lapId?: string }): string[] {
    return this.ringBuffer
      .toArray()
      .filter((e) => {
        if (e.type !== "log") return false;
        if (filter?.projectId && e.projectId !== filter.projectId) return false;
        if (filter?.lapId && e.lapId !== filter.lapId) return false;
        return true;
      })
      .map((e) => {
        const line = e.payload.line;
        return typeof line === "string" ? line : JSON.stringify(line ?? "");
      });
  }

  clearBuffer(): void {
    this.ringBuffer.clear();
    this.seenIds.clear();
    this.lastSeqByChannel.clear();
  }

  private setStatus(newStatus: ConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.options.onStatusChange?.(newStatus);
    }
  }

  connect(): void {
    this.intentionalClose = false;
    if (this.status === "connected" || this.status === "connecting") return;
    this.setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    try {
      const factory =
        this.options.webSocketFactory ?? ((url: string) => new (globalThis as any).WebSocket(url));
      const socket = factory(this.options.url);
      this.ws = socket;

      socket.onopen = () => {
        this.setStatus("connected");
        this.reconnectAttempt = 0;
        this.resubscribeAll();
      };

      socket.onmessage = (event: { data: unknown }) => {
        this.handleRawMessage(event.data);
      };

      socket.onerror = () => {
        // Network errors trigger close handler for reconnect
      };

      socket.onclose = () => {
        this.ws = null;
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        } else {
          this.setStatus("disconnected");
        }
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  subscribe(projectId: string, lapId?: string): void {
    const key = this.channelKey(projectId, lapId);
    this.activeSubscriptions.add(key);
    this.send({ action: "subscribe", projectId, lapId });
  }

  unsubscribe(projectId: string, lapId?: string): void {
    const key = this.channelKey(projectId, lapId);
    this.activeSubscriptions.delete(key);
    this.send({ action: "unsubscribe", projectId, lapId });
  }

  private resubscribeAll(): void {
    for (const key of this.activeSubscriptions) {
      let projectId: string | undefined;
      let lapId: string | undefined;
      try {
        const parsed = JSON.parse(key) as { p?: string; l?: string };
        projectId = parsed.p || undefined;
        lapId = parsed.l || undefined;
      } catch {
        const parts = key.split(":");
        projectId = parts[0] || undefined;
        lapId = parts[1] || undefined;
      }
      this.send({
        action: "subscribe",
        projectId,
        lapId,
      });
      // Invalidation hint on reconnect so snapshots are refetched as source of truth
      this.options.onInvalidationHint?.({
        scope: "reconnect",
        projectId,
        lapId,
      });
    }
  }

  send(message: WsSubscriptionMessage): void {
    if (this.ws && this.status === "connected") {
      try {
        this.ws.send(JSON.stringify(message));
      } catch {}
    }
  }

  handleRawMessage(rawData: unknown): void {
    let data: unknown;
    try {
      data = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
    } catch {
      return;
    }

    if (!data || typeof data !== "object") return;
    const msg = data as Partial<WsEvent>;

    // Handle heartbeats/pongs without sequence numbers
    if (msg.type === "pong" || msg.type === "heartbeat") {
      return;
    }

    if (
      typeof msg.id !== "string" ||
      typeof msg.seq !== "number" ||
      typeof msg.type !== "string" ||
      typeof msg.timestamp !== "string" ||
      !msg.payload ||
      typeof msg.payload !== "object"
    ) {
      return;
    }

    const event = msg as WsEvent;

    // 1. Deduplication by ID
    if (this.seenIds.has(event.id)) {
      return;
    }
    this.recordSeenId(event.id);

    // 2. Channel sequence tracking and gap recovery
    const channel = this.channelKey(event.projectId, event.lapId);
    const lastSeq = this.lastSeqByChannel.get(channel);

    if (lastSeq !== undefined) {
      if (event.seq <= lastSeq) {
        // Out of order duplicate sequence number
        return;
      }
      if (event.seq > lastSeq + 1) {
        // Sequence gap detected! Signal gap recovery
        this.options.onGapDetected?.({
          channel,
          expectedSeq: lastSeq + 1,
          receivedSeq: event.seq,
          projectId: event.projectId,
          lapId: event.lapId,
        });
        // Events serve as invalidation hints; gap triggers full snapshot query refetch
        this.options.onInvalidationHint?.({
          scope: "gap_recovery",
          projectId: event.projectId,
          lapId: event.lapId,
        });
      }
    }

    this.lastSeqByChannel.set(channel, event.seq);

    // 3. Ring buffer bounded storage
    this.ringBuffer.push(event);

    // 4. Invalidation hint delivery
    if (event.type === "invalidation" || event.type === "lifecycle") {
      const rawScope = event.payload.scope;
      const scope = typeof rawScope === "string" ? rawScope : event.type;
      this.options.onInvalidationHint?.({
        scope,
        projectId: event.projectId,
        lapId: event.lapId,
      });
    }

    // 5. Notify event listeners
    this.options.onEvent?.(event);
  }

  private channelKey(projectId?: string, lapId?: string): string {
    return JSON.stringify({ p: projectId ?? "", l: lapId ?? "" });
  }

  private recordSeenId(id: string): void {
    this.seenIds.set(id, true);
    if (this.seenIds.size > 5000) {
      const oldestKey = this.seenIds.keys().next().value;
      if (oldestKey !== undefined) this.seenIds.delete(oldestKey);
    }
  }

  private scheduleReconnect(): void {
    const maxAttempts = this.options.reconnectMaxAttempts ?? Infinity;
    if (this.reconnectAttempt >= maxAttempts) {
      this.setStatus("disconnected");
      return;
    }

    this.setStatus("reconnecting");
    const baseDelay = this.options.reconnectBaseDelayMs ?? 300;
    const maxDelay = this.options.reconnectMaxDelayMs ?? 5000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempt), maxDelay);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export function createWebSocketManager(
  options: WebSocketManagerOptions,
): WebSocketConnectionManager {
  return new WebSocketConnectionManager(options);
}
