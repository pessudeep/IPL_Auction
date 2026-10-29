# Auction Game

A mobile-friendly, real-time IPL auction lobby. Players can create or join a room, claim one of the ten IPL franchises, and configure the auction before it starts.

## Run locally

1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000` on your device or computer. For testing on a phone on the same Wi-Fi, open the computer's local network IP on port `3000`.

The room code can be shared with other players who can reach the same server. Room state is held in server memory and is cleared when the server restarts.

## Deploy and share a URL

This project includes a `render.yaml` blueprint. Create a new Render web service from this project (or connect the repository and deploy the blueprint); Render will build and start the Node service and assign it a public HTTPS URL. Share that URL with players, then share the room code created in the app. A Node host that supports long-lived Socket.IO connections can also be used.

## Auction roster format

The app loads `public/ipl_2026_players.json` as the default room roster. The admin can replace it in the lobby by uploading a JSON file containing an array of players with `name`, `type`, `basePrice`, and an optional `previousTeam`. `basePrice` is in crore; strings such as `"30 lakh"` and `"2 crore"` are also accepted. A null or omitted `basePrice` starts at ₹0.75 crore. Use one of the ten team codes or a full IPL team name for `previousTeam`.

```json
[
  {
    "name": "Example Player",
    "type": "Batter",
    "basePrice": 2,
    "previousTeam": "CSK"
  },
  {
    "name": "Another Example",
    "type": "All-rounder",
    "basePrice": "50 lakh",
    "previousTeam": ""
  }
]
```

The linked Cricinfo page is not accessible to this app in the current environment, so the real player list needs to be exported/provided and uploaded by the room admin.

## Auction rules

- Rooms support 2–10 connected players.
- Each IPL team can be selected by only one player at a time.
- Every player must provide a name and claim a team before the admin can start.
- The admin can choose a 10, 20, or 30 second bid timer and a ₹100, ₹120, ₹140, or ₹150 crore purse.
- The auction player order is randomized each time an auction starts; the lobby roster itself stays unchanged.
- The Trade tab lets a team propose a one-for-one swap of purchased players to another team's manager. The receiving manager must accept; declining leaves both squads unchanged. Trades do not change team purses.
- If the admin disconnects, the next connected player becomes admin.
- Starting the auction switches every connected player to the live auction.
- The admin can end an active auction at any time. The auction timer stops and all connected players return to the same room lobby. The cancelled auction cannot accept more bids; starting again creates a fresh auction, while the room's roster and player/team assignments stay in the lobby.
- Every IPL team has its own purse and four RTM cards. Each card can be activated up to twice for one player only. Using a card once locks it to that player; its second activation is only available for the same player, never for another player.
- The first bid is the player's base price (₹0.75 crore when the source base price is null). Every subsequent bid increases the current bid by a fixed ₹0.25 crore.
- When a player is sold, the winning team's song from `public/songs/` plays in the background while the next player appears immediately with a 10-second bid timer.
- If a player has a previous team, that team gets an RTM decision after the bid timer expires. The team has 20 seconds to select an available RTM card, then 20 seconds to enter a bid at least ₹0.25 crore above the current bid, in ₹0.25 crore steps. Other bidders see which team is using RTM while the decision is pending. The submitted RTM bid becomes the new high bid and regular bidding resumes; if another team outbids it, the previous team can use another available RTM activation.
- Bid activity, RTM actions, and sale results appear in the Chat & activity tab. The Teams tab shows remaining purses and acquired players.
- Rooms and auction state are held in server memory and are cleared when the server restarts.
