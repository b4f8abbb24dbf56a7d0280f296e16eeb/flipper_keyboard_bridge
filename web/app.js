import {
    PACKET_SIZE,
    SERIAL_CAPACITY,
    buildHidStatePacket,
    buildPingPacket,
    buildStatePacket,
    isMappedCode,
    parseFlowCredit,
    textToKeystrokes,
} from "./hid.js";

const SERVICE_UUID = "8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000";
const RX_UUID = "19ed82ae-ed21-4c9d-4145-228e62fe0000";
const TX_UUID = "19ed82ae-ed21-4c9d-4145-228e61fe0000";
const FLOW_UUID = "19ed82ae-ed21-4c9d-4145-228e63fe0000";

const FLOW_WAIT_MS = 1200;
const FLOW_POLL_MS = 400;
const HEARTBEAT_MS = 1000;
const PING_INTERVAL_MS = 2000;
const PONG_TIMEOUT_MS = 7000;
const MAX_LOG_ENTRIES = 80;
const MAX_PASTE_CHARS = 5000;
const TYPE_PRESS_MS = 40;
const TYPE_RELEASE_MS = 15;
const BRIDGE_PREFIX = "HKB1";

const $ = (id) => document.getElementById(id);

const els = {
    statusDot: $("statusDot"),
    statusText: $("statusText"),
    statusDetail: $("statusDetail"),
    connectBtn: $("connectBtn"),
    chooseBtn: $("chooseBtn"),
    disconnectBtn: $("disconnectBtn"),
    releaseBtn: $("releaseBtn"),
    allDevicesBtn: $("allDevicesBtn"),
    deviceName: $("deviceName"),
    usbStatus: $("usbStatus"),
    pad: $("capturePad"),
    padHint: $("padHint"),
    pressedKeys: $("pressedKeys"),
    packets: $("packets"),
    keyCount: $("keyCount"),
    bufferValue: $("bufferValue"),
    pasteBox: $("pasteBox"),
    pasteInfo: $("pasteInfo"),
    typeTextBtn: $("typeTextBtn"),
    stopTypingBtn: $("stopTypingBtn"),
    typeProgress: $("typeProgress"),
    countdownToggle: $("countdownToggle"),
    log: $("log"),
    clearLogBtn: $("clearLogBtn"),
    supportWarning: $("supportWarning"),
};

const boundDevices = new WeakSet();

const state = {
    device: null,
    rx: null,
    tx: null,
    flow: null,
    connected: false,
    connecting: false,
    pressed: new Set(),
    credit: SERIAL_CAPACITY,
    capacity: SERIAL_CAPACITY,
    writing: false,
    pumping: false,
    stateDirty: false,
    packets: 0,
    keys: 0,
    notificationsStarted: false,
    flowWaiters: new Set(),
    writeMode: "unknown",
    expectedDisconnect: false,
    supported: true,

    fapVerified: false,
    usbReady: false,
    txNotifying: false,
    session: 0,
    pingSeq: 0,
    lastPongSeq: -1,
    pingTimer: null,
    pinging: false,
    lastPongAt: 0,

    typing: false,
    typingCancel: false,
    typingRun: 0,
    typingTotal: 0,
    typingIndex: 0,
    typingDone: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message, level = "info") {
    const entry = document.createElement("div");
    entry.className = `log-entry log-entry--${level}`;

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const text = document.createElement("span");
    text.textContent = message;

    entry.append(time, text);
    els.log.prepend(entry);

    while(els.log.children.length > MAX_LOG_ENTRIES) {
        els.log.lastElementChild.remove();
    }
}

function setStatus(kind, text, detail = "") {
    els.statusDot.className = `status-dot status-dot--${kind}`;
    els.statusText.textContent = text;
    els.statusDetail.textContent = detail;
}

function isCaptureReady() {
    return state.connected && state.fapVerified && state.usbReady && !state.typing;
}

