import {
    PACKET_SIZE,
    SERIAL_CAPACITY,
    buildStatePacket,
    isMappedCode,
    parseFlowCredit,
} from "./hid.js";

const SERVICE_UUID = "8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000";
const RX_UUID = "19ed82ae-ed21-4c9d-4145-228e62fe0000";
const FLOW_UUID = "19ed82ae-ed21-4c9d-4145-228e63fe0000";

const FLOW_WAIT_MS = 1200;
const FLOW_POLL_MS = 400;
const HEARTBEAT_MS = 1000;
const MAX_LOG_ENTRIES = 80;

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
    pad: $("capturePad"),
    padHint: $("padHint"),
    pressedKeys: $("pressedKeys"),
    packets: $("packets"),
    keyCount: $("keyCount"),
    bufferValue: $("bufferValue"),
    log: $("log"),
    clearLogBtn: $("clearLogBtn"),
    supportWarning: $("supportWarning"),
    modeHint: $("modeHint"),
};

const boundDevices = new WeakSet();

const state = {
    device: null,
    rx: null,
    flow: null,
    connected: false,
    connecting: false,
    pressed: new Set(),
    credit: SERIAL_CAPACITY,
    capacity: SERIAL_CAPACITY,
    writing: false,
    stateDirty: false,
    packets: 0,
    keys: 0,
    notificationsStarted: false,
    flowWaiters: new Set(),
    writeMode: "unknown",
    expectedDisconnect: false,
    supported: true,
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

function setCaptureVisual() {
    const focused = document.activeElement === els.pad;
    els.pad.classList.toggle("capture-pad--focused", focused);
    els.pad.classList.toggle("capture-pad--muted", !state.connected);

    if(!state.connected) {
        els.padHint.textContent = "Connect the Flipper to start";
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

function updateStats() {
    els.packets.textContent = String(state.packets);
    els.keyCount.textContent = String(state.keys);
    els.bufferValue.textContent = `${state.credit} B`;
    els.deviceName.textContent = state.device?.name || "No device selected";
    updatePressedKeys();
}

function updateButtons() {
    els.connectBtn.disabled = !state.supported || state.connecting || state.connected;
    els.chooseBtn.disabled = !state.supported || state.connecting;
    els.disconnectBtn.disabled = !state.connected;
    els.releaseBtn.disabled = !state.connected;
    els.allDevicesBtn.disabled = !state.supported;
    els.connectBtn.textContent = state.connecting
        ? "Connecting…"
        : state.device && !state.connected
          ? "Reconnect"
          : "Connect Flipper";
    els.chooseBtn.hidden = !state.device;
    els.modeHint.textContent =
        "Live mode forwards physical key presses. The host keyboard layout decides the characters.";
}

function updateUI() {
    updateStats();
    updateButtons();
    setCaptureVisual();
}

function resetConnectionState() {
    state.connected = false;
    state.rx = null;
    state.flow = null;
    state.pressed.clear();
    state.credit = 0;
    state.capacity = SERIAL_CAPACITY;
    state.notificationsStarted = false;
    state.stateDirty = false;
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

async function writePacket(packet) {
    if(!state.rx) throw new Error("No RX characteristic");

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

async function pump() {
    if(state.writing || !state.connected) return;
    state.writing = true;

    try {
        while(state.connected && state.stateDirty) {
            state.stateDirty = false;
            await waitForCredit(PACKET_SIZE);
            if(!state.connected) break;

            const packet = buildStatePacket(state.pressed);
            await writePacket(packet);

            state.credit = Math.max(0, state.credit - packet.length);
            state.packets++;
            updateStats();
        }
    } catch(error) {
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
    } finally {
        state.writing = false;
        if(state.connected && state.stateDirty) {
            void pump();
        }
    }
}

function sendState() {
    if(!state.connected) return;
    state.stateDirty = true;
    void pump();
}

function releaseAll(reason = "Keys released") {
    state.pressed.clear();
    sendState();
    updateUI();
    if(reason) log(reason);
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
        state.flow = flow;
        state.credit = initialCredit > 0 ? initialCredit : SERIAL_CAPACITY;
        state.capacity = state.credit;

        try {
            await flow.startNotifications();
            flow.addEventListener("characteristicvaluechanged", onFlowChanged);
            state.notificationsStarted = true;
            log("Flow-control notifications enabled");
        } catch(error) {
            log(`Flow notifications unavailable: ${error.message}`, "warn");
        }

        // Give the FAP's main loop a moment to reclaim the serial callback
        // after the BT service's connect-time RPC setup.
        await sleep(250);

        // Probe with a zero state. This verifies the auth/bonded link and makes
        // the Flipper release any keys left over from a previous session.
        await rx.writeValue(buildStatePacket([]));
        state.credit = Math.max(0, state.credit - PACKET_SIZE);
        log("Keyboard link verified");

        state.connected = true;
        state.connecting = false;
        state.expectedDisconnect = false;
        setStatus(
            "connected",
            "Connected",
            `${device.name || "Flipper"} — make sure the Flipper screen shows USB READY.`,
        );
        updateUI();
        log("Ready. Click the capture pad and type (host layout applies).");

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
    if(!state.connected) return;
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

    els.clearLogBtn.addEventListener("click", () => {
        els.log.replaceChildren();
    });

    els.pad.addEventListener("keydown", mappedKeyDown);
    els.pad.addEventListener("keyup", mappedKeyUp);
    els.pad.addEventListener("click", () => {
        if(state.connected) els.pad.focus();
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
        if(document.hidden && state.pressed.size > 0) {
            releaseAll("Tab hidden — keys released");
        }
    });

    setInterval(() => {
        if(state.connected && state.pressed.size > 0) {
            sendState();
        }
    }, HEARTBEAT_MS);
}

function checkSupport() {
    const problems = [];
    if(!window.isSecureContext) {
        problems.push(
            "This page is not a secure context. Serve it from https:// or http://localhost.",
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
