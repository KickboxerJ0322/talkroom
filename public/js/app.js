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
const CAMERA_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: "user",
    width: { ideal: 640 },
    height: { ideal: 360 }
  }
};

const state = createInitialState();
state.speakerEnabled = true;

const ui = new UIController();
const socketClient = new SocketClient(io({ autoConnect: true }));
const observedVideoTracks = new WeakSet();

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

function syncVideoPanels() {
  ui.syncVideoPanels({
    localStream: state.localStream,
    remoteStream: state.remoteStream
  });
}

function syncMediaStatus() {
  ui.updateMediaStatus({
    micEnabled: state.micEnabled,
    speakerEnabled: state.speakerEnabled,
    cameraEnabled: state.cameraEnabled
  });
}

function observeVideoTracks(stream) {
  if (!stream) {
    return;
  }

  stream.getVideoTracks().forEach((track) => {
    if (observedVideoTracks.has(track)) {
      return;
    }

    observedVideoTracks.add(track);
    track.addEventListener("ended", syncVideoPanels);
    track.addEventListener("mute", syncVideoPanels);
    track.addEventListener("unmute", syncVideoPanels);
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

function resetMediaControls() {
  state.micEnabled = true;
  state.cameraEnabled = false;
  state.speakerEnabled = true;
  ui.setMuteButtonLabel(true);
  ui.setCameraButtonLabel(false);
  ui.setSpeakerButtonLabel(true);
  ui.remoteAudio.muted = false;
  ui.remoteAudio.volume = 1;
  ui.remoteVideo.muted = true;
  ui.remoteVideo.volume = 0;
  syncMediaStatus();
}

async function resetApp() {
  if (state.roomId) {
    socketClient.emit("leave-room");
  }

  await teardownCall();
  stopLocalStream();
  resetTranscriptState();
  ui.clearError();
  resetMediaControls();
  ui.resetForm();
  ui.setStatus("waiting", state.socketConnected ? "待機中" : "未接続");
  ui.setPresence("");
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
      ui.showError(error.message || "文字起こし処理でエラーが発生しました。");
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
    ui.showError(error.message || "文字起こしを開始できませんでした。");
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
    resetMediaControls();
    ui.attachLocalPreview(state.localStream);
    syncVideoPanels();
    return state.localStream;
  } catch (error) {
    if (error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
      throw new Error("マイクの使用が許可されていません。ブラウザ設定を確認してください。");
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

function releaseLocalVideoTrack() {
  if (!state.localStream) {
    state.cameraEnabled = false;
    ui.setCameraButtonLabel(false);
    syncMediaStatus();
    ui.clearLocalPreview();
    syncVideoPanels();
    return;
  }

  state.localStream.getVideoTracks().forEach((track) => {
    state.localStream.removeTrack(track);
    track.stop();
  });
  state.cameraEnabled = false;
  ui.setCameraButtonLabel(false);
  syncMediaStatus();
  ui.attachLocalPreview(state.localStream);
  syncVideoPanels();
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
  releaseLocalVideoTrack();
  ui.clearRemoteStream();
  syncVideoPanels();
  ui.stopTimer();
  ui.setCallControlsDisabled(true);
  ui.setStatus("waiting", state.socketConnected ? "待機中" : "未接続");
  ui.setPresence("");
  renderTranscript();

  if (!keepRoom) {
    resetRoomState();
  }
}

function stopLocalStream() {
  if (!state.localStream) {
    resetMediaControls();
    ui.clearLocalPreview();
    return;
  }

  releaseLocalVideoTrack();
  state.localStream.getTracks().forEach((track) => track.stop());
  state.localStream = null;
  resetMediaControls();
  ui.clearLocalPreview();
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
      observeVideoTracks(stream);
      ui.attachRemoteStream(stream);
      syncVideoPanels();
    },
    onConnectionStateChange: async (connectionState) => {
      if (connectionState === "connected") {
        state.callConnected = true;
        ui.clearError();
        ui.setStatus("connected", "通話中");
        ui.setPresence("");
        ui.setCallControlsDisabled(false);
        ui.startTimer();
        await startTranscription();
      }

      if (["failed", "disconnected"].includes(connectionState)) {
        ui.showError("通話接続に失敗しました。再接続を試してください。");
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

async function renegotiatePeerConnection() {
  if (!webRtcClient || !state.peerConnection || !state.roomId) {
    return;
  }

  const offer = await webRtcClient.createOffer();
  socketClient.emit("offer", { roomId: state.roomId, offer });
}

async function enableCamera() {
  await ensureLocalAudio();

  let videoTrack = state.localStream.getVideoTracks()[0];
  if (!videoTrack) {
    let cameraStream;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    } catch (error) {
      if (error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
        throw new Error("カメラの使用が許可されていません。ブラウザ設定を確認してください。");
      }

      throw new Error("カメラを利用できませんでした。");
    }

    videoTrack = cameraStream.getVideoTracks()[0];
    state.localStream.addTrack(videoTrack);
  }

  videoTrack.enabled = true;
  state.cameraEnabled = true;
  observeVideoTracks(state.localStream);
  ui.attachLocalPreview(state.localStream);

  if (state.peerConnection && webRtcClient) {
    await webRtcClient.addOrReplaceVideoTrack(videoTrack, state.localStream);
    await renegotiatePeerConnection();
  }

  ui.setCameraButtonLabel(true);
  syncMediaStatus();
  syncVideoPanels();
}

async function disableCamera() {
  if (!state.localStream) {
    state.cameraEnabled = false;
    ui.setCameraButtonLabel(false);
    syncMediaStatus();
    syncVideoPanels();
    return;
  }

  const [videoTrack] = state.localStream.getVideoTracks();
  if (!videoTrack) {
    state.cameraEnabled = false;
    ui.setCameraButtonLabel(false);
    syncMediaStatus();
    syncVideoPanels();
    return;
  }

  if (state.peerConnection && webRtcClient) {
    await webRtcClient.clearVideoTrack();
    await renegotiatePeerConnection();
  }

  state.localStream.removeTrack(videoTrack);
  videoTrack.stop();
  state.cameraEnabled = false;
  ui.setCameraButtonLabel(false);
  syncMediaStatus();
  ui.attachLocalPreview(state.localStream);
  syncVideoPanels();
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
    ui.showError("ルームIDは 3 から 32 文字の英数字、ハイフン、アンダースコアで入力してください。");
    return;
  }

  if (!PIN_PATTERN.test(pin)) {
    ui.showError("PIN は 4 から 8 桁の数字で入力してください。");
    return;
  }

  await ensureLocalAudio();
  transcriptionStreamer = createTranscriptionStreamer();
  state.roomId = roomId;
  state.pin = pin;
  ui.setRoom(roomId);
  ui.setJoinDisabled(true);
  ui.setStatus("waiting", "接続中");
  ui.setPresence("");
  resetTranscriptState();
  await startTranscription({ force: true });

  socketClient.emit("join-room", { roomId, pin });
}

async function leaveRoom() {
  socketClient.emit("leave-room");
  await teardownCall();
  stopLocalStream();
  ui.clearError();
  resetMediaControls();
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
  syncMediaStatus();
}

async function toggleCamera() {
  ui.cameraButton.disabled = true;

  try {
    if (state.cameraEnabled) {
      await disableCamera();
    } else {
      await enableCamera();
    }
  } catch (error) {
    ui.showError(error.message || "カメラ切り替えに失敗しました。");
  } finally {
    ui.cameraButton.disabled = !state.callConnected;
  }
}

function toggleSpeaker() {
  state.speakerEnabled = !state.speakerEnabled;
  ui.remoteAudio.muted = !state.speakerEnabled;
  ui.remoteAudio.volume = state.speakerEnabled ? (isMobileDevice() ? 0.34 : 0.56) : 0;
  ui.remoteVideo.muted = true;
  ui.remoteVideo.volume = 0;
  ui.setSpeakerButtonLabel(state.speakerEnabled);
  syncMediaStatus();
}

function registerSocketEvents() {
  socketClient.on("connect", () => {
    state.socketConnected = true;
    if (!state.callConnected) {
      ui.setStatus("waiting", "待機中");
      ui.setPresence("");
    }
  });

  socketClient.on("disconnect", async () => {
    state.socketConnected = false;
    ui.showError("Socket.IO 接続が切れました。ページを再読み込みして再接続してください。");
    await teardownCall({ keepRoom: true });
  });

  socketClient.on("joined-room", ({ roomId }) => {
    state.roomId = roomId;
    ui.setRoom(roomId);
    ui.setPresence("");
  });

  socketClient.on("waiting-peer", () => {
    ui.setStatus("waiting", "待機中");
    ui.setPresence("");
  });

  socketClient.on("peer-present", async () => {
    ui.setStatus("waiting", "接続中");
    ui.setPresence("");
    await preparePeerConnection();
  });

  socketClient.on("peer-joined", async () => {
    try {
      ui.setStatus("waiting", "接続中");
      ui.setPresence("");
      await preparePeerConnection();
      const offer = await webRtcClient.createOffer();
      socketClient.emit("offer", { roomId: state.roomId, offer });
    } catch (error) {
      ui.showError(error.message || "相手との接続準備に失敗しました。");
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
      ui.showError("Offer の処理に失敗しました。");
      await teardownCall({ keepRoom: true });
    }
  });

  socketClient.on("answer", async ({ answer }) => {
    try {
      await webRtcClient.handleAnswer(answer);
    } catch (_error) {
      ui.showError("Answer の処理に失敗しました。");
      await teardownCall({ keepRoom: true });
    }
  });

  socketClient.on("ice-candidate", async ({ candidate }) => {
    try {
      if (state.peerConnection) {
        await webRtcClient.addIceCandidate(candidate);
      }
    } catch (_error) {
      ui.showError("ICE Candidate の処理に失敗しました。");
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
    resetMediaControls();
    registerSocketEvents();
    renderTranscript();
    setTranscriptStatus();
    syncVideoPanels();
    syncMediaStatus();
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
    ui.cameraButton.addEventListener("click", toggleCamera);
    ui.speakerButton.addEventListener("click", toggleSpeaker);
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
