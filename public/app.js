const PLAYER_SESSION_STORAGE_KEY = "ipl-auction-player-session-v1";
const isUuid = (value) => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
let playerSession;
try {
  playerSession = JSON.parse(localStorage.getItem(PLAYER_SESSION_STORAGE_KEY));
} catch {
  playerSession = null;
}
if (!isUuid(playerSession?.resumeToken)) {
  playerSession = { playerId: null, resumeToken: crypto.randomUUID() };
  localStorage.setItem(PLAYER_SESSION_STORAGE_KEY, JSON.stringify(playerSession));
}
const socket = io({ auth: { resumeToken: playerSession.resumeToken } });

function savePlayerId(playerId) {
  if (!isUuid(playerId)) return;
  playerSession.playerId = playerId;
  localStorage.setItem(PLAYER_SESSION_STORAGE_KEY, JSON.stringify(playerSession));
}
const teams = [
  { code: "CSK", name: "Chennai", color: "#e5bd45" },
  { code: "DC", name: "Delhi", color: "#4b8fd8" },
  { code: "GT", name: "Gujarat", color: "#8092a7" },
  { code: "KKR", name: "Kolkata", color: "#8e79d2" },
  { code: "LSG", name: "Lucknow", color: "#47a8b8" },
  { code: "MI", name: "Mumbai", color: "#548cda" },
  { code: "PBKS", name: "Punjab", color: "#d75e69" },
  { code: "RR", name: "Rajasthan", color: "#df75b2" },
  { code: "RCB", name: "Bengaluru", color: "#dc6158" },
  { code: "SRH", name: "Hyderabad", color: "#e8914b" },
];

const homeScreen = document.querySelector("#home-screen");
const lobbyScreen = document.querySelector("#lobby-screen");
const auctionScreen = document.querySelector("#auction-screen");
const homeMessage = document.querySelector("#home-message");
const lobbyMessage = document.querySelector("#lobby-message");
const nameInput = document.querySelector("#player-name");
const savePlayerButton = document.querySelector("#save-player");
const teamGrid = document.querySelector("#team-grid");
const settingsCard = document.querySelector("#settings-card");
const startButton = document.querySelector("#start-auction");
const toast = document.querySelector("#toast");
const soundToggle = document.querySelector("#toggle-bid-sound");
const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
let currentRoom = null;
let selectedTeam = "";
let toastTimeout;
let selectedTradePlayerId = "";
let tradeRequestPending = false;
let incomingTradeRequest = null;
let bidSoundEnabled = true;
let bidAudioContext = null;
const teamSongAudio = new Audio();
teamSongAudio.preload = "auto";

function send(event, ...args) {
  return new Promise((resolve) => {
    socket.timeout(5000).emit(event, ...args, (timeoutError, response) => {
      if (timeoutError) {
        resolve({ ok: false, error: "The server did not respond. Please try again." });
        return;
      }
      resolve(response);
    });
  });
}

function showMessage(target, message = "") {
  target.textContent = message;
}

function notify(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.add("hidden"), 2600);
}

function initializeBidAudio() {
  if (!bidSoundEnabled || !AudioContextConstructor) return;
  try {
    if (!bidAudioContext) bidAudioContext = new AudioContextConstructor();
    if (bidAudioContext.state === "suspended") {
      bidAudioContext.resume().catch(() => notify("Could not start countdown audio. Check your browser sound settings."));
    }
  } catch {
    notify("Countdown audio is unavailable in this browser.");
  }
}

function playCountdownTick(seconds) {
  if (!bidSoundEnabled || !bidAudioContext || bidAudioContext.state !== "running") return;
  const oscillator = bidAudioContext.createOscillator();
  const gain = bidAudioContext.createGain();
  const start = bidAudioContext.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.value = seconds <= 5 ? 880 : 620;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.045, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
  oscillator.connect(gain);
  gain.connect(bidAudioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.1);
}

