/**
 * Slipstream Application Controller
 * Handles UI screen states, user events, Phase 1 direct peer verification,
 * Phase 2 File Transfer lifecycle, incoming preview, and visual trail transitions (§8, §9).
 */

document.addEventListener('DOMContentLoaded', () => {
  // Application State
  const state = {
    role: null, // 'host' | 'joiner'
    code: null,
    peer: null,
    qrInstance: null,
    selectedFile: null,

    // Phase 2 Protocol & Transfer Engine State (§5, §7.4)
    sender: null,            // SlipstreamFileSender instance
    receiver: null,          // SlipstreamFileReceiver instance
    transferState: 'idle',   // 'idle' | 'hashing' | 'offering' | 'awaiting-decision' | 'transferring' | 'verifying' | 'completed' | 'rejected' | 'cancelled' | 'failed'
    pendingOffer: null,      // Stored offer metadata on receiver
    downloadUrl: null,       // Blob URL for verified download
    downloadBlob: null,      // Assembled and verified Blob
    stats: {
      bytesTransferred: 0,
      totalBytes: 0,
      startTime: 0,
      lastProgressTime: 0,
      lastBytes: 0,
      speedBps: 0,
    },
  };

  // DOM Elements - Screens
  const screens = {
    home: document.getElementById('screen-home'),
    pairing: document.getElementById('screen-pairing'),
    join: document.getElementById('screen-join'),
    connected: document.getElementById('screen-connected'),
    transfer: document.getElementById('screen-transfer'),
  };

  // Navigation & Brand
  const btnStartSend = document.getElementById('btn-start-send');
  const btnStartReceive = document.getElementById('btn-start-receive');
  const btnCancelHost = document.getElementById('btn-cancel-host');
  const btnCancelJoin = document.getElementById('btn-cancel-join');
  const btnDisconnect = document.getElementById('btn-disconnect');
  const brandLink = document.getElementById('brand-link');

  // Header Elements
  const headerStatus = document.getElementById('header-status');
  const headerStatusText = document.getElementById('header-status-text');

  // Host Elements
  const hostCodeText = document.getElementById('host-code-text');
  const hostStatusMsg = document.getElementById('host-status-msg');
  const qrDisplay = document.getElementById('qr-display');

  // Join Elements
  const joinForm = document.getElementById('join-form');
  const joinCodeInput = document.getElementById('join-code-input');
  const joinErrorMsg = document.getElementById('join-error-msg');
  const btnSubmitJoin = document.getElementById('btn-submit-join');
  const btnScanQr = document.getElementById('btn-scan-qr');

  // Connected & Test Elements
  const senderFileSection = document.getElementById('sender-file-section');
  const receiverFileSection = document.getElementById('receiver-file-section');
  const receiverWaitingBox = document.getElementById('receiver-waiting-box');
  const receiverStatusMsg = document.getElementById('receiver-status-msg');
  const testChatLog = document.getElementById('test-chat-log');
  const testMessageInput = document.getElementById('test-message-input');
  const btnSendTestMsg = document.getElementById('btn-send-test-msg');
  const localDeviceLabel = document.getElementById('local-device-label');
  const peerDeviceLabel = document.getElementById('peer-device-label');
  const connectedDeviceItems = document.querySelectorAll('.device-item');

  // Sender File Dropzone & Preview Elements
  const fileDropzone = document.getElementById('file-dropzone');
  const fileInput = document.getElementById('file-input');
  const filePreview = document.getElementById('file-preview');
  const previewFilename = document.getElementById('preview-filename');
  const previewFilesize = document.getElementById('preview-filesize');
  const btnRemoveFile = document.getElementById('btn-remove-file');
  const fileActions = document.getElementById('file-actions');
  const btnSendFile = document.getElementById('btn-send-file');
  const btnChangeFile = document.getElementById('btn-change-file');

  // Receiver Incoming File Preview Elements (§7.5, Requirement 2)
  const incomingSection = document.getElementById('incoming-file-section');
  const incomingFilename = document.getElementById('incoming-filename');
  const incomingFilesize = document.getElementById('incoming-filesize');
  const incomingFilemeta = document.getElementById('incoming-filemeta');
  const btnAcceptTransfer = document.getElementById('btn-accept-transfer');
  const btnDeclineTransfer = document.getElementById('btn-decline-transfer');

  // Transfer Screen Elements (§8, §9, Requirements 4 & 5)
  const transferStatePill = document.getElementById('transfer-state-pill');
  const transferStateText = document.getElementById('transfer-state-text');
  const transferHeading = document.getElementById('transfer-heading');
  const transferSubtext = document.getElementById('transfer-subtext');
  const transferFileBadge = document.getElementById('transfer-file-badge');
  const transferFilename = document.getElementById('transfer-filename');
  const transferFilesize = document.getElementById('transfer-filesize');
  const transferSpeedEta = document.getElementById('transfer-speed-eta');
  const successCheckmarkBox = document.getElementById('success-checkmark-box');
  const errorCrossBox = document.getElementById('error-cross-box');
  const transferTrailFill = document.getElementById('transfer-trail-fill');
  const transferPercentageText = document.getElementById('transfer-percentage-text');
  const transferNodeSender = document.getElementById('transfer-node-sender');
  const transferNodeReceiver = document.getElementById('transfer-node-receiver');
  const transferLabelSender = document.getElementById('transfer-label-sender');
  const transferLabelReceiver = document.getElementById('transfer-label-receiver');

  // Transfer Controls (§8)
  const transferControls = document.getElementById('transfer-controls');
  const btnCancelTransfer = document.getElementById('btn-cancel-transfer');
  const btnSendAnother = document.getElementById('btn-send-another');
  const btnRetryTransfer = document.getElementById('btn-retry-transfer');
  const btnReturnHome = document.getElementById('btn-return-home');

  // Modal Handlers
  const modalButtons = document.querySelectorAll('[data-modal]');
  const modalCloseButtons = document.querySelectorAll('[data-close-modal]');
  const modalOverlays = document.querySelectorAll('.modal-overlay');

  /**
   * Screen Management
   */
  function showScreen(screenName) {
    Object.values(screens).forEach((el) => {
      if (el) el.classList.remove('active');
    });
    if (screens[screenName]) {
      screens[screenName].classList.add('active');
    }
  }

  function setHeaderConnected(isConnected) {
    if (!headerStatus) return;
    if (isConnected) {
      headerStatus.classList.add('connected');
      if (headerStatusText) headerStatusText.textContent = 'Connected';
    } else {
      headerStatus.classList.remove('connected');
      if (headerStatusText) headerStatusText.textContent = 'Local Network';
    }
  }

  function appendChatLog(prefix, message) {
    if (!testChatLog) return;

    // Clear initial placeholder if this is the first message
    if (testChatLog.children.length === 0 && testChatLog.textContent.trim() === 'Data channel ready.') {
      testChatLog.textContent = '';
    }

    // Sanitize message: strip any accidental or accumulated prefixes from prior entries
    const rawMsg = typeof message === 'string' ? message : String(message || '');
    const cleanMessage = rawMsg.replace(/^(?:(?:You|Peer|System):\s*)+/i, '').trim();

    // Create a brand-new, isolated DOM element for this single entry with no carryover
    const line = document.createElement('div');
    line.className = 'chat-log-entry';
    line.textContent = `${prefix}: ${cleanMessage}`;

    testChatLog.appendChild(line);
    testChatLog.scrollTop = testChatLog.scrollHeight;
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Reset application state and clean up resources (§8)
   */
  let pairingAttempt = 0;
  function resetApp() {
    pairingAttempt++;
    btnSubmitJoin.disabled = false;
    btnSubmitJoin.textContent = 'Connect to device';
    setHeaderConnected(false);

    // Clean up Phase 2 transfer engines & object URLs (§8)
    if (state.sender) {
      try { state.sender.destroy(); } catch {}
      state.sender = null;
    }
    if (state.receiver) {
      try { state.receiver.destroy(); } catch {}
      state.receiver = null;
    }
    if (state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
      state.downloadUrl = null;
    }
    state.downloadBlob = null;
    state.pendingOffer = null;
    state.transferState = 'idle';
    state.stats = {
      bytesTransferred: 0,
      totalBytes: 0,
      startTime: 0,
      lastProgressTime: 0,
      lastBytes: 0,
      speedBps: 0,
    };

    // Remove any dynamic download button
    const oldDlBtn = document.getElementById('btn-download-file');
    if (oldDlBtn) oldDlBtn.remove();

    // Reset receiver sections
    if (receiverFileSection) receiverFileSection.style.display = 'none';
    if (incomingSection) incomingSection.style.display = 'none';
    if (receiverWaitingBox) receiverWaitingBox.style.display = 'flex';
    if (receiverStatusMsg) receiverStatusMsg.textContent = 'Waiting for sender to select a file...';

    // Hide incoming offer fallback if present
    const fallback = document.getElementById('incoming-offer-fallback');
    if (fallback) fallback.style.display = 'none';

    if (state.peer) {
      state.peer.close();
      state.peer = null;
    }

    if (state.code) {
      void Api.deleteSession(state.code);
      state.code = null;
    }

    state.role = null;
    state.selectedFile = null;

    if (qrDisplay) {
      const scanLine = qrDisplay.querySelector('.qr-scan-line');
      qrDisplay.innerHTML = '';
      if (scanLine) qrDisplay.appendChild(scanLine);
    }

    if (joinCodeInput) joinCodeInput.value = '';
    if (joinErrorMsg) joinErrorMsg.style.display = 'none';
    if (testChatLog) testChatLog.innerHTML = 'Data channel ready.';

    // Reset sender file preview
    if (fileInput) fileInput.value = '';
    if (filePreview) filePreview.style.display = 'none';
    if (fileActions) fileActions.style.display = 'none';
    if (fileDropzone) fileDropzone.style.display = 'block';

    // Reset active file badge
    updateActiveFileBadge(null);

    // Reset trail state & UI
    setTrailProgress(0, 'active');
    updateTransferUIState('idle');

    connectedDeviceItems.forEach((el) => el.classList.remove('device-connected'));

    showScreen('home');
  }

  /**
   * Set trail progress & state (Requirements A, H, I)
   */
  function setTrailProgress(percent, status = 'active') {
    if (!transferTrailFill || !transferPercentageText) return;

    const clamped = Math.max(0, Math.min(100, Math.floor(percent)));
    transferTrailFill.style.setProperty('--trail-progress', `${clamped}%`);
    transferPercentageText.textContent = `${clamped}%`;

    transferTrailFill.classList.remove('success', 'broken');

    if (status === 'success') {
      transferTrailFill.classList.add('success');
      if (successCheckmarkBox) successCheckmarkBox.style.display = 'flex';
      if (transferHeading) transferHeading.textContent = 'Transfer complete';
      if (transferSubtext) transferSubtext.textContent = 'Verified byte-for-byte with SHA-256 integrity.';
    } else if (status === 'broken') {
      transferTrailFill.classList.add('broken');
    }
  }

  /**
   * Update active file badge summary card on transfer screen
   */
  function updateActiveFileBadge(file) {
    if (!transferFileBadge) return;
    if (!file) {
      transferFileBadge.style.display = 'none';
      return;
    }
    if (transferFilename) transferFilename.textContent = file.name || 'file';
    if (transferFilesize) transferFilesize.textContent = formatFileSize(file.size || 0);
    if (transferSpeedEta) transferSpeedEta.textContent = '';
    transferFileBadge.style.display = 'inline-flex';
  }

  /**
   * Comprehensive Transfer UI State Machine (§5, §7.5, §8)
   */
  function updateTransferUIState(stateName, details = {}) {
    state.transferState = stateName;
    console.log(`[Phase 2 UI State] ${stateName}`, details);

    // Reset modifier classes on pill, trail, and device glyphs
    if (transferStatePill) {
      transferStatePill.className = 'transfer-state-pill ' + stateName;
    }
    if (transferTrailFill) {
      transferTrailFill.classList.remove('success', 'broken', 'rejected', 'cancelled');
    }
    if (transferNodeSender) {
      transferNodeSender.classList.remove('active', 'receiving', 'success', 'broken');
    }
    if (transferNodeReceiver) {
      transferNodeReceiver.classList.remove('active', 'receiving', 'success', 'broken');
    }

    // Default icon boxes hidden
    if (successCheckmarkBox) successCheckmarkBox.style.display = 'none';
    if (errorCrossBox) errorCrossBox.style.display = 'none';

    // Default controls
    if (btnCancelTransfer) btnCancelTransfer.style.display = 'inline-flex';
    if (btnSendAnother) btnSendAnother.style.display = 'none';
    if (btnRetryTransfer) btnRetryTransfer.style.display = 'none';
    if (btnReturnHome) btnReturnHome.style.display = 'none';

    // Remove any previous dynamic download button if not completed
    const oldDlBtn = document.getElementById('btn-download-file');
    if (oldDlBtn && stateName !== 'completed') {
      oldDlBtn.remove();
    }

    switch (stateName) {
      case 'idle':
        if (transferStateText) transferStateText.textContent = 'Ready';
        if (transferNodeSender) transferNodeSender.classList.add('active');
        setTrailProgress(0, 'active');
        break;

      case 'hashing':
        if (transferStateText) transferStateText.textContent = 'Preparing';
        if (transferHeading) transferHeading.textContent = 'Preparing file...';
        if (transferSubtext) transferSubtext.textContent = `Computing SHA-256 for ${details.name || state.selectedFile?.name || 'selected file'}...`;
        if (transferNodeSender) transferNodeSender.classList.add('active');
        setTrailProgress(0, 'active');
        break;

      case 'offering':
      case 'awaiting-acceptance':
        if (transferStateText) transferStateText.textContent = 'Awaiting peer';
        if (transferHeading) transferHeading.textContent = 'Awaiting acceptance...';
        if (transferSubtext) transferSubtext.textContent = 'Waiting for peer device to accept transfer.';
        if (transferNodeSender) transferNodeSender.classList.add('active');
        setTrailProgress(0, 'active');
        break;

      case 'ready':
        if (transferStateText) transferStateText.textContent = 'Accepted';
        setTrailProgress(0, 'active');
        break;
      case 'transferring':
      case 'sending':
      case 'receiving':
        if (transferStateText) transferStateText.textContent = 'Transferring';
        if (transferHeading) {
          transferHeading.textContent = state.role === 'host' ? 'Sending file...' : 'Receiving file...';
        }
        if (transferNodeSender) transferNodeSender.classList.add('active');
        if (transferNodeReceiver) transferNodeReceiver.classList.add('receiving');
        break;

      case 'awaiting-verification':
        if (transferStateText) transferStateText.textContent = 'Awaiting verification';
        if (transferHeading) transferHeading.textContent = 'Waiting for receiver verification…';
        if (transferSubtext) transferSubtext.textContent = 'All chunks have been queued.';
        break;
      case 'verifying':
        if (transferStateText) transferStateText.textContent = 'Verifying';
        if (transferHeading) transferHeading.textContent = 'Verifying integrity...';
        if (transferSubtext) transferSubtext.textContent = 'Calculating and validating SHA-256 digest...';
        if (transferNodeSender) transferNodeSender.classList.add('active');
        if (transferNodeReceiver) transferNodeReceiver.classList.add('active');
        // Verification keeps the last receiver-confirmed progress.
        break;

      case 'completed':
        if (transferStateText) transferStateText.textContent = 'Complete';
        if (transferHeading) transferHeading.textContent = 'Transfer complete';
        const hashShort = details && details.sha256 ? details.sha256.substring(0, 16) + '...' : '';
        if (transferSubtext) {
          transferSubtext.textContent = hashShort
            ? `Verified byte-for-byte with SHA-256 integrity (${hashShort}).`
            : 'Verified byte-for-byte with SHA-256 integrity.';
        }
        if (successCheckmarkBox) successCheckmarkBox.style.display = 'flex';
        if (transferNodeSender) transferNodeSender.classList.add('success');
        if (transferNodeReceiver) transferNodeReceiver.classList.add('success');
        setTrailProgress(100, 'success');

        // Hide cancel, show completion actions
        if (btnCancelTransfer) btnCancelTransfer.style.display = 'none';

        if (state.role === 'joiner') {
          // Joiner / Receiver: Download button + Return home
          if (details && details.blob) {
            setupDownloadButton(details.blob, details.name || 'downloaded-file');
          }
          if (btnReturnHome) btnReturnHome.style.display = 'inline-flex';
        } else {
          // Host / Sender: Send another + Return home
          if (btnSendAnother) btnSendAnother.style.display = 'inline-flex';
          if (btnReturnHome) btnReturnHome.style.display = 'inline-flex';
        }
        break;

      case 'rejected':
        if (transferStateText) transferStateText.textContent = 'Declined';
        if (transferHeading) transferHeading.textContent = 'Offer declined';
        if (transferSubtext) {
          transferSubtext.textContent = state.role === 'host'
            ? 'The receiver declined the file offer.'
            : 'You declined the incoming file offer.';
        }
        if (transferTrailFill) transferTrailFill.classList.add('rejected');
        setTrailProgress(0, 'active');

        // Controls
        if (btnCancelTransfer) btnCancelTransfer.style.display = 'none';
        if (btnRetryTransfer) {
          btnRetryTransfer.textContent = state.role === 'host' ? 'Choose another file' : 'Back to connection';
          btnRetryTransfer.style.display = 'inline-flex';
        }
        if (btnReturnHome) btnReturnHome.style.display = 'inline-flex';
        break;

      case 'cancelled':
        if (transferStateText) transferStateText.textContent = 'Cancelled';
        if (transferHeading) transferHeading.textContent = 'Transfer cancelled';
        if (transferSubtext) {
          transferSubtext.textContent = details.message || 'Transfer was cancelled. Incomplete data was discarded.';
        }
        if (transferTrailFill) transferTrailFill.classList.add('cancelled');
        setTrailProgress(0, 'active');

        // Controls
        if (btnCancelTransfer) btnCancelTransfer.style.display = 'none';
        if (btnRetryTransfer) {
          btnRetryTransfer.textContent = 'Try again';
          btnRetryTransfer.style.display = 'inline-flex';
        }
        if (btnReturnHome) btnReturnHome.style.display = 'inline-flex';
        break;

      case 'failed':
        if (transferStateText) transferStateText.textContent = 'Failed';
        if (transferHeading) transferHeading.textContent = 'Transfer interrupted';
        if (transferSubtext) {
          transferSubtext.textContent = (details && details.message)
            ? details.message
            : 'Transfer failed. No incomplete file was stored.';
        }
        if (errorCrossBox) errorCrossBox.style.display = 'flex';
        if (transferNodeSender) transferNodeSender.classList.add('broken');
        if (transferNodeReceiver) transferNodeReceiver.classList.add('broken');

        const p = state.stats.totalBytes > 0 ? (state.stats.bytesTransferred / state.stats.totalBytes) * 100 : 0;
        setTrailProgress(p, 'broken');

        // Controls
        if (btnCancelTransfer) btnCancelTransfer.style.display = 'none';
        if (btnRetryTransfer) {
          btnRetryTransfer.textContent = 'Try again';
          btnRetryTransfer.style.display = 'inline-flex';
        }
        if (btnReturnHome) btnReturnHome.style.display = 'inline-flex';
        break;
    }
  }

  /**
   * Set up verified download action button on receiver (§7.4)
   */
  function setupDownloadButton(blob, filename) {
    if (state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
      state.downloadUrl = null;
    }
    state.downloadBlob = blob;
    state.downloadUrl = URL.createObjectURL(blob);

    const oldBtn = document.getElementById('btn-download-file');
    if (oldBtn) oldBtn.remove();

    const dlBtn = document.createElement('a');
    dlBtn.id = 'btn-download-file';
    dlBtn.className = 'btn btn-primary';
    dlBtn.href = state.downloadUrl;
    dlBtn.download = filename;
    dlBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      Download
    `;
    dlBtn.append(document.createTextNode(' ' + filename));
    dlBtn.style.textDecoration = 'none';
    dlBtn.style.display = 'inline-flex';
    dlBtn.style.alignItems = 'center';
    dlBtn.style.justifyContent = 'center';

    if (transferControls) {
      transferControls.insertBefore(dlBtn, transferControls.firstChild);
    }
  }

  /**
   * Host Flow (Send a file)
   */
  async function startHostFlow() {
    const attempt = ++pairingAttempt;
    try {
      showScreen('pairing');
      hostStatusMsg.textContent = 'Generating temporary session...';
      hostCodeText.textContent = '------';

      const session = await Api.createSession();
      if (attempt !== pairingAttempt) return Api.deleteSession(session.code);
      state.role = 'host';
      state.code = session.code;

      hostCodeText.textContent = session.code;
      hostStatusMsg.textContent = 'Waiting for peer device to connect...';

      // Generate join link for QR code
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('join', session.code);
      const joinUrl = currentUrl.toString();

      // Responsive QR dimension for narrow mobile viewports
      const qrContainerWidth = qrDisplay.clientWidth || 200;
      const qrSize = Math.max(160, Math.min(200, qrContainerWidth > 40 ? qrContainerWidth - 28 : 180));

      // Render high-contrast black-on-white QR code locally (§9)
      const scanLine = qrDisplay.querySelector('.qr-scan-line');
      qrDisplay.innerHTML = '';
      if (window.QRCode) {
        new QRCode(qrDisplay, {
          text: joinUrl,
          width: qrSize,
          height: qrSize,
          colorDark: '#000000',
          colorLight: '#FFFFFF',
          correctLevel: QRCode.CorrectLevel.M,
        });
      }
      if (scanLine) qrDisplay.appendChild(scanLine);

      // Initialize WebRTC Peer Connection
      state.peer = new SlipstreamPeer({
        role: 'host',
        code: state.code,
        onStatusChange: (status) => {
          hostStatusMsg.textContent = status;
        },
        onChannelOpen: () => {
          setHeaderConnected(true);
          localDeviceLabel.textContent = 'Host (Sender)';
          peerDeviceLabel.textContent = 'Receiver';
          if (senderFileSection) senderFileSection.style.display = 'block';
          if (receiverFileSection) receiverFileSection.style.display = 'none';

          // Trigger subtle device glyph lift and settle (Requirement B)
          connectedDeviceItems.forEach((el) => {
            el.classList.add('device-connected');
          });

          // Initialize Phase 2 sender engine on host (§7.4)
          initializeTransferEngines();

          showScreen('connected');
          appendChatLog('System', 'Direct WebRTC data channel connected!');
        },
        onControlMessage: (message) => {
          handleIncomingControlMessage(message);
        },
        onBinaryMessage: (buffer) => {
          handleIncomingBinaryMessage(buffer);
        },
        onChannelMessage: (data) => {
          handleIncomingChannelMessage(data);
        },
        onChannelClose: () => {
          handleChannelClose();
        },
        onError: (err) => {
          console.error('Host connection error:', err);
          hostStatusMsg.textContent = `Error: ${err.message}`;
          if (state.sender || state.receiver) handleChannelClose();
          else handleTransferError(err);
        },
      });

      await state.peer.start();
    } catch (err) {
      console.error('Failed to create host session:', err);
      if (attempt !== pairingAttempt) return;
      alert(`Could not start session: ${err.message}`);
      resetApp();
    }
  }

  /**
   * Joiner Flow (Receive a file)
   */
  function startJoinFlow() {
    state.role = 'joiner';
    showScreen('join');
    joinErrorMsg.style.display = 'none';
    joinCodeInput.focus();
  }

  async function handleJoinSubmit(e) {
    if (e) e.preventDefault();
    if (btnSubmitJoin.disabled) return;
    const attempt = ++pairingAttempt;
    const code = joinCodeInput.value.trim().toUpperCase();

    if (!code || code.length < 4) {
      joinErrorMsg.textContent = 'Please enter a valid pairing code.';
      joinErrorMsg.style.display = 'block';
      return;
    }

    try {
      btnSubmitJoin.disabled = true;
      btnSubmitJoin.innerHTML = 'Connecting<span class="loading-dots"><span></span><span></span><span></span></span>';
      joinErrorMsg.style.display = 'none';

      // Validate code with API
      const session = await Api.getSession(code);
      if (attempt !== pairingAttempt) return;
      state.code = session.code;

      // Initialize WebRTC Peer Connection as Joiner
      state.peer = new SlipstreamPeer({
        role: 'joiner',
        code: state.code,
        onStatusChange: (status) => {
          btnSubmitJoin.textContent = status;
        },
        onChannelOpen: () => {
          btnSubmitJoin.disabled = false;
          btnSubmitJoin.textContent = 'Connect to device';
          setHeaderConnected(true);
          localDeviceLabel.textContent = 'Joiner (Receiver)';
          peerDeviceLabel.textContent = 'Sender';
          if (senderFileSection) senderFileSection.style.display = 'none';
          if (receiverFileSection) receiverFileSection.style.display = 'block';
          if (receiverWaitingBox) receiverWaitingBox.style.display = 'flex';
          if (incomingSection) incomingSection.style.display = 'none';

          // Trigger subtle device glyph lift and settle (Requirement B)
          connectedDeviceItems.forEach((el) => {
            el.classList.add('device-connected');
          });

          // Initialize Phase 2 receiver engine on joiner (§7.4)
          initializeTransferEngines();

          showScreen('connected');
          appendChatLog('System', 'Direct WebRTC data channel connected!');
        },
        onControlMessage: (message) => {
          handleIncomingControlMessage(message);
        },
        onBinaryMessage: (buffer) => {
          handleIncomingBinaryMessage(buffer);
        },
        onChannelMessage: (data) => {
          handleIncomingChannelMessage(data);
        },
        onChannelClose: () => {
          handleChannelClose();
        },
        onError: (err) => {
          console.error('Joiner connection error:', err);
          btnSubmitJoin.disabled = false;
          btnSubmitJoin.textContent = 'Connect to device';
          joinErrorMsg.textContent = `Connection error: ${err.message}`;
          joinErrorMsg.style.display = 'block';
          if (state.sender || state.receiver) handleChannelClose();
          else handleTransferError(err);
        },
      });

      await state.peer.start();
    } catch (err) {
      if (attempt !== pairingAttempt) return;
      btnSubmitJoin.disabled = false;
      btnSubmitJoin.textContent = 'Connect to device';
      joinErrorMsg.textContent = err.message || 'Invalid or expired pairing code.';
      joinErrorMsg.style.display = 'block';
    }
  }

  /**
   * Phase 2 Protocol & Transfer Engine Coordination (§7.4)
   */

  /**
   * Instantiate role-specific transfer engines when data channel opens.
   */
  function initializeTransferEngines() {
    const callbacks = {
      peer: state.peer, onProgress: handleTransferProgress, onError: handleTransferError,
      onStateChange(next, details) {
        // Completion and failure callbacks carry the verified Blob or error.
        if (['completed', 'failed', 'awaiting-decision', 'ready'].includes(next)) return;
        showScreen('transfer');
        updateTransferUIState(next, details);
      },
    };
    if (state.role === 'host') {
      state.sender = new SlipstreamFileSender({ ...callbacks, onComplete: handleSenderComplete });
    } else {
      state.receiver = new SlipstreamFileReceiver({ ...callbacks, onOffer: handleIncomingOffer, onComplete: handleReceiverComplete });
    }
  }

  function handleIncomingControlMessage(message) {
    (state.sender || state.receiver)?.handleControlMessage(message);
  }

  function handleIncomingBinaryMessage(buffer) {
    state.receiver?.handleBinaryChunk(buffer);
  }

  function handleChannelClose() {
    setHeaderConnected(false);
    appendChatLog('System', 'Data channel closed by peer.');
    const engine = state.sender || state.receiver;
    engine?.channelClosed();
    engine?.destroy();
    state.sender = null;
    state.receiver = null;
  }

  /**
   * Initiate file transfer on the host/sender (§5.1, §7.4).
   */
  async function startFileSend() {
    if (!state.selectedFile) {
      alert('Please select a file to transfer.');
      return;
    }

    // 100 MiB initial guardrail (§3.3)
    if (state.selectedFile.size > TransferProtocol.maxFileSize) {
      alert(`File exceeds the 100 MB limit (${formatFileSize(state.selectedFile.size)}). Please choose a smaller file.`);
      return;
    }

    if (!state.sender || !state.peer?.isChannelOpen()) {
      handleTransferError(new Error('Reconnect before sending a file.'));
      return;
    }

    updateActiveFileBadge(state.selectedFile);
    showScreen('transfer');

    state.stats.startTime = 0;
    state.stats.lastProgressTime = 0;
    state.stats.lastBytes = 0;
    state.stats.speedBps = 0;
    state.stats.bytesTransferred = 0;
    state.stats.totalBytes = state.selectedFile.size;

    try {
      await state.sender.start(state.selectedFile);
    } catch (err) {
      console.error('Failed to start file transfer:', err);
      handleTransferError(err);
    }
  }

  /**
   * Handle incoming file offer on the joiner/receiver (§4.1, §7.4).
   */
  function handleIncomingOffer(offer) {
    state.stats.bytesTransferred = 0;
    state.stats.totalBytes = offer.size;
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
    state.downloadBlob = null;
    updateTransferUIState('idle');
    showScreen('connected');
    state.pendingOffer = offer;
    state.transferState = 'awaiting-decision';

    if (receiverWaitingBox) {
      receiverWaitingBox.style.display = 'none';
    }

    if (incomingSection && incomingFilename) {
      incomingFilename.textContent = offer.name;
      if (incomingFilesize) incomingFilesize.textContent = formatFileSize(offer.size);
      if (incomingFilemeta) incomingFilemeta.textContent = `${offer.mimeType || 'application/octet-stream'} · from Sender`;
      incomingSection.style.display = 'flex';
    } else {
      showIncomingOfferFallback(offer);
    }
  }

  /**
   * Show incoming file offer card fallback for testing
   */
  function showIncomingOfferFallback(offer) {
    let fallback = document.getElementById('incoming-offer-fallback');
    if (!fallback) {
      fallback = document.createElement('div');
      fallback.id = 'incoming-offer-fallback';
      fallback.style.cssText = `
        background: #FFFFFF;
        border: 1px solid var(--color-mist);
        border-radius: 14px;
        padding: 20px 24px;
        margin-top: 1.5rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        width: 100%;
        max-width: 440px;
        box-sizing: border-box;
      `;

      fallback.innerHTML = `
        <p style="margin: 0; font-family: 'Space Grotesk', sans-serif; font-weight: 600; font-size: 17px;">Incoming file</p>
        <div style="background: var(--color-fog); border: 1px solid var(--color-mist); border-radius: 10px; padding: 14px 18px; display: flex; align-items: center; gap: 14px; width: 100%; box-sizing: border-box;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FF5A3C" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <path d="M14 2v6h6"></path>
          </svg>
          <div style="min-width: 0; flex: 1;">
            <p id="fallback-incoming-filename" style="margin: 0; font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></p>
            <p id="fallback-incoming-meta" style="margin: 2px 0 0; font-size: 12px; color: var(--color-steel);"></p>
          </div>
        </div>
        <div style="display: flex; gap: 12px; width: 100%;">
          <button type="button" class="btn btn-secondary" id="fallback-btn-decline" style="flex: 1;">Decline</button>
          <button type="button" class="btn btn-primary" id="fallback-btn-accept" style="flex: 1;">Accept transfer</button>
        </div>
        <p style="margin: 0; font-size: 11px; color: var(--color-steel);">Nothing is downloaded until you accept.</p>
      `;

      const connectedCard = document.querySelector('#screen-connected .connected-card');
      if (connectedCard) {
        connectedCard.appendChild(fallback);
      }
    }

    const nameEl = document.getElementById('fallback-incoming-filename');
    const metaEl = document.getElementById('fallback-incoming-meta');
    if (nameEl) nameEl.textContent = offer.name;
    if (metaEl) metaEl.textContent = `${formatFileSize(offer.size)} · SHA-256 ready`;

    fallback.style.display = 'flex';

    const btnAccept = document.getElementById('fallback-btn-accept');
    const btnDecline = document.getElementById('fallback-btn-decline');

    if (btnAccept) {
      btnAccept.onclick = () => {
        fallback.style.display = 'none';
        acceptIncomingTransfer();
      };
    }
    if (btnDecline) {
      btnDecline.onclick = () => {
        fallback.style.display = 'none';
        declineIncomingTransfer();
      };
    }
  }

  /**
   * User accepts incoming offer (§4.2).
   */
  function acceptIncomingTransfer() {
    try {
      updateActiveFileBadge(state.pendingOffer);
      showScreen('transfer');
      updateTransferUIState('ready');
      if (transferHeading) transferHeading.textContent = 'Receiving file...';
      if (transferSubtext) {
        const name = state.pendingOffer ? state.pendingOffer.name : 'file';
        const size = state.pendingOffer ? formatFileSize(state.pendingOffer.size) : '';
        transferSubtext.textContent = `Connecting to stream ${name} (${size})...`;
      }

      state.stats.startTime = performance.now();
      state.stats.lastProgressTime = state.stats.startTime;
      state.stats.lastBytes = 0;
      state.stats.speedBps = 0;

      if (state.receiver && typeof state.receiver.accept === 'function') {
        state.receiver.accept();
      }
    } catch (err) {
      handleTransferError(err);
    }
  }

  /**
   * User declines incoming offer (§4.3).
   */
  function declineIncomingTransfer() {
    state.receiver?.reject('user-declined');
    state.pendingOffer = null;
  }

  /**
   * Progress updates derived from validated byte counts (§4.5, §6).
   */
  function handleTransferProgress({ bytesReceived, totalBytes, percent }) {
    const p = percent !== undefined ? percent : (totalBytes > 0 ? (bytesReceived / totalBytes) * 100 : 0);
    setTrailProgress(p, 'active');

    const now = performance.now();
    const stats = state.stats;

    if (!stats.startTime) {
      stats.startTime = now;
      stats.lastProgressTime = now;
      stats.lastBytes = bytesReceived;
    } else {
      const elapsed = (now - stats.lastProgressTime) / 1000;
      if (elapsed >= 0.5) {
        const deltaBytes = bytesReceived - stats.lastBytes;
        stats.speedBps = deltaBytes / elapsed;
        stats.lastProgressTime = now;
        stats.lastBytes = bytesReceived;
      }
    }

    stats.bytesTransferred = bytesReceived;
    stats.totalBytes = totalBytes;

    let subtext = `${formatFileSize(bytesReceived)} of ${formatFileSize(totalBytes)}`;
    let speedEtaStr = '';
    if (stats.speedBps > 0) {
      const speedStr = `${formatFileSize(stats.speedBps)}/s`;
      const remainingBytes = Math.max(0, totalBytes - bytesReceived);
      const remainingSecs = Math.round(remainingBytes / stats.speedBps);
      subtext += ` · ${speedStr} · ${remainingSecs}s remaining`;
      speedEtaStr = `· ${speedStr} · ${remainingSecs}s remaining`;
    }

    if (transferHeading && state.transferState !== 'awaiting-verification') {
      transferHeading.textContent = state.role === 'host' ? 'Sending file...' : 'Receiving file...';
    }
    if (transferSubtext) {
      transferSubtext.textContent = subtext;
    }
    if (transferSpeedEta) {
      transferSpeedEta.textContent = speedEtaStr;
    }
  }

  /**
   * Handle receiver verification & download readiness (§4.7, §7.4).
   */
  function handleReceiverComplete(result) {
    updateTransferUIState('completed', result);
  }

  /**
   * Handle sender completion after receiver verified acknowledgement (§4.7, §7.4).
   */
  function handleSenderComplete(details) {
    updateTransferUIState('completed', details);
  }

  /**
   * Handle transfer errors and broken connection trail (§4.10, §8).
   */
  function handleTransferError(err) {
    console.error('Transfer error:', err);
    showScreen('transfer');
    updateTransferUIState('failed', err);
  }

  /**
   * Cancel active transfer on either side (§4.8).
   */
  function cancelActiveTransfer() {
    (state.sender || state.receiver)?.cancel();
  }

  /**
   * Process legacy Phase 1 test chat messages over the direct WebRTC DataChannel (§2.3)
   */
  function handleIncomingChannelMessage(data) {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed && parsed.type === 'text') {
          appendChatLog('Peer', parsed.message);
          return;
        }
      } catch {
        appendChatLog('Peer', data);
      }
    }
  }

  /**
   * Phase 1 Test Message: Send message directly across data channel
   */
  function sendTestMessage() {
    const raw = testMessageInput.value;
    const text = raw.trim();
    if (!text || !state.peer) return;

    // Ensure outgoing message is stripped of any legacy/accidental prefixes
    const cleanText = text.replace(/^(?:(?:You|Peer|System):\s*)+/i, '').trim();
    if (!cleanText) return;

    try {
      state.peer.send(JSON.stringify({ type: 'text', message: cleanText }));
      appendChatLog('You', cleanText);
      testMessageInput.value = '';
    } catch (err) {
      alert(`Send failed: ${err.message}`);
    }
  }

  /**
   * Handle File Selection and Drag & Drop (Requirement G)
   */
  function handleSelectedFile(file) {
    if (!file) return;
    state.selectedFile = file;

    if (previewFilename) previewFilename.textContent = file.name;
    if (previewFilesize) previewFilesize.textContent = formatFileSize(file.size);

    if (fileDropzone) fileDropzone.style.display = 'none';
    if (filePreview) filePreview.style.display = 'flex';
    if (fileActions) fileActions.style.display = 'flex';
  }

  function clearSelectedFile() {
    state.selectedFile = null;
    if (fileInput) fileInput.value = '';
    if (filePreview) filePreview.style.display = 'none';
    if (fileActions) fileActions.style.display = 'none';
    if (fileDropzone) fileDropzone.style.display = 'block';
  }

  // Dropzone drag-and-drop event listeners with animated border (Requirement G)
  if (fileDropzone) {
    fileDropzone.addEventListener('click', () => {
      if (fileInput) fileInput.click();
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      fileDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileDropzone.classList.add('drag-over');
      });
    });

    ['dragleave', 'dragend'].forEach((eventName) => {
      fileDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileDropzone.classList.remove('drag-over');
      });
    });

    fileDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileDropzone.classList.remove('drag-over');

      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleSelectedFile(e.dataTransfer.files[0]);
      }
    });

    fileDropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (fileInput) fileInput.click();
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleSelectedFile(e.target.files[0]);
      }
    });
  }

  if (btnRemoveFile) {
    btnRemoveFile.addEventListener('click', clearSelectedFile);
  }

  if (btnChangeFile) {
    btnChangeFile.addEventListener('click', () => {
      if (fileInput) fileInput.click();
    });
  }

  if (btnSendFile) {
    btnSendFile.addEventListener('click', startFileSend);
  }

  if (btnCancelTransfer) {
    btnCancelTransfer.addEventListener('click', cancelActiveTransfer);
  }

  // Pre-wire Receiver Accept & Decline buttons (§7.5, Requirement 2)
  if (btnAcceptTransfer) {
    btnAcceptTransfer.addEventListener('click', acceptIncomingTransfer);
  }
  if (btnDeclineTransfer) {
    btnDeclineTransfer.addEventListener('click', declineIncomingTransfer);
  }

  // Transfer recovery & completion actions (§8)
  if (btnSendAnother) {
    btnSendAnother.addEventListener('click', () => {
      showScreen('connected');
      updateTransferUIState('idle');
      clearSelectedFile();
    });
  }

  if (btnRetryTransfer) {
    btnRetryTransfer.addEventListener('click', () => {
      showScreen('connected');
      updateTransferUIState('idle');
      if (state.role === 'host') clearSelectedFile();
      else {
        incomingSection.style.display = 'none';
        receiverWaitingBox.style.display = 'flex';
      }
    });
  }

  if (btnReturnHome) {
    btnReturnHome.addEventListener('click', resetApp);
  }

  // Navigation Event Listeners
  btnStartSend.addEventListener('click', startHostFlow);
  btnStartReceive.addEventListener('click', startJoinFlow);
  btnCancelHost.addEventListener('click', resetApp);
  btnCancelJoin.addEventListener('click', resetApp);
  btnDisconnect.addEventListener('click', resetApp);
  brandLink.addEventListener('click', (e) => {
    e.preventDefault();
    resetApp();
  });

  joinForm.addEventListener('submit', handleJoinSubmit);

  if (btnScanQr) {
    btnScanQr.addEventListener('click', () => {
      alert('Camera access requires HTTPS in browser secure contexts. On local HTTP, please enter the pairing code manually.');
      if (joinCodeInput) joinCodeInput.focus();
    });
  }

  btnSendTestMsg.addEventListener('click', sendTestMessage);
  testMessageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendTestMessage();
    }
  });

  // Modal open/close handlers
  modalButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-modal');
      const targetModal = document.getElementById(modalId);
      if (targetModal) targetModal.classList.add('open');
    });
  });

  modalCloseButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      modalOverlays.forEach((m) => m.classList.remove('open'));
    });
  });

  modalOverlays.forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('open');
      }
    });
  });

  // Check URL parameters for ?join=CODE
  const urlParams = new URLSearchParams(window.location.search);
  const joinParam = urlParams.get('join');
  if (joinParam) {
    startJoinFlow();
    joinCodeInput.value = joinParam.toUpperCase();
    handleJoinSubmit();
  }
});
