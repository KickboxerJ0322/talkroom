function formatElapsed(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  const short = [minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");

  if (hours === 0) {
    return short;
  }

  return [hours, short].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatMessageTime(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}

export class UIController {
  constructor() {
    this.joinForm = document.getElementById("join-form");
    this.roomInput = document.getElementById("roomId");
    this.pinInput = document.getElementById("pin");
    this.joinButton = document.getElementById("joinButton");
    this.currentRoom = document.getElementById("currentRoom");
    this.statusText = document.getElementById("statusText");
    this.statusDot = document.getElementById("statusDot");
    this.presenceText = document.getElementById("presenceText");
    this.errorText = document.getElementById("errorText");
    this.callTimer = document.getElementById("callTimer");
    this.muteButton = document.getElementById("muteButton");
    this.cameraButton = document.getElementById("cameraButton");
    this.speakerButton = document.getElementById("speakerButton");
    this.hangupButton = document.getElementById("hangupButton");
    this.exportTranscriptButton = document.getElementById("exportTranscriptButton");
    this.resetAppButton = document.getElementById("resetAppButton");
    this.videoStage = document.getElementById("videoStage");
    this.remoteVideo = document.getElementById("remoteVideo");
    this.localVideo = document.getElementById("localVideo");
    this.videoEmptyState = document.getElementById("videoEmptyState");
    this.remoteAudio = document.getElementById("remoteAudio");
    this.transcriptStatus = document.getElementById("transcriptStatus");
    this.transcriptTimeline = document.getElementById("transcriptTimeline");
    this.emptyTranscript = document.getElementById("emptyTranscript");
    this.timerId = null;
    this.callStartedAt = null;
    this.remoteVideo.muted = true;
  }

  getRoomIdInput() {
    return this.roomInput.value.trim();
  }

  getPinInput() {
    return this.pinInput.value.trim();
  }

  resetForm() {
    this.roomInput.value = "001";
    this.pinInput.value = "";
  }

  setRoom(roomId) {
    this.currentRoom.textContent = roomId || "未参加";
  }

  setStatus(kind, text) {
    this.statusText.textContent = text;
    this.statusDot.classList.remove("connected", "error");

    if (kind === "connected") {
      this.statusDot.classList.add("connected");
    } else if (kind === "error") {
      this.statusDot.classList.add("error");
    }
  }

  setPresence(text) {
    this.presenceText.textContent = text;
  }

  showError(message) {
    this.errorText.hidden = false;
    this.errorText.textContent = message;
    this.setStatus("error", "エラー");
  }

  clearError() {
    this.errorText.hidden = true;
    this.errorText.textContent = "";
  }

  setJoinDisabled(disabled) {
    this.joinButton.disabled = disabled;
    this.roomInput.disabled = disabled;
    this.pinInput.disabled = disabled;
  }

  setCallControlsDisabled(disabled) {
    this.muteButton.disabled = disabled;
    this.cameraButton.disabled = disabled;
    this.speakerButton.disabled = disabled;
    this.hangupButton.disabled = disabled;
  }

  setTranscriptActionsDisabled(disabled) {
    this.exportTranscriptButton.disabled = disabled;
  }

  setMuteButtonLabel(isMicEnabled) {
    this.muteButton.textContent = isMicEnabled ? "マイクOFF" : "マイクON";
  }

  setCameraButtonLabel(isCameraEnabled) {
    this.cameraButton.textContent = isCameraEnabled ? "カメラOFF" : "カメラON";
  }

  setSpeakerButtonLabel(isSpeakerEnabled) {
    this.speakerButton.textContent = isSpeakerEnabled ? "スピーカーOFF" : "スピーカーON";
  }

  setTranscriptStatus({ supported, listening }) {
    this.transcriptStatus.classList.remove("supported", "listening", "unsupported");

    if (!supported) {
      this.transcriptStatus.classList.add("unsupported");
      this.transcriptStatus.textContent = "文字起こし未設定";
      return;
    }

    if (listening) {
      this.transcriptStatus.classList.add("listening");
      this.transcriptStatus.textContent = "文字起こし中";
      return;
    }

    this.transcriptStatus.classList.add("supported");
    this.transcriptStatus.textContent = "文字起こし待機";
  }

  renderTranscript(messages, drafts) {
    this.transcriptTimeline.innerHTML = "";

    if (messages.length === 0 && !drafts.local && !drafts.remote) {
      this.transcriptTimeline.append(this.emptyTranscript);
      this.transcriptTimeline.scrollTop = 0;
      return;
    }

    const rows = [
      ...messages.map((message) => this.createTranscriptRow(message, false)),
      ...(drafts.remote
        ? [this.createTranscriptRow({ speaker: "remote", text: drafts.remote, timestamp: Date.now() }, true)]
        : []),
      ...(drafts.local
        ? [this.createTranscriptRow({ speaker: "local", text: drafts.local, timestamp: Date.now() }, true)]
        : [])
    ];

    rows.forEach((row) => this.transcriptTimeline.append(row));
    this.transcriptTimeline.scrollTop = this.transcriptTimeline.scrollHeight;
  }

  createTranscriptRow(message, isDraft) {
    const row = document.createElement("div");
    row.className = `message-row ${message.speaker}${isDraft ? " draft" : ""}`;

    const bubble = document.createElement("article");
    bubble.className = "message-bubble";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const speaker = document.createElement("span");
    speaker.className = "speaker-name";
    speaker.textContent = message.speaker === "local" ? "自分" : "相手";

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = isDraft ? "変換中..." : formatMessageTime(message.timestamp);

    const text = document.createElement("p");
    text.className = "message-text";
    text.textContent = message.text;

    meta.append(speaker, time);
    bubble.append(meta, text);
    row.append(bubble);

    return row;
  }

  attachRemoteStream(stream) {
    this.remoteAudio.srcObject = stream;
    this.remoteVideo.srcObject = stream;
    this.remoteVideo.muted = true;
    this.syncVideoPanels({ localStream: this.localVideo.srcObject, remoteStream: stream });
  }

  clearRemoteStream() {
    this.remoteAudio.srcObject = null;
    this.remoteVideo.srcObject = null;
    this.syncVideoPanels({ localStream: this.localVideo.srcObject, remoteStream: null });
  }

  attachLocalPreview(stream) {
    this.localVideo.srcObject = stream;
    this.syncVideoPanels({ localStream: stream, remoteStream: this.remoteVideo.srcObject });
  }

  clearLocalPreview() {
    this.localVideo.srcObject = null;
    this.syncVideoPanels({ localStream: null, remoteStream: this.remoteVideo.srcObject });
  }

  syncVideoPanels({ localStream, remoteStream }) {
    const hasLocalVideo = this.hasLiveVideoTrack(localStream);
    const hasRemoteVideo = this.hasLiveVideoTrack(remoteStream);

    this.videoStage.hidden = !hasLocalVideo && !hasRemoteVideo;
    this.videoEmptyState.hidden = hasLocalVideo || hasRemoteVideo;
    this.localVideo.hidden = !hasLocalVideo;
    this.remoteVideo.hidden = !hasRemoteVideo;
  }

  hasLiveVideoTrack(stream) {
    if (!stream) {
      return false;
    }

    return stream
      .getVideoTracks()
      .some((track) => track.readyState === "live" && track.enabled !== false);
  }

  startTimer() {
    this.stopTimer();
    this.callStartedAt = Date.now();
    this.callTimer.textContent = "00:00";
    this.timerId = window.setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - this.callStartedAt) / 1000);
      this.callTimer.textContent = formatElapsed(elapsedSeconds);
    }, 1000);
  }

  stopTimer() {
    if (this.timerId) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }

    this.callStartedAt = null;
    this.callTimer.textContent = "00:00";
  }
}
