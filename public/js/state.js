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
    rtcConfiguration: { iceServers: [] },
    transcriptMessages: [],
    transcriptDrafts: {
      local: "",
      remote: ""
    },
    transcriptSupported: false,
    transcriptListening: false
  };
}
