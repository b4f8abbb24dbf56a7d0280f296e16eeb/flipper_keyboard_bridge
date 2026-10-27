import assert from "node:assert/strict";
import test from "node:test";

import {
    MAX_KEYS,
    PACKET_SIZE,
    SERIAL_CAPACITY,
    buildStatePacket,
    isMappedCode,
    keyUsages,
    modifierMask,
    packetChecksum,
    parseFlowCredit,
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
