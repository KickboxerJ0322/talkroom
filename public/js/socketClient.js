export class SocketClient {
  constructor(socket) {
    this.socket = socket;
  }

  on(eventName, handler) {
    this.socket.on(eventName, handler);
  }

  emit(eventName, payload = {}) {
    this.socket.emit(eventName, payload);
  }

  disconnect() {
    this.socket.disconnect();
  }

  get connected() {
    return this.socket.connected;
  }
}