function playTeamSong(team) {
  teamSongAudio.pause();
  teamSongAudio.src = `/songs/${encodeURIComponent(team)}.mp3`;
  teamSongAudio.currentTime = 0;
  teamSongAudio.play().catch((error) => {
    if (error.name !== "AbortError") {
      notify("Could not play the team song. Check your browser sound settings.");
    }
  });
}

document.addEventListener("pointerdown", initializeBidAudio);
document.addEventListener("keydown", initializeBidAudio);

soundToggle.disabled = !AudioContextConstructor;
if (!AudioContextConstructor) {
  soundToggle.textContent = "Unavailable";
  soundToggle.setAttribute("aria-label", "Countdown sound is unavailable in this browser");
  soundToggle.setAttribute("aria-pressed", "false");
}
soundToggle.addEventListener("click", () => {
  if (!AudioContextConstructor) return;
  bidSoundEnabled = !bidSoundEnabled;
  soundToggle.textContent = bidSoundEnabled ? "Sound on" : "Sound off";
  soundToggle.setAttribute("aria-label", bidSoundEnabled ? "Mute countdown sound" : "Enable countdown sound");
  soundToggle.setAttribute("aria-pressed", String(bidSoundEnabled));
  if (bidSoundEnabled) initializeBidAudio();
});

function openLobby(room) {
  currentRoom = room;
  homeScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  showMessage(homeMessage);
  renderRoom(room);
}

function colorFor(code) {
  return teams.find((team) => team.code === code)?.color || "#56616b";
}

function renderTeams() {
  if (!currentRoom) return;
  const players = currentRoom.players;
  teamGrid.innerHTML = teams.map((team) => {
    const owner = players.find((player) => player.team === team.code);
    const isMine = owner?.id === playerSession.playerId;
    const isTaken = Boolean(owner) && !isMine;
    const isSelected = selectedTeam === team.code;
    const disabled = isTaken || currentRoom.started;
    return `<button class="team-card${isSelected || isMine ? " selected" : ""}" type="button" data-team="${team.code}" style="--team-color:${team.color}" ${disabled ? "disabled" : ""} aria-pressed="${isSelected || isMine}" aria-label="${team.name}${isTaken ? ", already selected" : ""}">
      <span class="team-icon">${team.code}</span><strong>${team.name}</strong><small>${isTaken ? "TAKEN" : isMine ? "YOUR TEAM" : "AVAILABLE"}</small>
    </button>`;
  }).join("");
  savePlayerButton.disabled = currentRoom.started || !selectedTeam || !nameInput.value.trim();
}

function renderRoster() {
  const players = currentRoom.players;
  const roster = document.querySelector("#roster-list");
  document.querySelector("#player-count").textContent = players.length;
  document.querySelector("#roster-count").textContent = players.length;
  roster.innerHTML = players.length
    ? players.map((player) => {
      const team = teams.find((entry) => entry.code === player.team);
      const name = player.name || (player.id === playerSession.playerId ? "You — choose a team" : "Choosing a team…");
      return `<div class="roster-player">
        <span class="roster-icon" style="--team-color:${colorFor(player.team)}">${player.team || "?"}</span>
        <span class="roster-player-copy"><strong>${escapeHtml(name)}</strong><small>${team ? team.name : "No team selected"}${player.connected ? "" : " · OFFLINE (CAN REJOIN)"}</small></span>
        ${player.isAdmin ? '<span class="admin-tag">ADMIN</span>' : ""}
      </div>`;
    }).join("")
    : '<div class="roster-empty">Waiting for players to join…</div>';
}

