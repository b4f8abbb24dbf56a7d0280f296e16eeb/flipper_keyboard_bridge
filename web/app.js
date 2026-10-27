import {
    MOUSE_BUTTON_LEFT,
    MOUSE_BUTTON_MIDDLE,
    MOUSE_BUTTON_RIGHT,
    PACKET_SIZE,
    SERIAL_CAPACITY,
    buildHidStatePacket,
    buildMousePacket,
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
const PING_INTERVAL_MS = 1000;
const PONG_TIMEOUT_MS = 4000;
const MAX_LOG_ENTRIES = 80;
const MAX_PASTE_CHARS = 5000;
const TYPE_PRESS_MS = 20;
const TYPE_RELEASE_MS = 8;
const BRIDGE_PREFIX = "HKB1";

const MOUSE_MOVE_INTERVAL_MS = 16;
const MOUSE_SENSITIVITY = 1;
const TAP_MAX_MOVE = 6;
const TAP_MAX_MS = 500;

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
    leftClickBtn: $("leftClickBtn"),
    rightClickBtn: $("rightClickBtn"),
    pressedKeys: $("pressedKeys"),
    packets: $("packets"),
    keyCount: $("keyCount"),
    bufferValue: $("bufferValue"),
    pasteBox: $("pasteBox"),
    pasteInfo: $("pasteInfo"),
    typeTextBtn: $("typeTextBtn"),
    stopTypingBtn: $("stopTypingBtn"),
    typeProgress: $("typeProgress"),
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

    mouseButtons: 0,
    mouseDx: 0,
    mouseDy: 0,
    mouseWheel: 0,
    mouseFlushTimer: null,
    mouseFlushing: false,

    pointerId: null,
    pointerLastX: 0,
    pointerLastY: 0,
    pointerMoved: 0,
    pointerStart: 0,
    pointerWasFocused: false,

    pointerLocked: false,
    pointerLockSupported: false,
    pointerLockUnsupported: false,
    pointerLockSuppressUntil: 0,
    touchMode: false,
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
    return (
        state.connected &&
        state.fapVerified &&
        state.usbReady &&
        !state.typing &&
        !state.connecting
    );
}

