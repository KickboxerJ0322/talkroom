const DEFAULT_ICE_SERVERS = [
  {
    urls: ["stun:stun.l.google.com:19302"]
  }
];

function splitCsv(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildIceServers() {
  const urls = process.env.WEBRTC_STUN_URLS
    ? splitCsv(process.env.WEBRTC_STUN_URLS)
    : DEFAULT_ICE_SERVERS[0].urls;

  const iceServers = [{ urls }];

  if (process.env.WEBRTC_TURN_URLS) {
    iceServers.push({
      urls: splitCsv(process.env.WEBRTC_TURN_URLS),
      username: process.env.WEBRTC_TURN_USERNAME || undefined,
      credential: process.env.WEBRTC_TURN_CREDENTIAL || undefined
    });
  }

  return iceServers;
}

function getRtcConfiguration() {
  return {
    iceServers: buildIceServers()
    // 本番環境では TURN サーバーを追加する必要がある。
  };
}

module.exports = {
  getRtcConfiguration
};
