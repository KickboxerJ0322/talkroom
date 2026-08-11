export class WebRtcClient {
  constructor({ rtcConfiguration, onIceCandidate, onTrack, onConnectionStateChange }) {
    this.rtcConfiguration = rtcConfiguration;
    this.onIceCandidate = onIceCandidate;
    this.onTrack = onTrack;
    this.onConnectionStateChange = onConnectionStateChange;
    this.peerConnection = null;
    this.videoSender = null;
  }

  createPeerConnection(localStream) {
    this.close();
    this.peerConnection = new RTCPeerConnection(this.rtcConfiguration);

    localStream.getTracks().forEach((track) => {
      const sender = this.peerConnection.addTrack(track, localStream);
      if (track.kind === "video") {
        this.videoSender = sender;
      }
    });

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    this.peerConnection.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        this.onTrack(stream);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      this.onConnectionStateChange(this.peerConnection.connectionState);
    };

    return this.peerConnection;
  }

  async createOffer() {
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer) {
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer) {
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async addIceCandidate(candidate) {
    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  async addOrReplaceVideoTrack(videoTrack, stream) {
    if (!this.peerConnection) {
      return;
    }

    if (this.videoSender) {
      await this.videoSender.replaceTrack(videoTrack);
      return;
    }

    this.videoSender = this.peerConnection.addTrack(videoTrack, stream);
  }

  async clearVideoTrack() {
    if (!this.videoSender) {
      return;
    }

    await this.videoSender.replaceTrack(null);
  }

  close() {
    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null;
      this.peerConnection.ontrack = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.videoSender = null;
  }
}
