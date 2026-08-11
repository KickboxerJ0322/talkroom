export function createInitialState() {
  return {
    roomId: "",
    pin: "",
    localStream: null,
    remoteStream: null,
    peerConnection: null,
    socketConnected: false,
    callConnected: false,
    micEnabled: true,
    cameraEnabled: false,
    rtcConfiguration: { iceServers: [] },
    transcriptMessages: [],
    transcriptDrafts: {
      local: "",
      remote: ""
    },
    transcriptServerEnabled: false,
    transcriptSupported: false,
    transcriptListening: false
  };
}
