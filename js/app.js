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
    selectedFile: null,

    // Phase 2 Protocol & Transfer Engine State (§5, §7.4)
    sender: null,            // SlipstreamFileSender instance
    receiver: null,          // SlipstreamFileReceiver instance
    transferProblem: '',
    transferState: 'idle',   // 'idle' | 'hashing' | 'offering' | 'awaiting-decision' | 'transferring' | 'verifying' | 'completed' | 'rejected' | 'cancelled' | 'failed'
    pendingOffer: null,      // Stored offer metadata on receiver
    stats: {
      bytesTransferred: 0,
      totalBytes: 0,
      startTime: 0,
      lastProgressTime: 0,
      lastBytes: 0,
      speedBps: 0,
    },
  };

  const byId = id => document.getElementById(id);
  const viewer = createPreviewDialog(byId('file-viewer'));
  const textSharing = setupTextSharing(byId, () => state.peer, recordActivity);
  const verifiedFiles = byId('verified-files');
  const downloads = new Set();
  let requests = null;
  let pickerRequest = null;
  let queue = null;
  let session = null;
  let sessionTimer;
  let transferName = '';
  let activityRows = 0;

  function renderSession() {
    if (!session) return;
    const list = byId('activity-list');
    for (; activityRows < session.activity.length; activityRows++) {
      const event = session.activity[activityRows];
      const row = document.createElement('li');
      row.textContent = new Date(event.time).toLocaleTimeString() + ' · ' + event.message;
      list.append(row);
    }
    const now = Date.now();
    const seconds = (start, end) => Math.max(0, Math.floor((end - start) / 1000)) + 's';
    const elapsed = session.transferStarted === null ? '—' : seconds(session.transferStarted, session.transferEnded ?? now);
    byId('session-stats').textContent = [
      session.verified + ' verified files', session.bytes.toLocaleString() + ' verified bytes',
      session.skipped + ' declined or cancelled', 'Transfer ' + elapsed, 'Session ' + seconds(session.started, now),
    ].join(' · ');
  }

  function recordActivity(message) {
    session?.record(message);
    renderSession();
  }

  function beginSession() {
    session = new SharingSession();
    if (state.role === 'host') queue = new FileQueue(startFileSend, renderQueue);
    requests = new FileRequests(state.peer, message => {
      byId('request-status').textContent = message;
      byId('request-file').disabled = !!requests.pending;
      byId('request-choice').hidden = !(requests.pending && state.role === 'host');
      recordActivity(message);
    });
    byId('request-file').hidden = state.role !== 'joiner';
    renderQueue();
    byId('session-tools').hidden = false;
    byId('nickname').value = localDeviceLabel.textContent = state.role === 'host' ? 'Sender' : 'Receiver';
    peerDeviceLabel.textContent = state.role === 'host' ? 'Receiver' : 'Sender';
    recordActivity(peerDeviceLabel.textContent + ' connected');
    AppMessages.send(state.peer, 'device-name', { name: localDeviceLabel.textContent });
    sessionTimer = setInterval(() => { if (byId('activity-panel').open) renderSession(); }, 1000);
  }

  function clearSession() {
    requests?.close();
    requests = pickerRequest = null;
    byId('request-choice').hidden = true;
    byId('request-file').disabled = false;
    byId('request-picker').value = byId('request-status').textContent = '';
    const previousQueue = queue;
    queue = null;
    previousQueue?.clear();
    viewer.close();
    textSharing.clear();
    state.selectedFile = null;
    fileInput.value = '';
    byId('queue-feedback').textContent = '';
    clearInterval(sessionTimer);
    session = null;
    transferName = '';
    activityRows = 0;
    byId('activity-list').replaceChildren();
    byId('session-tools').hidden = true;
    byId('session-stats').textContent = byId('name-feedback').textContent = '';
    byId('nickname').value = '';
    testMessageInput.value = '';
    testChatLog.textContent = 'Data channel ready.';
    transferLabelSender.textContent = 'Sender';
    transferLabelReceiver.textContent = 'Receiver';
    localDeviceLabel.textContent = 'This device';
    peerDeviceLabel.textContent = 'Peer device';
  }

  function receiveApplicationMessage(message) {
    if (!session) return;
    if (message.type === 'file-request' || message.type === 'file-request-result') requests?.receive(message);
    if (message.type === 'share-text') textSharing.receive(message.text, peerDeviceLabel.textContent);
    if (message.type === 'device-name') {
      peerDeviceLabel.textContent = message.name;
      (state.role === 'host' ? transferLabelReceiver : transferLabelSender).textContent = message.name;
    }
  }

  function trackTransfer(stage, details = {}) {
    const active = (state.sender || state.receiver)?.active;
    const id = details.transferId || active?.id;
    if (active?.file) transferName = active.file.name;
    const labels = {
      'awaiting-acceptance': 'Offered', 'awaiting-decision': 'Offered', ready: 'Accepted',
      sending: 'Started', receiving: 'Started', completed: 'Verified',
      rejected: 'Rejected', failed: 'Failed', cancelled: 'Cancelled',
    };
    if (stage === 'sending') session?.transfer(id, 'Accepted', transferName);
    if (labels[stage]) {
      session?.transfer(id, labels[stage], transferName, details.bytesReceived);
      renderSession();
    }
  }

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
  const chatBox = document.getElementById('phase-chat');
  const testMessageInput = document.getElementById('test-message-input');
  const btnSendTestMsg = document.getElementById('btn-send-test-msg');
  const localDeviceLabel = document.getElementById('local-device-label');
  const peerDeviceLabel = document.getElementById('peer-device-label');
  const connectedDeviceItems = document.querySelectorAll('.device-item');

  // Sender File Dropzone & Preview Elements
  const fileDropzone = document.getElementById('file-dropzone');
  const fileInput = document.getElementById('file-input');
  const btnSendFile = document.getElementById('btn-send-file');

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
  const btnCancelTransfer = document.getElementById('btn-cancel-transfer');
  const btnSendAnother = document.getElementById('btn-send-another');
  const btnRetryTransfer = document.getElementById('btn-retry-transfer');
  const btnReturnHome = document.getElementById('btn-return-home');

  // Modal Handlers
  const modalButtons = document.querySelectorAll('[data-modal]');
  const modalCloseButtons = document.querySelectorAll('[data-close-modal]');
  const modalOverlays = document.querySelectorAll('.modal-overlay');

  function renderDiagnostics() {
    const snapshot = state.peer?.snapshot() || SlipstreamPeer.lastSnapshot;
    const list = byId('connection-details');
    list.replaceChildren();
    byId('connection-summary').textContent = !snapshot ? 'Start a pairing attempt to see connection details.'
      : snapshot.channelOpen ? 'The data channel is open.' : 'The data channel is closed or still connecting.';
    if (!snapshot) return;
    const fields = {
      'Pairing stage': snapshot.stage, Signaling: snapshot.signaling, 'ICE gathering': snapshot.gathering,
      ICE: snapshot.ice, Peer: snapshot.connection, 'Data channel': snapshot.channel,
      'Local candidate types': snapshot.candidateTypes.local.join(', '),
      'Remote candidate types': snapshot.candidateTypes.remote.join(', '),
      'Candidate applications (successful / failed)': snapshot.applied + ' / ' + snapshot.applyFailures,
      'Attempt duration': snapshot.durationSeconds + 's',
    };
    for (const [label, value] of Object.entries(fields)) {
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = value || 'Not observed';
      list.append(term, detail);
    }
  }
  document.getElementById('btn-download-diagnostics').addEventListener('click', () => {
    const entries = SlipstreamPeer.diagnostics;
    const status = document.getElementById('diagnostics-status');
    const snapshot = state.peer?.snapshot() || SlipstreamPeer.lastSnapshot;
    if (!entries.length && !snapshot) {
      status.textContent = 'Start a pairing attempt first, then download its report here.';
      return;
    }
    const blob = new Blob([JSON.stringify({ build: 'sharing-experience', snapshot, entries }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'slipstream-connection.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Report downloaded for the latest pairing attempt in this tab.';
  });

  /**
   * Screen Management
   */
  function showScreen(screenName) {
    if (screenName === 'connected' && !state.peer?.isChannelOpen()) return;
    if (screens[screenName]?.classList.contains('active')) return;
    Object.values(screens).forEach((el) => {
      if (el) el.classList.remove('active');
    });
    if (screens[screenName]) {
      screens[screenName].classList.add('active');
    }
    const heading = screens[screenName]?.querySelector('h1, h2');
    if (heading && !document.querySelector('dialog[open]')) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    // Keep the existing conversation accessible throughout an open connection.
    if (screenName === 'connected' || screenName === 'transfer') {
      const card = screens[screenName].querySelector('.connected-card');
      if (chatBox.parentElement !== card) card.append(verifiedFiles, byId('session-tools'), chatBox);
    }
  }

  function setHeaderConnected(isConnected) {
    const open = isConnected && !!state.peer?.isChannelOpen();
    chatBox.hidden = !open;
    testMessageInput.disabled = !open;
    btnSendTestMsg.disabled = !open;
    if (!headerStatus) return;
    if (open) {
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
    const sizes = ['B', 'KiB', 'MiB', 'GiB'];
    const i = Math.max(0, Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k))));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Reset application state and clean up resources (§8)
   */
  let pairingAttempt = 0;
  function resetApp() {
    clearSession();
    pairingControls(false);
    byId('pairing-feedback').textContent = '';
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
    for (const url of downloads) URL.revokeObjectURL(url);
    downloads.clear();
    verifiedFiles.querySelector('ul').replaceChildren();
    verifiedFiles.hidden = true;
    state.pendingOffer = null;
    state.transferProblem = '';
    state.transferState = 'idle';
    state.stats = {
      bytesTransferred: 0,
      totalBytes: 0,
      startTime: 0,
      lastProgressTime: 0,
      lastBytes: 0,
      speedBps: 0,
    };

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
    console.debug('[Slipstream] transfer state', stateName);

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
        if (transferHeading) transferHeading.textContent = details.connectionTitle || 'Transfer interrupted';
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
    const url = URL.createObjectURL(blob.slice(0, blob.size, 'application/octet-stream'));
    downloads.add(url);
    const row = document.createElement('li');
    const link = document.createElement('a');
    byId('btn-download-file')?.removeAttribute('id');
    link.id = 'btn-download-file';
    link.className = 'btn btn-primary';
    link.href = url;
    link.download = filename;
    link.textContent = 'Download';
    row.append(filename, ' ', link,
      actionButton('Preview', () => viewer.open({ name: filename, blob, verified: true })),
      actionButton('Remove', () => {
        URL.revokeObjectURL(url);
        downloads.delete(url);
        row.remove();
        verifiedFiles.hidden = !downloads.size;
      }));
    verifiedFiles.querySelector('ul').append(row);
    verifiedFiles.hidden = false;
  }

  function actionButton(label, click) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary';
    button.textContent = label;
    button.onclick = click;
    return button;
  }

  /**
   * Host Flow (Send a file)
   */
  function pairingControls(enabled) {
    for (const id of ['copy-code', 'copy-link', 'new-code']) byId(id).disabled = !enabled;
  }

  function pairingLink() {
    const link = new URL(location.href);
    link.searchParams.set('join', state.code);
    return link.href;
  }

  async function regenerateCode() {
    if (!state.code || state.peer?.isChannelOpen() || state.role !== 'host') return;
    const attempt = ++pairingAttempt;
    pairingControls(false);
    state.peer?.close();
    state.peer = null;
    const removed = await Api.deleteSession(state.code);
    if (attempt !== pairingAttempt) return;
    if (!removed) {
      byId('pairing-feedback').textContent = 'Could not retire this code. Check your connection and try New code again.';
      byId('new-code').disabled = false;
      return;
    }
    state.code = null;
    byId('pairing-feedback').textContent = '';
    await startHostFlow();
  }

  async function startHostFlow() {
    const attempt = ++pairingAttempt;
    state.role = 'host';
    try {
      showScreen('pairing');
      hostStatusMsg.textContent = 'Generating temporary session...';
      hostCodeText.textContent = '------';

      const session = await Api.createSession();
      if (attempt !== pairingAttempt) return Api.deleteSession(session.code);
      state.code = session.code;

      pairingControls(true);
      hostCodeText.textContent = session.code;
      hostStatusMsg.textContent = 'Waiting for peer device to connect...';

      // Generate join link for QR code
      const joinUrl = pairingLink();

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
          if (attempt !== pairingAttempt || !state.peer?.isChannelOpen()) return;
          setHeaderConnected(true);
          beginSession();
          pairingControls(false);
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
        onApplicationMessage: receiveApplicationMessage,
        onControlMessage: (message) => {
          handleIncomingControlMessage(message);
        },
        onBinaryMessage: (buffer) => {
          handleIncomingBinaryMessage(buffer);
        },
        onChannelMessage: (data) => {
          handleIncomingChannelMessage(data);
        },
        onChannelClose: () => handleChannelClose(attempt),
        onError: () => handleChannelClose(attempt),
      });

      await state.peer.start();
    } catch (err) {
      if (attempt !== pairingAttempt) return;
      console.warn('[Slipstream] pairing setup failed', { error: err.name, status: err.status });
      handleChannelClose(attempt);
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

    if (!/^[A-Z2-9]{6}$/.test(code)) {
      joinErrorMsg.textContent = 'Please enter a valid pairing code.';
      joinErrorMsg.style.display = 'block';
      return;
    }

    try {
      btnSubmitJoin.disabled = true;
      btnSubmitJoin.textContent = 'Checking pairing code…';
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
          if (attempt !== pairingAttempt || !state.peer?.isChannelOpen()) return;
          btnSubmitJoin.disabled = false;
          btnSubmitJoin.textContent = 'Connect to device';
          setHeaderConnected(true);
          beginSession();
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
        onApplicationMessage: receiveApplicationMessage,
        onControlMessage: (message) => {
          handleIncomingControlMessage(message);
        },
        onBinaryMessage: (buffer) => {
          handleIncomingBinaryMessage(buffer);
        },
        onChannelMessage: (data) => {
          handleIncomingChannelMessage(data);
        },
        onChannelClose: () => handleChannelClose(attempt),
        onError: () => handleChannelClose(attempt),
      });

      await state.peer.start();
    } catch (err) {
      if (attempt !== pairingAttempt) return;
      btnSubmitJoin.disabled = false;
      btnSubmitJoin.textContent = 'Connect to device';
      joinErrorMsg.textContent = err.status === 404 || err.status === 410 ? 'Code not found or expired. Ask for a new code.'
        : err.status === 429 ? 'Too many attempts. Wait a minute before trying again.'
        : 'Could not check the code. Check your network and try again.';
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
        if (next === 'failed') {
          state.transferProblem = ({
            HASH_MISMATCH: 'Integrity check failed. Discarded the file. Ask the sender to offer it again.',
            SIZE_MISMATCH: 'Incomplete file discarded. Ask the sender to offer it again.',
            INVALID_CHUNK_SIZE: 'Unexpected file data. The incomplete file was discarded.',
          })[details?.code] || (details?.reason === 'timeout' ? 'The peer did not respond in time. Try again when both devices are ready.' : '');
        }
        if (next === 'sending' || next === 'receiving') {
          state.stats.startTime = state.stats.lastProgressTime = performance.now();
          state.stats.lastBytes = state.stats.speedBps = 0;
          state.stats.lastPaint = null;
        }
        trackTransfer(next, details);
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

  function handleChannelClose(attempt) {
    if (attempt !== pairingAttempt) return;
    pairingAttempt++;
    const engine = state.sender || state.receiver;
    const interrupted = !!engine?.active;
    const completed = state.transferState === 'completed';
    const previouslyConnected = !!engine;
    state.peer?.close();
    state.peer = null;
    setHeaderConnected(false);
    engine?.channelClosed();
    engine?.destroy();
    if (previouslyConnected) recordActivity(peerDeviceLabel.textContent + ' disconnected');
    clearSession();
    state.sender = null;
    state.receiver = null;
    if (state.code) {
      void Api.deleteSession(state.code);
      state.code = null;
    }
    // A verified download remains usable after its peer leaves.
    if (completed) return;
    showScreen('transfer');
    if (interrupted) return; // channelClosed already reported the transfer error.
    updateTransferUIState('failed', {
      connectionTitle: previouslyConnected ? 'Connection lost' : 'Connection failed',
      message: previouslyConnected ? 'Pair again to reconnect.' : "Couldn't connect to device",
    });
  }

  function retryConnection() {
    const role = state.role;
    resetApp();
    if (role === 'host') startHostFlow();
    else startJoinFlow();
  }

  /**
   * Initiate file transfer on the host/sender (§5.1, §7.4).
   */
  async function startFileSend(file) {
    if (!state.sender || !state.peer?.isChannelOpen()) {
      handleTransferError(new Error('Reconnect before sending a file.'));
      return { state: 'failed' };
    }
    state.selectedFile = file;
    updateActiveFileBadge(state.selectedFile);
    showScreen('transfer');

    state.stats.startTime = 0;
    state.stats.lastProgressTime = 0;
    state.stats.lastBytes = 0;
    state.stats.speedBps = 0;
    state.stats.bytesTransferred = 0;
    state.stats.totalBytes = state.selectedFile.size;

    try {
      return await state.sender.start(file);
    } catch (err) {
      handleTransferError(err);
      return { state: 'failed' };
    } finally {
      if (state.selectedFile === file) state.selectedFile = null;
    }
  }

  /**
   * Handle incoming file offer on the joiner/receiver (§4.1, §7.4).
   */
  function handleIncomingOffer(offer) {
    state.stats.bytesTransferred = 0;
    state.stats.totalBytes = offer.size;
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
      if (incomingFilemeta) incomingFilemeta.textContent = `${offer.mimeType || 'application/octet-stream'} · from ${peerDeviceLabel.textContent}`;
      incomingSection.style.display = 'flex';
      btnAcceptTransfer.focus({ preventScroll: true });
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

    // Keep byte accounting exact while limiting DOM writes during multi-chunk bursts.
    if (stats.lastPaint != null && now - stats.lastPaint < 100 && bytesReceived !== totalBytes) return;
    stats.lastPaint = now;
    setTrailProgress(p, 'active');
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
    console.warn('[Slipstream] Transfer interrupted');
    showScreen('transfer');
    updateTransferUIState('failed', { message: state.transferProblem || 'Transfer interrupted. Check the connection and try again.' });
    state.transferProblem = '';
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
          recordActivity(peerDeviceLabel.textContent + ' shared a message');
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
    if (!text || !state.peer?.isChannelOpen()) return;

    // Ensure outgoing message is stripped of any legacy/accidental prefixes
    const cleanText = text.replace(/^(?:(?:You|Peer|System):\s*)+/i, '').trim();
    if (!cleanText) return;

    try {
      state.peer.send(JSON.stringify({ type: 'text', message: cleanText }));
      appendChatLog('You', cleanText);
      recordActivity('You shared a message');
      testMessageInput.value = '';
    } catch (err) {
      appendChatLog('System', 'Could not send. Check the connection and try again.');
    }
  }

  /**
   * Handle File Selection and Drag & Drop (Requirement G)
   */
  function renderQueue() {
    const panel = byId('queue-panel');
    const list = byId('queue-list');
    list.replaceChildren();
    panel.hidden = !queue;
    if (!queue) return;
    for (const [index, file] of queue.pending.entries()) {
      const row = document.createElement('li');
      row.append(file.name + ' · ' + (file.type || 'Unknown type') + ' · ' + formatFileSize(file.size) + ' · Queued ',
        actionButton('Preview', () => viewer.open({ name: file.name, blob: file, local: true })),
        actionButton('Remove', () => queue.remove(index)));
      list.append(row);
    }
    btnSendFile.disabled = queue.running || !queue.pending.length;
    byId('clear-queue').disabled = !queue.pending.length;
  }

  function addFiles(files) {
    if (!queue) return;
    const oversized = queue.add(files);
    byId('queue-feedback').textContent = oversized.length
      ? 'Over the 100 MiB limit: ' + oversized.join(', ') : '';
    fileInput.value = '';
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
        addFiles(e.dataTransfer.files);
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
        addFiles(e.target.files);
      }
    });
  }

  byId('request-file').onclick = () => requests?.request();
  byId('decline-request').onclick = () => requests?.respond(requests.pending, 'declined');
  const requestPicker = byId('request-picker');
  byId('approve-request').onclick = () => {
    if (!requests?.pending) return;
    pickerRequest = requests.pending;
    requestPicker.value = '';
    requestPicker.click();
  };
  requestPicker.oncancel = () => requests?.respond(pickerRequest, 'declined');
  requestPicker.onchange = () => {
    const file = requestPicker.files[0];
    requestPicker.value = '';
    if (!pickerRequest || requests?.pending !== pickerRequest) return;
    if (!file || file.size > TransferProtocol.maxFileSize) {
      requests.respond(pickerRequest, 'declined');
      byId('request-status').textContent = 'Request declined. Choose a file of 100 MiB or less next time.';
      return;
    }
    if (!requests.respond(pickerRequest, 'approved')) return;
    const wasEmpty = queue.pending.length === 0;
    queue.add([file]);
    // Do not start other files the user has queued but has not chosen to send yet.
    if (wasEmpty) void queue.run();
  };
  byId('clear-queue').onclick = () => queue?.clear();
  btnSendFile.onclick = () => queue?.run();

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
      if (!state.peer?.isChannelOpen()) return retryConnection();
      showScreen('connected');
      updateTransferUIState('idle');
    });
  }

  if (btnRetryTransfer) {
    btnRetryTransfer.addEventListener('click', () => {
      if (!state.peer?.isChannelOpen()) return retryConnection();
      showScreen('connected');
      updateTransferUIState('idle');
      if (state.role === 'joiner') {
        incomingSection.style.display = 'none';
        receiverWaitingBox.style.display = 'flex';
      }
    });
  }

  if (btnReturnHome) {
    btnReturnHome.addEventListener('click', resetApp);
  }

  function endSession() {
    if ((state.sender?.active || state.receiver?.active) && !confirm('End this session and cancel the current transfer?')) return;
    resetApp();
  }

  byId('end-session').addEventListener('click', endSession);
  byId('clear-activity').addEventListener('click', () => {
    if (!session) return;
    session.activity.length = 0;
    activityRows = 0;
    byId('activity-list').replaceChildren();
  });
  byId('save-name').addEventListener('click', () => {
    const name = AppMessages.nickname(byId('nickname').value);
    if (!AppMessages.send(state.peer, 'device-name', { name })) {
      byId('name-feedback').textContent = 'Enter a name and check that the connection is open.';
      return;
    }
    localDeviceLabel.textContent = byId('nickname').value = name;
    (state.role === 'host' ? transferLabelSender : transferLabelReceiver).textContent = name;
    byId('name-feedback').textContent = 'Name shared.';
  });
  byId('new-code').addEventListener('click', regenerateCode);
  for (const id of ['copy-code', 'copy-link']) {
    byId(id).addEventListener('click', async () => {
      if (!state.code) return;
      const value = id === 'copy-code' ? state.code : pairingLink();
      const attempt = pairingAttempt;
      let message;
      try {
        await navigator.clipboard.writeText(value);
        message = 'Copied.';
      } catch {
        message = 'Select and copy manually: ' + value;
      }
      if (attempt === pairingAttempt) byId('pairing-feedback').textContent = message;
    });
  }

  // Navigation Event Listeners
  btnStartSend.addEventListener('click', startHostFlow);
  btnStartReceive.addEventListener('click', startJoinFlow);
  btnCancelHost.addEventListener('click', resetApp);
  btnCancelJoin.addEventListener('click', resetApp);
  btnDisconnect.addEventListener('click', endSession);
  brandLink.addEventListener('click', (e) => {
    e.preventDefault();
    endSession();
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

  // Native dialogs contain keyboard focus and restore it to the invoking control.
  let diagnosticsTimer;
  for (const button of modalButtons) {
    button.addEventListener('click', event => {
      event.preventDefault();
      const dialog = byId(button.dataset.modal);
      if (dialog.id === 'modal-help') {
        renderDiagnostics();
        clearInterval(diagnosticsTimer);
        diagnosticsTimer = setInterval(renderDiagnostics, 1000);
      }
      dialog.showModal();
    });
  }
  for (const button of modalCloseButtons) button.onclick = () => button.closest('dialog').close();
  for (const dialog of modalOverlays) {
    dialog.onclick = event => { if (event.target === dialog) dialog.close(); };
    dialog.onclose = () => { if (dialog.id === 'modal-help') clearInterval(diagnosticsTimer); };
  }

  // Check URL parameters for ?join=CODE
  const urlParams = new URLSearchParams(window.location.search);
  const joinParam = urlParams.get('join');
  if (joinParam) {
    startJoinFlow();
    joinCodeInput.value = joinParam.toUpperCase();
    handleJoinSubmit();
  }
});
