/*
 * Browser KeyboardEvent.code -> USB HID keyboard usage mapping.
 *
 * This is intentionally a physical-key mapping: the host's keyboard layout
 * decides which character a key produces, just like a real USB keyboard.
 */

export const PACKET_MAGIC = 0xa5;
export const PACKET_SIZE = 9;
export const MAX_KEYS = 6;
export const SERIAL_CAPACITY = 486;

export const MODIFIER_CODES = Object.freeze({
    ControlLeft: 0x01,
    ShiftLeft: 0x02,
    AltLeft: 0x04,
    MetaLeft: 0x08,
    ControlRight: 0x10,
    ShiftRight: 0x20,
    AltRight: 0x40,
    MetaRight: 0x80,
    // Legacy/alternate names used by some browsers.
    OSLeft: 0x08,
    OSRight: 0x80,
    AltGraph: 0x40,
});

export const KEY_CODE_TO_HID = Object.freeze({
    KeyA: 0x04,
    KeyB: 0x05,
    KeyC: 0x06,
    KeyD: 0x07,
    KeyE: 0x08,
    KeyF: 0x09,
    KeyG: 0x0a,
    KeyH: 0x0b,
    KeyI: 0x0c,
    KeyJ: 0x0d,
    KeyK: 0x0e,
    KeyL: 0x0f,
    KeyM: 0x10,
    KeyN: 0x11,
    KeyO: 0x12,
    KeyP: 0x13,
    KeyQ: 0x14,
    KeyR: 0x15,
    KeyS: 0x16,
    KeyT: 0x17,
    KeyU: 0x18,
    KeyV: 0x19,
    KeyW: 0x1a,
    KeyX: 0x1b,
    KeyY: 0x1c,
    KeyZ: 0x1d,

    Digit1: 0x1e,
    Digit2: 0x1f,
    Digit3: 0x20,
    Digit4: 0x21,
    Digit5: 0x22,
    Digit6: 0x23,
    Digit7: 0x24,
    Digit8: 0x25,
    Digit9: 0x26,
    Digit0: 0x27,

    Enter: 0x28,
    NumpadEnter: 0x58,
    Escape: 0x29,
    Backspace: 0x2a,
    Tab: 0x2b,
    Space: 0x2c,
    Minus: 0x2d,
    Equal: 0x2e,
    BracketLeft: 0x2f,
    BracketRight: 0x30,
    Backslash: 0x31,
    IntlBackslash: 0x64,
    Semicolon: 0x33,
    Quote: 0x34,
    Backquote: 0x35,
    Comma: 0x36,
    Period: 0x37,
    Slash: 0x38,
    CapsLock: 0x39,
    ContextMenu: 0x65,

    F1: 0x3a,
    F2: 0x3b,
    F3: 0x3c,
    F4: 0x3d,
    F5: 0x3e,
    F6: 0x3f,
    F7: 0x40,
    F8: 0x41,
    F9: 0x42,
    F10: 0x43,
    F11: 0x44,
    F12: 0x45,
    F13: 0x68,
    F14: 0x69,
    F15: 0x6a,
    F16: 0x6b,
    F17: 0x6c,
    F18: 0x6d,
    F19: 0x6e,
    F20: 0x6f,
    F21: 0x70,
    F22: 0x71,
    F23: 0x72,
    F24: 0x73,

    PrintScreen: 0x46,
    ScrollLock: 0x47,
    Pause: 0x48,
    Insert: 0x49,
    Home: 0x4a,
    PageUp: 0x4b,
    Delete: 0x4c,
    End: 0x4d,
    PageDown: 0x4e,
    ArrowRight: 0x4f,
    ArrowLeft: 0x50,
    ArrowDown: 0x51,
    ArrowUp: 0x52,

    NumLock: 0x53,
    NumpadDivide: 0x54,
    NumpadMultiply: 0x55,
    NumpadSubtract: 0x56,
    NumpadAdd: 0x57,
    Numpad1: 0x59,
    Numpad2: 0x5a,
    Numpad3: 0x5b,
    Numpad4: 0x5c,
    Numpad5: 0x5d,
    Numpad6: 0x5e,
    Numpad7: 0x5f,
    Numpad8: 0x60,
    Numpad9: 0x61,
    Numpad0: 0x62,
    NumpadDecimal: 0x63,
    NumpadComma: 0x85,
    NumpadEqual: 0x67,

    IntlRo: 0x87,
    IntlYen: 0x89,
    KanaMode: 0x88,
    Power: 0x66,
    Help: 0x75,
    Undo: 0x7a,
    Cut: 0x7b,
    Copy: 0x7c,
    Paste: 0x7d,
    Find: 0x7e,
    Mute: 0x7f,
    VolumeUp: 0x80,
    VolumeDown: 0x81,

    // Some Chromium builds use these names for the same physical keys.
    AudioVolumeMute: 0x7f,
    AudioVolumeUp: 0x80,
    AudioVolumeDown: 0x81,
});

export function isModifierCode(code) {
    return Object.prototype.hasOwnProperty.call(MODIFIER_CODES, code);
}

export function isMappedCode(code) {
    return isModifierCode(code) || Object.prototype.hasOwnProperty.call(KEY_CODE_TO_HID, code);
}

export function modifierMask(codes) {
    let mask = 0;
    for(const code of codes) {
        mask |= MODIFIER_CODES[code] || 0;
    }
    return mask & 0xff;
}

export function keyUsages(codes, limit = MAX_KEYS) {
    const usages = [];
    for(const code of codes) {
        const usage = KEY_CODE_TO_HID[code];
        if(!usage) continue;
        if(!usages.includes(usage)) usages.push(usage);
        if(usages.length >= limit) break;
    }
    return usages;
}

/**
 * Build the 9-byte "full keyboard state" packet consumed by the FAP.
 * @param {Iterable<string>} codes pressed KeyboardEvent.code values
 * @returns {Uint8Array}
 */
export function buildStatePacket(codes) {
    const packet = new Uint8Array(PACKET_SIZE);
    packet[0] = PACKET_MAGIC;
    packet[1] = modifierMask(codes);
    const usages = keyUsages(codes);
    for(let i = 0; i < usages.length; i++) {
        packet[2 + i] = usages[i];
    }
    let checksum = 0;
    for(let i = 0; i < PACKET_SIZE - 1; i++) {
        checksum ^= packet[i];
    }
    packet[PACKET_SIZE - 1] = checksum;
    return packet;
}

/**
 * Flipper writes the flow-control value as a big-endian uint32. Be liberal
 * about the endianness in case another firmware build changes it.
 * @param {DataView} view
 * @returns {number} bytes the Flipper can currently accept
 */
export function parseFlowCredit(view) {
    if(!view || view.byteLength < 4) return SERIAL_CAPACITY;

    const bigEndian = view.getUint32(0, false);
    if(bigEndian > 0 && bigEndian <= 65535) return bigEndian;

    const littleEndian = view.getUint32(0, true);
    if(littleEndian > 0 && littleEndian <= 65535) return littleEndian;

    return SERIAL_CAPACITY;
}

export function packetChecksum(packet) {
    let checksum = 0;
    for(let i = 0; i < packet.length - 1; i++) {
        checksum ^= packet[i];
    }
    return checksum;
}
