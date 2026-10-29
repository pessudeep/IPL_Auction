const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const http = require("node:http");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 5 * 1024 * 1024 });
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const MAX_AUCTION_PLAYERS = 2000;
const NEXT_BID_AFTER_SALE_SECONDS = 10;
const RECONNECT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const VALID_BID_TIMES = [10, 20, 30];
const VALID_PURSES = [100, 120, 140, 150];
const TEAMS = [
  "CSK",
  "DC",
  "GT",
  "KKR",
  "LSG",
  "MI",
  "PBKS",
  "RR",
  "RCB",
  "SRH",
];
const TEAM_NAMES = {
  CSK: "Chennai Super Kings",
  DC: "Delhi Capitals",
  GT: "Gujarat Titans",
  KKR: "Kolkata Knight Riders",
  LSG: "Lucknow Super Giants",
  MI: "Mumbai Indians",
  PBKS: "Punjab Kings",
  RR: "Rajasthan Royals",
  RCB: "Royal Challengers Bengaluru",
  SRH: "Sunrisers Hyderabad",
};
const rooms = new Map();
const activeSockets = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_request, response) => response.json({ status: "ok" }));

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("");
  } while (rooms.has(code));
  return code;
}

function roomAdminId(room) {
  const admin = room.players.get(room.adminId);
  if (admin?.connected) return admin.id;
  return [...room.players.values()].find((player) => player.connected)?.id || room.adminId;
}

function playerSnapshot(player, adminId) {
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    isAdmin: player.id === adminId,
    connected: player.connected,
  };
}

function roomSnapshot(room) {
  const auction = room.auction;
  const adminId = roomAdminId(room);
  return {
    code: room.code,
    adminId,
    settings: { ...room.settings },
    players: [...room.players.values()].map((player) => playerSnapshot(player, adminId)),
    started: room.started,
    rosterCount: room.playerList.length,
    auction: auction ? {
      phase: auction.phase,
      currentIndex: auction.currentIndex,
      playerCount: auction.players.length,
      soldCount: auction.players.filter((player) => player.status === "sold").length,
      unsoldCount: auction.players.filter((player) => player.status === "unsold").length,
      currentPlayer: auction.players[auction.currentIndex] || null,
      currentBid: auction.currentBid / 100,
      highestBidTeam: auction.highestBidTeam,
      secondsLeft: auction.secondsLeft,
      rtmSecondsLeft: auction.rtmSecondsLeft,
      pendingRtm: auction.pendingRtm ? {
        team: auction.pendingRtm.team,
        cardIndex: auction.pendingRtm.cardIndex,
      } : null,
      teams: Object.values(auction.teams).map((team) => ({
        code: team.code,
        purse: team.purse / 100,
        rtmCards: team.rtmCards.map((card) => ({
          uses: card.uses,
          maxUses: 2,
          playerId: card.playerId,
          playerName: card.playerName,
        })),
        squad: [...team.squad],
      })),
      activity: auction.activity.slice(-100),
    } : null,
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room:update", roomSnapshot(room));
}

function reply(callback, result) {
  if (typeof callback === "function") callback(result);
}

function playerRoom(socket) {
  const code = socket.data.roomCode;
  const room = code && rooms.get(code);
  const player = room && room.players.get(socket.data.playerId);
  return room && player ? { room, player } : null;
}

function emitToPlayer(playerId, event, payload) {
  const socketId = activeSockets.get(playerId);
  if (socketId) io.to(socketId).emit(event, payload);
}

function removePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;
  clearTimeout(player.reconnectTimer);
  room.players.delete(playerId);
  if (room.adminId === playerId) {
    room.adminId = [...room.players.values()].find((member) => member.connected)?.id
      || room.players.keys().next().value
      || "";
  }
  if (room.players.size === 0) {
    if (room.auction) clearTimer(room.auction);
    rooms.delete(room.code);
    return;
  }
  broadcastRoom(room);
}

