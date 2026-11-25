// A minimal DevTools protocol client over Node's WebSocket, with flattened sessions.
export class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #sessions = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#receive(JSON.parse(event.data)));
  }

  static async connect(address) {
    const version = await (await fetch(`http://${address}:9222/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', () => reject(new Error('DevTools socket failed')));
    });
    return { cdp: new Cdp(socket), product: version.Browser };
  }

  #receive(message) {
    if (message.id === undefined) {
      this.#sessions.get(message.sessionId)?.(message.method, message.params);
      return;
    }
    const { resolve, reject, method } = this.#pending.get(message.id);
    this.#pending.delete(message.id);
    if (message.error) reject(new Error(`${method}: ${message.error.message}`));
    else resolve(message.result);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }

  listen(sessionId, handler) {
    this.#sessions.set(sessionId, handler);
  }
}
