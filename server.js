// ----------------------
// Mafia Game Server
// ----------------------

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.get("/", (req, res) => {
  res.send("Mafia Server Running");
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ----------------------
// Game State
// ----------------------
const rooms = {}; // roomCode → { players: [], roles: {}, settings: {}, status: "" }
const NIGHT_DURATION = 30000;
const VOTE_DURATION = 120000;

// ----------------------
// Utility – Generate Room Code
// ----------------------
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ----------------------
// Socket.IO Logic
// ----------------------
io.on("connection", (socket) => {

  // Create Room
  socket.on("createRoom", ({ username, mafiaCount }) => {
    const roomCode = generateRoomCode();

    rooms[roomCode] = {
      players: [{ id: socket.id, username, alive: true }],
      roles: {},
      mafiaCount,
      status: "waiting"
    };

    socket.join(roomCode);
    socket.emit("roomCreated", { roomCode, players: rooms[roomCode].players });
    io.to(roomCode).emit("updatePlayers", rooms[roomCode].players);
  });


  // Join Room
  socket.on("joinRoom", ({ roomCode, username }) => {
    if (!rooms[roomCode]) {
      socket.emit("errorMessage", "Invalid room code.");
      return;
    }

    rooms[roomCode].players.push({ id: socket.id, username, alive: true });
    socket.join(roomCode);

    io.to(roomCode).emit("updatePlayers", rooms[roomCode].players);
    socket.emit("joinedRoom", { roomCode, players: rooms[roomCode].players });
  });


  // Start Game
  socket.on("startGame", (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    const players = room.players;

    // ROLE ASSIGNMENT
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const roles = {};
    let index = 0;

    // Mafia
    for (let i = 0; i < room.mafiaCount; i++) {
      roles[shuffled[index].id] = "mafia";
      index++;
    }

    // Medic
    roles[shuffled[index].id] = "medic";
    index++;

    // Detective
    roles[shuffled[index].id] = "detective";
    index++;

    // Villagers
    for (let i = index; i < shuffled.length; i++) {
      roles[shuffled[i].id] = "villager";
    }

    room.roles = roles;
    room.status = "night";

    // Send Everyone Their Role
    for (let id in roles) {
      io.to(id).emit("yourRole", roles[id]);
    }

    io.to(roomCode).emit("nightStart");
  });


  // Mafia Choice
  socket.on("mafiaChoose", ({ roomCode, target }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.mafiaTarget = target;
    io.to(roomCode).emit("mafiaDone");
  });


  // Medic Choice
  socket.on("medicChoose", ({ roomCode, target }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.medicSave = target;
    io.to(roomCode).emit("medicDone");
  });


  // Detective Choice
  socket.on("detectiveChoose", ({ roomCode, target }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.detectiveTarget = target;
    io.to(roomCode).emit("detectiveDone");
  });


  // Chat
  socket.on("chatMessage", ({ roomCode, username, message }) => {
    io.to(roomCode).emit("chatMessage", { username, message });
  });


  // Disconnect
  socket.on("disconnect", () => {
    for (const roomCode in rooms) {
      rooms[roomCode].players = rooms[roomCode].players.filter(p => p.id !== socket.id);
      io.to(roomCode).emit("updatePlayers", rooms[roomCode].players);
    }
  });
});


// ----------------------
// Keep Render Awake
// ----------------------
setInterval(() => {
  fetch("https://mafia-server-snwd.onrender.com").catch(() => {});
}, 300000);


// ----------------------
// Start Server
// ----------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