function resumePlayer(socket) {
  const token = socket.data.resumeToken;
  if (!token) return;
  for (const room of rooms.values()) {
    const player = [...room.players.values()].find((candidate) => candidate.resumeToken === token);
    if (!player) continue;

    const previousSocketId = activeSockets.get(player.id);
    if (previousSocketId && previousSocketId !== socket.id) {
      io.sockets.sockets.get(previousSocketId)?.disconnect(true);
    }
    activeSockets.set(player.id, socket.id);
    socket.data.playerId = player.id;
    socket.data.roomCode = room.code;
    player.connected = true;
    clearTimeout(player.reconnectTimer);
    player.reconnectTimer = null;
    socket.join(room.code);
    socket.emit("session:restored", { playerId: player.id });
    broadcastRoom(room);
    return;
  }
}

function addActivity(room, message, kind = "system") {
  room.auction.activity.push({
    id: crypto.randomUUID(),
    message,
    kind,
    time: Date.now(),
  });
  if (room.auction.activity.length > 200) room.auction.activity.shift();
}

function clearTimer(auction) {
  if (auction.timer) clearInterval(auction.timer);
  auction.timer = null;
  auction.deadline = 0;
}

function startTimer(room, seconds, onExpire) {
  const auction = room.auction;
  clearTimer(auction);
  auction.deadline = Date.now() + seconds * 1000;
  let lastSeconds = seconds;
  auction.secondsLeft = auction.phase === "bidding" ? seconds : 0;
  auction.rtmSecondsLeft = auction.phase === "bidding" ? 0 : seconds;
  auction.timer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((auction.deadline - Date.now()) / 1000));
    if (remaining !== lastSeconds) {
      lastSeconds = remaining;
      if (auction.phase === "bidding") auction.secondsLeft = remaining;
      else auction.rtmSecondsLeft = remaining;
      io.to(room.code).emit("auction:tick", {
        phase: auction.phase,
        secondsLeft: auction.secondsLeft,
        rtmSecondsLeft: auction.rtmSecondsLeft,
      });
    }
    if (remaining === 0) {
      clearTimer(auction);
      onExpire();
    }
  }, 200);
  broadcastRoom(room);
}

function normalizedTeam(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const code = trimmed.toUpperCase();
  if (TEAMS.includes(code)) return code;
  const match = Object.entries(TEAM_NAMES).find(([, name]) => name.toLowerCase() === trimmed.toLowerCase());
  return match ? match[0] : "";
}

function parseBasePrice(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  const normalized = value.trim().replace(/[₹,\s]/g, "").toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)(cr(?:ore)?s?|l(?:ac|akh)s?)?$/);
  if (!match) return NaN;
  const amount = Number(match[1]);
  return match[2]?.startsWith("l") ? amount / 100 : amount;
}

function validatePlayerList(rawPlayers) {
  if (!Array.isArray(rawPlayers) || rawPlayers.length === 0 || rawPlayers.length > MAX_AUCTION_PLAYERS) {
    return { error: `Upload a JSON array containing 1–${MAX_AUCTION_PLAYERS} players.` };
  }
  const players = [];
  for (let index = 0; index < rawPlayers.length; index += 1) {
    const raw = rawPlayers[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: `Player row ${index + 1} must be an object.` };
    }
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 100) : "";
    const type = typeof raw.type === "string" ? raw.type.trim().slice(0, 60) : "";
    const rawBasePrice = raw.basePrice ?? raw.base_price;
    const basePrice = rawBasePrice === null || rawBasePrice === undefined
      ? 0.75
      : parseBasePrice(rawBasePrice);
    const originalTeamValue = raw.previousTeam ?? raw.previous_team ?? raw.team ?? "";
    const hasPreviousTeam = typeof originalTeamValue === "string" && originalTeamValue.trim() !== "";
    const previousTeam = normalizedTeam(hasPreviousTeam ? originalTeamValue : "");
    if (!name || !type || !Number.isFinite(basePrice) || basePrice <= 0 || basePrice > 100) {
      return { error: `Player row ${index + 1} needs a name, type, and valid basePrice in crore (or lakh). Use null for a ₹0.75 crore base price.` };
    }
    if (hasPreviousTeam && !previousTeam) {
      return { error: `Player row ${index + 1} has an unknown previousTeam. Use an IPL team code or full name.` };
    }
    players.push({
      id: `${index}-${crypto.randomUUID()}`,
      name,
      type,
      basePrice: Math.round(basePrice * 100) / 100,
      previousTeam,
      status: "upcoming",
      soldTeam: "",
      soldPrice: null,
    });
  }
  return { players };
}

