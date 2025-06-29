// src/durable-objects/UserSessionDO.ts
import { Bindings } from "../bindings";

export class UserSessionDO implements DurableObject {
  state: DurableObjectState;
  env: Bindings;
  webSocket: WebSocket | null = null;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/connect')) {
      // This is a WebSocket upgrade request
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade request", { status: 426 });
      }

      const [client, server] = Object.values(new WebSocketPair());
      this.webSocket = server;
      
      server.accept();
      server.addEventListener("message", (event) => {
        // For now, just echo back messages
        server.send(JSON.stringify({ received: event.data }));
      });

      server.addEventListener("close", () => {
        this.webSocket = null;
      });
      
      server.addEventListener("error", () => {
        this.webSocket = null;
      });

      return new Response(null, { status: 101, webSocket: client });

    } else if (url.pathname.endsWith('/update-balance')) {
      // This is an internal command to push a balance update
      if (!this.webSocket) {
        return new Response("No active WebSocket connection", { status: 400 });
      }
      
      const { balance } = await request.json() as { balance: number };
      this.webSocket.send(JSON.stringify({ type: "POINTS_UPDATE", balance }));
      
      return new Response("Update sent");
    }

    return new Response("Not found", { status: 404 });
  }
}