function renderRoom(room) {
  currentRoom = room;
  if (room.started && room.auction) {
    homeScreen.classList.add("hidden");
    lobbyScreen.classList.add("hidden");
    auctionScreen.classList.remove("hidden");
    renderAuction(room);
    return;
  }
  auctionScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  document.querySelector("#room-code-display").textContent = room.code;
  settingsCard.classList.toggle("hidden", room.adminId !== playerSession.playerId);
  const bidTime = document.querySelector("#bid-time");
  const purse = document.querySelector("#purse");
  bidTime.value = String(room.settings.bidTime);
  purse.value = String(room.settings.purse);
  bidTime.disabled = room.started;
  purse.disabled = room.started;
  nameInput.disabled = room.started;
  renderTeams();
  renderRoster();
  const completePlayers = room.players.filter((player) => player.name && player.team).length;
  startButton.disabled = room.adminId !== playerSession.playerId || room.players.length < 2 || completePlayers !== room.players.length || room.rosterCount === 0;
  document.querySelector("#start-hint").textContent = room.rosterCount === 0
    ? "Upload the player list before starting."
    : room.players.length < 2
      ? "At least 2 players are needed to start."
      : completePlayers !== room.players.length
        ? "Everyone needs a name and a team."
        : `${room.rosterCount} players loaded. Your room is ready.`;
  document.querySelector("#upload-status").textContent = room.rosterCount
    ? `${room.rosterCount} auction players loaded.`
    : "No player list uploaded.";
  document.querySelector("#player-file").disabled = room.adminId !== playerSession.playerId;
}

function formatCrore(amount) {
  return `₹${Number(amount).toFixed(2)} crore`;
}

