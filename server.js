const express = require("express");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { Server } = require("socket.io");
const { getRtcConfiguration } = require("./config/webrtc");

const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTPS_PORT = 3443;
const GOOGLE_STT_ENDPOINT = "https://speech.googleapis.com/v1/speech:recognize";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const PIN_PATTERN = /^\d{4,8}$/;
const rooms = new Map();

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }

  return process.argv[index + 1] || null;
}

function shouldUseHttps() {
  return process.argv.includes("--https") || process.env.DEV_HTTPS === "1";
}

function loadHttpsOptions() {
  const pfxPath =
    process.env.HTTPS_PFX_PATH || path.join(__dirname, "certs", "localhost-dev.pfx");
  const passphrase = process.env.HTTPS_PFX_PASSPHRASE || "changeit";

  if (!fs.existsSync(pfxPath)) {
    throw new Error(
      `HTTPS証明書が見つかりません: ${pfxPath}\n先に scripts/generate-dev-cert.ps1 を実行してください。`
    );
  }

  return {
    pfx: fs.readFileSync(pfxPath),
    passphrase
  };
}

function isRoomIdValid(roomId) {
  return ROOM_ID_PATTERN.test(roomId);
}

function isPinValid(pin) {
  return PIN_PATTERN.test(pin);
}

function getSpeechApiKey() {
  return process.env.GOOGLE_CLOUD_API_KEY || "";
}

function isTranscriptionEnabled() {
  return Boolean(getSpeechApiKey());
}

function normalizeTranscriptFromResponse(payload) {
  const results = Array.isArray(payload.results) ? payload.results : [];

  return results
    .map((result) => result.alternatives?.[0]?.transcript || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getOrCreateRoomRecord(roomId, pin) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      pin,
      locked: false,
      participantsSeen: 0
    });
  }

  return rooms.get(roomId);
}

