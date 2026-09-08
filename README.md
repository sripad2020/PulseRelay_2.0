# ⚡ PulseRelay Enterprise Communication

A privacy-first, zero-database anonymous workspace built with TCP/IP (WebSockets and WebRTC DataChannels). Designed for **Local Area Networks (LAN)** and **Vercel Serverless Deployment**.

---

## 🌟 Key Features

1. **PulseRelay Business Portal First**
   - Opening `http://localhost:3000` loads the **Business Landing Page FIRST**, displaying enterprise business specs, TCP/IP architecture, zero-database compliance details, and room join/create controls.
2. **Encrypted Anonymous Identity**
   - Uses cryptographic hex handles (e.g. `0x7F4A_9C`, `0xE29B_41`) protecting user identity without registration or personal data tracking.
3. **Zero Database / Auto-Wiping Session Memory**
   - Messages are stored strictly inside browser `sessionStorage` and are **automatically wiped clean when the browser tab or session is closed**.
4. **Dual TCP/IP Transport Engine**
   - **LAN Mode**: Runs over Python (`python main.py`) or Node.js (`npm start`) WebSockets across any local network.
   - **Vercel Mode**: Deploys serverlessly using WebRTC Data Channels and Serverless Signaling routes (`/api/signal.js`).
5. **Karnataka Bank-Inspired Enterprise Theme**
   - Clean, professional white & royal navy blue (`#0a3663`) design system with crimson red (`#c8102e`) accents.

---

## 🚀 How to Run

### Option 1: Run with Python (Recommended)
```bash
python main.py
```

### Option 2: Run with Node.js
```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser to view the **PulseRelay Business Portal**, create or join a workspace room, and start communicating!
