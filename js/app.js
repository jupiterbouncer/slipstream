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
  const textSharing = setupTextSharing(byId, () => state.peer, participantName, recordActivity);
  const verifiedFiles = byId('verified-files');
  const savedFiles = byId('saved-files');
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
      const time = document.createElement('time');
      const date = new Date(event.time);
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const description = document.createElement('span');
      if (event.person) {
        const name = document.createElement('strong');
        name.dataset.person = event.person;
        name.textContent = participantName(event.person);
        description.append(name, ' ');
      }
      description.append(event.message);
      row.append(time, description);
      list.append(row);
    }
    const now = Date.now();
    const seconds = (start, end) => Math.max(0, Math.floor((end - start) / 1000)) + 's';
    const elapsed = session.transferStarted === null ? '—' : seconds(session.transferStarted, session.transferEnded ?? now);
    byId('session-stats').textContent = [
      session.verified + ' verified files', formatFileSize(session.bytes) + ' shared',
      session.skipped + ' declined or cancelled', 'Transfer ' + elapsed, 'Session ' + seconds(session.started, now),
    ].join(' · ');
  }

  function recordActivity(message, person) {
    session?.record(message, person);
    renderSession();
  }

  function beginSession() {
    session = new SharingSession();
    if (state.role === 'host') queue = new FileQueue(startFileSend, renderQueue);
    requests = new FileRequests(state.peer, message => {
      byId('request-status').textContent = message;
      byId('request-file').disabled = !!requests.pending;
      byId('request-choice').hidden = !(requests.pending && state.role === 'host');
      if (requests.pending && state.role === 'host' && byId('view-files').hidden) byId('tab-files').classList.add('unread');
      recordActivity(message);
    });
    byId('request-file').hidden = state.role !== 'joiner';
    renderQueue();
    byId('session-tools').hidden = false;
    byId('nickname').value = localDeviceLabel.textContent = state.role === 'host' ? 'Sender' : 'Receiver';
    peerDeviceLabel.textContent = state.role === 'host' ? 'Receiver' : 'Sender';
    refreshNames();
    selectView('files');
    renderRoute();
    recordActivity('connected', 'peer');
    AppMessages.send(state.peer, 'device-name', { name: localDeviceLabel.textContent });
    sessionTimer = setInterval(() => {
      if (!byId('view-activity').hidden) renderSession();
      renderRoute();
    }, 1000);
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
    byId('tab-files').classList.remove('unread');
    byId('session-stats').textContent = byId('name-feedback').textContent = '';
    byId('nickname').value = '';
    transferLabelSender.textContent = 'Sender';
    transferLabelReceiver.textContent = 'Receiver';
    localDeviceLabel.textContent = 'This device';
    peerDeviceLabel.textContent = 'Peer device';
  }

  function receiveApplicationMessage(message) {
    if (!session) return;
    if (message.type === 'file-request' || message.type === 'file-request-result') requests?.receive(message);
    if (message.type === 'share-text') textSharing.receive(message.text);
    if (message.type === 'device-name') {
      peerDeviceLabel.textContent = message.name;
      refreshNames();
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
    failed: byId('screen-failed'),
  };

  // Navigation & Brand
  const btnStartSend = document.getElementById('btn-start-send');
  const btnStartReceive = document.getElementById('btn-start-receive');
  const btnCancelHost = document.getElementById('btn-cancel-host');
  const btnCancelJoin = document.getElementById('btn-cancel-join');
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
      'Selected route (last observed)': snapshot.selectedRoute?.route,
      'Selected path type': snapshot.selectedRoute?.kind,
      'Selected local / remote types': [snapshot.selectedRoute?.local, snapshot.selectedRoute?.remote].filter(Boolean).join(' / '),
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
    const blob = new Blob([JSON.stringify({ build: 'workspace1', snapshot, entries }, null, 2)], { type: 'application/json' });
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
    byId('home-notice').hidden = true;
    const workspaceOpen = screenName === 'connected';
    document.body.classList.toggle('in-workspace', workspaceOpen);
    document.querySelector('.settings-trigger').hidden = !workspaceOpen;
  }

  const tabs = Array.from(document.querySelectorAll('.workspace-rail [role="tab"]'));
  function selectView(name) {
    const next = byId('tab-' + name);
    const previous = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
    for (const tab of tabs) {
      const active = tab === next;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = byId(tab.getAttribute('aria-controls'));
      panel.style.setProperty('--slide-from', tabs.indexOf(next) < tabs.indexOf(previous) ? '-8px' : '8px');
      panel.hidden = !active;
    }
    next.classList.remove('unread');
    if (name === 'activity') renderSession();
    if (name === 'messages') byId('received-text').scrollTop = byId('received-text').scrollHeight;
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => selectView(tab.id.slice(4));
    tab.onkeydown = event => {
      const target = { ArrowDown: (index + 1) % tabs.length, ArrowUp: (index + tabs.length - 1) % tabs.length,
        Home: 0, End: tabs.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      tabs[target].click();
      tabs[target].focus();
    };
  });

  function participantName(person) {
    return (person === 'local' ? localDeviceLabel : peerDeviceLabel).textContent;
  }
  function refreshNames() {
    for (const label of document.querySelectorAll('[data-person]')) label.textContent = participantName(label.dataset.person);
    transferLabelSender.textContent = participantName(state.role === 'host' ? 'local' : 'peer');
    transferLabelReceiver.textContent = participantName(state.role === 'host' ? 'peer' : 'local');
    receiverStatusMsg.textContent = 'Waiting for ' + participantName('peer') + ' to share a file';
    if (state.pendingOffer) incomingFilemeta.textContent = (state.pendingOffer.mimeType || 'File') + ' · from ' + participantName('peer');
  }
  function renderRoute() {
    const route = state.peer?.disconnectStarted == null ? state.peer?.selectedRoute?.route : 'unknown';
    const copy = ({
      direct: 'Direct · DTLS encrypted · Server pairs devices',
      relayed: 'Via TURN · DTLS encrypted · Server pairs devices',
    })[route] || 'DTLS encrypted · Server pairs devices';
    if (byId('security-copy').textContent !== copy) byId('security-copy').textContent = copy;
  }
  function setHeaderConnected(isConnected) {
    const open = isConnected && !!state.peer?.isChannelOpen();
    const recovering = open && state.peer.stage === 'Reconnecting…';
    headerStatus.classList.toggle('connected', open && !recovering);
    headerStatus.classList.toggle('recovering', recovering);
    headerStatusText.textContent = recovering ? 'Reconnecting…' : open ? 'Connected' : 'Local Network';
    byId('send-text').disabled = !open || recovering;
    renderRoute();
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
    pairingAttempt++;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    clearSession();
    pairingControls(false);
    byId('pairing-feedback').textContent = '';
    btnScanQr.disabled = false;
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
    // Keep verified Blobs in this tab, outside the next peer's workspace.
    const savedList = savedFiles.querySelector('ul');
    verifiedFiles.querySelector('#btn-download-file')?.removeAttribute('id');
    const currentList = verifiedFiles.querySelector('ul');
    while (currentList.firstChild) savedList.append(currentList.firstChild);
    savedFiles.hidden = !savedList.children.length;
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

    const address = new URL(location.href);
    if (address.searchParams.has('join')) {
      address.searchParams.delete('join');
      history.replaceState(history.state, '', address);
    }
    if (joinCodeInput) joinCodeInput.value = '';
    if (joinErrorMsg) joinErrorMsg.style.display = 'none';

    // Reset sender file preview
    if (fileInput) fileInput.value = '';

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
    byId('transfer-progress').hidden = stateName === 'idle';
    incomingSection.style.display = 'none';
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

    const row = document.createElement('li');
    const link = document.createElement('a');
    verifiedFiles.querySelector('#btn-download-file')?.removeAttribute('id');
    link.id = 'btn-download-file';
    link.className = 'btn btn-primary';
    link.href = url;
    link.download = filename;
    link.textContent = 'Download';
    row.append(fileDetails(filename, formatFileSize(blob.size)), link,
      actionButton('Preview', () => viewer.open({ name: filename, blob, verified: true })),
      actionButton('Remove', () => {
        URL.revokeObjectURL(url);
        const section = row.closest('section');
        row.remove();
        section.hidden = !section.querySelector('li');
      }));
    verifiedFiles.querySelector('ul').append(row);
    verifiedFiles.hidden = false;
  }

  function fileDetails(name, meta) {
    const info = document.createElement('div');
    info.className = 'file-details';
    const title = document.createElement('strong');
    title.textContent = name;
    const size = document.createElement('small');
    size.textContent = meta;
    info.append(title, size);
    return info;
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
    const link = new URL(location.pathname, location.origin);
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
          if (attempt === pairingAttempt && state.peer?.isChannelOpen()) setHeaderConnected(true);
        },
        onChannelOpen: () => {
          if (attempt !== pairingAttempt || !state.peer?.isChannelOpen()) return;
          setHeaderConnected(true);
          beginSession();
          pairingControls(false);
          senderFileSection.hidden = false;
          if (receiverFileSection) receiverFileSection.style.display = 'none';

          // Trigger subtle device glyph lift and settle (Requirement B)
          connectedDeviceItems.forEach((el) => {
            el.classList.add('device-connected');
          });

          // Initialize Phase 2 sender engine on host (§7.4)
          initializeTransferEngines();

          showScreen('connected');
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
      btnScanQr.disabled = btnSubmitJoin.disabled = true;
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
          if (attempt !== pairingAttempt) return;
          if (state.peer?.isChannelOpen()) setHeaderConnected(true);
          else btnSubmitJoin.textContent = status;
        },
        onChannelOpen: () => {
          if (attempt !== pairingAttempt || !state.peer?.isChannelOpen()) return;
          btnSubmitJoin.disabled = false;
          btnSubmitJoin.textContent = 'Connect to device';
          setHeaderConnected(true);
          beginSession();
          senderFileSection.hidden = true;
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
      btnScanQr.disabled = btnSubmitJoin.disabled = false;
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
    const role = state.role;
    const wasConnected = !!session;
    // The peer calls this only on a terminal error/close, after any ICE grace period.
    resetApp();
    if (wasConnected) {
      byId('home-notice').hidden = false;
      byId('home-notice').textContent = savedFiles.hidden ? 'Connection ended. Pair again to start a new session.'
        : 'Connection ended. Your verified files are still available below.';
    } else {
      state.role = role;
      showScreen('failed');
    }
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
    selectView('files');
    state.pendingOffer = offer;
    state.transferState = 'awaiting-decision';

    if (receiverWaitingBox) {
      receiverWaitingBox.style.display = 'none';
    }

    incomingFilename.textContent = offer.name;
    incomingFilesize.textContent = formatFileSize(offer.size);
    incomingFilemeta.textContent = (offer.mimeType || 'File') + ' · from ' + peerDeviceLabel.textContent;
    incomingSection.style.display = 'flex';
    btnAcceptTransfer.focus({ preventScroll: true });
  }

  /**
   * User accepts incoming offer (§4.2).
   */
  function acceptIncomingTransfer() {
    try {
      updateActiveFileBadge(state.pendingOffer);
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
          if (typeof parsed.message === 'string') textSharing.receive(parsed.message);
        }
      } catch {
        textSharing.receive(data);
      }
    }
  }

  /**
   * Handle File Selection and Drag & Drop (Requirement G)
   */
  function renderQueue() {
    const panel = byId('queue-panel');
    const list = byId('queue-list');
    list.replaceChildren();
    panel.hidden = !queue?.pending.length;
    if (!queue) return;
    for (const [index, file] of queue.pending.entries()) {
      const row = document.createElement('li');
      row.append(fileDetails(file.name, formatFileSize(file.size)),
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
  byId('nickname-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = AppMessages.nickname(byId('nickname').value);
    if (!AppMessages.send(state.peer, 'device-name', { name })) {
      byId('name-feedback').textContent = 'Enter a name and check that the connection is open.';
      return;
    }
    localDeviceLabel.textContent = byId('nickname').value = name;
    refreshNames();
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
  byId('retry-pairing').onclick = retryConnection;
  byId('leave-pairing').onclick = resetApp;
  brandLink.addEventListener('click', (e) => {
    e.preventDefault();
    endSession();
  });

  joinForm.addEventListener('submit', handleJoinSubmit);

  btnScanQr.onclick = setupScanner(byId, code => {
    joinCodeInput.value = code;
    handleJoinSubmit();
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