function teamForPlayer(room, player) {
  return [...room.players.values()].find((candidate) => candidate.team === player.team);
}

function currentAuctionPlayer(auction) {
  return auction.players[auction.currentIndex] || null;
}

function teamCanBid(room, player, bidUnits) {
  const team = room.auction.teams[player.team];
  return team && team.purse >= bidUnits;
}

function finishCurrentPlayer(room) {
  const auction = room.auction;
  const player = currentAuctionPlayer(auction);
  if (!player) return finishAuction(room);
  clearTimer(auction);

  if (auction.highestBidTeam && auction.currentBid > 0) {
    const winningTeam = auction.teams[auction.highestBidTeam];
    winningTeam.purse -= auction.currentBid;
    winningTeam.squad.push({
      id: player.id,
      name: player.name,
      type: player.type,
      price: auction.currentBid / 100,
    });
    player.status = "sold";
    player.soldTeam = winningTeam.code;
    player.soldPrice = auction.currentBid / 100;
    addActivity(room, `${player.name} sold to ${winningTeam.code} for ₹${(auction.currentBid / 100).toFixed(2)} crore.`, "sold");
    io.to(room.code).emit("auction:sold", { team: winningTeam.code });
  } else {
    player.status = "unsold";
    addActivity(room, `${player.name} went unsold.`, "system");
  }

  advanceAuction(room, player);
}

function advanceAuction(room, completedPlayer) {
  const auction = room.auction;
  clearTimer(auction);
  auction.currentIndex += 1;
  auction.currentBid = 0;
  auction.highestBidTeam = "";
  auction.pendingRtm = null;
  if (auction.currentIndex >= auction.players.length) return finishAuction(room);
  currentAuctionPlayer(auction).status = "active";
  const bidTime = completedPlayer.status === "sold" ? NEXT_BID_AFTER_SALE_SECONDS : room.settings.bidTime;
  startTimer(room, bidTime, () => onBidTimerExpired(room));
}

function finishAuction(room) {
  const auction = room.auction;
  clearTimer(auction);
  auction.phase = "finished";
  auction.secondsLeft = 0;
  auction.rtmSecondsLeft = 0;
  addActivity(room, "The auction is complete.", "system");
  broadcastRoom(room);
}

function clearPendingTrades(room, message) {
  for (const trade of room.pendingTrades.values()) {
    emitToPlayer(trade.requesterId, "trade:result", { ok: false, message });
    emitToPlayer(trade.recipientId, "trade:cancelled", { tradeId: trade.id, message });
  }
  room.pendingTrades.clear();
}

function cancelAuction(room, adminName) {
  const auction = room.auction;
  clearTimer(auction);
  auction.phase = "cancelled";
  auction.secondsLeft = 0;
  auction.rtmSecondsLeft = 0;
  auction.pendingRtm = null;
  room.started = false;
  clearPendingTrades(room, "The auction ended. The pending trade request was cancelled.");
  addActivity(room, `The admin (${adminName}) ended the auction.`, "system");
  broadcastRoom(room);
}