function setCaptureVisual() {
    const focused = document.activeElement === els.pad;
    const ready = isCaptureReady();
    els.pad.classList.toggle("capture-pad--focused", focused && ready);
    els.pad.classList.toggle("capture-pad--muted", !ready);

    if(!state.connected) {
        els.padHint.textContent = "Connect the Flipper to start";
    } else if(state.connecting) {
        els.padHint.textContent = "Verifying the Flipper app…";
    } else if(!state.fapVerified) {
        els.padHint.textContent = "Bridge not verified";
    } else if(!state.usbReady) {
        els.padHint.textContent = "Plug the Flipper into the host";
    } else if(state.typing) {
        els.padHint.textContent = "Typing pasted text…";
    } else if(focused) {
        els.padHint.textContent = "Listening — type now";
    } else {
        els.padHint.textContent = "Click here to capture the keyboard";
    }
}

function updatePressedKeys() {
    if(state.pressed.size === 0) {
        els.pressedKeys.textContent = "—";
        return;
    }

    els.pressedKeys.textContent = [...state.pressed]
        .map((code) => code.replace(/^(Key|Digit)/, ""))
        .join(" + ");
}

function updatePasteInfo() {
    els.pasteInfo.textContent = `${els.pasteBox.value.length} / ${MAX_PASTE_CHARS}`;
}

function updateStats() {
    els.packets.textContent = String(state.packets);
    els.keyCount.textContent = String(state.keys);
    els.bufferValue.textContent = `${state.credit} B`;
    els.deviceName.textContent = state.device?.name || "No device selected";
    els.usbStatus.textContent = state.connected
        ? state.usbReady
            ? "READY"
            : "NOT CONNECTED"
        : "—";
    updatePressedKeys();
}

function updateButtons() {
    els.connectBtn.disabled = !state.supported || state.connecting || state.connected;
    els.chooseBtn.disabled = !state.supported || state.connecting || state.connected;
    els.disconnectBtn.disabled = !state.connected;
    els.releaseBtn.disabled = !state.connected || state.typing;
    els.allDevicesBtn.disabled = !state.supported;
    els.typeTextBtn.disabled =
        !state.connected ||
        !state.fapVerified ||
        !state.usbReady ||
        state.typing ||
        state.connecting;
    els.stopTypingBtn.disabled = !state.typing;
    els.countdownToggle.disabled = state.typing;
    els.pasteBox.disabled = state.typing;

    els.connectBtn.textContent = state.connecting
        ? "Connecting…"
        : state.device && !state.connected
          ? "Reconnect"
          : "Connect Flipper";
    els.chooseBtn.hidden = !state.device;
}

function updateUI() {
    updateStats();
    updateButtons();
    setCaptureVisual();
    updatePasteInfo();
}

function resetConnectionState() {
    stopKeepalive();
    state.connected = false;
    state.rx = null;
    state.tx = null;
    state.flow = null;
    state.pressed.clear();
    state.credit = 0;
    state.capacity = SERIAL_CAPACITY;
    state.notificationsStarted = false;
    state.stateDirty = false;
    state.fapVerified = false;
    state.usbReady = false;
    state.txNotifying = false;
    state.pinging = false;
    state.lastPongAt = 0;
    state.lastPongSeq = -1;
    state.session = 0;
    state.pingSeq = 0;
    state.typingRun++;
    state.typing = false;
    state.typingCancel = true;
    if(els.typeProgress) els.typeProgress.textContent = "Ready";
    resolveFlowWaiters();
}

function finishDisconnect(reason = "") {
    resetConnectionState();
    if(reason) log(reason, "warn");
    setStatus("offline", "Not connected", "Start the Flipper app and connect again.");
    updateUI();
}

function resolveFlowWaiters() {
    for(const resolve of [...state.flowWaiters]) resolve();
    state.flowWaiters.clear();
}

function onFlowChanged(event) {
    const credit = parseFlowCredit(event.target.value);
    if(credit > 0) {
        state.credit = credit;
        state.capacity = Math.max(state.capacity, credit);
        updateStats();
    }
    resolveFlowWaiters();
}

function waitForFlow(ms) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if(settled) return;
            settled = true;
            state.flowWaiters.delete(finish);
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        state.flowWaiters.add(finish);
    });
}

