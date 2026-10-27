/*
 * BLE Keyboard Bridge
 *
 * A Flipper Zero FAP that receives 9-byte keyboard-state packets over the
 * Flipper BLE serial profile and replays them on the USB HID keyboard.
 *
 * Packet layout:
 *   [0]    0xA5 magic
 *   [1]    HID modifier byte (bit 0 = left ctrl ... bit 7 = right GUI)
 *   [2..7] up to six HID keyboard usage IDs
 *   [8]    XOR of bytes 0..7
 *
 * The packet is 9 bytes long on purpose: Flipper's BLE serial flow-control
 * window is 486 bytes, which is exactly 54 packets.
 */

#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_usb.h>
#include <furi_hal_usb_hid.h>
#include <gui/gui.h>
#include <input/input.h>
#include <bt/bt_service/bt.h>
#include <profiles/serial_profile.h>

#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#define TAG "BleKbBridge"

#define PACKET_MAGIC     0xA5
#define PACKET_SIZE      9
#define MAX_KEYS         6
#define EVENT_QUEUE_LEN  32

#define CONTROL_MAGIC    0x48 // 'H'
#define CONTROL_VERSION  1
#define CONTROL_PING     1

#define TYPING_LOG_CAPACITY 64
#define TYPING_LOG_TAIL     13

#define WEB_PING_TIMEOUT_MS 5000
#define WATCHDOG_MS          5000
#define USB_RETRY_MS         1000
#define USB_POLL_MS          250
#define UI_REFRESH_MS        100

typedef enum {
    AppEventTypeBtConnected,
    AppEventTypeBtDisconnected,
    AppEventTypeBtReset,
    AppEventTypeBtData,
    AppEventTypeInput,
} AppEventType;

typedef struct {
    AppEventType type;
    InputEvent input;
    uint8_t data[PACKET_SIZE];
} AppEvent;

typedef struct {
    Gui* gui;
    ViewPort* view_port;
    FuriMessageQueue* queue;

    Bt* bt;
    FuriHalBleProfileBase* profile;
    bool ble_connected;

    FuriHalUsbInterface* previous_usb;
    bool usb_configured;
    bool usb_ready;

    uint8_t mods;
    uint8_t keys[MAX_KEYS];

    char typing_log[TYPING_LOG_CAPACITY];
    size_t typing_log_len;

    uint32_t packets;
    uint32_t keys_sent;
    uint32_t last_rx_tick;
    uint32_t last_web_ping_tick;
    uint32_t last_usb_poll;
    uint32_t last_usb_retry;
    uint32_t last_ui_tick;
    bool web_active;

    atomic_bool emergency_release;
    bool running;
} App;

static FuriHalUsbHidConfig hid_config = {
    .vid = 0x046D,
    .pid = 0xC529,
    .manuf = "Flipper Devices",
    .product = "BLE Keyboard Bridge",
};

static void ui_update(App* app, bool force) {
    uint32_t now = furi_get_tick();
    if(force || now - app->last_ui_tick >= UI_REFRESH_MS) {
        app->last_ui_tick = now;
        view_port_update(app->view_port);
    }
}

static void hid_release_all(App* app) {
    furi_hal_hid_kb_release_all();
    memset(app->keys, 0, sizeof(app->keys));
    app->mods = 0;
}

static bool web_client_active(App* app) {
    return app->last_web_ping_tick != 0 &&
           (furi_get_tick() - app->last_web_ping_tick <= WEB_PING_TIMEOUT_MS);
}

static void typing_log_append(App* app, char character) {
    if(character == '\0') return;

    if(app->typing_log_len >= TYPING_LOG_CAPACITY - 1) {
        memmove(app->typing_log, app->typing_log + 1, TYPING_LOG_CAPACITY - 2);
        app->typing_log_len = TYPING_LOG_CAPACITY - 2;
    }

    app->typing_log[app->typing_log_len++] = character;
    app->typing_log[app->typing_log_len] = '\0';
}

static void typing_log_backspace(App* app) {
    if(app->typing_log_len == 0) return;
    app->typing_log[--app->typing_log_len] = '\0';
}

