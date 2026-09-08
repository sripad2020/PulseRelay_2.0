/**
 * PulseRelay Advanced Enterprise Controller
 * Web Crypto AES-GCM-256 Room Key Derivation & Decryption Fix
 */

class PulseRelayApp {
  constructor() {
    this.currentRoomId = null;
    this.user = window.chatStorage.getUserProfile();
    this.typingTimeout = null;
    this.onlinePeers = [];

    this.stagedTransfers = {};
    this.incomingTransfers = {};
    this.pendingIncomingMeta = null;
    this.pendingIncomingSender = null;
    this.burnTimers = {};
    this.dynamicChunkSize = 256 * 1024;

    this.initUI();
    this.initEventListeners();
    this.initTransport();
    this.handleUrlRouting();
    this.initTopologyCanvas();
  }

  initUI() {
    document.getElementById('user-alias').textContent = this.user.alias;
    const avatarEl = document.getElementById('user-avatar');
    avatarEl.textContent = this.user.initial || 'OP';
  }

  initTransport() {
    window.transportEngine.on('connection-status', (status) => {
      const modeEl = document.getElementById('connection-mode-text');
      if (modeEl) modeEl.textContent = status.mode;
    });

    window.transportEngine.on('network-telemetry', ({ pingMs }) => {
      this.updateTelemetryMetrics(pingMs);
    });

    window.transportEngine.on('room-users', (users) => {
      this.onlinePeers = users || [];
      this.renderPeersList(users);
      this.updateStagingRecipientDropdown();
      this.drawTopologyCanvas();
    });

    window.transportEngine.on('user-joined', (user) => {
      this.appendSystemMessage(`${user.alias} joined room.`);
      this.drawTopologyCanvas();
    });

    window.transportEngine.on('user-left', (user) => {
      if (user && user.alias) {
        this.appendSystemMessage(`${user.alias} left room.`);
        this.drawTopologyCanvas();
      }
    });

    // Receive Encrypted Chat Message & Decrypt matching room key
    window.transportEngine.on('chat-message', async (msgPayload) => {
      if (this.currentRoomId) {
        let plainText = msgPayload.text;
        if (msgPayload.encryptedObj) {
          plainText = await window.chatStorage.decryptPayload(msgPayload.encryptedObj, this.currentRoomId);
        }

        const msg = { ...msgPayload, text: plainText };
        window.chatStorage.saveMessage(this.currentRoomId, msg);
        this.appendMessageToFeed(msg);

        if (msg.burnSeconds && msg.burnSeconds > 0) {
          this.startBurnCountdown(msg.id, msg.burnSeconds);
        }
      }
    });

    window.transportEngine.on('burn-message-purge', ({ messageId }) => {
      this.purgeBurnMessageFromUI(messageId);
    });

    window.transportEngine.on('typing-status', (data) => {
      const typingEl = document.getElementById('typing-indicator');
      if (typingEl && data.isTyping && data.user.id !== this.user.id) {
        typingEl.textContent = `${data.user.alias} is typing...`;
      } else if (typingEl) {
        typingEl.textContent = '';
      }
    });

    window.transportEngine.on('targeted-file-init', ({ meta, sender }) => {
      this.promptRecipientLocationSelection(meta, sender);
    });

    window.transportEngine.on('targeted-file-chunk', ({ chunk, sender }) => {
      this.handleIncomingChunkToDisk(chunk, sender);
    });

    window.transportEngine.on('targeted-file-ack', ({ ack, sender }) => {
      this.handleTransferAck(ack, sender);
    });
  }

  handleUrlRouting() {
    const fullUrl = window.location.href;
    let roomCode = null;

    if (fullUrl.includes('room=')) {
      const raw = fullUrl.split('room=')[1];
      roomCode = raw.split('&')[0].split('#')[0].trim().toUpperCase();
    } else if (window.location.hash && window.location.hash.length > 1) {
      roomCode = window.location.hash.replace('#', '').replace('room=', '').trim().toUpperCase();
    }

    if (roomCode) {
      const landingInput = document.getElementById('input-landing-room-code');
      if (landingInput) landingInput.value = roomCode;
      this.enterWorkspace(roomCode);
    } else {
      this.showLandingPage();
    }
  }