async function readFlowCredit() {
    if(!state.flow) return 0;
    try {
        const value = await state.flow.readValue();
        const credit = parseFlowCredit(value);
        if(credit > 0) {
            state.credit = credit;
            state.capacity = Math.max(state.capacity, credit);
            updateStats();
        }
        return credit;
    } catch(error) {
        log(`Flow-control read failed: ${error.message}`, "warn");
        return 0;
    }
}

async function waitForCredit(bytes) {
    const deadline = performance.now() + FLOW_WAIT_MS;
    let readAttempts = 0;

    while(state.connected && state.credit < bytes) {
        const remaining = deadline - performance.now();
        if(remaining <= 0) break;

        await waitForFlow(Math.min(remaining, FLOW_POLL_MS));

        if(state.connected && state.credit < bytes && readAttempts < 3) {
            readAttempts++;
            await readFlowCredit();
        }
    }

    if(state.credit < bytes && state.connected) {
        // One small overshoot wakes up the Flipper's flow-control reset. This
        // only happens if a notification was lost; normal operation never
        // needs it because 486 is an exact multiple of 9.
        log("Flow control stalled — retrying with one packet", "warn");
        state.credit = bytes;
    }
}

async function writePacket(packet, forceResponse = false) {
    if(!state.rx) throw new Error("No RX characteristic");

    if(forceResponse) {
        await state.rx.writeValue(packet);
        return;
    }

    if(state.writeMode !== "response" && state.rx.properties.writeWithoutResponse) {
        try {
            await state.rx.writeValueWithoutResponse(packet);
            state.writeMode = "no-response";
            return;
        } catch(error) {
            if(error.name !== "NotSupportedError") throw error;
            log("Write-without-response unavailable; using acknowledged writes", "warn");
        }
    }

    await state.rx.writeValue(packet);
    state.writeMode = "response";
}

async function acquireGatt() {
    while(state.writing) {
        await sleep(5);
    }
    state.writing = true;
}

function releaseGatt() {
    state.writing = false;
}

async function withGatt(task) {
    await acquireGatt();
    try {
        return await task();
    } finally {
        releaseGatt();
    }
}

function handleSendError(error) {
    log(`Send failed: ${error.name}: ${error.message}`, "error");

    if(
        error.name === "NetworkError" ||
        error.name === "InvalidStateError" ||
        /disconnect|not connected/i.test(error.message)
    ) {
        state.expectedDisconnect = true;
        state.device?.gatt?.disconnect();
        resetConnectionState();
        setStatus("error", "BLE link lost", "Reconnect to continue.");
        updateUI();
    } else if(error.name === "SecurityError" || /auth|pair/i.test(error.message)) {
        state.expectedDisconnect = true;
        state.device?.gatt?.disconnect();
        resetConnectionState();
        setStatus(
            "error",
            "Pairing problem",
            "Confirm the PIN on the Flipper, or pair it in system Bluetooth settings and reconnect.",
        );
        log(
            "Pairing/security error. Confirm the PIN on the Flipper. If no prompt appears, pair the Flipper in the OS Bluetooth settings first.",
            "error",
        );
        updateUI();
    } else {
        setStatus("error", "Send failed", error.message);
    }
}

async function pump() {
    if(!state.connected || state.pumping) return;
    state.pumping = true;

    try {
        while(state.connected && state.stateDirty && !state.typing) {
            state.stateDirty = false;
            await withGatt(async () => {
                if(!state.connected || state.typing) return;
                await waitForCredit(PACKET_SIZE);
                if(!state.connected || state.typing) return;

                const packet = buildStatePacket(state.pressed);
                await writePacket(packet);
                state.credit = Math.max(0, state.credit - packet.length);
                state.packets++;
                updateStats();
            });
        }
    } catch(error) {
        handleSendError(error);
    } finally {
        state.pumping = false;
        if(state.connected && state.stateDirty && !state.typing) {
            void pump();
        }
    }
}

function sendState() {
    if(!state.connected || state.typing) return;
    state.stateDirty = true;
    void pump();
}

