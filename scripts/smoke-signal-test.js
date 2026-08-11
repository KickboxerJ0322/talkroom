const { io } = require("socket.io-client");

const roomId = `room${Date.now()}`;
const pin = "1234";
const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

const events = [];

function record(clientName, eventName, payload) {
  events.push({
    clientName,
    eventName,
    payload
  });
}

async function createClient(name) {
  const socket = io(baseUrl, {
    transports: ["websocket"],
    reconnection: false
  });

  socket.on("connect", () => record(name, "connect"));
  socket.on("joined-room", (payload) => record(name, "joined-room", payload));
  socket.on("waiting-peer", (payload) => record(name, "waiting-peer", payload));
  socket.on("peer-joined", (payload) => record(name, "peer-joined", payload));
  socket.on("peer-present", (payload) => record(name, "peer-present", payload));
  socket.on("offer", (payload) => record(name, "offer", payload));
  socket.on("answer", (payload) => record(name, "answer", payload));
  socket.on("ice-candidate", (payload) => record(name, "ice-candidate", payload));
  socket.on("peer-left", (payload) => record(name, "peer-left", payload));
  socket.on("room-full", (payload) => record(name, "room-full", payload));
  socket.on("room-error", (payload) => record(name, "room-error", payload));

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });

  return socket;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const alice = await createClient("alice");
  const bob = await createClient("bob");
  const charlie = await createClient("charlie");

  alice.emit("join-room", { roomId, pin });
  await wait(100);
  bob.emit("join-room", { roomId, pin });
  await wait(100);

  alice.emit("offer", {
    roomId,
    offer: { type: "offer", sdp: "fake-offer" }
  });
  await wait(50);

  bob.emit("answer", {
    roomId,
    answer: { type: "answer", sdp: "fake-answer" }
  });
  await wait(50);

  bob.emit("ice-candidate", {
    roomId,
    candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 5000 typ host" }
  });
  await wait(50);

  charlie.emit("join-room", { roomId, pin });
  await wait(100);

  bob.emit("leave-room");
  await wait(100);

  [alice, bob, charlie].forEach((socket) => socket.disconnect());

  const requiredChecks = [
    events.some((event) => event.clientName === "alice" && event.eventName === "waiting-peer"),
    events.some((event) => event.clientName === "alice" && event.eventName === "peer-joined"),
    events.some((event) => event.clientName === "bob" && event.eventName === "peer-present"),
    events.some((event) => event.clientName === "bob" && event.eventName === "offer"),
    events.some((event) => event.clientName === "alice" && event.eventName === "answer"),
    events.some((event) => event.clientName === "alice" && event.eventName === "ice-candidate"),
    events.some(
      (event) =>
        event.clientName === "charlie" &&
        ((event.eventName === "room-full") ||
          (event.eventName === "room-error" && event.payload?.code === "ROOM_LOCKED"))
    ),
    events.some((event) => event.clientName === "alice" && event.eventName === "peer-left")
  ];

  if (requiredChecks.every(Boolean)) {
    console.log("Smoke test passed.");
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  console.error("Smoke test failed.");
  console.error(JSON.stringify(events, null, 2));
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
