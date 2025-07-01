// src/durable-objects/MatchStateDO.ts
import { Bindings } from "../bindings";

interface VoteEvent {
  id: number;
  points_award: number;
  cost_per_vote: number;
  end_time: number;
}

export class MatchStateDO implements DurableObject {
  state: DurableObjectState;
  env: Bindings;
  websockets: WebSocket[] = [];
  currentVoteEvent: VoteEvent | null = null;
  currentScores: { player_a_score: number; player_b_score: number } = { player_a_score: 0, player_b_score: 0 };

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/connect')) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade request", { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/start-vote')) {
      try {
        const { event } = await request.json() as { event: VoteEvent };
        console.log("Received start-vote event in DO:", JSON.stringify(event, null, 2));
        
        this.currentVoteEvent = event;
        this.broadcast({ type: 'VOTE_STARTED', event });
        
        // Set an alarm to end the vote
        const alarmTime = event.end_time;
        console.log(`Setting alarm for: ${alarmTime} (Type: ${typeof alarmTime})`);
        
        if (alarmTime <= Date.now()) {
          console.error("Alarm time is in the past!");
          return new Response("Alarm time is in the past", { status: 400 });
        }

        await this.state.storage.setAlarm(alarmTime);
        console.log("Alarm set successfully.");
        
        return new Response("Vote started");
      } catch (e: any) {
        console.error("Error in start-vote handler:", e.stack);
        return new Response("Error processing start-vote", { status: 500 });
      }
    }

    if (url.pathname.endsWith('/update-score') && request.method === 'POST') {
      try {
        const updates = await request.json() as { player_a_score?: number; player_b_score?: number };
        console.log("Received score update in DO:", updates);
        
        // Update scores
        if (updates.player_a_score !== undefined) {
          this.currentScores.player_a_score = updates.player_a_score;
        }
        if (updates.player_b_score !== undefined) {
          this.currentScores.player_b_score = updates.player_b_score;
        }
        
        // Broadcast score update to all connected clients
        this.broadcast({ 
          type: 'SCORE_UPDATE', 
          scores: this.currentScores 
        });
        
        return new Response(JSON.stringify({ success: true, scores: this.currentScores }));
      } catch (e: any) {
        console.error("Error in update-score handler:", e.stack);
        return new Response("Error processing score update", { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async handleWebSocket(server: WebSocket) {
    server.accept();
    this.websockets.push(server);
    
    console.log('New WebSocket connection established. Total connections:', this.websockets.length);

    // Send current state to new connection
    if (this.currentVoteEvent) {
      server.send(JSON.stringify({ type: 'VOTE_STARTED', event: this.currentVoteEvent }));
    }
    
    // Send current scores to new connection
    server.send(JSON.stringify({ 
      type: 'SCORE_UPDATE', 
      scores: this.currentScores,
      message: 'Connected to live match updates'
    }));
    
    console.log('Sent initial scores to new connection:', this.currentScores);

    server.addEventListener("close", () => {
      this.websockets = this.websockets.filter(ws => ws !== server);
      console.log('WebSocket connection closed. Remaining connections:', this.websockets.length);
    });
    server.addEventListener("error", () => {
      this.websockets = this.websockets.filter(ws => ws !== server);
      console.log('WebSocket connection error. Remaining connections:', this.websockets.length);
    });
  }

  broadcast(message: any) {
    const serializedMessage = JSON.stringify(message);
    this.websockets.forEach(ws => {
      try {
        ws.send(serializedMessage);
      } catch (e) {
        // This can happen if the socket is closed but not yet removed from the array
        this.websockets = this.websockets.filter(s => s !== ws);
      }
    });
  }

  async alarm() {
    // This is called when the vote ends
    if (this.currentVoteEvent) {
      this.broadcast({ type: 'VOTE_ENDED', eventId: this.currentVoteEvent.id });
      
      // TODO: Call internal endpoint to resolve the vote
      
      this.currentVoteEvent = null;
    }
  }
}
