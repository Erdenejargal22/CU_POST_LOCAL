const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const PORT = Number(process.env.BRIDGE_PORT || 4000);
const SERIAL_PATH = process.env.LOCKER_COM_PORT || "COM7";
const BAUD_RATE = Number(process.env.LOCKER_BAUD_RATE || 115200);
const SCANNER_COM_PORT = process.env.SCANNER_COM_PORT || "COM6";
const SCANNER_BAUD_RATE = Number(process.env.SCANNER_BAUD_RATE || 9600);

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function escapeDle(bytes) {
  const out = [];
  for (const b of bytes) {
    out.push(b);
    if (b === 0x10) out.push(0x10);
  }
  return out;
}

function buildYinLongOpenFrame(boardAddr, gateIndex) {
  const dataPacket = [0x57, 0x4f, 0x02, 0x00, boardAddr & 0xff, gateIndex & 0xff];
  let xor = 0;
  for (const b of dataPacket) xor ^= b;
  const body = escapeDle([...dataPacket, xor]);
  return Buffer.from([0x10, 0x02, ...body, 0x10, 0x03]);
}

// 1. YinLong Locker Control Board Serial Port (COM7)
let lockerPort = null;
let lockerPortReady = false;
let lockerReconnectTimer = null;

function initLockerSerial() {
  if (lockerReconnectTimer) {
    clearTimeout(lockerReconnectTimer);
    lockerReconnectTimer = null;
  }

  lockerPort = new SerialPort({
    path: SERIAL_PATH,
    baudRate: BAUD_RATE,
    dataBits: 8,
    stopBits: 1,
    parity: "even",
    autoOpen: false,
  });

  lockerPort.open((err) => {
    if (err) {
      lockerPortReady = false;
      console.error(`[LOCKER SERIAL] ${SERIAL_PATH} нээгдсэнгүй:`, err.message);
      lockerReconnectTimer = setTimeout(initLockerSerial, 3000);
      return;
    }
    lockerPortReady = true;
    console.log(`[LOCKER SERIAL] ${SERIAL_PATH} (${BAUD_RATE}, 8E1) нээгдлээ.`);
  });

  lockerPort.on("data", (chunk) => {
    console.log("[LOCKER RX HEX]:", chunk.toString("hex").toUpperCase());
  });

  lockerPort.on("close", () => {
    lockerPortReady = false;
    console.warn("[LOCKER SERIAL] Порт хаагдлаа, 3 сек дараа дахин холбогдоно...");
    lockerReconnectTimer = setTimeout(initLockerSerial, 3000);
  });

  lockerPort.on("error", (err) => {
    console.error("[LOCKER SERIAL ERR]:", err.message);
  });
}

// 2. QR Scanner Serial Port (COM6)
let scannerPort = null;
let scannerPortReady = false;
let scannerReconnectTimer = null;

function initScannerSerial() {
  if (scannerReconnectTimer) {
    clearTimeout(scannerReconnectTimer);
    scannerReconnectTimer = null;
  }

  if (!SCANNER_COM_PORT) {
    console.log("[SCANNER SERIAL] SCANNER_COM_PORT тохируулаагүй.");
    return;
  }

  if (SCANNER_COM_PORT.toUpperCase() === SERIAL_PATH.toUpperCase()) {
    console.error(
      `[SCANNER SERIAL] ${SCANNER_COM_PORT} нь LOCKER_COM_PORT (${SERIAL_PATH})-тай давхцаж байна. Өөр порт заана уу.`,
    );
    return;
  }

  scannerPort = new SerialPort({
    path: SCANNER_COM_PORT,
    baudRate: SCANNER_BAUD_RATE,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    autoOpen: false,
  });

  const parser = scannerPort.pipe(new ReadlineParser({ delimiter: "\r" }));

  scannerPort.open((err) => {
    if (err) {
      scannerPortReady = false;
      console.error(`[SCANNER SERIAL] ${SCANNER_COM_PORT} нээгдсэнгүй:`, err.message);
      scannerReconnectTimer = setTimeout(initScannerSerial, 3000);
      return;
    }
    scannerPortReady = true;
    console.log(`[SCANNER SERIAL] ${SCANNER_COM_PORT} (${SCANNER_BAUD_RATE}, 8N1) нээгдлээ.`);
  });

  parser.on("data", (line) => {
    const code = String(line).replace(/[\r\n]+/g, "").trim();
    if (!code) return;
    console.log("[SCANNER RX]:", code);
    broadcast({ type: "qr_scan", code });
  });

  scannerPort.on("close", () => {
    scannerPortReady = false;
    console.warn("[SCANNER SERIAL] Порт хаагдлаа, 3 сек дараа дахин холбогдоно...");
    scannerReconnectTimer = setTimeout(initScannerSerial, 3000);
  });

  scannerPort.on("error", (err) => {
    console.error("[SCANNER SERIAL ERR]:", err.message);
  });
}

initLockerSerial();
initScannerSerial();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    locker: { port: SERIAL_PATH, baudRate: BAUD_RATE, ready: lockerPortReady },
    scanner: { port: SCANNER_COM_PORT || null, baudRate: SCANNER_BAUD_RATE, ready: scannerPortReady },
    wsClients: wss.clients.size,
  });
});

app.post("/api/locker/open", (req, res) => {
  const { doorId, boardAddr = 1, gateIndex = 1 } = req.body || {};
  const frame = buildYinLongOpenFrame(Number(boardAddr), Number(gateIndex));
  const hex = frame.toString("hex").toUpperCase();

  console.log(`[OPEN REQ] doorId=${doorId} board=${boardAddr} gate=${gateIndex} hex=${hex}`);

  if (!lockerPortReady || !lockerPort) {
    return res.status(503).json({ ok: false, error: "Locker serial port not ready", hex });
  }

  lockerPort.write(frame, (err) => {
    if (err) {
      console.error("[LOCKER WRITE ERR]:", err.message);
      return res.status(500).json({ ok: false, error: err.message, hex });
    }
    lockerPort.drain(() => {
      res.json({ ok: true, doorId, boardAddr, gateIndex, hex });
    });
  });
});

// Тест хийх эсвэл гараар scan event илгээх endpoint
app.post("/api/scanner/simulate", (req, res) => {
  const code = String(req.body?.code || "").trim();
  if (!code) return res.status(400).json({ ok: false, error: "code required" });
  console.log("[SCANNER SIMULATE]:", code);
  broadcast({ type: "qr_scan", code });
  res.json({ ok: true, code });
});

wss.on("connection", (ws) => {
  console.log("[WS] Next.js UI холбогдлоо.");
  ws.send(
    JSON.stringify({
      type: "bridge_status",
      lockerReady: lockerPortReady,
      scannerReady: scannerPortReady,
    }),
  );
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[BRIDGE] http://127.0.0.1:${PORT} болон ws://127.0.0.1:${PORT} ажиллаж байна.`);
});