function renderAuction(room) {
  const auction = room.auction;
  if (!auction) return;
  const player = auction.currentPlayer;
  const me = room.players.find((member) => member.id === playerSession.playerId);
  const myTeam = me?.team || "";
  const myTeamState = auction.teams.find((team) => team.code === myTeam);
  const playerTeam = player?.previousTeam || "";
  const currentBid = auction.currentBid;

  document.querySelector("#auction-room-code").textContent = room.code;
  document.querySelector("#wallet-team").textContent = myTeam || "NO TEAM";
  document.querySelector("#purse-team").textContent = myTeam || "NO TEAM";
  document.querySelector("#remaining-purse").innerHTML = myTeamState
    ? `₹${myTeamState.purse.toFixed(2)} <small>CR</small>`
    : "—";
  document.querySelector("#rtm-cards").innerHTML = myTeamState
    ? myTeamState.rtmCards.map((card, index) => {
    const availableForPlayer = card.uses < card.maxUses && (!card.playerId || card.playerId === player?.id);
    const status = card.playerId
      ? `${card.playerName} · ${card.maxUses - card.uses} USE${card.maxUses - card.uses === 1 ? "" : "S"} LEFT`
      : `${card.maxUses} USES LEFT · UNUSED`;
    return `<div class="rtm-card${availableForPlayer ? " available" : ""}">RTM ${index + 1}<small>${escapeHtml(status)}</small></div>`;
    }).join("")
    : '<div class="wallet-team">No team assigned.</div>';

  const isTerminal = auction.phase === "finished" || auction.phase === "cancelled";
  const phaseLabel = auction.phase === "finished"
    ? "AUCTION COMPLETE"
    : auction.phase === "cancelled"
      ? "AUCTION ENDED"
      : "LIVE AUCTION";
  document.querySelector("#auction-phase-label").textContent = phaseLabel;
  const endAuctionButton = document.querySelector("#end-auction");
  endAuctionButton.classList.toggle("hidden", room.adminId !== playerSession.playerId || isTerminal);
  document.querySelector("#auction-progress-text").textContent = player
    ? `PLAYER ${auction.currentIndex + 1} / ${auction.playerCount}`
    : `PLAYERS ${auction.playerCount} / ${auction.playerCount}`;
  document.querySelector("#auction-result-count").textContent = `${auction.soldCount} SOLD · ${auction.unsoldCount} UNSOLD`;
  document.querySelector("#auction-player-number").textContent = String(auction.currentIndex + 1).padStart(2, "0");
  document.querySelector("#auction-player-name").textContent = player?.name || "Auction complete";
  document.querySelector("#auction-player-type").textContent = player?.type || "—";
  document.querySelector("#auction-player-team").textContent = playerTeam;
  document.querySelector("#auction-player-base").textContent = player ? formatCrore(player.basePrice) : "—";
  document.querySelector("#auction-clock").textContent = `00:${String(auction.phase === "rtm" || auction.phase === "rtm-response" ? auction.rtmSecondsLeft : auction.secondsLeft).padStart(2, "0")}`;
  document.querySelector("#bid-clock-label").textContent = auction.phase === "rtm" || auction.phase === "rtm-response" ? "RTM TIME LEFT" : "TIME LEFT";
  document.querySelector("#current-bid").textContent = currentBid > 0 ? formatCrore(currentBid) : player ? `Base ${formatCrore(player.basePrice)}` : "—";
  const highBidTeam = auction.highestBidTeam
    ? `${auction.highestBidTeam} is highest bidder`
    : "Waiting for first bid";
  document.querySelector("#highest-bid-team").textContent = highBidTeam;

  const nextBid = player
    ? currentBid === 0 ? player.basePrice : currentBid + 0.25
    : 0;
  document.querySelector("#next-bid-amount").textContent = player ? formatCrore(nextBid) : "";
  const bidButton = document.querySelector("#place-bid");
  bidButton.classList.toggle("hidden", auction.phase !== "bidding");
  bidButton.disabled = !player || !myTeamState || myTeam === auction.highestBidTeam || myTeamState.purse < nextBid;

  const response = document.querySelector("#rtm-response");
  const choice = document.querySelector("#rtm-choice");
  const confirm = document.querySelector("#rtm-confirm");
  const promptTitle = document.querySelector("#rtm-prompt-title");
  const promptDescription = document.querySelector("#rtm-prompt-description");
  const isOriginalTeam = myTeam && myTeam === playerTeam;
  response.classList.toggle("hidden", auction.phase !== "rtm" && auction.phase !== "rtm-response");
  choice.classList.add("hidden");
  confirm.classList.add("hidden");
  if (auction.phase === "rtm") {
    promptTitle.textContent = isOriginalTeam ? "Your team can use RTM" : `${playerTeam} RTM decision`;
    promptDescription.textContent = isOriginalTeam
      ? "Select an available card. You will have 20 seconds to enter your RTM bid."
      : `Team ${playerTeam} can choose an RTM card. Bidding is paused until their decision.`;
    if (isOriginalTeam && myTeamState) {
      choice.innerHTML = myTeamState.rtmCards.map((card, index) => {
        const remaining = card.maxUses - card.uses;
        const assignedToAnotherPlayer = card.playerId && card.playerId !== player.id;
        const cardLabel = assignedToAnotherPlayer
          ? `RTM ${index + 1} · Locked to ${escapeHtml(card.playerName)}`
          : `Use RTM ${index + 1} · ${remaining} left`;
        return `<button type="button" class="rtm-use-button" data-rtm="${index}" ${remaining <= 0 || assignedToAnotherPlayer ? "disabled" : ""}>${cardLabel}</button>`;
      }).join("");
      choice.classList.remove("hidden");
    }
  } else if (auction.phase === "rtm-response" && auction.pendingRtm) {
    promptTitle.textContent = isOriginalTeam ? "Enter your RTM bid" : `Team ${auction.pendingRtm.team} is using RTM`;
    promptDescription.textContent = isOriginalTeam
      ? `Enter at least ₹${(currentBid + 0.25).toFixed(2)} crore in ₹0.25 crore steps within 20 seconds.`
      : `Team ${auction.pendingRtm.team} has 20 seconds to enter an RTM bid. Bidding is paused.`;
    if (isOriginalTeam) {
      const input = document.querySelector("#rtm-match-amount");
      input.min = (currentBid + 0.25).toFixed(2);
      input.value = (currentBid + 0.25).toFixed(2);
      input.max = myTeamState?.purse.toFixed(2) || "";
      confirm.classList.remove("hidden");
    }
  }

  if (auction.phase === "finished") {
    document.querySelector("#auction-player-card").classList.add("hidden");
    document.querySelector("#auction-finished").classList.remove("hidden");
    document.querySelector("#auction-cancelled").classList.add("hidden");
    document.querySelector("#bid-board").classList.add("hidden");
    response.classList.add("hidden");
  } else if (auction.phase === "cancelled") {
    document.querySelector("#auction-player-card").classList.add("hidden");
    document.querySelector("#auction-finished").classList.add("hidden");
    document.querySelector("#auction-cancelled").classList.remove("hidden");
    document.querySelector("#bid-board").classList.add("hidden");
    response.classList.add("hidden");
  } else {
    document.querySelector("#auction-player-card").classList.remove("hidden");
    document.querySelector("#auction-finished").classList.add("hidden");
    document.querySelector("#auction-cancelled").classList.add("hidden");
    document.querySelector("#bid-board").classList.remove("hidden");
  }

  document.querySelector("#activity-feed").innerHTML = auction.activity.length
    ? auction.activity.slice().reverse().map((entry) => `<article class="activity-item ${entry.kind}"><p>${escapeHtml(entry.message)}</p><small>${new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></article>`).join("")
    : '<div class="roster-empty">Auction activity will appear here.</div>';
  const participatingTeams = new Set(room.players.map((member) => member.team).filter(Boolean));
  document.querySelector("#teams-table").innerHTML = auction.teams.filter((team) => participatingTeams.has(team.code)).map((team) => {
    const manager = room.players.find((member) => member.team === team.code)?.name || "No manager";
    const squad = team.squad.length
      ? team.squad.map((item) => `<div><span>${escapeHtml(item.name)}</span><strong>₹${item.price.toFixed(2)} cr</strong></div>`).join("")
      : '<div><span>No players bought yet</span></div>';
    return `<details class="team-ledger"><summary><span><span class="team-ledger-name">${team.code}</span><br><span class="team-ledger-manager">${escapeHtml(manager)}</span></span><strong class="team-ledger-purse">₹${team.purse.toFixed(2)} cr</strong></summary><div class="team-ledger-squad">${squad}</div><div class="team-ledger-actions"><button type="button" class="button button-secondary" data-download-team="${team.code}">Download CSV</button><button type="button" class="button button-secondary" data-share-team="${team.code}">Share team</button></div></details>`;
  }).join("");
  renderTradePanel(room, myTeam);
}