static char hid_key_to_char(uint8_t usage, bool shift) {
    if(usage >= HID_KEYBOARD_A && usage <= HID_KEYBOARD_Z) {
        char character = (char)('a' + (usage - HID_KEYBOARD_A));
        return shift ? (char)(character - 'a' + 'A') : character;
    }

    static const char digits[] = "1234567890";
    static const char shifted_digits[] = "!@#$%^&*()";
    if(usage >= HID_KEYBOARD_1 && usage <= HID_KEYBOARD_0) {
        size_t index = usage - HID_KEYBOARD_1;
        return shift ? shifted_digits[index] : digits[index];
    }

    switch(usage) {
    case HID_KEYBOARD_RETURN:
    case HID_KEYBOARD_TAB:
    case HID_KEYBOARD_SPACEBAR:
        return ' ';
    case HID_KEYBOARD_MINUS:
        return shift ? '_' : '-';
    case HID_KEYBOARD_EQUAL_SIGN:
        return shift ? '+' : '=';
    case HID_KEYBOARD_OPEN_BRACKET:
        return shift ? '{' : '[';
    case HID_KEYBOARD_CLOSE_BRACKET:
        return shift ? '}' : ']';
    case HID_KEYBOARD_BACKSLASH:
        return shift ? '|' : '\\';
    case HID_KEYBOARD_SEMICOLON:
        return shift ? ':' : ';';
    case HID_KEYBOARD_APOSTROPHE:
        return shift ? '"' : '\'';
    case HID_KEYBOARD_GRAVE_ACCENT:
        return shift ? '~' : '`';
    case HID_KEYBOARD_COMMA:
        return shift ? '<' : ',';
    case HID_KEYBOARD_DOT:
        return shift ? '>' : '.';
    case HID_KEYBOARD_SLASH:
        return shift ? '?' : '/';
    default:
        return '\0';
    }
}

static bool checksum_valid(const uint8_t* packet) {
    uint8_t checksum = 0;
    for(size_t i = 0; i < PACKET_SIZE - 1; i++) {
        checksum ^= packet[i];
    }
    return checksum == packet[PACKET_SIZE - 1];
}

static bool keyboard_packet_valid(const uint8_t* packet) {
    return packet[0] == PACKET_MAGIC && checksum_valid(packet);
}

static bool control_packet_valid(const uint8_t* packet) {
    return packet[0] == CONTROL_MAGIC && packet[1] == 'K' && packet[2] == 'B' &&
           packet[3] == CONTROL_VERSION && packet[4] == CONTROL_PING &&
           checksum_valid(packet);
}

static void bridge_send(App* app, const char* message) {
    if(!app->profile || !message) return;

    size_t length = strlen(message);
    if(length == 0) return;
    if(length > BLE_PROFILE_SERIAL_PACKET_SIZE_MAX) {
        length = BLE_PROFILE_SERIAL_PACKET_SIZE_MAX;
    }

    ble_profile_serial_tx(app->profile, (uint8_t*)message, (uint16_t)length);
}

static void bridge_send_ready(App* app) {
    char message[40];
    snprintf(
        message,
        sizeof(message),
        "HKB1 READY USB=%u\r\n",
        furi_hal_hid_is_connected() ? 1 : 0);
    bridge_send(app, message);
}

static void bridge_send_usb(App* app) {
    char message[32];
    snprintf(
        message,
        sizeof(message),
        "HKB1 USB=%u\r\n",
        furi_hal_hid_is_connected() ? 1 : 0);
    bridge_send(app, message);
}

static void handle_control_packet(App* app, const uint8_t* packet) {
    if(packet[4] != CONTROL_PING) return;

    app->last_web_ping_tick = furi_get_tick();
    if(!app->web_active) {
        app->web_active = true;
        ui_update(app, true);
        FURI_LOG_I(TAG, "Web client handshake active");
    }

    uint16_t session = (uint16_t)packet[5] | ((uint16_t)packet[6] << 8);
    uint8_t sequence = packet[7];

    char message[80];
    snprintf(
        message,
        sizeof(message),
        "HKB1 PONG %04X %u USB=%u\r\n",
        (unsigned)session,
        sequence,
        furi_hal_hid_is_connected() ? 1 : 0);
    bridge_send(app, message);
}

