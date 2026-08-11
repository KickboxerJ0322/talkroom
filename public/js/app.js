import { createInitialState } from "./state.js";
import { SocketClient } from "./socketClient.js";
import { TranscriptionStreamer } from "./transcriptionStreamer.js";
import { UIController } from "./ui.js";
import { WebRtcClient } from "./webrtcClient.js";

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const PIN_PATTERN = /^\d{4,8}$/;
const MEDIA_CONSTRAINTS = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  },
  video: false
};

const state = createInitialState();
const ui = new UIController();
const socketClient = new SocketClient(io({ autoConnect: true }));
let webRtcClient = null;
let transcriptionStreamer = null;

function buildTranscriptExport() {
  if (state.transcriptMessages.length === 0) {
    return "";
  }

  return state.transcriptMessages
    .map((message) => {
      const speaker = message.speaker === "local" ? "自分" : "相手";
      const time = new Intl.DateTimeFormat("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(new Date(message.timestamp));
      return `${speaker}\n${time}\n${message.text}\n`;
    })
    .join("\n");
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function renderTranscript() {
  ui.renderTranscript(state.transcriptMessages, state.transcriptDrafts);
}

function setTranscriptStatus() {
  ui.setTranscriptStatus({
    supported: state.transcriptSupported,
    listening: state.transcriptListening
  });
}

function resetTranscriptState() {
  state.transcriptMessages = [];
  state.transcriptDrafts = {
    local: "",
    remote: ""
  };
  renderTranscript();
  ui.setTranscriptActionsDisabled(true);
}

function appendTranscriptMessage(speaker, text) {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return;
  }

  state.transcriptMessages.push({
    speaker,
    text: normalizedText,
    timestamp: Date.now()
  });
  state.transcriptDrafts[speaker] = "";
  renderTranscript();
  ui.setTranscriptActionsDisabled(false);
}

function updateTranscriptDraft(speaker, text) {
  state.transcriptDrafts[speaker] = text.trim();
  renderTranscript();
}

function exportTranscript() {
  const text = buildTranscriptExport();
  if (!text) {
    return;
  }

  const fileName = `talkroom-${state.roomId || "log"}-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.txt`;
  const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([utf8Bom, text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function resetApp() {
  if (state.roomId) {
    socketClient.emit("leave-room");
  }

  await teardownCall();
  stopLocalStream();
  resetTranscriptState();
  ui.clearError();
  ui.setMuteButtonLabel(true);
  ui.resetForm();
  ui.setStatus("waiting", state.socketConnected ? "待機中" : "未接続");
  ui.setPresence("ルームに参加すると状態がここに表示されます。");
}

function createTranscriptionStreamer() {
  if (!state.transcriptServerEnabled || !TranscriptionStreamer.isSupported()) {
    state.transcriptSupported = false;
    state.transcriptListening = false;
    setTranscriptStatus();
    return null;
  }

  state.transcriptSupported = true;
  state.transcriptListening = false;
  setTranscriptStatus();

  return new TranscriptionStreamer({
    stream: state.localStream,
    onTranscript: (text) => {
      appendTranscriptMessage("local", text);
      socketClient.emit("transcript-final", {
        roomId: state.roomId,
        text
      });
    },
    onStateChange: ({ supported, listening }) => {
      state.transcriptSupported = supported;
      state.transcriptListening = listening;
      setTranscriptStatus();
    },
    onError: (error) => {
      ui.showError(error.message || "音声文字起こしに失敗しました。");
      state.transcriptListening = false;
      setTranscriptStatus();
    }
  });
}

async function startTranscription({ force = false } = {}) {
  if ((!state.callConnected && !force) || !state.localStream || !state.transcriptServerEnabled) {
    return;
  }

  if (!transcriptionStreamer) {
    transcriptionStreamer = createTranscriptionStreamer();
  }

  if (!transcriptionStreamer) {
    return;
  }

  try {
    await transcriptionStreamer.start();
  } catch (error) {
    ui.showError(error.message || "音声文字起こしを開始できませんでした。");
    state.transcriptListening = false;
    setTranscriptStatus();
  }
}

async function stopTranscription() {
  if (!transcriptionStreamer) {
    return;
  }

  updateTranscriptDraft("local", "");
  try {
    await transcriptionStreamer.stop();
  } catch (_error) {
    state.transcriptListening = false;
    setTranscriptStatus();
  }
}

async function fetchAppConfiguration() {
  const response = await fetch("/api/config");
  if (!response.ok) {
    throw new Error("設定の読み込みに失敗しました。");
  }

  const data = await response.json();
  state.rtcConfiguration = data.rtcConfiguration;
  state.transcriptServerEnabled = Boolean(data.transcription?.enabled);
  state.transcriptSupported = state.transcriptServerEnabled && TranscriptionStreamer.isSupported();
}

async function ensureLocalAudio() {
  if (state.localStream) {
    return state.localStream;
  }

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
    state.micEnabled = true;
    ui.setMuteButtonLabel(true);
    return state.localStream;
  } catch (error) {
    if (error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
      throw new Error("マイクの利用が許可されていません。ブラウザ設定を確認してください。");
    }

    throw new Error("マイクを利用できませんでした。");
  }
}

function resetRoomState() {
  state.roomId = "";
  state.pin = "";
  ui.setRoom("");
  ui.setJoinDisabled(false);
}

async function teardownCall({ keepRoom = false } = {}) {
  await stopTranscription();

  if (webRtcClient) {
    webRtcClient.close();
  }

  webRtcClient = null;
  transcriptionStreamer = null;
  state.peerConnection = null;
  state.remoteStream = null;
  state.callConnected = false;
  state.transcriptDrafts.remote = "";
  ui.clearRemoteStream();
  ui.stopTimer();
  ui.setCallControlsDisabled(true);
  ui.setStatus("waiting", state.socketConnected ? "待機中" : "未接続");
  ui.setPresence(keepRoom ? "相手を待っています。" : "ルームに参加すると状態がここに表示されます。");
  renderTranscript();

  if (!keepRoom) {
    resetRoomState();
  }
}

function stopLocalStream() {
  if (!state.localStream) {
    return;
  }

  state.localStream.getTracks().forEach((track) => track.stop());
  state.localStream = null;
}

function initializeWebRtcClient() {
  webRtcClient = new WebRtcClient({
    rtcConfiguration: state.rtcConfiguration,
    onIceCandidate: (candidate) => {
      socketClient.emit("ice-candidate", {
        roomId: state.roomId,
        candidate
      });
    },
    onTrack: (stream) => {
      state.remoteStream = stream;
      ui.attachRemoteStream(stream);
    },
    onConnectionStateChange: async (connectionState) => {
      if (connectionState === "connected") {
        state.callConnected = true;
        ui.clearError();
        ui.setStatus("connected", "通話中");
        ui.setPresence("音声接続が完了しました。");
        ui.setCallControlsDisabled(false);
        ui.startTimer();
        await startTranscription();
      }

      if (["failed", "disconnected"].includes(connectionState)) {
        ui.showError("接続に失敗しました。通信環境を確認してください。");
        await teardownCall({ keepRoom: true });
      }

      if (connectionState === "closed") {
        await teardownCall({ keepRoom: true });
      }
    }
  });

  return webRtcClient;
}

async function preparePeerConnection() {
  const localStream = await ensureLocalAudio();
  const rtc = initializeWebRtcClient();
  state.peerConnection = rtc.createPeerConnection(localStream);
}

async function joinRoom() {
  const roomId = ui.getRoomIdInput();
  const pin = ui.getPinInput();
  ui.clearError();

  if (!roomId) {
    ui.showError("ルームIDを入力してください。");
    return;
  }

  if (!ROOM_ID_PATTERN.test(roomId)) {
    ui.showError("ルームIDは3〜32文字の英数字、ハイフン、アンダースコアで入力してください。");
    return;
  }

  if (!PIN_PATTERN.test(pin)) {
    ui.showError("PINは4〜8桁の数字で入力してください。");
    return;
  }

  await ensureLocalAudio();
  transcriptionStreamer = createTranscriptionStreamer();
  state.roomId = roomId;
  state.pin = pin;
  ui.setRoom(roomId);
  ui.setJoinDisabled(true);
  ui.setStatus("waiting", "接続中");
  ui.setPresence("相手を待っています。");
  resetTranscriptState();
  await startTranscription({ force: true });

  socketClient.emit("join-room", { roomId, pin });
}

async function leaveRoom() {
  socketClient.emit("leave-room");
  await teardownCall();
  stopLocalStream();
  ui.clearError();
  ui.setMuteButtonLabel(true);
}

function toggleMute() {
  if (!state.localStream) {
    return;
  }

  state.micEnabled = !state.micEnabled;
  state.localStream.getAudioTracks().forEach((track) => {
    track.enabled = state.micEnabled;
  });
  ui.setMuteButtonLabel(state.micEnabled);
}

function registerSocketEvents() {
  socketClient.on("connect", () => {
    state.socketConnected = true;
    if (!state.callConnected) {
      ui.setStatus("waiting", "待機中");
    }
  });

  socketClient.on("disconnect", async () => {
    state.socketConnected = false;
    ui.showError("Socket.IO接続が切れました。ページを再読み込みして再接続してください。");
    await teardownCall({ keepRoom: true });
  });

  socketClient.on("joined-room", ({ roomId, participantCount }) => {
    state.roomId = roomId;
    ui.setRoom(roomId);
    ui.setPresence(participantCount === 1 ? "相手を待っています。" : "通話相手を認識しています。");
  });

  socketClient.on("waiting-peer", ({ message }) => {
    ui.setStatus("waiting", "待機中");
    ui.setPresence(message);
  });

  socketClient.on("peer-present", async () => {
    ui.setStatus("waiting", "接続中");
    ui.setPresence("通話相手を認識しています。");
    await preparePeerConnection();
  });

  socketClient.on("peer-joined", async () => {
    try {
      ui.setStatus("waiting", "接続中");
      ui.setPresence("通話相手を認識しています。");
      await preparePeerConnection();
      const offer = await webRtcClient.createOffer();
      socketClient.emit("offer", { roomId: state.roomId, offer });
    } catch (error) {
      ui.showError(error.message || "通話接続の準備に失敗しました。");
      await teardownCall({ keepRoom: true });
    }
  });

  socketClient.on("offer", async ({ offer }) => {
    try {
      if (!state.peerConnection) {
        await preparePeerConnection();
      }

      const answer = await webRtcClient.handleOffer(offer);
      socketClient.emit("answer", { roomId: state.roomId, answer });
    } catch (_error) {
      ui.showError("Offerの処理に失敗しました。");
      await teardownCall({ keepRoom: true });
    }
  });

  socketClient.on("answer", async ({ answer }) => {
    try {
      await webRtcClient.handleAnswer(answer);
    } catch (_error) {
      ui.showError("Answerの処理に失敗しました。");
      await teardownCall({ keepRoom: true });
    }
  });

  socketClient.on("ice-candidate", async ({ candidate }) => {
    try {
      if (state.peerConnection) {
        await webRtcClient.addIceCandidate(candidate);
      }
    } catch (_error) {
      ui.showError("ICE Candidateの処理に失敗しました。");
    }
  });

  socketClient.on("transcript-interim", ({ text }) => {
    updateTranscriptDraft("remote", text || "");
  });

  socketClient.on("transcript-final", ({ text }) => {
    appendTranscriptMessage("remote", text || "");
  });

  socketClient.on("peer-left", async () => {
    ui.showError("相手が退出しました。");
    await teardownCall({ keepRoom: true });
  });

  socketClient.on("room-full", async ({ message }) => {
    await stopTranscription();
    transcriptionStreamer = null;
    ui.showError(message);
    resetRoomState();
  });

  socketClient.on("room-error", async ({ message }) => {
    await stopTranscription();
    transcriptionStreamer = null;
    ui.showError(message);
    resetRoomState();
  });
}

async function init() {
  try {
    await fetchAppConfiguration();
    ui.remoteAudio.volume = isMobileDevice() ? 0.34 : 0.56;
    registerSocketEvents();
    renderTranscript();
    setTranscriptStatus();
    ui.setTranscriptActionsDisabled(true);

    ui.joinForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      try {
        await joinRoom();
      } catch (error) {
        ui.showError(error.message || "ルーム参加に失敗しました。");
        ui.setJoinDisabled(false);
      }
    });

    ui.muteButton.addEventListener("click", toggleMute);
    ui.hangupButton.addEventListener("click", leaveRoom);
    ui.exportTranscriptButton.addEventListener("click", exportTranscript);
    ui.resetAppButton.addEventListener("click", resetApp);
  } catch (error) {
    ui.showError(error.message || "初期化に失敗しました。");
  }
}

window.addEventListener("beforeunload", () => {
  if (state.roomId) {
    socketClient.emit("leave-room");
  }
  stopTranscription();
  stopLocalStream();
});

init();