function getTeamShareText(team) {
  const teamName = teams.find((entry) => entry.code === team.code)?.name || team.code;
  const manager = currentRoom.players.find((member) => member.team === team.code)?.name || "No manager";
  const players = team.squad.length
    ? team.squad.map((player) => `- ${player.name} — ₹${player.price.toFixed(2)} cr`).join("\n")
    : "No players bought yet";
  return `${teamName} (${team.code})\nManager: ${manager}\nRemaining purse: ₹${team.purse.toFixed(2)} cr\n\nSquad:\n${players}`;
}

function csvCell(value) {
  const text = String(value);
  const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function downloadTeamCsv(team) {
  const teamName = teams.find((entry) => entry.code === team.code)?.name || team.code;
  const manager = currentRoom.players.find((member) => member.team === team.code)?.name || "No manager";
  const rows = [
    ["Team", "Manager", "Player", "Price (crore)", "Remaining purse (crore)"],
    ...(team.squad.length
      ? team.squad.map((player) => [teamName, manager, player.name, player.price.toFixed(2), team.purse.toFixed(2)])
      : [[teamName, manager, "No players bought yet", "", team.purse.toFixed(2)]]),
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${team.code.toLowerCase()}-squad.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderTradePanel(room, myTeam) {
  const auction = room.auction;
  const panel = document.querySelector("#trade-teams");
  const instructions = document.querySelector("#trade-instructions");
  const myTeamState = auction.teams.find((team) => team.code === myTeam);
  const myPlayer = myTeamState?.squad.find((item) => item.id === selectedTradePlayerId);
  if (!myPlayer) selectedTradePlayerId = "";

  if (tradeRequestPending) {
    instructions.textContent = "Trade request sent. Waiting for the other team to respond.";
  } else if (selectedTradePlayerId) {
    instructions.textContent = `Selected ${myPlayer.name}. Choose a player from another team to propose a one-for-one trade.`;
  } else {
    instructions.textContent = "Choose one of your players, then choose a player from another team to propose a one-for-one trade.";
  }

  const participatingTeams = new Set(room.players.map((member) => member.team).filter(Boolean));
  const myPlayers = myTeamState?.squad.length
    ? myTeamState.squad.map((item) => `<button type="button" class="trade-player-button${item.id === selectedTradePlayerId ? " selected" : ""}" data-trade-own="${escapeHtml(item.id)}" ${tradeRequestPending ? "disabled" : ""}><span>${escapeHtml(item.name)}</span><small>${escapeHtml(item.type)} · ₹${item.price.toFixed(2)} cr</small></button>`).join("")
    : '<div class="trade-empty">Your team has no players to trade yet.</div>';
  const otherTeams = auction.teams
    .filter((team) => participatingTeams.has(team.code) && team.code !== myTeam)
    .map((team) => {
      const manager = room.players.find((member) => member.team === team.code)?.name || team.code;
      const players = team.squad.length
        ? team.squad.map((item) => `<button type="button" class="trade-player-button" data-trade-target="${escapeHtml(item.id)}" ${!selectedTradePlayerId || tradeRequestPending ? "disabled" : ""}><span>${escapeHtml(item.name)}</span><small>${escapeHtml(item.type)} · ₹${item.price.toFixed(2)} cr</small></button>`).join("")
        : '<div class="trade-empty">No players available.</div>';
      return `<details class="trade-team"><summary><span><strong>${team.code}</strong><small>${escapeHtml(manager)}</small></span><span>${team.squad.length} PLAYER${team.squad.length === 1 ? "" : "S"}</span></summary><div class="trade-player-list">${players}</div></details>`;
    }).join("");

  panel.innerHTML = `<section class="trade-team-section"><h3>Your team · ${escapeHtml(myTeam || "No team")}</h3><div class="trade-player-list">${myPlayers}</div></section><section class="trade-team-section"><h3>Other teams</h3>${otherTeams || '<div class="trade-empty">No other participating teams.</div>'}</section>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

document.querySelector("#create-room").addEventListener("click", async () => {
  const result = await send("room:create");
  if (!result?.ok) {
    showMessage(homeMessage, result?.error || "Could not create the room.");
    return;
  }
  savePlayerId(result.playerId);
  openLobby(result.room);
});

document.querySelector("#join-room").addEventListener("click", async () => {
  const codeInput = document.querySelector("#room-code");
  const code = codeInput.value.trim().toUpperCase();
  if (!code) {
    showMessage(homeMessage, "Enter a room code to join.");
    codeInput.focus();
    return;
  }
  const result = await send("room:join", code);
  if (!result?.ok) {
    showMessage(homeMessage, result?.error || "Could not join the room.");
    return;
  }
  savePlayerId(result.playerId);
  openLobby(result.room);
});

document.querySelector("#room-code").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  showMessage(homeMessage);
});

document.querySelector("#leave-room").addEventListener("click", async () => {
  const result = await send("room:leave");
  if (!result?.ok) {
    notify(result?.error || "Could not leave the room. Your session is still saved.");
    return;
  }
  localStorage.removeItem(PLAYER_SESSION_STORAGE_KEY);
  window.location.reload();
});

document.querySelector("#copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentRoom.code);
    notify("Room code copied.");
  } catch {
    notify(`Share room code: ${currentRoom.code}`);
  }
});

teamGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-team]");
  if (!button || button.disabled) return;
  selectedTeam = button.dataset.team;
  showMessage(lobbyMessage);
  renderTeams();
});

nameInput.addEventListener("input", () => renderTeams());

savePlayerButton.addEventListener("click", async () => {
  const result = await send("player:update", { name: nameInput.value, team: selectedTeam });
  if (!result?.ok) {
    showMessage(lobbyMessage, result?.error || "Could not save your team.");
    return;
  }
  showMessage(lobbyMessage, "Your team is saved.");
});

async function updateSettings() {
  const result = await send("room:updateSettings", {
    bidTime: document.querySelector("#bid-time").value,
    purse: document.querySelector("#purse").value,
  });
  if (!result?.ok) notify(result?.error || "Could not update settings.");
}

document.querySelector("#bid-time").addEventListener("change", updateSettings);
document.querySelector("#purse").addEventListener("change", updateSettings);

startButton.addEventListener("click", async () => {
  const result = await send("room:start");
  if (!result?.ok) notify(result?.error || "Could not start the auction.");
});

document.querySelector("#player-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const status = document.querySelector("#upload-status");
  if (file.size > 4 * 1024 * 1024) {
    status.textContent = "File must be smaller than 4 MB.";
    event.target.value = "";
    return;
  }
  try {
    const players = JSON.parse(await file.text());
    status.textContent = "Loading player list…";
    const result = await send("room:loadPlayers", players);
    if (!result?.ok) {
      status.textContent = result?.error || "Could not load player list.";
      return;
    }
    status.textContent = `${result.count} auction players loaded.`;
  } catch (error) {
    status.textContent = error instanceof SyntaxError
      ? "Invalid JSON. Please choose a valid player list."
      : "Could not read the selected file.";
  } finally {
    event.target.value = "";
  }
});

document.querySelector("#place-bid").addEventListener("click", async () => {
  const result = await send("auction:bid");
  showMessage(document.querySelector("#auction-message"), result?.ok ? "" : result?.error || "Could not place bid.");
});

document.querySelector("#rtm-choice").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-rtm]");
  if (!button || button.disabled) return;
  const result = await send("auction:useRtm", Number(button.dataset.rtm));
  showMessage(document.querySelector("#auction-message"), result?.ok ? "" : result?.error || "Could not use RTM.");
});

document.querySelector("#confirm-rtm").addEventListener("click", async () => {
  const amount = document.querySelector("#rtm-match-amount").value;
  const result = await send("auction:submitRtm", amount);
  showMessage(document.querySelector("#auction-message"), result?.ok ? "" : result?.error || "Could not confirm RTM.");
});

const endAuctionDialog = document.querySelector("#end-auction-confirm");
document.querySelector("#end-auction").addEventListener("click", () => {
  endAuctionDialog.classList.remove("hidden");
});

document.querySelector("#keep-auction").addEventListener("click", () => {
  endAuctionDialog.classList.add("hidden");
});

document.querySelector("#confirm-end-auction").addEventListener("click", async () => {
  const button = document.querySelector("#confirm-end-auction");
  button.disabled = true;
  const result = await send("auction:end");
  button.disabled = false;
  if (!result?.ok) {
    notify(result?.error || "Could not end the auction.");
    return;
  }
  endAuctionDialog.classList.add("hidden");
});

endAuctionDialog.addEventListener("click", (event) => {
  if (event.target === endAuctionDialog) endAuctionDialog.classList.add("hidden");
});

document.querySelector(".auction-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  document.querySelectorAll(".auction-tab").forEach((item) => {
    const active = item === tab;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  document.querySelector("#chat-panel").classList.toggle("hidden", tab.dataset.tab !== "chat");
  document.querySelector("#teams-panel").classList.toggle("hidden", tab.dataset.tab !== "teams");
  document.querySelector("#trade-panel").classList.toggle("hidden", tab.dataset.tab !== "trade");
});

document.querySelector("#teams-table").addEventListener("click", async (event) => {
  const downloadButton = event.target.closest("[data-download-team]");
  const shareButton = event.target.closest("[data-share-team]");
  const code = downloadButton?.dataset.downloadTeam || shareButton?.dataset.shareTeam;
  if (!code || !currentRoom?.auction) return;
  const team = currentRoom.auction.teams.find((entry) => entry.code === code);
  if (!team) return;

  if (downloadButton) {
    downloadTeamCsv(team);
    notify(`${code} team list downloaded.`);
    return;
  }

  const text = getTeamShareText(team);
  try {
    if (navigator.share) {
      await navigator.share({ title: `${code} team list`, text });
      return;
    }
    await navigator.clipboard.writeText(text);
    notify(`${code} team list copied to share.`);
  } catch (error) {
    if (error.name !== "AbortError") {
      notify("Could not share the team list. Please try again.");
    }
  }
});

document.querySelector("#trade-teams").addEventListener("click", async (event) => {
  const ownPlayerButton = event.target.closest("[data-trade-own]");
  if (ownPlayerButton && !ownPlayerButton.disabled) {
    selectedTradePlayerId = ownPlayerButton.dataset.tradeOwn;
    renderAuction(currentRoom);
    return;
  }
  const targetPlayerButton = event.target.closest("[data-trade-target]");
  if (!targetPlayerButton || targetPlayerButton.disabled || tradeRequestPending) return;

  tradeRequestPending = true;
  renderAuction(currentRoom);
  const result = await send("trade:request", {
    sourcePlayerId: selectedTradePlayerId,
    targetPlayerId: targetPlayerButton.dataset.tradeTarget,
  });
  if (!result?.ok) {
    tradeRequestPending = false;
    notify(result?.error || "Could not send trade request.");
    renderAuction(currentRoom);
    return;
  }
  notify("Trade request sent.");
});

async function respondToTrade(accept) {
  if (!incomingTradeRequest) return;
  const request = incomingTradeRequest;
  const result = await send("trade:respond", { tradeId: request.id, accept });
  if (!result?.ok) notify(result?.error || "Could not respond to the trade request.");
  else notify(accept ? "Trade accepted." : "Trade declined.");
  incomingTradeRequest = null;
  document.querySelector("#trade-request-overlay").classList.add("hidden");
}

document.querySelector("#accept-trade").addEventListener("click", () => respondToTrade(true));
document.querySelector("#decline-trade").addEventListener("click", () => respondToTrade(false));

socket.on("trade:request", (request) => {
  incomingTradeRequest = request;
  document.querySelector("#trade-request-description").textContent =
    `${request.requesterName} (${request.sourceTeam}) offers ${request.sourcePlayerName} for your ${request.targetPlayerName}. Accepting swaps the players; team purses are unchanged.`;
  document.querySelector("#trade-request-overlay").classList.remove("hidden");
});

socket.on("trade:cancelled", (result) => {
  if (incomingTradeRequest?.id === result.tradeId) {
    incomingTradeRequest = null;
    document.querySelector("#trade-request-overlay").classList.add("hidden");
  }
  notify(result.message || "The trade request was cancelled.");
});

socket.on("trade:result", (result) => {
  tradeRequestPending = false;
  notify(result.message || (result.accepted ? "Trade accepted." : "Trade declined."));
  if (currentRoom?.started) renderAuction(currentRoom);
});

socket.on("room:update", renderRoom);
socket.on("session:restored", ({ playerId }) => savePlayerId(playerId));
socket.on("auction:sold", ({ team }) => playTeamSong(team));
socket.on("auction:tick", (tick) => {
  if (!currentRoom?.auction) return;
  Object.assign(currentRoom.auction, tick);
  const isRtmPhase = tick.phase === "rtm" || tick.phase === "rtm-response";
  const seconds = isRtmPhase ? tick.rtmSecondsLeft : tick.secondsLeft;
  document.querySelector("#auction-clock").textContent = `00:${String(seconds).padStart(2, "0")}`;
  document.querySelector("#bid-clock-label").textContent = isRtmPhase ? "RTM TIME LEFT" : "TIME LEFT";
  if (seconds > 0) playCountdownTick(seconds);
});
socket.on("connect_error", () => {
  if (homeScreen.classList.contains("hidden")) {
    notify("Connection lost. Reconnecting and restoring your room…");
  } else {
    showMessage(homeMessage, "Unable to connect to the game server. Try refreshing.");
  }
});
socket.on("connect", () => {
  if (currentRoom) notify("Reconnected. Your room has been restored.");
});