static void hid_apply_packet(App* app, const uint8_t* packet) {
    uint8_t new_mods = packet[1];
    uint8_t new_keys[MAX_KEYS] = {0};
    size_t new_key_count = 0;

    for(size_t i = 0; i < MAX_KEYS; i++) {
        uint8_t key = packet[2 + i];
        if(key == HID_KEYBOARD_NONE) continue;
        if(key >= HID_KEYBOARD_L_CTRL && key <= HID_KEYBOARD_R_GUI) continue;

        bool duplicate = false;
        for(size_t j = 0; j < new_key_count; j++) {
            if(new_keys[j] == key) {
                duplicate = true;
                break;
            }
        }
        if(!duplicate && new_key_count < MAX_KEYS) {
            new_keys[new_key_count++] = key;
        }
    }

    uint8_t added_mods = new_mods & ~app->mods;
    uint8_t removed_mods = app->mods & ~new_mods;
    bool shift = (new_mods & 0x22) != 0;
    bool shortcut = (new_mods & 0xdd) != 0;

    // Put modifiers down before the keys they modify.
    if(added_mods) {
        furi_hal_hid_kb_press((uint16_t)added_mods << 8);
    }

    for(size_t i = 0; i < new_key_count; i++) {
        bool was_down = false;
        for(size_t j = 0; j < MAX_KEYS; j++) {
            if(app->keys[j] == new_keys[i]) {
                was_down = true;
                break;
            }
        }
        if(!was_down) {
            furi_hal_hid_kb_press(new_keys[i]);
            app->keys_sent++;

            if(!shortcut) {
                if(new_keys[i] == HID_KEYBOARD_DELETE) {
                    typing_log_backspace(app);
                } else {
                    typing_log_append(app, hid_key_to_char(new_keys[i], shift));
                }
            }
        }
    }

    for(size_t i = 0; i < MAX_KEYS; i++) {
        uint8_t old_key = app->keys[i];
        if(old_key == HID_KEYBOARD_NONE) continue;

        bool still_down = false;
        for(size_t j = 0; j < new_key_count; j++) {
            if(new_keys[j] == old_key) {
                still_down = true;
                break;
            }
        }
        if(!still_down) {
            furi_hal_hid_kb_release(old_key);
        }
    }

    // Release modifiers last, after the keys that depended on them.
    if(removed_mods) {
        furi_hal_hid_kb_release((uint16_t)removed_mods << 8);
    }

    memcpy(app->keys, new_keys, sizeof(app->keys));
    app->mods = new_mods;
    app->packets++;
}

static uint16_t serial_event_callback(SerialServiceEvent event, void* context) {
    App* app = context;

    if(event.event == SerialServiceEventTypeDataReceived && event.data.size > 0) {
        if(event.data.size == PACKET_SIZE) {
            AppEvent app_event = {
                .type = AppEventTypeBtData,
            };
            memcpy(app_event.data, event.data.buffer, PACKET_SIZE);
            if(furi_message_queue_put(app->queue, &app_event, 0) != FuriStatusOk) {
                atomic_store(&app->emergency_release, true);
            }
        } else {
            FURI_LOG_W(TAG, "Ignoring %u-byte BLE write", event.data.size);
        }
    } else if(event.event == SerialServiceEventTypesBleResetRequest) {
        AppEvent app_event = {
            .type = AppEventTypeBtReset,
        };
        furi_message_queue_put(app->queue, &app_event, 0);
    }

    return event.data.size;
}

static void bt_status_callback(BtStatus status, void* context) {
    App* app = context;
    AppEvent app_event = {0};

    if(status == BtStatusConnected) {
        app_event.type = AppEventTypeBtConnected;
    } else if(
        status == BtStatusAdvertising || status == BtStatusOff ||
        status == BtStatusUnavailable) {
        app_event.type = AppEventTypeBtDisconnected;
    } else {
        return;
    }

    if(furi_message_queue_put(app->queue, &app_event, 0) != FuriStatusOk) {
        atomic_store(&app->emergency_release, true);
    }
}

static void bt_arm_serial_callback(App* app) {
    if(!app->profile) return;

    // The BT service installs its RPC callback when a central connects and
    // disables our callback. Reclaim the serial service after every connect.
    ble_profile_serial_set_event_callback(
        app->profile, BLE_PROFILE_SERIAL_PACKET_SIZE_MAX, serial_event_callback, app);
    ble_profile_serial_set_rpc_active(app->profile, false);
    ble_profile_serial_notify_buffer_is_empty(app->profile);
}

static bool bt_start(App* app) {
    if(app->profile) return true;

    if(!app->bt) {
        app->bt = furi_record_open(RECORD_BT);
        if(!app->bt) return false;
        bt_set_status_changed_callback(app->bt, bt_status_callback, app);
    }

    app->profile = bt_profile_start(app->bt, ble_profile_serial, NULL);
    if(!app->profile) {
        FURI_LOG_E(TAG, "Failed to start BLE serial profile");
        return false;
    }

    bt_arm_serial_callback(app);
    FURI_LOG_I(TAG, "BLE serial profile started");
    return true;
}

static void bt_stop(App* app) {
    if(app->profile) {
        ble_profile_serial_set_event_callback(app->profile, 0, NULL, NULL);
        app->profile = NULL;
        if(app->bt) bt_profile_restore_default(app->bt);
    }

    if(app->bt) {
        bt_set_status_changed_callback(app->bt, NULL, NULL);
        furi_record_close(RECORD_BT);
        app->bt = NULL;
    }

    app->ble_connected = false;
}

