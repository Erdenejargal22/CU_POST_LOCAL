"use client";

const BRIDGE_HTTP = process.env.NEXT_PUBLIC_BRIDGE_HTTP ?? "http://127.0.0.1:4000";
const BRIDGE_WS = process.env.NEXT_PUBLIC_BRIDGE_WS ?? "ws://127.0.0.1:4000";

export interface DoorTarget {
  boardAddr: number;
  gateIndex: number;
}

/**
 * doorId (жишээ нь "D01" эсвэл "1") -> V1 boardAddr & gateIndex (1..18).
 */
export function resolveDoorTarget(doorId: string): DoorTarget {
  const num = parseInt(doorId.replace(/\D+/g, ""), 10) || 1;
  const boardAddr = Math.floor((num - 1) / 18) + 1;
  const gateIndex = ((num - 1) % 18) + 1;
  return { boardAddr, gateIndex };
}

/**
 * V1 control board руу хаалга нээх команд явуулах bridge дуудлага.
 */
export async function openLockerDoorHardware(doorId: string): Promise<boolean> {
  const { boardAddr, gateIndex } = resolveDoorTarget(doorId);
  try {
    const res = await fetch(`${BRIDGE_HTTP}/api/locker/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doorId, boardAddr, gateIndex }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.ok ?? true);
  } catch {
    return false;
  }
}

/**
 * Serial/Bridge талаас ирэх QR scan болон хаалга хаагдсан төлөвийг сонсох WebSocket.
 */
export function subscribeHardwareEvents(handlers: {
  onScan: (code: string) => void;
  onDoorClosed?: (doorId: string) => void;
}): () => void {
  let ws: WebSocket | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (disposed) return;
    try {
      ws = new WebSocket(BRIDGE_WS);
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(String(ev.data));
          if (parsed?.type === "qr_scan" && typeof parsed.code === "string") {
            const clean = parsed.code.trim();
            if (clean) handlers.onScan(clean);
          } else if (parsed?.type === "door_closed" && typeof parsed.doorId === "string") {
            handlers.onDoorClosed?.(parsed.doorId);
          }
        } catch {
          const raw = String(ev.data).trim();
          if (raw) handlers.onScan(raw);
        }
      };
      ws.onclose = () => {
        if (!disposed) timer = setTimeout(connect, 2000);
      };
      ws.onerror = () => {
        ws?.close();
      };
    } catch {
      timer = setTimeout(connect, 2000);
    }
  };

  connect();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}