function releaseAll(reason = "Keys released") {
    if(state.typing) {
        stopTyping();
        return;
    }
    state.pressed.clear();
    sendState();
    updateUI();
    if(reason) log(reason);
}

async function sendExactState(mods, usages, forceResponse = false) {
    if(!state.connected) throw new Error("Disconnected");
    await withGatt(async () => {
        if(!state.connected) throw new Error("Disconnected");
        await waitForCredit(PACKET_SIZE);
        if(!state.connected) throw new Error("Disconnected");

        const packet = buildHidStatePacket(mods, usages);
        await writePacket(packet, forceResponse);
        state.credit = Math.max(0, state.credit - packet.length);
        state.packets++;
        updateStats();
    });
}

function stopTyping() {
    if(!state.typing) return;
    state.typingCancel = true;
    els.typeProgress.textContent = "Stopping…";
    log("Stopping typing…", "warn");
}

async function typePastedText() {
    if(!state.connected || !state.fapVerified || !state.usbReady || state.typing) {
        if(state.connected && state.fapVerified && !state.usbReady) {
            setStatus(
                "error",
                "USB not connected",
                "Plug the Flipper into the target host and wait for USB READY.",
            );
        }
        return;
    }

    const text = els.pasteBox.value
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");

    if(text.length === 0) {
        setStatus("error", "Nothing to type", "Paste or type some text first.");
        els.pasteBox.focus();
        return;
    }
    if(text.length > MAX_PASTE_CHARS) {
        setStatus("error", "Text is too long", `Limit is ${MAX_PASTE_CHARS} characters.`);
        return;
    }

    const { actions, unsupported } = textToKeystrokes(text);
    if(unsupported.length > 0) {
        const preview = unsupported.slice(0, 8).join("");
        setStatus(
            "error",
            "Unsupported characters",
            `ASCII only. Remove: ${preview}${unsupported.length > 8 ? "…" : ""}`,
        );
        log(`Paste rejected: ${unsupported.length} unsupported character(s)`, "warn");
        return;
    }
    if(actions.length === 0) {
        setStatus("error", "Nothing to type", "No printable characters found.");
        return;
    }

    const run = ++state.typingRun;
    state.typing = true;
    state.typingCancel = false;
    state.typingTotal = actions.length;
    state.typingIndex = 0;
    state.typingDone = 0;
    state.pressed.clear();
    state.stateDirty = false;
    setStatus(
        "connected",
        "Connected",
        `Typing ${actions.length} character${actions.length === 1 ? "" : "s"} via USB HID`,
    );
    log(`Typing ${actions.length} character(s) as USB HID`);
    updateUI();

    let completed = false;
    let failed = false;

    try {
        await sendExactState(0, [], true);
        if(state.typingCancel || state.typingRun !== run) throw new Error("Cancelled");

        if(els.countdownToggle.checked) {
            for(let remaining = 3; remaining > 0; remaining--) {
                if(state.typingCancel || !state.connected || state.typingRun !== run) {
                    throw new Error("Cancelled");
                }
                els.typeProgress.textContent = `Starting in ${remaining}…`;
                await sleep(1000);
            }
        }

        for(let i = 0; i < actions.length; i++) {
            if(state.typingCancel || !state.connected || state.typingRun !== run) {
                throw new Error("Cancelled");
            }

            state.typingIndex = i;
            els.typeProgress.textContent = `Typing ${i + 1} / ${actions.length}`;
            const action = actions[i];

            await sendExactState(action.mods, [action.usage], true);
            await sleep(TYPE_PRESS_MS);
            await sendExactState(0, [], true);
            await sleep(TYPE_RELEASE_MS);
            state.typingDone = i + 1;
        }

        completed = !state.typingCancel && state.typingDone >= actions.length;
    } catch(error) {
        if(
            state.typingRun === run &&
            error.message !== "Cancelled" &&
            state.connected &&
            !state.expectedDisconnect
        ) {
            failed = true;
            log(`Typing failed: ${error.message}`, "error");
            handleSendError(error);
        }
    } finally {
        if(state.typingRun !== run) return;

        if(state.connected) {
            try {
                await sendExactState(0, [], true);
            } catch(_) {
                // The disconnect path already released keys on the Flipper.
            }
        }

        state.typing = false;
        state.typingCancel = false;
        els.typeProgress.textContent = completed
            ? `Typed ${actions.length} character${actions.length === 1 ? "" : "s"}`
            : `Stopped at ${state.typingDone} / ${actions.length}`;
        log(completed ? "Paste typing complete" : "Paste typing stopped");
        updateUI();
        if(!failed) updateBridgeDetail();
    }
}