static bool usb_hid_start(App* app) {
    if(app->usb_configured) return true;

    FuriHalUsbInterface* previous = furi_hal_usb_get_config();
    if(!furi_hal_usb_set_config(&usb_hid, &hid_config)) {
        return false;
    }

    app->previous_usb = previous;
    app->usb_configured = true;
    FURI_LOG_I(TAG, "USB HID configured");
    return true;
}

static void usb_hid_stop(App* app) {
    furi_hal_hid_kb_release_all();

    if(app->usb_configured) {
        if(app->previous_usb) {
            furi_hal_usb_set_config(app->previous_usb, NULL);
        }
        app->usb_configured = false;
        app->usb_ready = false;
    }
}

static void app_draw_callback(Canvas* canvas, void* context) {
    App* app = context;

    canvas_clear(canvas);
    canvas_set_color(canvas, ColorBlack);

    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 2, 11, "BLE Keyboard Bridge");
    canvas_draw_line(canvas, 2, 15, 125, 15);

    canvas_set_font(canvas, FontSecondary);

    const char* ble_state;
    bool ble_ok = false;
    if(!app->profile) {
        ble_state = "OFF";
    } else if(!app->ble_connected) {
        ble_state = "WAITING";
    } else if(app->web_active) {
        ble_state = "CONNECTED";
        ble_ok = true;
    } else {
        ble_state = "INVALID";
    }

    const char* usb_state;
    bool usb_ok = false;
    if(app->usb_ready) {
        usb_state = "READY";
        usb_ok = true;
    } else if(app->usb_configured) {
        usb_state = "NO HOST";
    } else {
        usb_state = "BUSY";
    }

    if(ble_ok) {
        canvas_draw_box(canvas, 2, 22, 5, 5);
    } else {
        canvas_draw_frame(canvas, 2, 22, 5, 5);
    }
    canvas_draw_str(canvas, 11, 27, "BLE:");
    canvas_draw_str(canvas, 35, 27, ble_state);

    if(usb_ok) {
        canvas_draw_box(canvas, 2, 32, 5, 5);
    } else {
        canvas_draw_frame(canvas, 2, 32, 5, 5);
    }
    canvas_draw_str(canvas, 11, 37, "USB:");
    canvas_draw_str(canvas, 35, 37, usb_state);

    char stats[32];
    snprintf(stats, sizeof(stats), "Keys: %lu  Packets: %lu",
        (unsigned long)app->keys_sent, (unsigned long)app->packets);
    canvas_draw_str(canvas, 2, 47, stats);

    bool typing = app->mods != 0;
    for(size_t i = 0; i < MAX_KEYS; i++) {
        if(app->keys[i]) typing = true;
    }

    if(app->web_active && app->typing_log_len > 0) {
        size_t start = app->typing_log_len > TYPING_LOG_TAIL ?
                           app->typing_log_len - TYPING_LOG_TAIL :
                           0;
        char line[8 + TYPING_LOG_TAIL + 2];
        snprintf(line, sizeof(line), "Typing: %s", app->typing_log + start);
        canvas_draw_str(canvas, 2, 58, line);
    } else {
        const char* hint;
        if(!app->profile) {
            hint = "Enable BT, then OK";
        } else if(!app->ble_connected) {
            hint = "Pair from Chrome";
        } else if(!app->web_active) {
            hint = "Open web app";
        } else if(!app->usb_ready) {
            hint = "Plug USB into host";
        } else if(typing) {
            hint = "Typing...";
        } else {
            hint = "Use web app";
        }
        canvas_draw_str(canvas, 2, 58, hint);
    }
}

static void app_input_callback(InputEvent* input_event, void* context) {
    App* app = context;
    AppEvent event = {
        .type = AppEventTypeInput,
        .input = *input_event,
    };
    furi_message_queue_put(app->queue, &event, 0);
}

