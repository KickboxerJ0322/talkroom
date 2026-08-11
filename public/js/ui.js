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
    this.hangupButton = document.getElementById("hangupButton");
    this.remoteAudio = document.getElementById("remoteAudio");
    this.timerId = null;
    this.callStartedAt = null;
  }

  getRoomIdInput() {
    return this.roomInput.value.trim();
  }

  getPinInput() {
    return this.pinInput.value.trim();
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
    this.hangupButton.disabled = disabled;
  }

  setMuteButtonLabel(isMicEnabled) {
    this.muteButton.textContent = isMicEnabled ? "マイクOFF" : "マイクON";
  }

  attachRemoteStream(stream) {
    this.remoteAudio.srcObject = stream;
  }

  clearRemoteStream() {
    this.remoteAudio.srcObject = null;
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