function setCaptureVisual() {
    const focused = document.activeElement === els.pad;
    const ready = isCaptureReady();
    els.pad.classList.toggle("capture-pad--focused", focused && ready);
    els.pad.classList.toggle("capture-pad--muted", !ready);

    if(!state.connected) {
        els.padHint.textContent = "Connect for keyboard + trackpad";
    } else if(state.connecting) {
        els.padHint.textContent = "Verifying the Flipper app…";
    } else if(!state.fapVerified) {
        els.padHint.textContent = "Bridge not verified";
    } else if(!state.usbReady) {
        els.padHint.textContent = "Plug the Flipper into the host";
    } else if(state.typing) {
        els.padHint.textContent = "Typing pasted text…";
    } else if(state.pointerLocked) {
        els.padHint.textContent = "Mouse locked · Esc releases";
    } else if(state.touchMode) {
        els.padHint.textContent = "Drag to move · tap to click";
    } else if(state.pointerLockUnsupported) {
        els.padHint.textContent = "Drag to move · lock unavailable";
    } else if(focused) {
        els.padHint.textContent = "Type · click pad to lock mouse";
    } else {
        els.padHint.textContent = "Click to lock cursor";
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
    els.leftClickBtn.disabled = !isCaptureReady();
    els.rightClickBtn.disabled = !isCaptureReady();
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

    if(state.mouseFlushTimer) {
        clearTimeout(state.mouseFlushTimer);
        state.mouseFlushTimer = null;
    }
    state.mouseButtons = 0;
    state.mouseDx = 0;
    state.mouseDy = 0;
    state.mouseWheel = 0;
    state.mouseFlushing = false;
    state.pointerId = null;
    state.pointerMoved = 0;
    state.pointerLocked = false;
    state.pointerLockSupported = false;
    state.pointerLockUnsupported = false;
    state.pointerLockSuppressUntil = 0;
    state.touchMode = false;
    els.pad.classList.remove("capture-pad--dragging", "capture-pad--locked");
    if(document.pointerLockElement === els.pad) {
        document.exitPointerLock?.();
    }

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
    cancelPointerDrag();
    void releaseMouseButtons();

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

async function sendMousePacket(buttons, dx, dy, wheel, forceResponse = false) {
    if(!state.connected || !state.fapVerified) throw new Error("Disconnected");

    await withGatt(async () => {
        if(!state.connected || !state.fapVerified) throw new Error("Disconnected");
        await waitForCredit(PACKET_SIZE);
        if(!state.connected) throw new Error("Disconnected");

        const packet = buildMousePacket(buttons, dx, dy, wheel);
        await writePacket(packet, forceResponse);
        state.credit = Math.max(0, state.credit - packet.length);
        state.packets++;
        updateStats();
    });
}

function scheduleMouseFlush(delay = MOUSE_MOVE_INTERVAL_MS) {
    if(state.mouseFlushTimer || state.mouseFlushing) return;
    state.mouseFlushTimer = setTimeout(() => {
        state.mouseFlushTimer = null;
        void flushMouseMove();
    }, delay);
}

async function flushMouseMove() {
    if(state.mouseFlushing || !isCaptureReady()) return;
    state.mouseFlushing = true;
    let sendFailed = false;

    try {
        let dx = Math.trunc(state.mouseDx);
        let dy = Math.trunc(state.mouseDy);
        let wheel = Math.trunc(state.mouseWheel);
        state.mouseDx -= dx;
        state.mouseDy -= dy;
        state.mouseWheel -= wheel;

        const sendX = Math.max(-127, Math.min(127, dx));
        const sendY = Math.max(-127, Math.min(127, dy));
        const sendWheel = Math.max(-127, Math.min(127, wheel));
        state.mouseDx += dx - sendX;
        state.mouseDy += dy - sendY;
        state.mouseWheel += wheel - sendWheel;

        if(sendX || sendY || sendWheel) {
            await sendMousePacket(state.mouseButtons, sendX, sendY, sendWheel);
        }
    } catch(error) {
        sendFailed = true;
        log(`Mouse send failed: ${error.message}`, "warn");
    } finally {
        state.mouseFlushing = false;
        if(
            !sendFailed &&
            isCaptureReady() &&
            (Math.abs(state.mouseDx) >= 1 ||
                Math.abs(state.mouseDy) >= 1 ||
                Math.abs(state.mouseWheel) >= 1)
        ) {
            scheduleMouseFlush(0);
        }
    }
}

function queueMouseMove(dx, dy) {
    if(!isCaptureReady()) return;
    state.mouseDx += dx * MOUSE_SENSITIVITY;
    state.mouseDy += dy * MOUSE_SENSITIVITY;
    scheduleMouseFlush();
}

async function setMouseButton(button, pressed) {
    if(!state.connected || !state.fapVerified) return;

    const next = pressed ? state.mouseButtons | button : state.mouseButtons & ~button;
    if(next === state.mouseButtons) return;

    const previous = state.mouseButtons;
    state.mouseButtons = next;
    try {
        await sendMousePacket(next, 0, 0, 0, true);
    } catch(error) {
        state.mouseButtons = previous;
        log(`Mouse button send failed: ${error.message}`, "warn");
    }
}

async function clickMouseButton(button) {
    if(!isCaptureReady()) return;
    state.mouseDx = 0;
    state.mouseDy = 0;
    await setMouseButton(button, true);
    await sleep(25);
    await setMouseButton(button, false);
}

async function releaseMouseButtons() {
    const hadButtons = state.mouseButtons !== 0;
    state.mouseButtons = 0;
    state.mouseDx = 0;
    state.mouseDy = 0;
    state.mouseWheel = 0;

    if(!hadButtons || !state.connected || !state.fapVerified) return;
    try {
        await sendMousePacket(0, 0, 0, 0, true);
    } catch(_) {
        // The FAP releases mouse buttons on disconnect and web-session timeout.
    }
}

function cancelPointerDrag() {
    if(state.pointerId !== null) {
        try {
            if(els.pad.hasPointerCapture?.(state.pointerId)) {
                els.pad.releasePointerCapture(state.pointerId);
            }
        } catch(_) {
            // Pointer capture may already be gone.
        }
    }
    state.pointerId = null;
    state.pointerMoved = 0;
    els.pad.classList.remove("capture-pad--dragging");
}

function mouseButtonForEvent(event) {
    if(event.button === 0) return MOUSE_BUTTON_LEFT;
    if(event.button === 1) return MOUSE_BUTTON_MIDDLE;
    if(event.button === 2) return MOUSE_BUTTON_RIGHT;
    return 0;
}

function requestMouseLock() {
    if(state.pointerLocked) return;

    state.pointerLockSuppressUntil = performance.now() + 300;
    if(!els.pad.requestPointerLock) {
        state.pointerLockUnsupported = true;
        setCaptureVisual();
        log("Pointer lock is unavailable in this browser", "warn");
        return;
    }

    try {
        const request = els.pad.requestPointerLock();
        if(request?.catch) {
            request.catch((error) => {
                state.pointerLockUnsupported = true;
                setCaptureVisual();
                log(`Pointer lock failed: ${error.message}`, "warn");
            });
        }
    } catch(error) {
        state.pointerLockUnsupported = true;
        setCaptureVisual();
        log(`Pointer lock failed: ${error.message}`, "warn");
    }

    setTimeout(() => {
        if(!state.pointerLocked && !state.pointerLockSupported && !state.pointerLockUnsupported) {
            state.pointerLockUnsupported = true;
            setCaptureVisual();
            log("Pointer lock did not engage; using drag fallback", "warn");
        }
    }, 900);
}

function onPointerLockChange() {
    const locked = document.pointerLockElement === els.pad;
    const wasLocked = state.pointerLocked;
    state.pointerLocked = locked;
    els.pad.classList.toggle("capture-pad--locked", locked);

    if(locked) {
        state.pointerLockSupported = true;
        state.pointerLockUnsupported = false;
        log("Cursor locked. Press Esc to release.");
    } else if(wasLocked) {
        void releaseMouseButtons();
        log("Cursor released.");
    }
    setCaptureVisual();
}

function onPointerLockError() {
    state.pointerLockUnsupported = true;
    setCaptureVisual();
    log("Pointer lock was rejected; using drag fallback", "warn");
}

function onLockedMouseMove(event) {
    if(!state.pointerLocked || !isCaptureReady()) return;
    queueMouseMove(event.movementX || 0, event.movementY || 0);
}

function onLockedMouseDown(event) {
    if(!state.pointerLocked || !isCaptureReady()) return;
    if(performance.now() < state.pointerLockSuppressUntil) return;

    const button = mouseButtonForEvent(event);
    if(button === 0) return;

    event.preventDefault();
    void setMouseButton(button, true);
}

function onLockedMouseUp(event) {
    if(!state.pointerLocked) return;

    const button = mouseButtonForEvent(event);
    if(button === 0 || (state.mouseButtons & button) === 0) return;
    event.preventDefault();
    void setMouseButton(button, false);
}

function onLockedWheel(event) {
    if(!state.pointerLocked || !isCaptureReady()) return;
    event.preventDefault();

    const delta = event.deltaMode === 0 ? -event.deltaY / 100 : -Math.sign(event.deltaY);
    state.mouseWheel += delta;
    scheduleMouseFlush();
}

function onPadPointerDown(event) {
    if(!isCaptureReady()) return;
    if(event.pointerType === "mouse" && event.button !== 0) return;

    if(event.pointerType === "mouse") {
        if(state.pointerLocked) return;
        event.preventDefault();
        els.pad.focus();
        state.touchMode = false;

        if(!state.pointerLockUnsupported) {
            requestMouseLock();
            return;
        }
    } else {
        state.touchMode = true;
        setCaptureVisual();
    }

    event.preventDefault();
    const wasFocused = document.activeElement === els.pad;
    els.pad.focus();

    state.pointerId = event.pointerId;
    state.pointerWasFocused = wasFocused;
    state.pointerLastX = event.clientX;
    state.pointerLastY = event.clientY;
    state.pointerMoved = 0;
    state.pointerStart = performance.now();

    try {
        els.pad.setPointerCapture(event.pointerId);
    } catch(_) {
        // Older iOS WebKit may not expose pointer capture.
    }
    els.pad.classList.add("capture-pad--dragging");
}

function onPadPointerMove(event) {
    if(state.pointerId !== event.pointerId || !isCaptureReady()) return;
    event.preventDefault();

    const dx = event.clientX - state.pointerLastX;
    const dy = event.clientY - state.pointerLastY;
    state.pointerLastX = event.clientX;
    state.pointerLastY = event.clientY;
    state.pointerMoved += Math.hypot(dx, dy);

    if(state.pointerMoved >= 2) {
        queueMouseMove(dx, dy);
    }
}

function onPadPointerUp(event) {
    if(state.pointerId !== event.pointerId) return;

    const duration = performance.now() - state.pointerStart;
    const tapped = state.pointerMoved < TAP_MAX_MOVE && duration < TAP_MAX_MS;
    const wasFocused = state.pointerWasFocused;

    event.preventDefault();
    cancelPointerDrag();
    state.pointerWasFocused = false;

    if(tapped && wasFocused && isCaptureReady()) {
        void clickMouseButton(MOUSE_BUTTON_LEFT);
    }
}

function onPadPointerCancel(event) {
    if(state.pointerId !== event.pointerId) return;
    cancelPointerDrag();
    state.pointerWasFocused = false;
}

function onPadContextMenu(event) {
    event.preventDefault();
    if(state.pointerLocked) return;
    if(isCaptureReady()) {
        void clickMouseButton(MOUSE_BUTTON_RIGHT);
    }
}

function onPadWheel(event) {
    if(!isCaptureReady() || state.pointerLocked) return;
    event.preventDefault();

    // Browser deltaY is positive when scrolling down; HID wheel is positive up.
    const delta = event.deltaMode === 0 ? -event.deltaY / 100 : -Math.sign(event.deltaY);
    state.mouseWheel += delta;
    scheduleMouseFlush();
}

function bindMouseButton(element, button) {
    element.addEventListener("pointerdown", (event) => {
        if(!isCaptureReady()) return;
        event.preventDefault();
        try {
            element.setPointerCapture(event.pointerId);
        } catch(_) {
            // Ignore missing pointer capture.
        }
        void setMouseButton(button, true);
    });

    const release = (event) => {
        event.preventDefault();
        void setMouseButton(button, false);
    };
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("pointerleave", (event) => {
        if(!element.hasPointerCapture?.(event.pointerId)) {
            void setMouseButton(button, false);
        }
    });
    element.addEventListener("lostpointercapture", () => {
        void setMouseButton(button, false);
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

    cancelPointerDrag();
    await releaseMouseButtons();
    if(state.pointerLocked) {
        document.exitPointerLock?.();
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
        if(!ready) {
            state.mouseButtons = 0;
            state.mouseDx = 0;
            state.mouseDy = 0;
            state.mouseWheel = 0;
            cancelPointerDrag();
            if(state.pointerLocked) {
                document.exitPointerLock?.();
            }
        }
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

    void releaseMouseButtons();
    cancelPointerDrag();
    if(state.pointerLocked) {
        document.exitPointerLock?.();
    }
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

    if(!state.device?.gatt?.connected) {
        finishDisconnect("Flipper disconnected.");
        return;
    }

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
    if(state.pointerLocked && event.code === "Escape") {
        event.preventDefault();
        document.exitPointerLock?.();
        return;
    }

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
    els.pad.addEventListener("pointerdown", onPadPointerDown);
    els.pad.addEventListener("pointermove", onPadPointerMove);
    els.pad.addEventListener("pointerup", onPadPointerUp);
    els.pad.addEventListener("pointercancel", onPadPointerCancel);
    els.pad.addEventListener("contextmenu", onPadContextMenu);
    els.pad.addEventListener("wheel", onPadWheel, { passive: false });
    els.pad.addEventListener("click", () => {
        if(isCaptureReady()) els.pad.focus();
    });

    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("pointerlockerror", onPointerLockError);
    document.addEventListener("mousemove", onLockedMouseMove);
    document.addEventListener("mousedown", onLockedMouseDown);
    document.addEventListener("mouseup", onLockedMouseUp);
    document.addEventListener(
        "keydown",
        (event) => {
            if(state.pointerLocked && event.code === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                document.exitPointerLock?.();
            }
        },
        true,
    );
    document.addEventListener(
        "wheel",
        onLockedWheel,
        { passive: false },
    );
    document.addEventListener("contextmenu", (event) => {
        if(state.pointerLocked) event.preventDefault();
    });
    els.pad.addEventListener("focus", setCaptureVisual);
    els.pad.addEventListener("blur", () => {
        setCaptureVisual();
        if(state.pressed.size > 0) {
            releaseAll("Capture paused — keys released");
        }
    });

    bindMouseButton(els.leftClickBtn, MOUSE_BUTTON_LEFT);
    bindMouseButton(els.rightClickBtn, MOUSE_BUTTON_RIGHT);

    window.addEventListener("blur", () => {
        cancelPointerDrag();
        void releaseMouseButtons();
        if(state.pointerLocked) {
            document.exitPointerLock?.();
        }
        if(state.pressed.size > 0) releaseAll("Window lost focus — keys released");
    });

    document.addEventListener("visibilitychange", () => {
        if(document.hidden) {
            cancelPointerDrag();
            void releaseMouseButtons();
            if(state.pointerLocked) {
                document.exitPointerLock?.();
            }
            if(state.pressed.size > 0 && !state.typing) {
                releaseAll("Tab hidden — keys released");
            }
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