static void app_tick(App* app) {
    uint32_t now = furi_get_tick();

    if(!app->usb_configured && (now - app->last_usb_retry >= USB_RETRY_MS)) {
        app->last_usb_retry = now;
        if(usb_hid_start(app)) {
            ui_update(app, true);
        }
    }

    if(app->usb_configured && (now - app->last_usb_poll >= USB_POLL_MS)) {
        app->last_usb_poll = now;
        bool ready = furi_hal_hid_is_connected();
        if(ready != app->usb_ready) {
            app->usb_ready = ready;
            hid_release_all(app);
            bridge_send_usb(app);
            FURI_LOG_I(TAG, "USB HID %s", ready ? "connected" : "disconnected");
            ui_update(app, true);
        }
    }

    bool web_active = web_client_active(app);
    if(web_active != app->web_active) {
        app->web_active = web_active;
        if(!web_active) {
            hid_release_all(app);
            FURI_LOG_I(TAG, "Web client handshake timed out");
        }
        ui_update(app, true);
    }

    bool has_keys = app->mods != 0;
    for(size_t i = 0; i < MAX_KEYS; i++) {
        if(app->keys[i]) has_keys = true;
    }

    if(has_keys && (now - app->last_rx_tick >= WATCHDOG_MS)) {
        hid_release_all(app);
        FURI_LOG_W(TAG, "Key watchdog released all keys");
        ui_update(app, true);
    }

    if(atomic_exchange(&app->emergency_release, false)) {
        hid_release_all(app);
        ui_update(app, true);
    }
}

static void app_handle_event(App* app, const AppEvent* event) {
    switch(event->type) {
    case AppEventTypeBtConnected:
        app->ble_connected = true;
        app->web_active = false;
        app->last_web_ping_tick = 0;
        app->last_rx_tick = furi_get_tick();
        bt_arm_serial_callback(app);
        bridge_send_ready(app);
        hid_release_all(app);
        FURI_LOG_I(TAG, "Central connected (waiting for web handshake)");
        break;

    case AppEventTypeBtDisconnected:
        app->ble_connected = false;
        app->web_active = false;
        app->last_web_ping_tick = 0;
        hid_release_all(app);
        FURI_LOG_I(TAG, "Central disconnected");
        break;

    case AppEventTypeBtReset:
        app->ble_connected = true;
        app->web_active = false;
        app->last_web_ping_tick = 0;
        bt_arm_serial_callback(app);
        bridge_send_ready(app);
        hid_release_all(app);
        break;

    case AppEventTypeBtData:
        if(control_packet_valid(event->data)) {
            handle_control_packet(app, event->data);
        } else if(keyboard_packet_valid(event->data)) {
            if(web_client_active(app)) {
                hid_apply_packet(app, event->data);
                app->last_rx_tick = furi_get_tick();
            } else {
                hid_release_all(app);
                FURI_LOG_W(TAG, "Ignoring keyboard packet without web handshake");
            }
        } else {
            FURI_LOG_W(TAG, "Bad packet");
        }
        if(app->profile) {
            // Safe here: the BLE callback has already returned.
            ble_profile_serial_notify_buffer_is_empty(app->profile);
        }
        break;

    case AppEventTypeInput:
        if(event->input.key == InputKeyBack && event->input.type == InputTypeShort) {
            app->running = false;
        } else if(event->input.key == InputKeyOk && event->input.type == InputTypeShort) {
            hid_release_all(app);
            if(!app->profile) {
                bt_start(app);
            }
            ui_update(app, true);
        }
        break;
    }
}

int32_t ble_kb_bridge_app(void* context) {
    UNUSED(context);

    App* app = malloc(sizeof(App));
    if(!app) return -1;
    memset(app, 0, sizeof(App));

    app->queue = furi_message_queue_alloc(EVENT_QUEUE_LEN, sizeof(AppEvent));
    if(!app->queue) {
        free(app);
        return -1;
    }

    app->view_port = view_port_alloc();
    view_port_draw_callback_set(app->view_port, app_draw_callback, app);
    view_port_input_callback_set(app->view_port, app_input_callback, app);

    app->gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(app->gui, app->view_port, GuiLayerFullscreen);

    atomic_init(&app->emergency_release, false);
    app->running = true;
    app->last_rx_tick = furi_get_tick();
    app->last_ui_tick = furi_get_tick();
    app->last_usb_retry = furi_get_tick() - USB_RETRY_MS;

    usb_hid_start(app);
    if(!bt_start(app)) {
        FURI_LOG_W(TAG, "BLE unavailable; enable Bluetooth and press OK");
    }

    ui_update(app, true);

    AppEvent event;
    while(app->running) {
        FuriStatus status = furi_message_queue_get(app->queue, &event, 100);
        if(status == FuriStatusOk) {
            app_handle_event(app, &event);
            ui_update(app, false);
        }
        app_tick(app);
    }

    hid_release_all(app);
    bt_stop(app);
    usb_hid_stop(app);

    gui_remove_view_port(app->gui, app->view_port);
    furi_record_close(RECORD_GUI);
    view_port_free(app->view_port);
    furi_message_queue_free(app->queue);
    free(app);

    return 0;
}
