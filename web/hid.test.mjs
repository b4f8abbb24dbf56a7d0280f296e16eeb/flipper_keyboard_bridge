import assert from "node:assert/strict";
import test from "node:test";

import {
    CONTROL_MAGIC,
    MAX_KEYS,
    MOUSE_BUTTON_LEFT,
    MOUSE_BUTTON_RIGHT,
    MOUSE_MAGIC,
    PACKET_SIZE,
    SERIAL_CAPACITY,
    asciiToHid,
    buildHidStatePacket,
    buildMousePacket,
    buildPingPacket,
    buildStatePacket,
    isMappedCode,
    keyUsages,
    modifierMask,
    packetChecksum,
    parseFlowCredit,
    textToKeystrokes,
} from "./hid.js";

test("maps common physical keys", () => {
    assert.equal(isMappedCode("KeyA"), true);
    assert.equal(isMappedCode("ShiftLeft"), true);
    assert.equal(isMappedCode("MediaPlayPause"), false);
});

test("combines modifier bits", () => {
    assert.equal(modifierMask(["ShiftLeft"]), 0x02);
    assert.equal(modifierMask(["ShiftLeft", "ControlRight", "MetaLeft"]), 0x1a);
});

test("builds a valid full-state packet", () => {
    const packet = buildStatePacket(new Set(["KeyA", "ShiftLeft"]));
    assert.equal(packet.length, PACKET_SIZE);
    assert.equal(packet[0], 0xa5);
    assert.equal(packet[1], 0x02);
    assert.equal(packet[2], 0x04);
    assert.equal(packet[3], 0x00);
    assert.equal(packet[PACKET_SIZE - 1], packetChecksum(packet));
});

test("empty state is a valid release packet", () => {
    const packet = buildStatePacket([]);
    assert.deepEqual([...packet], [0xa5, 0, 0, 0, 0, 0, 0, 0, 0xa5]);
});

test("deduplicates and caps key usages", () => {
    const usages = keyUsages([
        "KeyA",
        "KeyA",
        "KeyB",
        "KeyC",
        "KeyD",
        "KeyE",
        "KeyF",
        "KeyG",
    ]);
    assert.equal(usages.length, MAX_KEYS);
    assert.deepEqual(usages, [0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);

    const packet = buildStatePacket([
        "KeyA",
        "KeyB",
        "KeyC",
        "KeyD",
        "KeyE",
        "KeyF",
        "KeyG",
    ]);
    assert.deepEqual([...packet.slice(2, 8)], [0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
});

test("flow control value is big-endian on the wire", () => {
    const view = new DataView(new Uint8Array([0x00, 0x00, 0x01, 0xe6]).buffer);
    assert.equal(parseFlowCredit(view), SERIAL_CAPACITY);
});

test("flow control falls back to little-endian or capacity", () => {
    const little = new DataView(new Uint8Array([0xe6, 0x01, 0x00, 0x00]).buffer);
    assert.equal(parseFlowCredit(little), SERIAL_CAPACITY);
    assert.equal(parseFlowCredit(new DataView(new ArrayBuffer(0))), SERIAL_CAPACITY);
});

test("packet size divides the serial flow-control window exactly", () => {
    assert.equal(SERIAL_CAPACITY % PACKET_SIZE, 0);
});

test("builds a raw HID state packet", () => {
    const packet = buildHidStatePacket(0x02, [0x04, 0x05, 0x06]);
    assert.equal(packet.length, PACKET_SIZE);
    assert.equal(packet[0], 0xa5);
    assert.equal(packet[1], 0x02);
    assert.deepEqual([...packet.slice(2, 8)], [0x04, 0x05, 0x06, 0, 0, 0]);
    assert.equal(packet[8], packetChecksum(packet));
});

test("maps printable ASCII to HID keystrokes", () => {
    assert.deepEqual(asciiToHid("a"), { usage: 0x04, mods: 0, label: "a" });
    assert.deepEqual(asciiToHid("A"), { usage: 0x04, mods: 0x02, label: "A" });
    assert.deepEqual(asciiToHid("1"), { usage: 0x1e, mods: 0, label: "1" });
    assert.deepEqual(asciiToHid("!"), { usage: 0x1e, mods: 0x02, label: "!" });
    assert.deepEqual(asciiToHid("?"), { usage: 0x38, mods: 0x02, label: "?" });
    assert.deepEqual(asciiToHid("\n"), { usage: 0x28, mods: 0, label: "Enter" });
    assert.deepEqual(asciiToHid("\t"), { usage: 0x2b, mods: 0, label: "Tab" });

    for(let code = 32; code <= 126; code++) {
        const char = String.fromCharCode(code);
        const action = asciiToHid(char);
        assert.ok(action, `missing mapping for ${JSON.stringify(char)}`);
        assert.ok(action.usage >= 0x04 && action.usage <= 0x64);
    }
});

test("rejects non-ASCII paste content", () => {
    const { actions, unsupported } = textToKeystrokes("Hi 👋\n");
    assert.equal(actions.length, 4);
    assert.deepEqual(actions.map((action) => action.label), ["H", "i", "Space", "Enter"]);
    assert.deepEqual(unsupported, ["👋"]);
});

test("builds a mouse packet with signed deltas", () => {
    const packet = buildMousePacket(MOUSE_BUTTON_LEFT | MOUSE_BUTTON_RIGHT, -12, 34, -1);
    assert.equal(packet[0], MOUSE_MAGIC);
    assert.equal(packet[1], 0x03);
    assert.equal(packet[2], 0xf4);
    assert.equal(packet[3], 34);
    assert.equal(packet[4], 0xff);
    assert.equal(packet[8], packetChecksum(packet));
});

test("builds a proprietary keepalive packet", () => {
    const packet = buildPingPacket(0x1234, 7);
    assert.equal(packet[0], CONTROL_MAGIC);
    assert.equal(packet[1], 0x4b);
    assert.equal(packet[2], 0x42);
    assert.equal(packet[3], 1);
    assert.equal(packet[4], 1);
    assert.equal(packet[5], 0x34);
    assert.equal(packet[6], 0x12);
    assert.equal(packet[7], 7);
    assert.equal(packet[8], packetChecksum(packet));
});
