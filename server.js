// server.js - Mafia game server (Node + Express + Socket.IO)
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.get("/", (req, res) => res.send("Mafia Server Running"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

// Data
const rooms = {}; 
const DEFAULTS = { mafiaCount: 1, minPlayers: 4, maxPlayers: 10 };

// helpers
function genCode() {
  return Math.random().toString(36).substring(2,8).toUpperCase();
}

function broadcastLobby(room){
  io.to(room.code).emit('lobbyState', {
    code: room.code,
    host: room.host,
    players: room.players.map(p=>({
      id: p.id,
      name: p.name,
      alive: p.alive,
      role: p.role
    }))
  });
}

function resetPhaseTimers(room){
  if(room._phaseTimer) { clearTimeout(room._phaseTimer); room._phaseTimer = null; }
}

// assign roles
function assignRoles(room){
  const players = [...room.players];

  for(let i=players.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [players[i], players[j]] = [players[j], players[i]];
  }

  const roles = {};
  let idx = 0;

  for(let i=0;i<room.settings.mafiaCount && idx < players.length;i++, idx++){
    roles[players[idx].id] = 'mafia';
  }

  if(idx < players.length) { roles[players[idx].id] = 'medic'; idx++; }
  if(idx < players.length) { roles[players[idx].id] = 'detective'; idx++; }

  for(let i=idx;i<players.length;i++) roles[players[i].id] = 'villager';

  room.players.forEach(p=>{ p.role = roles[p.id]; p.alive = true; });
  return roles;
}

// alive players
function alivePlayers(room){
  return room.players.filter(p=>p.alive);
}

// win check
function checkWin(room){
  const alive = alivePlayers(room);
  const mafiaAlive = alive.filter(p => p.role === 'mafia').length;
  const others = alive.length - mafiaAlive;

  if(mafiaAlive === 0) return { over: true, winner: 'town' };
  if(mafiaAlive >= others) return { over: true, winner: 'mafia' };

  return { over: false };
}

// SOCKET logic
io.on('connection', socket => {
  console.log("Connected:", socket.id);

  // Create room
  socket.on('createRoom', ({ username, mafiaCount = 1 }) => {
    const code = genCode();

    rooms[code] = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name: username, alive: true, role: null }],
      settings: { mafiaCount: mafiaCount || DEFAULTS.mafiaCount, maxPlayers: DEFAULTS.maxPlayers, minPlayers: DEFAULTS.minPlayers },
      phase: 'lobby',
      mafiaTarget: null,
      medicSave: null,
      detectiveTarget: null,
      votes: {},
      _phaseTimer: null
    };

    socket.join(code);
    socket.emit("roomCreated", { roomCode: code, players: rooms[code].players, host: socket.id });
    broadcastLobby(rooms[code]);
  });

  // Join room
  socket.on('joinRoom', ({ username, roomCode }) => {
    const room = rooms[roomCode];
    if(!room){ socket.emit('errorMessage', 'Invalid room code.'); return; }

    if(room.players.length >= room.settings.maxPlayers){
      socket.emit('errorMessage', 'Room full');
      return;
    }

    room.players.push({ id: socket.id, name: username, alive: true, role: null });
    socket.join(roomCode);

    broadcastLobby(room);

    socket.emit('joinedRoom', { roomCode: room.code, players: room.players, host: room.host });
    console.log(username, "joined", roomCode);
  });

  // Request lobby sync
  socket.on('requestLobby', (code) => {
    const room = rooms[code];
    if(room) broadcastLobby(room);
  });

  // Start game
  socket.on('startGame', (roomCode) => {
    const room = rooms[roomCode];
    if(!room) return;

    if(room.host !== socket.id) return;

    if(room.players.length < room.settings.minPlayers){
      socket.emit('errorMessage', 'Minimum 4 players required.');
      return;
    }

    assignRoles(room);
    room.phase = 'night';
    broadcastLobby(room);

    room.players.forEach(p => io.to(p.id).emit('yourRole', { role: p.role }));

    startNightFlow(room);
  });

  // Mafia choose
  socket.on('mafiaChoose', ({ roomCode, targetId }) => {
    const room = rooms[roomCode]; if(!room) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(player.role !== 'mafia') return;

    room.mafiaTarget = targetId;
    io.to(roomCode).emit('phaseMessage', { phase: "mafia_done" });
  });

  // Medic choose
  socket.on('medicChoose', ({ roomCode, targetId }) => {
    const room = rooms[roomCode]; if(!room) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(player.role !== 'medic') return;

    room.medicSave = targetId;
    io.to(roomCode).emit('phaseMessage', { phase: "medic_done" });
  });

  // Detective choose
  socket.on('detectiveChoose', ({ roomCode, targetId }) => {
    const room = rooms[roomCode]; if(!room) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(player.role !== 'detective') return;

    room.detectiveTarget = targetId;
    const isMafia = room.players.find(p=>p.id===targetId)?.role === "mafia";

    io.to(socket.id).emit("detectiveResult", { targetId, isMafia });
    io.to(roomCode).emit("phaseMessage", { phase: "detective_done" });
  });

  // Voting
  socket.on("vote", ({ roomCode, targetId }) => {
    const room = rooms[roomCode]; if(!room) return;

    room.votes[socket.id] = targetId;
    io.to(roomCode).emit("voteUpdate", { votes: room.votes });
  });

  // Chat
  socket.on("chatMessage", ({ roomCode, text }) => {
    const room = rooms[roomCode]; if(!room) return;
    const player = room.players.find(p=>p.id===socket.id);

    io.to(roomCode).emit("chatMessage", { from: player?.name || "Unknown", text });
  });

  // Disconnect
  socket.on("disconnect", () => {
    for(const code in rooms){
      const room = rooms[code];
      const idx = room.players.findIndex(p=>p.id===socket.id);

      if(idx !== -1){
        room.players.splice(idx,1);
        broadcastLobby(room);
      }

      if(room.host === socket.id){
        if(room.players.length > 0){
          room.host = room.players[0].id;
        } else {
          delete rooms[code];
        }
      }
    }
  });

  // NIGHT PHASE FLOW
  function startNightFlow(room){
    room.mafiaTarget = null;
    room.medicSave = null;
    room.detectiveTarget = null;
    room.votes = {};

    io.to(room.code).emit("phaseMessage", { phase: "mafia", timeout: 30000 });

    room._phaseTimer = setTimeout(()=>{

      if(!room.mafiaTarget){
        const candidates = room.players.filter(p=>p.alive && p.role !== "mafia");
        if(candidates.length)
          room.mafiaTarget = candidates[Math.floor(Math.random()*candidates.length)].id;
      }

      io.to(room.code).emit("phaseMessage", { phase: "medic", timeout: 30000 });

      room._phaseTimer = setTimeout(()=>{

        io.to(room.code).emit("phaseMessage", { phase: "detective", timeout: 30000 });

        room._phaseTimer = setTimeout(()=>{

          const killedId = room.mafiaTarget || null;
          const medicSaved = killedId && room.medicSave === killedId;

          if(killedId && !medicSaved){
            const victim = room.players.find(p=>p.id===killedId);
            if(victim) victim.alive = false;
          }

          const killedName = killedId ? room.players.find(p=>p.id===killedId)?.name : null;

          io.to(room.code).emit("nightResult", {
            killedId: killedId && !medicSaved ? killedId : null,
            medicSaved,
            killedName
          });

          if(killedId && !medicSaved){
            io.to(killedId).emit("playerKilled", { you: true });
          }

          const res = checkWin(room);
          if(res.over){
            const reveal = {};
            room.players.forEach(p => reveal[p.id] = { name: p.name, role: p.role });

            io.to(room.code).emit("gameEnd", { winner: res.winner, reveal });
            delete rooms[room.code];
            return;
          }

          room.phase = "day";
          io.to(room.code).emit("phaseMessage", { phase: "day", timeout: 120000 });
          room.votes = {};

          room._phaseTimer = setTimeout(()=>{

            const counts = {};
            for(const voter in room.votes){
              const t = room.votes[voter];
              if(t) counts[t] = (counts[t]||0) + 1;
            }

            let lynched = null, max = 0;
            for(const id in counts){
              if(counts[id] > max){
                max = counts[id];
                lynched = id;
              }
            }

            if(lynched){
              const victim = room.players.find(p=>p.id===lynched);
              if(victim){
                victim.alive = false;
                io.to(room.code).emit("voteResult", { lynched: true, reveal: victim.name });
              }
            } else {
              io.to(room.code).emit("voteResult", { lynched: false });
            }

            const res2 = checkWin(room);
            if(res2.over){
              const reveal = {};
              room.players.forEach(p => reveal[p.id] = { name: p.name, role: p.role });

              io.to(room.code).emit("gameEnd", { winner: res2.winner, reveal });
              delete rooms[room.code];
              return;
            }

            startNightFlow(room);

          }, 120000);

        }, 30000);
      }, 30000);

    }, 30000);
  }

});

const PORT = process.env.PORT || 5000;
server.listen(PORT, ()=> console.log("Server running on port", PORT));