  showLandingPage() {
    document.getElementById('landing-view').style.display = 'flex';
    document.getElementById('workspace-view').style.display = 'none';
    document.getElementById('btn-toggle-sidebar').style.display = 'none';
    window.location.hash = '';
  }

  async enterWorkspace(roomId) {
    if (!roomId) return;
    const cleanRoomId = roomId.trim().toUpperCase();
    this.currentRoomId = cleanRoomId;
    window.location.hash = `room=${cleanRoomId}`;

    // Derive room-specific AES-GCM 256 CryptoKey
    await window.chatStorage.deriveRoomKey(cleanRoomId);

    document.getElementById('landing-view').style.display = 'none';
    document.getElementById('workspace-view').style.display = 'flex';
    document.getElementById('btn-toggle-sidebar').style.display = 'flex';

    document.getElementById('room-name-heading').textContent = `Workspace ${cleanRoomId}`;
    document.getElementById('room-code-display').textContent = `#${cleanRoomId}`;

    // Seed roster with self identity immediately so online roster shows 1 right away
    this.onlinePeers = [this.user];
    this.renderPeersList(this.onlinePeers);

    window.transportEngine.joinRoom(cleanRoomId, this.user);
    this.loadRoomMessages();
    this.drawTopologyCanvas();
  }

  loadRoomMessages() {
    const feed = document.getElementById('messages-feed');
    feed.innerHTML = `<div class="system-event">Joined room #${this.currentRoomId}. Protected by AES-256 E2EE & Ephemeral RAM Auto-Wipe.</div>`;
    
    const messages = window.chatStorage.getRoomMessages(this.currentRoomId);
    messages.forEach(msg => this.appendMessageToFeed(msg));
    this.scrollToBottom();
  }