function newSessionToken() {
    if(globalThis.crypto?.getRandomValues) {
        const value = new Uint16Array(1);
        crypto.getRandomValues(value);
        return value[0] || 1;
    }
    return (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
}

function updateUsbFromLine(line) {
    const match = /\bUSB=([01])\b/.exec(line);
    if(!match) return;
    const ready = match[1] === "1";
    if(ready !== state.usbReady) {
        state.usbReady = ready;
        updateBridgeDetail();
        updateUI();
    }
}

function processBridgeText(text, expectedSession, expectedSequence) {
    let matched = false;

    for(const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if(!line.startsWith(BRIDGE_PREFIX)) continue;

        updateUsbFromLine(line);

        const match = /^HKB1\s+PONG\s+([0-9A-Fa-f]{4})\s+(\d+)\b/.exec(line);
        if(!match) continue;

        const session = parseInt(match[1], 16);
        const sequence = Number(match[2]);
        if(session === expectedSession && sequence === expectedSequence) {
            matched = true;
        }
    }

    return matched;
}

function updateBridgeDetail() {
    if(!state.connected || state.connecting || !state.fapVerified) return;
    setStatus(
        "connected",
        "Connected",
        `Verified BLE Keyboard Bridge · USB ${state.usbReady ? "READY" : "not connected"}`,
    );
}

async function readTxText() {
    if(!state.tx) return "";
    const value = await state.tx.readValue();
    return new TextDecoder().decode(value);
}

function onTxStatus(event) {
    if(!state.connected || !state.tx || !event.target.value) return;
    const text = new TextDecoder().decode(event.target.value);
    const matched = processBridgeText(text, state.session, state.pingSeq);

    if(!matched) return;

    const wasVerified = state.fapVerified;
    state.fapVerified = true;
    state.lastPongAt = Date.now();
    state.lastPongSeq = state.pingSeq;
    if(!wasVerified) {
        log("Bridge verified with HKB1 indication");
    }
    updateBridgeDetail();
    updateUI();
}

async function pingOnce() {
    if(!state.connected || !state.tx) return false;

    const sequence = state.pingSeq = (state.pingSeq + 1) & 0xff;
    const packet = buildPingPacket(state.session, sequence);

    await withGatt(async () => {
        if(!state.connected) throw new Error("Disconnected");
        await waitForCredit(PACKET_SIZE);
        if(!state.connected) throw new Error("Disconnected");
        await writePacket(packet);
        state.credit = Math.max(0, state.credit - packet.length);
    });

    for(let attempt = 0; attempt < 2 && state.connected; attempt++) {
        await sleep(attempt === 0 ? 70 : 100);

        if(state.lastPongSeq === sequence) {
            state.lastPongAt = Date.now();
            updateBridgeDetail();
            updateUI();
            return true;
        }

        let text = "";
        try {
            text = await withGatt(readTxText);
        } catch(error) {
            log(`Status read failed: ${error.message}`, "warn");
            if(state.txNotifying) {
                for(let i = 0; i < 10 && state.connected; i++) {
                    if(state.lastPongSeq === sequence) {
                        state.lastPongAt = Date.now();
                        updateBridgeDetail();
                        updateUI();
                        return true;
                    }
                    await sleep(50);
                }
            }
            return false;
        }

        if(processBridgeText(text, state.session, sequence)) {
            const wasVerified = state.fapVerified;
            state.fapVerified = true;
            state.lastPongAt = Date.now();
            state.lastPongSeq = sequence;

            if(!wasVerified) {
                log("Bridge verified with HKB1 ping/pong");
            }
            updateBridgeDetail();
            updateUI();
            return true;
        }
    }

    return false;
}

function markBridgeLost(reason) {
    if(!state.connected) return;

    state.fapVerified = false;
    state.usbReady = false;
    stopTyping();
    state.pressed.clear();
    state.stateDirty = true;
    void pump();
    setStatus(
        "error",
        "Bridge not responding",
        `${reason}. Open BLE Keyboard Bridge on the Flipper, then reconnect.`,
    );
    log(`Bridge verification lost: ${reason}`, "error");
    updateUI();
}

function stopKeepalive() {
    if(state.pingTimer) {
        clearInterval(state.pingTimer);
        state.pingTimer = null;
    }
}

function startKeepalive() {
    stopKeepalive();
    state.pingTimer = setInterval(() => {
        void keepalivePing();
    }, PING_INTERVAL_MS);
}

async function keepalivePing() {
    if(!state.connected || state.pinging) return;

    state.pinging = true;
    try {
        await pingOnce();

        if(
            state.connected &&
            state.fapVerified &&
            !state.typing &&
            Date.now() - state.lastPongAt > PONG_TIMEOUT_MS
        ) {
            markBridgeLost("Keepalive timed out");
        }
    } catch(error) {
        handleSendError(error);
    } finally {
        state.pinging = false;
    }
}

async function verifyBridge() {
    for(let attempt = 0; attempt < 3 && state.connected; attempt++) {
        if(await pingOnce()) return true;
        if(attempt < 2) await sleep(250);
    }
    return false;
}

function chooseDevice(showAll = false) {
    const filters = [
        { namePrefix: "Flipper" },
        { services: [0x3080] },
        { services: [0x3081] },
        { services: [0x3082] },
        { services: [0x3083] },
    ];

    const options = showAll
        ? {
              acceptAllDevices: true,
              optionalServices: [SERVICE_UUID],
          }
        : {
              filters,
              optionalServices: [SERVICE_UUID],
          };

    return navigator.bluetooth.requestDevice(options);
}

function pairingHint(error) {
    const message = `${error?.message || ""}`.toLowerCase();
    if(
        error?.name === "SecurityError" ||
        error?.name === "NotAllowedError" ||
        /pair|auth|security|permission|not permitted|denied/.test(message)
    ) {
        return "Pairing failed. Confirm the PIN on the Flipper. If no prompt appears, pair the Flipper in your OS Bluetooth settings, then click Reconnect.";
    }
    if(error?.name === "NotFoundError" && /cancel|chooser|user/.test(message)) {
        return "No device selected.";
    }
    if(/gatt|network|disconnected/.test(message)) {
        return "Bluetooth connection failed. Wake the Flipper, keep the app open, and try again.";
    }
    return error?.message || String(error);
}

async function connectToDevice(device) {
    state.connecting = true;
    state.expectedDisconnect = false;
    setStatus("connecting", "Connecting…", "Pairing may ask for a PIN shown on the Flipper.");
    updateButtons();

    try {
        if(device.gatt.connected) {
            device.gatt.disconnect();
            for(let i = 0; i < 40 && device.gatt.connected; i++) {
                await sleep(50);
            }
        }

        const server = await device.gatt.connect();
        log(`Connected to GATT: ${device.name || "Flipper"}`);

        const service = await server.getPrimaryService(SERVICE_UUID);
        const rx = await service.getCharacteristic(RX_UUID);
        const tx = await service.getCharacteristic(TX_UUID);
        const flow = await service.getCharacteristic(FLOW_UUID);

        // RX is authenticated. Reading it (and the zero-state probe below)
        // gives the OS a chance to start the pairing flow.
        try {
            await rx.readValue();
            log("Authenticated read OK");
        } catch(error) {
            log(`Authenticated read: ${error.message}`, "warn");
        }

        const initialCredit = await (async () => {
            try {
                return parseFlowCredit(await flow.readValue());
            } catch(error) {
                log(`Could not read flow control: ${error.message}`, "warn");
                return SERIAL_CAPACITY;
            }
        })();

        state.rx = rx;
        state.tx = tx;
        state.flow = flow;
        state.credit = initialCredit > 0 ? initialCredit : SERIAL_CAPACITY;
        state.capacity = state.credit;
        state.session = newSessionToken();
        state.pingSeq = 0;
        state.lastPongAt = 0;

        try {
            await flow.startNotifications();
            flow.addEventListener("characteristicvaluechanged", onFlowChanged);
            state.notificationsStarted = true;
            log("Flow-control notifications enabled");
        } catch(error) {
            log(`Flow notifications unavailable: ${error.message}`, "warn");
        }

        // Optional: indications give instant USB status. Reading TX after each
        // ping still works if indications are unavailable.
        try {
            await tx.startNotifications();
            tx.addEventListener("characteristicvaluechanged", onTxStatus);
            state.txNotifying = true;
            log("Bridge status indications enabled");
        } catch(error) {
            log(`TX indications unavailable; using reads (${error.message})`, "warn");
        }

        // Give the FAP's main loop a moment to reclaim the serial callback
        // after the BT service's connect-time RPC setup.
        await sleep(250);

        // Probe with a zero state. This verifies the auth/bonded link and makes
        // the Flipper release any keys left over from a previous session.
        await rx.writeValue(buildStatePacket([]));
        state.credit = Math.max(0, state.credit - PACKET_SIZE);
        log("Zero-state probe sent");

        state.connected = true;
        state.connecting = true;
        state.expectedDisconnect = false;
        state.fapVerified = false;
        state.usbReady = false;
        setStatus(
            "connecting",
            "Verifying bridge…",
            "Waiting for the proprietary HKB1 handshake.",
        );
        updateUI();

        if(!(await verifyBridge())) {
            throw new Error(
                "BLE Keyboard Bridge did not answer the HKB1 handshake. Open the app on the Flipper and reconnect.",
            );
        }

        state.connecting = false;
        state.fapVerified = true;
        state.lastPongAt = Date.now();
        startKeepalive();
        setStatus(
            "connected",
            "Connected",
            `Verified BLE Keyboard Bridge · USB ${state.usbReady ? "READY" : "not connected"}`,
        );
        updateUI();
        log("Bridge verified. Live capture and paste mode are ready.");

        // Focus must happen after the connection click finishes.
        setTimeout(() => {
            if(state.connected) els.pad.focus();
        }, 50);
    } catch(error) {
        state.connecting = false;
        if(device.gatt.connected) {
            state.expectedDisconnect = true;
            device.gatt.disconnect();
        } else {
            state.expectedDisconnect = false;
        }

        resetConnectionState();
        setStatus("error", "Connection failed", pairingHint(error));
        log(`Connection failed: ${error.name}: ${error.message}`, "error");
        log(pairingHint(error), "warn");
        updateUI();
    }
}

async function connect(showAll = false, pickNew = false) {
    if(!state.supported || state.connecting || state.connected) return;

    if(state.device && !pickNew) {
        await connectToDevice(state.device);
        return;
    }

    state.connecting = true;
    updateButtons();
    setStatus("connecting", "Choose a device", "Select your Flipper in the browser dialog.");

    try {
        const device = await chooseDevice(showAll);
        if(!boundDevices.has(device)) {
            device.addEventListener("gattserverdisconnected", onGattDisconnected);
            boundDevices.add(device);
        }
        state.device = device;
        state.connecting = false;
        updateUI();
        await connectToDevice(device);
    } catch(error) {
        state.connecting = false;
        updateButtons();
        if(error.name === "NotFoundError") {
            setStatus("offline", "No device selected", "Press Connect to try again.");
            log("Device chooser closed.", "warn");
        } else {
            setStatus("error", "Could not open chooser", pairingHint(error));
            log(`Device chooser failed: ${error.name}: ${error.message}`, "error");
        }
    }
}

function onGattDisconnected() {
    state.expectedDisconnect = false;
    if(!state.connected) {
        updateUI();
        return;
    }
    finishDisconnect("Flipper disconnected.");
}

function disconnect() {
    state.expectedDisconnect = true;
    resetConnectionState();
    if(state.device?.gatt?.connected) {
        state.device.gatt.disconnect();
    }
    setStatus("offline", "Disconnected", "Press Reconnect or choose another device.");
    log("Disconnected from Flipper.");
    updateUI();
}

function mappedKeyDown(event) {
    if(!isCaptureReady()) return;
    if(document.activeElement !== els.pad) return;
    if(event.isComposing || event.key === "Process") return;

    if(!isMappedCode(event.code)) {
        // Unmapped keys (media keys, browser-level shortcuts, etc.) are left
        // to the browser. Mapped keys are fully captured.
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    if(event.repeat) return;

    state.pressed.add(event.code);
    state.keys++;
    sendState();
    updateUI();
}

function mappedKeyUp(event) {
    if(!state.connected) return;
    if(!state.pressed.has(event.code)) return;

    if(document.activeElement === els.pad) {
        event.preventDefault();
        event.stopPropagation();
    }

    state.pressed.delete(event.code);
    sendState();
    updateUI();
}

function bindEvents() {
    els.connectBtn.addEventListener("click", () => void connect(false, false));
    els.chooseBtn.addEventListener("click", () => void connect(false, true));
    els.allDevicesBtn.addEventListener("click", () => void connect(true, true));
    els.disconnectBtn.addEventListener("click", disconnect);
    els.releaseBtn.addEventListener("click", () => releaseAll("Release-all sent"));
    els.typeTextBtn.addEventListener("click", () => void typePastedText());
    els.stopTypingBtn.addEventListener("click", stopTyping);

    els.clearLogBtn.addEventListener("click", () => {
        els.log.replaceChildren();
    });

    els.pasteBox.addEventListener("input", updatePasteInfo);
    els.pasteBox.addEventListener("keydown", (event) => {
        if((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void typePastedText();
        }
    });

    els.pad.addEventListener("keydown", mappedKeyDown);
    els.pad.addEventListener("keyup", mappedKeyUp);
    els.pad.addEventListener("click", () => {
        if(isCaptureReady()) els.pad.focus();
    });
    els.pad.addEventListener("focus", setCaptureVisual);
    els.pad.addEventListener("blur", () => {
        setCaptureVisual();
        if(state.pressed.size > 0) {
            releaseAll("Capture paused — keys released");
        }
    });

    window.addEventListener("blur", () => {
        if(state.pressed.size > 0) releaseAll("Window lost focus — keys released");
    });

    document.addEventListener("visibilitychange", () => {
        if(document.hidden && state.pressed.size > 0 && !state.typing) {
            releaseAll("Tab hidden — keys released");
        }
    });

    setInterval(() => {
        if(state.connected && state.fapVerified && !state.typing && state.pressed.size > 0) {
            sendState();
        }
    }, HEARTBEAT_MS);
}

function checkSupport() {
    const problems = [];
    if(!window.isSecureContext) {
        problems.push(
            "This page is not a secure context. Open the GitHub Pages HTTPS URL.",
        );
    }
    if(!("bluetooth" in navigator)) {
        problems.push(
            "Web Bluetooth is not available. Use Chrome or Edge on desktop, or Chrome on Android.",
        );
    }

    state.supported = problems.length === 0;
    if(!state.supported) {
        els.supportWarning.hidden = false;
        els.supportWarning.textContent = problems.join(" ");
        setStatus("error", "Web Bluetooth unavailable", problems[0]);
        log(problems.join(" "), "error");
        updateButtons();
        return false;
    }

    els.supportWarning.hidden = true;
    updateButtons();
    return true;
}

function init() {
    bindEvents();
    updateUI();
    setStatus("offline", "Not connected", "Start the Flipper app, then press Connect.");
    log("Ready. Start BLE Keyboard Bridge on the Flipper and pair from this page.");
    checkSupport();
}

init();