function onBidTimerExpired(room) {
  const auction = room.auction;
  if (!auction || auction.phase !== "bidding") return;
  const player = currentAuctionPlayer(auction);
  if (!player) return finishAuction(room);

  const previousTeam = player.previousTeam;
  const originalTeamCanUseRtm = previousTeam
    && previousTeam !== auction.highestBidTeam
    && auction.highestBidTeam
    && auction.teams[previousTeam]?.rtmCards.some((card) =>
      card.uses < 2 && (!card.playerId || card.playerId === player.id))
    && teamForPlayer(room, { team: previousTeam });
  if (originalTeamCanUseRtm && auction.teams[previousTeam].purse >= auction.currentBid + 25) {
    auction.phase = "rtm";
    auction.rtmSecondsLeft = 20;
    auction.pendingRtm = null;
    addActivity(room, `${previousTeam} can use an RTM card for ${player.name}.`, "rtm");
    startTimer(room, 20, () => {
      if (auction.phase !== "rtm") return;
      addActivity(room, `${previousTeam} did not use an RTM card in time.`, "system");
      auction.phase = "bidding";
      finishCurrentPlayer(room);
    });
    return;
  }
  finishCurrentPlayer(room);
}

function shufflePlayers(players) {
  const shuffled = [...players];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function startAuction(room) {
  const auction = {
    phase: "bidding",
    players: shufflePlayers(room.playerList).map((player) => ({ ...player })),
    currentIndex: 0,
    currentBid: 0,
    highestBidTeam: "",
    secondsLeft: room.settings.bidTime,
    rtmSecondsLeft: 0,
    pendingRtm: null,
    timer: null,
    deadline: 0,
    teams: Object.fromEntries(TEAMS.map((code) => [code, {
      code,
      purse: room.settings.purse * 100,
      rtmCards: Array.from({ length: 4 }, () => ({
        uses: 0,
        playerId: "",
        playerName: "",
      })),
      squad: [],
    }])),
    activity: [],
  };
  room.auction = auction;
  room.started = true;
  const player = currentAuctionPlayer(auction);
  player.status = "active";
  addActivity(room, `Auction started. ${player.name} is up for bidding at ₹${player.basePrice.toFixed(2)} crore.`, "system");
  startTimer(room, room.settings.bidTime, () => onBidTimerExpired(room));
}

const defaultPlayerDataPath = path.join(__dirname, "public", "ipl_2026_players.json");
const defaultPlayerData = fs.existsSync(defaultPlayerDataPath)
  ? JSON.parse(fs.readFileSync(defaultPlayerDataPath, "utf8"))
  : null;
const defaultPlayerListResult = defaultPlayerData ? validatePlayerList(defaultPlayerData) : { players: [] };
if (defaultPlayerListResult.error) throw new Error(`Invalid default auction roster: ${defaultPlayerListResult.error}`);

io.on("connection", (socket) => {
  const auth = socket.handshake.auth || {};
  const isUuid = (value) => typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  socket.data.resumeToken = isUuid(auth.resumeToken)
    ? auth.resumeToken
    : "";
  socket.data.playerId = null;
  resumePlayer(socket);

  socket.on("room:create", (callback) => {
    if (playerRoom(socket)) return reply(callback, { ok: false, error: "Leave your current room before creating another." });
    const code = createRoomCode();
    const playerId = crypto.randomUUID();
    socket.data.playerId = playerId;
    const room = {
      code,
      adminId: playerId,
      settings: { bidTime: 20, purse: 100 },
      players: new Map([[playerId, {
        id: playerId,
        resumeToken: socket.data.resumeToken,
        name: "",
        team: "",
        connected: true,
        reconnectTimer: null,
      }]]),
      playerList: defaultPlayerListResult.players.map((player) => ({
        ...player,
        id: crypto.randomUUID(),
      })),
      started: false,
      auction: null,
      pendingTrades: new Map(),
    };
    rooms.set(code, room);
    socket.data.roomCode = code;
    activeSockets.set(playerId, socket.id);
    socket.join(code);
    reply(callback, { ok: true, playerId, room: roomSnapshot(room) });
  });

  socket.on("room:join", (rawCode, callback) => {
    const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
    const room = rooms.get(code);
    if (!room) return reply(callback, { ok: false, error: "Room not found. Check the code and try again." });
    if (room.started) return reply(callback, { ok: false, error: "This auction has already started." });
    if (room.players.size >= MAX_PLAYERS) return reply(callback, { ok: false, error: "This room is full (10 players maximum)." });
    if (playerRoom(socket)) return reply(callback, { ok: false, error: "You are already in a room." });

    const playerId = crypto.randomUUID();
    socket.data.playerId = playerId;
    room.players.set(playerId, {
      id: playerId,
      resumeToken: socket.data.resumeToken,
      name: "",
      team: "",
      connected: true,
      reconnectTimer: null,
    });
    socket.data.roomCode = code;
    activeSockets.set(playerId, socket.id);
    socket.join(code);
    broadcastRoom(room);
    reply(callback, { ok: true, playerId, room: roomSnapshot(room) });
  });

  socket.on("room:leave", (callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: true });
    const { room, player } = membership;
    for (const [tradeId, trade] of room.pendingTrades) {
      if (trade.requesterId === player.id || trade.recipientId === player.id) {
        room.pendingTrades.delete(tradeId);
        const otherPlayerId = trade.requesterId === player.id ? trade.recipientId : trade.requesterId;
        emitToPlayer(otherPlayerId, "trade:cancelled", {
          tradeId: trade.id,
          message: "The other manager left the room. The trade request was cancelled.",
        });
      }
    }
    activeSockets.delete(player.id);
    socket.data.roomCode = null;
    socket.leave(room.code);
    removePlayer(room, player.id);
    reply(callback, { ok: true });
  });

  socket.on("player:update", (input, callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: false, error: "Join a room before choosing a team." });
    const { room, player } = membership;
    if (room.started) return reply(callback, { ok: false, error: "Teams are locked because the auction has started." });
    const name = typeof input?.name === "string" ? input.name.trim().slice(0, 20) : "";
    const team = typeof input?.team === "string" ? input.team : "";

    if (!name) return reply(callback, { ok: false, error: "Enter your name." });
    if (!TEAMS.includes(team)) return reply(callback, { ok: false, error: "Choose an IPL team." });
    const teamOwner = [...room.players.values()].find((candidate) => candidate.team === team && candidate.id !== player.id);
    if (teamOwner) return reply(callback, { ok: false, error: `${team} has already been selected.` });

    player.name = name;
    player.team = team;
    broadcastRoom(room);
    reply(callback, { ok: true });
  });

  socket.on("room:updateSettings", (settings, callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: false, error: "Join a room before changing settings." });
    const { room, player } = membership;
    if (roomAdminId(room) !== player.id) return reply(callback, { ok: false, error: "Only the room admin can change settings." });
    if (room.started) return reply(callback, { ok: false, error: "Settings are locked because the auction has started." });
    if (!VALID_BID_TIMES.includes(Number(settings?.bidTime)) || !VALID_PURSES.includes(Number(settings?.purse))) {
      return reply(callback, { ok: false, error: "Choose a valid bid time and purse." });
    }

    room.settings = { bidTime: Number(settings.bidTime), purse: Number(settings.purse) };
    broadcastRoom(room);
    reply(callback, { ok: true });
  });

  socket.on("room:loadPlayers", (rawPlayers, callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: false, error: "Join a room before loading the player list." });
    const { room, player } = membership;
    if (roomAdminId(room) !== player.id) return reply(callback, { ok: false, error: "Only the admin can load the player list." });
    if (room.started) return reply(callback, { ok: false, error: "The auction has already started." });
    const result = validatePlayerList(rawPlayers);
    if (result.error) return reply(callback, { ok: false, error: result.error });

    room.playerList = result.players;
    broadcastRoom(room);
    reply(callback, { ok: true, count: room.playerList.length });
  });

  socket.on("room:start", (callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: false, error: "Join a room before starting the auction." });
    const { room, player } = membership;
    if (roomAdminId(room) !== player.id) return reply(callback, { ok: false, error: "Only the room admin can start the auction." });
    if (room.started) return reply(callback, { ok: false, error: "The auction has already started." });
    if (room.players.size < 2) return reply(callback, { ok: false, error: "At least 2 players are required to start." });
    if ([...room.players.values()].some((member) => !member.name || !member.team)) {
      return reply(callback, { ok: false, error: "Every player must enter a name and choose a team." });
    }
    if (room.playerList.length === 0) return reply(callback, { ok: false, error: "The admin must upload the auction player list first." });

    startAuction(room);
    reply(callback, { ok: true });
  });

  socket.on("auction:end", (callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: false, error: "Join the room before ending the auction." });
    const { room, player } = membership;
    if (roomAdminId(room) !== player.id) {
      return reply(callback, { ok: false, error: "Only the room admin can end the auction." });
    }
    if (!room.auction || room.auction.phase === "finished" || room.auction.phase === "cancelled") {
      return reply(callback, { ok: false, error: "There is no active auction to end." });
    }

    cancelAuction(room, player.name);
    reply(callback, { ok: true });
  });

  socket.on("trade:request", (input, callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: false, error: "Join the room before proposing a trade." });
    const { room, player } = membership;
    const auction = room.auction;
    if (!room.started || !auction || auction.phase === "cancelled") {
      return reply(callback, { ok: false, error: "Trades are available during or after an auction." });
    }

    const sourceTeam = player.team && auction.teams[player.team];
    const sourcePlayer = sourceTeam?.squad.find((item) => item.id === input?.sourcePlayerId);
    if (!sourcePlayer) return reply(callback, { ok: false, error: "Choose a player owned by your team." });

    const targetTeam = Object.values(auction.teams).find((team) =>
      team.code !== player.team && team.squad.some((item) => item.id === input?.targetPlayerId));
    const targetPlayer = targetTeam?.squad.find((item) => item.id === input?.targetPlayerId);
    if (!targetTeam || !targetPlayer) return reply(callback, { ok: false, error: "Choose a player owned by another team." });
    const recipient = [...room.players.values()].find((candidate) => candidate.team === targetTeam.code);
    if (!recipient) return reply(callback, { ok: false, error: "That team's manager is not available." });
    if ([...room.pendingTrades.values()].some((trade) =>
      trade.requesterId === player.id || trade.recipientId === recipient.id)) {
      return reply(callback, { ok: false, error: "You or that manager already has a pending trade request." });
    }

    const trade = {
      id: crypto.randomUUID(),
      requesterId: player.id,
      recipientId: recipient.id,
      requesterName: player.name,
      sourceTeam: sourceTeam.code,
      sourcePlayerId: sourcePlayer.id,
      sourcePlayerName: sourcePlayer.name,
      targetTeam: targetTeam.code,
      targetPlayerId: targetPlayer.id,
      targetPlayerName: targetPlayer.name,
    };
    room.pendingTrades.set(trade.id, trade);
    emitToPlayer(recipient.id, "trade:request", {
      id: trade.id,
      requesterName: trade.requesterName,
      sourceTeam: trade.sourceTeam,
      sourcePlayerName: trade.sourcePlayerName,
      targetTeam: trade.targetTeam,
      targetPlayerName: trade.targetPlayerName,
    });
    reply(callback, { ok: true });
  });

  socket.on("trade:respond", (input, callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: false, error: "Join the room before responding to a trade." });
    const { room } = membership;
    const trade = room.pendingTrades.get(input?.tradeId);
    if (!trade || trade.recipientId !== socket.data.playerId) {
      return reply(callback, { ok: false, error: "That trade request is no longer available." });
    }
    room.pendingTrades.delete(trade.id);

    const auction = room.auction;
    const sourceTeam = auction?.teams[trade.sourceTeam];
    const targetTeam = auction?.teams[trade.targetTeam];
    const sourceIndex = sourceTeam?.squad.findIndex((item) => item.id === trade.sourcePlayerId) ?? -1;
    const targetIndex = targetTeam?.squad.findIndex((item) => item.id === trade.targetPlayerId) ?? -1;
    if (!room.started || !auction || auction.phase === "cancelled" || sourceIndex < 0 || targetIndex < 0) {
      const error = "The trade could not be completed because a player or the auction is no longer available.";
      emitToPlayer(trade.requesterId, "trade:result", { ok: false, message: error });
      return reply(callback, { ok: false, error });
    }

    if (input?.accept !== true) {
      const message = `${trade.targetTeam} declined the trade for ${trade.targetPlayerName}.`;
      addActivity(room, message, "trade");
      emitToPlayer(trade.requesterId, "trade:result", { ok: true, accepted: false, message });
      broadcastRoom(room);
      return reply(callback, { ok: true });
    }

    [sourceTeam.squad[sourceIndex], targetTeam.squad[targetIndex]] =
      [targetTeam.squad[targetIndex], sourceTeam.squad[sourceIndex]];
    const message = `${trade.sourceTeam} and ${trade.targetTeam} traded ${trade.sourcePlayerName} for ${trade.targetPlayerName}.`;
    addActivity(room, message, "trade");
    emitToPlayer(trade.requesterId, "trade:result", { ok: true, accepted: true, message });
    broadcastRoom(room);
    reply(callback, { ok: true });
  });

  socket.on("auction:bid", (callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: false, error: "Join the room to bid." });
    const { room, player } = membership;
    const auction = room.auction;
    if (!auction || auction.phase !== "bidding") return reply(callback, { ok: false, error: "Bidding is not open right now." });
    if (!player.team) return reply(callback, { ok: false, error: "You need a team to bid." });
    if (player.team === auction.highestBidTeam) return reply(callback, { ok: false, error: "Your team already has the highest bid." });

    const currentPlayer = currentAuctionPlayer(auction);
    const increment = 25;
    const bid = auction.currentBid === 0
      ? Math.round(currentPlayer.basePrice * 100)
      : auction.currentBid + increment;
    if (!teamCanBid(room, player, bid)) return reply(callback, { ok: false, error: "Your team does not have enough purse for that bid." });

    auction.currentBid = bid;
    auction.highestBidTeam = player.team;
    addActivity(room, `${player.team} bid ₹${(bid / 100).toFixed(2)} crore for ${currentPlayer.name}.`, "bid");
    startTimer(room, room.settings.bidTime, () => onBidTimerExpired(room));
    reply(callback, { ok: true });
  });

  socket.on("auction:useRtm", (cardIndex, callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: false, error: "Join the room to use an RTM card." });
    const { room, player } = membership;
    const auction = room.auction;
    if (!auction || auction.phase !== "rtm") return reply(callback, { ok: false, error: "There is no RTM decision pending." });
    const currentPlayer = currentAuctionPlayer(auction);
    const team = player.team && auction.teams[player.team];
    if (!team || player.team !== currentPlayer.previousTeam) {
      return reply(callback, { ok: false, error: "Only the player's previous team can use RTM." });
    }
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= team.rtmCards.length) {
      return reply(callback, { ok: false, error: "That RTM card has no uses remaining." });
    }
    const card = team.rtmCards[cardIndex];
    if (card.uses >= 2 || (card.playerId && card.playerId !== currentPlayer.id)) {
      return reply(callback, { ok: false, error: "That RTM card is unavailable for this player." });
    }
    if (team.purse < auction.currentBid + 25) return reply(callback, { ok: false, error: "Your remaining purse is too low to make the next RTM bid." });

    card.uses += 1;
    card.playerId = currentPlayer.id;
    card.playerName = currentPlayer.name;
    auction.pendingRtm = { team: team.code, cardIndex };
    auction.phase = "rtm-response";
    addActivity(room, `${team.code} activated RTM card ${cardIndex + 1} for ${currentPlayer.name} and has 20 seconds to submit a bid above ₹${(auction.currentBid / 100).toFixed(2)} crore.`, "rtm");
    startTimer(room, 20, () => {
      if (auction.phase !== "rtm-response") return;
      addActivity(room, `${team.code} did not complete the RTM match in time.`, "system");
      auction.pendingRtm = null;
      auction.phase = "bidding";
      finishCurrentPlayer(room);
    });
    reply(callback, { ok: true });
  });

  socket.on("auction:submitRtm", (rawAmount, callback) => {
    const membership = playerRoom(socket);
    if (!membership) return reply(callback, { ok: false, error: "Join the room to confirm RTM." });
    const { room, player } = membership;
    const auction = room.auction;
    if (!auction || auction.phase !== "rtm-response" || !auction.pendingRtm) {
      return reply(callback, { ok: false, error: "There is no RTM response to submit." });
    }
    if (player.team !== auction.pendingRtm.team) return reply(callback, { ok: false, error: "Only the RTM team can confirm this match." });
    const team = auction.teams[player.team];
    if (typeof rawAmount !== "string" && typeof rawAmount !== "number") {
      return reply(callback, { ok: false, error: "Enter a valid RTM bid amount." });
    }
    const amount = Number(rawAmount);
    const amountUnits = Math.round(amount * 100);
    if (!Number.isFinite(amount) || Math.abs(amount * 100 - amountUnits) > 0.000001) {
      return reply(callback, { ok: false, error: "RTM bids must use two decimal places in crore." });
    }
    if (amountUnits < auction.currentBid + 25 || (amountUnits - auction.currentBid) % 25 !== 0) {
      return reply(callback, { ok: false, error: `Enter at least ₹${((auction.currentBid + 25) / 100).toFixed(2)} crore, using ₹0.25 crore increments.` });
    }
    if (team.purse < amountUnits) {
      return reply(callback, { ok: false, error: "Your remaining purse is too low for that RTM bid." });
    }

    const currentPlayer = currentAuctionPlayer(auction);
    const cardNumber = auction.pendingRtm.cardIndex + 1;
    const previousBid = auction.currentBid;
    auction.currentBid = amountUnits;
    auction.highestBidTeam = team.code;
    auction.phase = "bidding";
    auction.pendingRtm = null;
    addActivity(room, `${team.code} used RTM card ${cardNumber} to bid ₹${(amountUnits / 100).toFixed(2)} crore for ${currentPlayer.name} (previous bid ₹${(previousBid / 100).toFixed(2)} crore).`, "rtm");
    startTimer(room, room.settings.bidTime, () => onBidTimerExpired(room));
    reply(callback, { ok: true });
  });

  socket.on("disconnect", () => {
    const membership = playerRoom(socket);
    if (!membership) return;
    const { room, player } = membership;
    if (activeSockets.get(player.id) !== socket.id) return;
    activeSockets.delete(player.id);
    for (const [tradeId, trade] of room.pendingTrades) {
      if (trade.requesterId === player.id || trade.recipientId === player.id) {
        room.pendingTrades.delete(tradeId);
        if (trade.requesterId !== player.id) {
          emitToPlayer(trade.requesterId, "trade:result", {
            ok: false,
            message: "The other manager disconnected. The trade request was cancelled.",
          });
        } else {
          emitToPlayer(trade.recipientId, "trade:cancelled", {
            tradeId: trade.id,
            message: "The requesting manager disconnected. The trade request was cancelled.",
          });
        }
      }
    }
    player.connected = false;
    player.reconnectTimer = setTimeout(
      () => removePlayer(room, player.id),
      RECONNECT_GRACE_PERIOD_MS,
    );
    broadcastRoom(room);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Auction Game is listening on port ${PORT}`);
});
