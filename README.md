# PeerCall — Free Anonymous Video Calls

> Start a free, anonymous peer-to-peer video call with anyone. No accounts, no downloads, no phone number required. Just share a 6-character code and connect.

![PeerCall](https://img.shields.io/badge/WebRTC-Peer--to--Peer-blue) ![Socket.io](https://img.shields.io/badge/Signaling-Socket.io-green) ![License](https://img.shields.io/badge/License-MIT-yellow)

## How It Works

1. **Start a Call** — Click "Start a Call" to generate a unique 6-character room code
2. **Share the Code** — Send the code to anyone via text, chat, email, etc.
3. **They Join** — They enter the code on the site and click "Join"
4. **You Approve** — You see a prompt to Allow or Deny the join request
5. **Connected** — Once approved, you're in a direct peer-to-peer video call

```
┌──────────┐    WebSocket (signaling only)    ┌─────────────┐
│ Browser A │ ◄──────────────────────────────► │  Node.js    │
└─────┬─────┘                                  │  Server     │
      │          WebRTC (direct P2P)           └──────┬──────┘
      │  ◄─────────────────────────────►              │
┌─────┴─────┐    WebSocket (signaling only)          │
│ Browser B │ ◄──────────────────────────────────────┘
└───────────┘
```

The server only handles signaling (room codes, join approval, WebRTC handshake). **Audio and video flow directly between browsers** — never through the server.

---

## Local Development

### Prerequisites
- Node.js 18+ and npm

### Setup

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/peercall.git
cd peercall

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Start the development server
npm run dev
```

The app will be running at `http://localhost:3000`.

> **Note:** For local testing, you can open two browser tabs on `localhost:3000`. Camera/mic access works on `localhost` without HTTPS. For testing between devices on a LAN, you'll need HTTPS (browsers block `getUserMedia` on non-secure origins other than localhost).

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server port |
| `TURN_URL` | No | — | TURN server URL (e.g., `turn:a.relay.metered.ca:443`) |
| `TURN_USERNAME` | No | — | TURN server username |
| `TURN_CREDENTIAL` | No | — | TURN server credential |

---

## TURN Server Setup

The app works with STUN only (Google's public STUN servers are included by default), but **some users behind restrictive NATs or corporate firewalls will fail to connect without a TURN server**.

### Free Option: Metered.ca

1. Sign up at [metered.ca/stun-turn](https://www.metered.ca/stun-turn) (free tier: 20 GB/month)
2. Get your TURN URL, username, and credential from the dashboard
3. Set them as environment variables:

```bash
TURN_URL=turn:a.relay.metered.ca:443
TURN_USERNAME=your_username
TURN_CREDENTIAL=your_credential
```

---

## Deployment (Render.com)

### One-Click Deploy

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) and sign up (free)
3. Click **New** → **Blueprint** → connect your GitHub repo
4. Render will detect the `render.yaml` and configure everything
5. Add your TURN credentials as environment variables in the Render dashboard
6. Deploy!

### Manual Deploy

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repository
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Add environment variables (TURN_URL, TURN_USERNAME, TURN_CREDENTIAL)
5. Deploy

---

## Known Limitations

### Free-Tier Hosting (Render.com Free Plan)
- The server **spins down after ~15 minutes of inactivity**. The first visit after idle time will take **30–60 seconds** to wake up. This is a trade-off of free hosting, not a bug.
- The free tier has limited compute hours per month.

### TURN Relay Bandwidth
- When a call falls back to TURN relay (because direct P2P fails), media flows through the TURN provider's servers.
- On Metered.ca's free tier, this is capped at **20 GB/month**. Direct P2P calls do not consume any TURN bandwidth.
- "Unlimited calls" only truly applies to direct P2P connections.

### Ephemeral by Design
- All room data is stored **in memory only**. Nothing survives a server restart.
- There is no database, no user accounts, no call history, no recordings.
- This is intentional — privacy by design.

### Two-Party Only
- Each room supports exactly two participants. There is no multi-party conferencing.

### No Chat / No Recording
- This app is audio/video only. There is no text chat, screen sharing, or recording functionality.

---

## Security

- **No brute-forcing:** Join attempts are rate-limited to 5 per minute per IP. The code space (29^6 ≈ 594 million codes) makes guessing impractical.
- **Join approval:** The room creator must explicitly approve each join request.
- **End-to-end WebRTC encryption:** WebRTC media streams are encrypted by default (DTLS-SRTP).
- **No data retention:** Nothing is logged or stored beyond the lifetime of a room.
- **TURN credentials:** Served from the backend via API — never hardcoded in client-side code.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | HTML, CSS, Vanilla JavaScript |
| Backend | Node.js, Express |
| Signaling | Socket.io (WebSockets) |
| Media | WebRTC (RTCPeerConnection, getUserMedia) |
| NAT Traversal | Google STUN + Metered.ca TURN |

---

## Project Structure

```
peercall/
├── server.js              # Express + Socket.io signaling server
├── package.json           # Dependencies and scripts
├── .env.example           # Environment variable template
├── .gitignore             # Git ignore rules
├── render.yaml            # Render.com deploy blueprint
├── README.md              # This file
└── public/
    ├── index.html         # Single-page app HTML
    ├── css/
    │   └── style.css      # Premium dark-mode styles
    └── js/
        ├── app.js         # Main application logic
        └── config.js      # ICE server configuration
```

---

## License

MIT — do whatever you want with it.
