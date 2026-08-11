import { createInitialState } from "./state.js";
import { UIController } from "./ui.js";
import { SocketClient } from "./socketClient.js";
import { WebRtcClient } from "./webrtcClient.js";

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const PIN_PATTERN = /^\d{4,8}$/;
const MEDIA_CONSTRAINTS = {
  audio: true,
  video: false
};

const state = createInitialState();
const ui = new UIController();
const socketClient = new SocketClient(io({ autoConnect: true }));
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let webRtcClient = null;
let speechRecognition = null;
let suppressSpeechRestart = false;

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
}

function updateTranscriptDraft(speaker, text) {
  state.transcriptDrafts[speaker] = text.trim();
  renderTranscript();
}

function createSpeechRecognition() {
  if (!SpeechRecognitionCtor) {
    state.transcriptSupported = false;
    setTranscriptStatus();
    return null;
  }

  const recognition = new SpeechRecognitionCtor();
  recognition.lang = "ja-JP";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    state.transcriptListening = true;
    setTranscriptStatus();
  };

  recognition.onresult = (event) => {
    let interimText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result[0]?.transcript || "";

      if (result.isFinal) {
        appendTranscriptMessage("local", transcript);
        socketClient.emit("transcript-final", {
          roomId: state.roomId,
          text: transcript
        });
      } else {
        interimText += transcript;
      }
    }

    updateTranscriptDraft("local", interimText);
    socketClient.emit("transcript-interim", {
      roomId: state.roomId,
      text: interimText
    });
  };

  recognition.onerror = () => {
    state.transcriptListening = false;
    setTranscriptStatus();
  };

  recognition.onend = () => {
    state.transcriptListening = false;
    setTranscriptStatus();

    if (state.callConnected && !suppressSpeechRestart) {
      try {
        recognition.start();
      } catch (_error) {
        state.transcriptListening = false;
        setTranscriptStatus();
      }
    }
  };

  state.transcriptSupported = true;
  setTranscriptStatus();

  return recognition;
}

function startSpeechRecognition() {
  if (!state.transcriptSupported || !speechRecognition) {
    return;
  }

  suppressSpeechRestart = false;

  try {
    speechRecognition.start();
  } catch (_error) {
    state.transcriptListening = false;
    setTranscriptStatus();
  }
}

function stopSpeechRecognition() {
  if (!speechRecognition) {
    return;
  }

  suppressSpeechRestart = true;
  state.transcriptDrafts.local = "";
  socketClient.emit("transcript-interim", {
    roomId: state.roomId,
    text: ""
  });
  renderTranscript();

  try {
    speechRecognition.stop();
  } catch (_error) {
    state.transcriptListening = false;
    setTranscriptStatus();
  }
}

async function fetchRtcConfiguration() {
  const response = await fetch("/api/config");
  if (!response.ok) {
    throw new Error("通話設定の読み込みに失敗しました。");
  }

  const data = await response.json();
  state.rtcConfiguration = data.rtcConfiguration;
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
  resetTranscriptState();
}

function teardownCall({ keepRoom = false } = {}) {
  stopSpeechRecognition();

  if (webRtcClient) {
    webRtcClient.close();
  }

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
    onConnectionStateChange: (connectionState) => {
      if (connectionState === "connected") {
        state.callConnected = true;
        ui.clearError();
        ui.setStatus("connected", "通話中");
        ui.setPresence("音声接続が完了しました。");
        ui.setCallControlsDisabled(false);
        ui.startTimer();
        startSpeechRecognition();
      }

      if (["failed", "disconnected"].includes(connectionState)) {
        ui.showError("相手との接続に失敗しました。再度お試しください。");
        teardownCall({ keepRoom: true });
      }

      if (connectionState === "closed") {
        teardownCall({ keepRoom: true });
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
    ui.showError("ルームIDは3〜32文字の英字、数字、ハイフン、アンダースコアで入力してください。");
    return;
  }

  if (!PIN_PATTERN.test(pin)) {
    ui.showError("PINは4〜8桁の数字で入力してください。");
    return;
  }

  await ensureLocalAudio();
  state.roomId = roomId;
  state.pin = pin;
  ui.setRoom(roomId);
  ui.setJoinDisabled(true);
  ui.setStatus("waiting", "接続中");
  ui.setPresence("相手を待っています。");
  resetTranscriptState();

  socketClient.emit("join-room", { roomId, pin });
}

async function leaveRoom() {
  socketClient.emit("leave-room");
  teardownCall();
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

  socketClient.on("disconnect", () => {
    state.socketConnected = false;
    ui.showError("Socket.IO接続が切れました。ページを再読み込みして再接続してください。");
    teardownCall({ keepRoom: true });
  });

  socketClient.on("joined-room", ({ roomId, participantCount }) => {
    state.roomId = roomId;
    ui.setRoom(roomId);
    ui.setPresence(participantCount === 1 ? "相手を待っています。" : "接続準備を進めています。");
  });

  socketClient.on("waiting-peer", ({ message }) => {
    ui.setStatus("waiting", "待機中");
    ui.setPresence(message);
  });

  socketClient.on("peer-present", async () => {
    ui.setStatus("waiting", "接続中");
    ui.setPresence("接続準備を進めています。");
    await preparePeerConnection();
  });

  socketClient.on("peer-joined", async () => {
    try {
      ui.setStatus("waiting", "接続中");
      ui.setPresence("接続準備を進めています。");
      await preparePeerConnection();
      const offer = await webRtcClient.createOffer();
      socketClient.emit("offer", { roomId: state.roomId, offer });
    } catch (error) {
      ui.showError(error.message || "通話接続の準備に失敗しました。");
      teardownCall({ keepRoom: true });
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
      teardownCall({ keepRoom: true });
    }
  });

  socketClient.on("answer", async ({ answer }) => {
    try {
      await webRtcClient.handleAnswer(answer);
    } catch (_error) {
      ui.showError("Answerの処理に失敗しました。");
      teardownCall({ keepRoom: true });
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

  socketClient.on("peer-left", () => {
    ui.showError("相手が退出しました。");
    teardownCall({ keepRoom: true });
  });

  socketClient.on("room-full", ({ message }) => {
    ui.showError(message);
    resetRoomState();
  });

  socketClient.on("room-error", ({ message }) => {
    ui.showError(message);
    resetRoomState();
  });
}

async function init() {
  try {
    await fetchRtcConfiguration();
    speechRecognition = createSpeechRecognition();
    registerSocketEvents();
    renderTranscript();

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
  } catch (error) {
    ui.showError(error.message || "初期化に失敗しました。");
  }
}

window.addEventListener("beforeunload", () => {
  if (state.roomId) {
    socketClient.emit("leave-room");
  }
  stopSpeechRecognition();
  stopLocalStream();
});

init();