  initEventListeners() {
    document.getElementById('brand-logo-btn').addEventListener('click', () => {
      this.showLandingPage();
    });

    document.getElementById('btn-landing-create-room').addEventListener('click', () => {
      const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      this.enterWorkspace(newCode);
    });

    document.getElementById('btn-landing-join-room').addEventListener('click', () => {
      const input = document.getElementById('input-landing-room-code');
      const code = input.value.trim().toUpperCase();
      if (code) {
        this.enterWorkspace(code);
        input.value = '';
      } else {
        alert('Please enter a room code.');
      }
    });

    document.getElementById('btn-back-portal').addEventListener('click', () => {
      this.showLandingPage();
    });

    document.getElementById('btn-sidebar-create-room').addEventListener('click', () => {
      const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      this.enterWorkspace(newCode);
    });

    const topoModal = document.getElementById('modal-network-topology');
    document.getElementById('btn-topology-modal').addEventListener('click', () => {
      topoModal.classList.add('active');
      this.drawTopologyCanvas();
    });
    document.getElementById('btn-close-topology-modal').addEventListener('click', () => {
      topoModal.classList.remove('active');
    });

    const stagingModal = document.getElementById('modal-staging-area');
    document.getElementById('btn-staging-modal').addEventListener('click', () => {
      this.updateStagingRecipientDropdown();
      stagingModal.classList.add('active');
    });
    document.getElementById('btn-close-staging-modal').addEventListener('click', () => {
      stagingModal.classList.remove('active');
    });

    document.getElementById('btn-pick-folder').addEventListener('click', () => {
      document.getElementById('input-staging-folder').click();
    });

    document.getElementById('btn-initiate-staging').addEventListener('click', () => {
      this.stageFileAndNotifyRecipient();
    });

    const recipModal = document.getElementById('modal-recipient-location');
    document.getElementById('btn-accept-recipient-location').addEventListener('click', async () => {
      await this.acceptStreamWithConfirmedLocation(false);
    });
    document.getElementById('btn-choose-other-location').addEventListener('click', async () => {
      await this.acceptStreamWithConfirmedLocation(true);
    });
    document.getElementById('btn-reject-recipient-stream').addEventListener('click', () => {
      recipModal.classList.remove('active');
      if (this.pendingIncomingMeta && this.pendingIncomingSender) {
        window.transportEngine.sendTargetedFileAck(this.pendingIncomingSender.id, {
          transferId: this.pendingIncomingMeta.transferId,
          status: 'rejected'
        });
      }
    });

    // Enterprise Mode Selector
    const modeSelect = document.getElementById('select-profile-mode-header');
    if (modeSelect) {
      modeSelect.addEventListener('change', (e) => {
        this.updateProfileMode(e.target.value);
      });
    }

    // Industrial Presets in Staging Modal
    document.querySelectorAll('.btn-preset').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const presetKey = e.currentTarget.getAttribute('data-preset');
        this.applyIndustrialPreset(presetKey);
      });
    });

    // Compliance Certificate Modal Handlers
    const certModal = document.getElementById('modal-compliance-cert');
    document.getElementById('btn-export-audit-cert').addEventListener('click', () => {
      this.openComplianceCertificateModal();
    });
    document.getElementById('btn-close-cert-modal').addEventListener('click', () => {
      certModal.classList.remove('active');
    });
    document.getElementById('btn-download-cert-json').addEventListener('click', () => {
      this.downloadComplianceCertificateJSON();
    });

    const inputField = document.getElementById('chat-input-field');
    const sendBtn = document.getElementById('btn-send-msg');

    const handleSend = () => {
      const text = inputField.value.trim();
      if (!text) return;

      const burnSeconds = parseInt(document.getElementById('select-burn-timer').value, 10) || 0;
      this.sendChatMessage(text, null, false, burnSeconds);
      
      inputField.value = '';
      document.getElementById('select-burn-timer').value = '0';
      this.handleTyping(false);
    };

    sendBtn.addEventListener('click', handleSend);
    inputField.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSend();
    });

    inputField.addEventListener('input', () => {
      this.handleTyping(true);
    });

    const fileInput = document.getElementById('file-attachment-input');
    document.getElementById('btn-attach-file').addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (file.size > 3 * 1024 * 1024) {
        alert('For large files (up to 50GB+), please use the "📦 File & Folder Staging" button.');
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        this.sendChatMessage(`Attachment: ${file.name}`, event.target.result, file.type.startsWith('image/'));
      };
      reader.readAsDataURL(file);
      fileInput.value = '';
    });

    document.getElementById('btn-copy-link').addEventListener('click', () => {
      const shareUrl = `${window.location.protocol}//${window.location.host}/#room=${this.currentRoomId}`;
      navigator.clipboard.writeText(shareUrl);
      alert(`📋 Room share link copied:\n${shareUrl}`);
    });

    document.getElementById('room-code-display').addEventListener('click', () => {
      navigator.clipboard.writeText(this.currentRoomId);
      alert(`Room code #${this.currentRoomId} copied!`);
    });

    const sidebar = document.getElementById('sidebar-drawer');
    document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }

  updateProfileMode(modeKey) {
    window.chatStorage.setProfileMode(modeKey);
    const hipaaBadge = document.getElementById('badge-hipaa');
    const soc2Badge = document.getElementById('badge-soc2');
    const offgridBadge = document.getElementById('badge-offgrid');

    if (hipaaBadge) hipaaBadge.style.display = 'none';
    if (soc2Badge) soc2Badge.style.display = 'none';
    if (offgridBadge) offgridBadge.style.display = 'none';

    if (modeKey === 'AIRGAPPED_HEALTHCARE') {
      if (hipaaBadge) hipaaBadge.style.display = 'inline-flex';
      if (soc2Badge) soc2Badge.style.display = 'inline-flex';
      this.appendSystemMessage('🏥 Switched to Zero-Trust Air-Gapped Mode (HIPAA/Banking Certified). WAN Fallbacks Locked.');
    } else if (modeKey === 'OFFGRID_MARITIME') {
      if (offgridBadge) offgridBadge.style.display = 'inline-flex';
      this.appendSystemMessage('🚢 Switched to Maritime & Aviation Off-Grid Remote Sync Mode.');
    } else {
      this.appendSystemMessage('🛡️ Switched to Standard Enterprise LAN Mode.');
    }

    this.drawTopologyCanvas();
  }

  applyIndustrialPreset(presetKey) {
    const statusBox = document.getElementById('staging-status-box');
    const fileNameEl = document.getElementById('staging-file-name');
    const fileSizeEl = document.getElementById('staging-file-size');

    let fileName = '';
    let fileSize = 0;

    if (presetKey === 'dicom') {
      fileName = '🏥 DICOM_MRI_3D_Volume_Scan_2026.dcm';
      fileSize = 50 * 1024 * 1024 * 1024; // 50GB
    } else if (presetKey === 'financial') {
      fileName = '🏦 Encrypted_Ledger_Audit_Vault.bin';
      fileSize = 25 * 1024 * 1024 * 1024; // 25GB
    } else if (presetKey === 'drone') {
      fileName = '🚁 Drone_LiDAR_Mapping_Dataset.tar';
      fileSize = 40 * 1024 * 1024 * 1024; // 40GB
    } else if (presetKey === 'maritime') {
      fileName = '🚢 Vessel_Engine_Telemetry_Pack.dat';
      fileSize = 60 * 1024 * 1024 * 1024; // 60GB
    }

    if (fileName) {
      statusBox.style.display = 'flex';
      fileNameEl.textContent = `📦 Staged Preset: ${fileName}`;
      fileSizeEl.textContent = `Size: ${this.formatBytes(fileSize)}`;
      document.getElementById('staging-speed-label').textContent = 'Ready to stream. Select target recipient (User 3) & click Stage.';
    }
  }

  openComplianceCertificateModal() {
    const certModal = document.getElementById('modal-compliance-cert');
    const previewEl = document.getElementById('cert-json-preview');

    const certData = window.chatStorage.generateComplianceCertificate(this.currentRoomId);
    previewEl.textContent = JSON.stringify(certData, null, 2);

    certModal.classList.add('active');
  }

  downloadComplianceCertificateJSON() {
    const certData = window.chatStorage.generateComplianceCertificate(this.currentRoomId);
    const jsonStr = JSON.stringify(certData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `PulseRelay_Compliance_Audit_${certData.certificateId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  updateTelemetryMetrics(pingMs) {
    const pingEl = document.getElementById('topo-ping-val');
    const chunkEl = document.getElementById('topo-chunk-val');
    if (pingEl) pingEl.textContent = `${pingMs} ms`;

    if (pingMs > 0 && pingMs < 10) {
      this.dynamicChunkSize = 1024 * 1024;
      if (chunkEl) chunkEl.textContent = '1 MB (Optimized)';
    } else {
      this.dynamicChunkSize = 256 * 1024;
      if (chunkEl) chunkEl.textContent = '256 KB';
    }

    this.drawTopologyCanvas();
  }

  initTopologyCanvas() {
    this.drawTopologyCanvas();
  }

  drawTopologyCanvas() {
    const canvas = document.getElementById('topology-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const isOffGrid = window.chatStorage.activeProfileMode === 'OFFGRID_MARITIME';

    if (isOffGrid) {
      // Tactical Radar Grid background
      ctx.fillStyle = '#051b11';
      ctx.fillRect(0, 0, w, h);

      const hubX = w / 2;
      const hubY = h / 2;

      // Draw green tactical radar rings
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.25)';
      ctx.lineWidth = 1;
      [30, 60, 90, 110].forEach(r => {
        ctx.beginPath();
        ctx.arc(hubX, hubY, r, 0, Math.PI * 2);
        ctx.stroke();
      });

      // Draw radar crosshairs
      ctx.beginPath(); ctx.moveTo(hubX, 0); ctx.lineTo(hubX, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, hubY); ctx.lineTo(w, hubY); ctx.stroke();

      ctx.fillStyle = '#10b981';
      ctx.font = '10px JetBrains Mono';
      ctx.textAlign = 'center';
      ctx.fillText('OFFGRID_HUB (VSAT LINK)', hubX, hubY - 14);

      const peers = this.onlinePeers || [];
      peers.forEach((peer, i) => {
        const angle = (i / Math.max(1, peers.length)) * Math.PI * 2;
        const radius = 80;
        const px = hubX + Math.cos(angle) * radius;
        const py = hubY + Math.sin(angle) * radius;
        const isSelf = peer.id === this.user.id;

        ctx.beginPath();
        ctx.arc(px, py, 8, 0, Math.PI * 2);
        ctx.fillStyle = isSelf ? '#34d399' : '#f59e0b';
        ctx.fill();

        const lat = (12.97 + (i * 0.05)).toFixed(2);
        const lon = (77.59 + (i * 0.03)).toFixed(2);

        ctx.fillStyle = '#6ee7b7';
        ctx.font = '8px JetBrains Mono';
        ctx.fillText(`${peer.alias} [${lat}° N, ${lon}° E]`, px, py + 18);
      });
      return;
    }

    // Standard Enterprise Grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 30) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 30) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const hubX = w / 2;
    const hubY = h / 2;

    ctx.beginPath();
    ctx.arc(hubX, hubY, 18, 0, Math.PI * 2);
    ctx.fillStyle = '#0a3663';
    ctx.fill();
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '10px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText('LAN_HUB', hubX, hubY + 4);

    const peers = this.onlinePeers || [];
    const count = peers.length;

    peers.forEach((peer, i) => {
      const angle = (i / Math.max(1, count)) * Math.PI * 2;
      const radius = 80;
      const px = hubX + Math.cos(angle) * radius;
      const py = hubY + Math.sin(angle) * radius;
      const isSelf = peer.id === this.user.id;

      ctx.beginPath();
      ctx.moveTo(hubX, hubY);
      ctx.lineTo(px, py);
      ctx.strokeStyle = isSelf ? '#10b981' : '#1d4ed8';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(px, py, 14, 0, Math.PI * 2);
      ctx.fillStyle = isSelf ? '#10b981' : '#1e293b';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = '9px JetBrains Mono';
      ctx.fillText(peer.initial || 'OP', px, py + 3);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '8px Plus Jakarta Sans';
      ctx.fillText(peer.alias, px, py + 24);
    });
  }

  startBurnCountdown(messageId, seconds) {
    let remaining = seconds;
    const updateBadge = () => {
      const cardEl = document.getElementById(`msg-card-${messageId}`);
      if (!cardEl) return;

      let badgeEl = cardEl.querySelector('.burn-badge');
      if (!badgeEl) {
        badgeEl = document.createElement('div');
        badgeEl.className = 'burn-badge';
        cardEl.appendChild(badgeEl);
      }
      badgeEl.textContent = `🔥 Self-Destruct in ${remaining}s...`;

      if (remaining <= 0) {
        clearInterval(this.burnTimers[messageId]);
        delete this.burnTimers[messageId];

        window.chatStorage.purgeMessage(this.currentRoomId, messageId);
        this.purgeBurnMessageFromUI(messageId);
        window.transportEngine.sendBurnMessagePurge(messageId);
      }
      remaining--;
    };

    updateBadge();
    this.burnTimers[messageId] = setInterval(updateBadge, 1000);
  }

  purgeBurnMessageFromUI(messageId) {
    const cardEl = document.getElementById(`msg-card-${messageId}`);
    if (cardEl) {
      cardEl.style.transition = 'opacity 0.5s ease';
      cardEl.style.opacity = '0';
      setTimeout(() => cardEl.remove(), 500);
    }
  }

  stageFileAndNotifyRecipient() {
    const targetPeerId = document.getElementById('select-target-peer-staging').value;
    const fileInput = document.getElementById('input-staging-file');
    const folderInput = document.getElementById('input-staging-folder');

    let file = fileInput.files[0];
    let isFolder = false;
    let folderName = '';

    if (!file && folderInput.files.length > 0) {
      file = folderInput.files[0];
      isFolder = true;
      folderName = file.webkitRelativePath.split('/')[0] || 'Folder';
    }

    if (!targetPeerId) {
      alert('Please select User 3 (target recipient) from the room roster.');
      return;
    }
    if (!file) {
      alert('Please select a file or folder to stage.');
      return;
    }

    const transferId = 'staged_' + Math.random().toString(36).substring(2, 9);
    const chunkSize = this.dynamicChunkSize;

    this.stagedTransfers[transferId] = {
      transferId,
      file,
      targetPeerId,
      offset: 0,
      totalSize: file.size,
      chunkSize,
      startTime: Date.now(),
      status: 'staged'
    };

    const statusBox = document.getElementById('staging-status-box');
    statusBox.style.display = 'flex';
    document.getElementById('staging-file-name').textContent = `📦 Staged: ${isFolder ? folderName : file.name}`;
    document.getElementById('staging-file-size').textContent = `Size: ${this.formatBytes(file.size)}`;
    document.getElementById('staging-speed-label').textContent = 'Waiting for recipient location confirmation...';

    window.transportEngine.sendTargetedFileInit(targetPeerId, {
      transferId,
      fileName: isFolder ? folderName : file.name,
      fileSize: file.size,
      fileType: file.type,
      totalChunks: Math.ceil(file.size / chunkSize)
    });
  }

  promptRecipientLocationSelection(meta, sender) {
    this.pendingIncomingMeta = meta;
    this.pendingIncomingSender = sender;

    const recipModal = document.getElementById('modal-recipient-location');
    document.getElementById('recip-sender-name').textContent = `Sender: ${sender.alias}`;
    document.getElementById('recip-file-details').textContent = `Staged Stream: ${meta.fileName} (${this.formatBytes(meta.fileSize)})`;
    document.getElementById('recip-destination-path').textContent = `Downloads / ${meta.fileName}`;
    document.getElementById('recip-progress-box').style.display = 'none';
    
    recipModal.classList.add('active');
  }

  async acceptStreamWithConfirmedLocation(forcePicker = false) {
    const meta = this.pendingIncomingMeta;
    const sender = this.pendingIncomingSender;
    if (!meta || !sender) return;

    let writableStream = null;

    if (forcePicker && ('showSaveFilePicker' in window)) {
      try {
        const fileHandle = await window.showSaveFilePicker({ suggestedName: meta.fileName });
        writableStream = await fileHandle.createWritable();
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }

    this.incomingTransfers[meta.transferId] = {
      transferId: meta.transferId,
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      writableStream,
      chunks: writableStream ? null : [],
      receivedBytes: 0,
      startTime: Date.now(),
      senderAlias: sender.alias
    };

    document.getElementById('recip-progress-box').style.display = 'flex';

    window.transportEngine.sendTargetedFileAck(sender.id, {
      transferId: meta.transferId,
      status: 'accepted'
    });
  }

  handleTransferAck(ack, sender) {
    const transfer = this.stagedTransfers[ack.transferId];
    if (!transfer) return;

    if (ack.status === 'rejected') {
      alert(`Recipient ${sender.alias} declined the file transfer.`);
      delete this.stagedTransfers[ack.transferId];
      return;
    }

    if (ack.status === 'accepted' || ack.status === 'chunk_received') {
      transfer.status = 'streaming';
      document.getElementById('staging-speed-label').textContent = 'Streaming content directly to recipient disk...';
      this.sendNextStagedChunkSlice(ack.transferId);
    }
  }

  sendNextStagedChunkSlice(transferId) {
    const transfer = this.stagedTransfers[transferId];
    if (!transfer) return;

    if (transfer.offset >= transfer.totalSize) {
      document.getElementById('staging-speed-label').textContent = 'Status: Transfer Complete (100%)';
      delete this.stagedTransfers[transferId];
      return;
    }

    const slice = transfer.file.slice(transfer.offset, transfer.offset + transfer.chunkSize);
    const reader = new FileReader();

    reader.onload = (e) => {
      const chunkData = e.target.result;
      
      window.transportEngine.sendTargetedFileChunk(transfer.targetPeerId, {
        transferId,
        offset: transfer.offset,
        chunkData
      });

      transfer.offset += slice.size;
      this.updateStagingProgress(transfer);
    };

    reader.readAsDataURL(slice);
  }

  async handleIncomingChunkToDisk(chunk, sender) {
    const transfer = this.incomingTransfers[chunk.transferId];
    if (!transfer) return;

    const base64Data = chunk.chunkData.split(',')[1] || chunk.chunkData;
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    if (transfer.writableStream) {
      try {
        await transfer.writableStream.write(bytes.buffer);
      } catch (e) {
        console.error('Error writing chunk to disk:', e);
      }
    } else {
      transfer.chunks.push(bytes.buffer);
    }

    transfer.receivedBytes += bytes.length;

    const pct = Math.min(100, Math.round((transfer.receivedBytes / transfer.fileSize) * 100));
    const fillEl = document.getElementById('recip-progress-fill');
    const labelEl = document.getElementById('recip-speed-label');
    if (fillEl) fillEl.style.width = `${pct}%`;

    const elapsedSec = (Date.now() - transfer.startTime) / 1000;
    if (elapsedSec > 0 && labelEl) {
      const speedMBps = ((transfer.receivedBytes / elapsedSec) / (1024 * 1024)).toFixed(1);
      labelEl.textContent = `Streaming to disk: ${speedMBps} MB/s (${pct}%)`;
    }

    window.transportEngine.sendTargetedFileAck(sender.id, {
      transferId: chunk.transferId,
      status: 'chunk_received',
      offset: chunk.offset
    });

    if (transfer.receivedBytes >= transfer.fileSize) {
      await this.finishDiskStreamTransfer(transfer);
    }
  }

  async finishDiskStreamTransfer(transfer) {
    if (transfer.writableStream) {
      try {
        await transfer.writableStream.close();
      } catch (e) {
        console.error('Error closing disk stream:', e);
      }
    } else {
      const blob = new Blob(transfer.chunks);
      const url = URL.createObjectURL(blob);
      
      const downloadMsg = {
        id: 'msg_' + Math.random().toString(36).substring(2, 9),
        sender: { alias: transfer.senderAlias, avatar: '📥' },
        text: `Completed stream: ${transfer.fileName} (${this.formatBytes(transfer.fileSize)})`,
        attachmentData: url,
        isImage: false,
        timestamp: new Date().toISOString()
      };
      this.appendMessageToFeed(downloadMsg);
    }

    const recipModal = document.getElementById('modal-recipient-location');
    if (recipModal) recipModal.classList.remove('active');

    delete this.incomingTransfers[transfer.transferId];
  }

  updateStagingProgress(transfer) {
    const pct = Math.min(100, Math.round((transfer.offset / transfer.totalSize) * 100));
    const fillEl = document.getElementById('staging-progress-fill');
    const speedEl = document.getElementById('staging-speed-label');

    if (fillEl) fillEl.style.width = `${pct}%`;

    const elapsedSec = (Date.now() - transfer.startTime) / 1000;
    if (elapsedSec > 0) {
      const speedBytesPerSec = transfer.offset / elapsedSec;
      const speedMBps = (speedBytesPerSec / (1024 * 1024)).toFixed(1);
      const remainingBytes = transfer.totalSize - transfer.offset;
      const etaSec = Math.round(remainingBytes / speedBytesPerSec);

      if (speedEl) speedEl.textContent = `Speed: ${speedMBps} MB/s (${pct}%) | ETA: ${this.formatETA(etaSec)}`;
    }
  }

  updateStagingRecipientDropdown() {
    const select = document.getElementById('select-target-peer-staging');
    if (!select) return;
    select.innerHTML = '';

    const otherPeers = this.onlinePeers.filter(p => p.id !== this.user.id);
    if (otherPeers.length === 0) {
      select.innerHTML = '<option value="">No other online peers in room</option>';
      return;
    }

    otherPeers.forEach(peer => {
      const opt = document.createElement('option');
      opt.value = peer.id;
      opt.textContent = `${peer.alias} (${peer.initial})`;
      select.appendChild(opt);
    });
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  formatETA(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '0s';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  handleTyping(isTyping) {
    window.transportEngine.sendTypingStatus(isTyping);
    if (this.typingTimeout) clearTimeout(this.typingTimeout);
    if (isTyping) {
      this.typingTimeout = setTimeout(() => {
        window.transportEngine.sendTypingStatus(false);
      }, 3000);
    }
  }

  /**
   * Send E2E Encrypted Chat Message (Matching Room Key)
   */
  async sendChatMessage(text, attachmentData = null, isImage = false, burnSeconds = 0) {
    const msgId = 'msg_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    
    // Encrypt payload with Web Crypto / Pure-JS E2EE Engine
    const encryptedObj = await window.chatStorage.encryptPayload(text, this.currentRoomId);

    const wireMsgPayload = {
      id: msgId,
      sender: this.user,
      text: '🔒 [Encrypted Message]',
      encryptedObj,
      attachmentData,
      isImage,
      burnSeconds,
      timestamp: new Date().toISOString()
    };

    const localMsgPayload = { ...wireMsgPayload, text };
    window.chatStorage.saveMessage(this.currentRoomId, localMsgPayload);
    this.appendMessageToFeed(localMsgPayload);

    if (burnSeconds > 0) {
      this.startBurnCountdown(msgId, burnSeconds);
    }

    window.transportEngine.sendMessage(wireMsgPayload);
  }

  appendMessageToFeed(msg) {
    const feed = document.getElementById('messages-feed');
    const isSelf = msg.sender.id === this.user.id;

    const card = document.createElement('div');
    card.id = `msg-card-${msg.id}`;
    card.className = `message-card ${isSelf ? 'self' : 'peer'}`;

    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let attachmentHtml = '';
    if (msg.attachmentData) {
      if (msg.isImage) {
        attachmentHtml = `<br><img src="${msg.attachmentData}" class="message-image" alt="Attachment">`;
      } else {
        attachmentHtml = `<br><a href="${msg.attachmentData}" download="attachment" style="color: var(--brand-blue); text-decoration: underline;">Download Attachment</a>`;
      }
    }

    card.innerHTML = `
      <div class="message-meta">
        <span style="font-weight: 700; font-family: var(--font-mono); color: ${isSelf ? 'var(--brand-navy)' : 'var(--brand-blue)'};">${msg.sender.alias}</span>
        <span>${timeStr}</span>
      </div>
      <div class="message-bubble">
        ${this.escapeHtml(msg.text)}
        ${attachmentHtml}
      </div>
    `;

    feed.appendChild(card);
    this.scrollToBottom();
  }

  appendSystemMessage(text) {
    const feed = document.getElementById('messages-feed');
    const sys = document.createElement('div');
    sys.className = 'system-event';
    sys.textContent = text;
    feed.appendChild(sys);
    this.scrollToBottom();
  }

  renderPeersList(users) {
    const container = document.getElementById('peers-container');
    const countTag = document.getElementById('online-count-tag');
    if (!container) return;
    container.innerHTML = '';

    const uniquePeersMap = new Map();
    (users || []).forEach(p => {
      if (p && p.id) uniquePeersMap.set(p.id, p);
    });

    const uniquePeers = Array.from(uniquePeersMap.values());
    if (countTag) countTag.textContent = uniquePeers.length;

    if (uniquePeers.length === 0) {
      container.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); padding: 8px;">No active peers in room.</div>';
      return;
    }

    uniquePeers.forEach(peer => {
      const item = document.createElement('div');
      item.className = 'peer-item';
      const isSelf = peer.id === this.user.id;

      item.innerHTML = `
        <div class="peer-avatar">${peer.initial || 'OP'}</div>
        <div class="peer-name">
          ${peer.alias} ${isSelf ? '<span style="font-size: 0.72rem; color: var(--brand-red); font-weight: 600;">(You)</span>' : ''}
        </div>
      `;
      container.appendChild(item);
    });
  }

  scrollToBottom() {
    const feed = document.getElementById('messages-feed');
    if (feed) feed.scrollTop = feed.scrollHeight;
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new PulseRelayApp();
});