async function transcribeAudio({
  buffer,
  languageCode = "ja-JP",
  encoding = "LINEAR16",
  sampleRateHertz
}) {
  const apiKey = getSpeechApiKey();
  if (!apiKey) {
    throw new Error("Google Cloud Speech-to-Text の API キーが未設定です。");
  }

  if (!sampleRateHertz) {
    throw new Error("音声のサンプルレートが取得できませんでした。");
  }

  const response = await fetch(`${GOOGLE_STT_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      config: {
        encoding,
        languageCode,
        sampleRateHertz,
        enableAutomaticPunctuation: true,
        model: "default"
      },
      audio: {
        content: buffer.toString("base64")
      }
    })
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    const apiMessage = errorPayload.error?.message;
    throw new Error(apiMessage || "Google Cloud Speech-to-Text の呼び出しに失敗しました。");
  }

  return normalizeTranscriptFromResponse(await response.json());
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  res.json({
    rtcConfiguration: getRtcConfiguration(),
    transcription: {
      enabled: isTranscriptionEnabled()
    }
  });
});

app.post(
  "/api/transcribe",
  express.raw({ type: "*/*", limit: "2mb" }),
  async (req, res) => {
    if (!isTranscriptionEnabled()) {
      res.status(503).json({
        message: "Google Cloud Speech-to-Text の API キーが設定されていません。"
      });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({
        message: "音声データが空です。"
      });
      return;
    }

    const languageCodeHeader = req.get("X-Language-Code");
    const encodingHeader = req.get("X-Audio-Encoding");
    const sampleRateHeader = req.get("X-Sample-Rate-Hz");
    const languageCode =
      typeof languageCodeHeader === "string" && languageCodeHeader.trim()
        ? languageCodeHeader.trim()
        : "ja-JP";
    const encoding =
      typeof encodingHeader === "string" && encodingHeader.trim()
        ? encodingHeader.trim()
        : "LINEAR16";
    const sampleRateHertz = parsePositiveInteger(sampleRateHeader);

    if (!sampleRateHertz) {
      res.status(400).json({
        message: "音声のサンプルレートが不正です。"
      });
      return;
    }

    try {
      const text = await transcribeAudio({
        buffer: req.body,
        languageCode,
        encoding,
        sampleRateHertz
      });
      res.json({ text });
    } catch (error) {
      res.status(502).json({
        message: error.message || "音声文字起こしに失敗しました。"
      });
    }
  }
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const transportServer = shouldUseHttps()
  ? https.createServer(loadHttpsOptions(), app)
  : http.createServer(app);

const io = new Server(transportServer);

function getRoomSize(roomId) {
  return io.sockets.adapter.rooms.get(roomId)?.size || 0;
}

function emitRoomState(roomId) {
  io.to(roomId).emit("room-state", {
    roomId,
    participantCount: getRoomSize(roomId)
  });
}

function leaveCurrentRoom(socket, reason = "left") {
  const roomId = socket.data.roomId;

  if (!roomId) {
    return;
  }

  socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.pin = null;
  socket.to(roomId).emit("peer-left", { reason });
  socket.to(roomId).emit("transcript-interim", { text: "" });
  emitRoomState(roomId);
}

function isAuthorizedRoomEvent(socket, roomId, payload) {
  return Boolean(roomId && roomId === socket.data.roomId && payload);
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, pin }) => {
    const normalizedRoomId = typeof roomId === "string" ? roomId.trim() : "";
    const normalizedPin = typeof pin === "string" ? pin.trim() : "";

    if (!isRoomIdValid(normalizedRoomId)) {
      socket.emit("room-error", {
        code: "INVALID_ROOM",
        message:
          "ルームIDは3〜32文字の英数字、ハイフン、アンダースコアで入力してください。"
      });
      return;
    }

    if (!isPinValid(normalizedPin)) {
      socket.emit("room-error", {
        code: "INVALID_PIN",
        message: "PINは4〜8桁の数字で入力してください。"
      });
      return;
    }

    if (socket.data.roomId && socket.data.roomId !== normalizedRoomId) {
      leaveCurrentRoom(socket, "switched-room");
    }

    const roomRecord = getOrCreateRoomRecord(normalizedRoomId, normalizedPin);
    if (roomRecord.pin !== normalizedPin) {
      socket.emit("room-error", {
        code: "INVALID_PIN",
        message: "PINが一致しません。"
      });
      return;
    }

    if (roomRecord.locked) {
      socket.emit("room-error", {
        code: "ROOM_LOCKED",
        message: "このルームは使用済みのため、再入室できません。"
      });
      return;
    }

    const currentSize = getRoomSize(normalizedRoomId);
    if (currentSize >= 2) {
      socket.emit("room-full", {
        roomId: normalizedRoomId,
        message: "このルームは満員です。"
      });
      return;
    }

    const existingPeerIds = Array.from(io.sockets.adapter.rooms.get(normalizedRoomId) || []);
    socket.join(normalizedRoomId);
    socket.data.roomId = normalizedRoomId;
    socket.data.pin = normalizedPin;
    roomRecord.participantsSeen = Math.max(roomRecord.participantsSeen, currentSize + 1);
    if (roomRecord.participantsSeen >= 2) {
      roomRecord.locked = true;
    }

    socket.emit("joined-room", {
      roomId: normalizedRoomId,
      participantCount: currentSize + 1
    });

    emitRoomState(normalizedRoomId);

    if (existingPeerIds.length === 0) {
      socket.emit("waiting-peer", {
        roomId: normalizedRoomId,
        message: "相手を待っています。"
      });
      return;
    }

    const [existingPeerId] = existingPeerIds;
    io.to(existingPeerId).emit("peer-joined", {
      roomId: normalizedRoomId
    });
    socket.emit("peer-present", {
      roomId: normalizedRoomId
    });
  });

  socket.on("offer", ({ roomId, offer }) => {
    if (!isAuthorizedRoomEvent(socket, roomId, offer)) {
      return;
    }

    socket.to(roomId).emit("offer", { offer });
  });

  socket.on("answer", ({ roomId, answer }) => {
    if (!isAuthorizedRoomEvent(socket, roomId, answer)) {
      return;
    }

    socket.to(roomId).emit("answer", { answer });
  });

  socket.on("ice-candidate", ({ roomId, candidate }) => {
    if (!isAuthorizedRoomEvent(socket, roomId, candidate)) {
      return;
    }

    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  socket.on("transcript-interim", ({ roomId, text }) => {
    if (typeof text !== "string" || !roomId || roomId !== socket.data.roomId) {
      return;
    }

    socket.to(roomId).emit("transcript-interim", { text });
  });

  socket.on("transcript-final", ({ roomId, text }) => {
    if (typeof text !== "string" || !roomId || roomId !== socket.data.roomId || !text.trim()) {
      return;
    }

    socket.to(roomId).emit("transcript-final", { text: text.trim() });
  });

  socket.on("leave-room", () => {
    leaveCurrentRoom(socket, "peer-left");
  });

  socket.on("disconnecting", () => {
    leaveCurrentRoom(socket, "peer-disconnected");
  });
});

const port = Number(process.env.PORT) || (shouldUseHttps() ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT);
const host = getArgValue("--host") || process.env.HOST || "0.0.0.0";
const protocol = shouldUseHttps() ? "https" : "http";

transportServer.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  console.log(`Server listening on ${protocol}://${displayHost}:${port}`);
});
