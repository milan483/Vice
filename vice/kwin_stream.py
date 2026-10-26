"""Keep one exact KWin window PipeWire feed alive for the capture bridge.

Wire definitions follow KDE's zkde-screencast-unstable-v1.xml (version 6):
https://invent.kde.org/libraries/plasma-wayland-protocols/-/blob/master/src/protocols/zkde-screencast-unstable-v1.xml
This compositor-private protocol is optional. No output/region request is used.
The CLI writes flushed JSON lines; stdout is reserved for those events.
"""
from __future__ import annotations

import argparse
import ctypes as C
import ctypes.util
import json
import os
import select
import signal
import sys
import time
import uuid


class StreamError(RuntimeError):
    pass


class _Interface(C.Structure):
    pass


class _Message(C.Structure):
    _fields_ = [("name", C.c_char_p), ("signature", C.c_char_p),
                ("types", C.POINTER(C.POINTER(_Interface)))]


_Interface._fields_ = [("name", C.c_char_p), ("version", C.c_int),
                      ("method_count", C.c_int), ("methods", C.POINTER(_Message)),
                      ("event_count", C.c_int), ("events", C.POINTER(_Message))]


class _Argument(C.Union):
    _fields_ = [("u", C.c_uint32), ("i", C.c_int32), ("s", C.c_char_p),
                ("o", C.c_void_p), ("n", C.c_uint32), ("h", C.c_int32)]


_PROTOCOL = b"zkde_screencast_unstable_v1"
_stream_methods = (_Message * 1)(_Message(b"close", b"", None))
_stream_events = (_Message * 4)(
    _Message(b"closed", b"", None), _Message(b"created", b"u", None),
    _Message(b"failed", b"s", None), _Message(b"serial", b"6uu", None))
_stream_interface = _Interface(b"zkde_screencast_stream_unstable_v1", 6,
                               1, _stream_methods, 4, _stream_events)
# All requests are described to keep opcode and version metadata faithful to XML.
_manager_methods = (_Message * 6)(
    _Message(b"stream_output", b"nou", None),
    _Message(b"stream_window", b"nsu", None),
    _Message(b"destroy", b"", None),
    _Message(b"stream_virtual_output", b"2nsiifu", None),
    _Message(b"stream_region", b"3niiuufu", None),
    _Message(b"stream_virtual_output_with_description", b"4nssiifu", None))
_manager_interface = _Interface(_PROTOCOL, 6, 6, _manager_methods, 0, None)
# libwayland consults the types array for new_id arguments during marshaling.
_window_types = (C.POINTER(_Interface) * 3)(C.pointer(_stream_interface), None, None)
_manager_methods[1].types = _window_types


def _load_library():
    # Wrapped applications (including Nix) can supply the library through
    # LD_LIBRARY_PATH without a system ldconfig entry.
    name = ctypes.util.find_library("wayland-client") or "libwayland-client.so.0"
    try:
        lib = C.CDLL(name, use_errno=True)
        signatures = {
            "wl_display_connect": ([C.c_char_p], C.c_void_p),
            "wl_display_disconnect": ([C.c_void_p], None),
            "wl_display_get_fd": ([C.c_void_p], C.c_int),
            "wl_display_dispatch_pending": ([C.c_void_p], C.c_int),
            "wl_display_prepare_read": ([C.c_void_p], C.c_int),
            "wl_display_cancel_read": ([C.c_void_p], None),
            "wl_display_read_events": ([C.c_void_p], C.c_int),
            "wl_display_flush": ([C.c_void_p], C.c_int),
            "wl_display_get_error": ([C.c_void_p], C.c_int),
            "wl_proxy_destroy": ([C.c_void_p], None),
            "wl_proxy_add_listener": ([C.c_void_p, C.POINTER(C.c_void_p), C.c_void_p], C.c_int),
            "wl_proxy_marshal_array_flags": ([C.c_void_p, C.c_uint32,
                C.POINTER(_Interface), C.c_uint32, C.c_uint32, C.POINTER(_Argument)], C.c_void_p),
        }
        for symbol, (args, result) in signatures.items():
            fn = getattr(lib, symbol)
            fn.argtypes, fn.restype = args, result
        return lib
    except (OSError, AttributeError) as exc:
        raise StreamError(f"Cannot load compatible libwayland-client: {exc}") from exc


class WindowStream:
    """Single-threaded Wayland owner; listener callbacks live until disconnect."""

    def __init__(self, emit=None):
        self.lib = _load_library()
        self.display = None
        self.registry = self.manager = self.stream = None
        self.version = self.global_name = 0
        self.created = self.finished = False
        self.emit = emit or (lambda event: None)
        self._listeners = []

    def _request(self, proxy, opcode, interface=None, version=1, args=(), destroy=False):
        array = (_Argument * len(args))(*args) if args else None
        return self.lib.wl_proxy_marshal_array_flags(
            proxy, opcode, C.pointer(interface) if interface is not None else None,
            version, int(destroy), array)

    def _listen(self, proxy, callbacks):
        listener = (C.c_void_p * len(callbacks))(
            *(C.cast(cb, C.c_void_p).value for cb in callbacks))
        self._listeners.append((callbacks, listener))
        if self.lib.wl_proxy_add_listener(proxy, listener, None) != 0:
            raise StreamError("Cannot install Wayland listener")

    def _pump(self, timeout):
        lib, display = self.lib, self.display
        if lib.wl_display_dispatch_pending(display) < 0:
            raise StreamError("KWin Wayland connection lost")
        while lib.wl_display_prepare_read(display) != 0:
            if lib.wl_display_dispatch_pending(display) < 0:
                raise StreamError("KWin Wayland connection lost")
        try:
            import errno
            flushed = lib.wl_display_flush(display)
            if flushed < 0 and C.get_errno() != errno.EAGAIN:
                raise StreamError("Cannot flush KWin Wayland connection")
            fd = lib.wl_display_get_fd(display)
            readable, writable, _ = select.select([fd], [fd] if flushed < 0 else [], [], timeout)
        except BaseException:
            lib.wl_display_cancel_read(display)
            raise
        if readable:
            if lib.wl_display_read_events(display) < 0:
                raise StreamError("KWin Wayland connection lost")
        else:
            lib.wl_display_cancel_read(display)
        if writable and lib.wl_display_flush(display) < 0 and C.get_errno() != errno.EAGAIN:
            raise StreamError("Cannot flush KWin Wayland connection")
        if lib.wl_display_dispatch_pending(display) < 0:
            raise StreamError("KWin Wayland connection lost")

    def discover(self, timeout=1.0):
        self.display = self.lib.wl_display_connect(None)
        if not self.display:
            raise StreamError("Cannot connect to the Wayland compositor")
        registry_interface = _Interface.in_dll(self.lib, "wl_registry_interface")
        callback_interface = _Interface.in_dll(self.lib, "wl_callback_interface")
        self.registry = self._request(self.display, 1, registry_interface, args=(_Argument(o=None),))
        if not self.registry:
            raise StreamError("Cannot create Wayland registry")
        global_cb = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p, C.c_uint32, C.c_char_p, C.c_uint32)
        remove_cb = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p, C.c_uint32)

        def added(data, proxy, name, interface, version):
            if interface == _PROTOCOL:
                self.global_name, self.version = name, min(version, 6)

        def removed(data, proxy, name):
            if name == self.global_name:
                self.global_name = 0

        self._listen(self.registry, [global_cb(added), remove_cb(removed)])
        sync = self._request(self.display, 0, callback_interface, args=(_Argument(o=None),))
        done = [False]
        done_cb = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p, C.c_uint32)

        def synced(data, proxy, serial):
            done[0] = True
            self.lib.wl_proxy_destroy(proxy)

        if not sync:
            raise StreamError("Cannot synchronize Wayland registry")
        self._listen(sync, [done_cb(synced)])
        deadline = time.monotonic() + timeout
        while not done[0]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise StreamError("Timed out reading KWin screencast capabilities")
            self._pump(remaining)
        if not self.global_name or self.version < 1:
            raise StreamError("Compositor does not expose the KWin window screencast protocol")
        return self.version

    def start(self, window_uuid, cursor="hidden"):
        # Validate input without changing the exact KWin identifier supplied by caller.
        uuid.UUID(window_uuid.strip("{}"))
        if cursor not in ("hidden", "embedded"):
            raise ValueError("cursor must be hidden or embedded")
        self.manager = self._request(self.registry, 0, _manager_interface, self.version,
            (_Argument(u=self.global_name), _Argument(s=_PROTOCOL),
             _Argument(u=self.version), _Argument(o=None)))
        if not self.manager:
            raise StreamError("Cannot bind KWin screencast protocol")
        self.stream = self._request(self.manager, 1, _stream_interface, self.version,
            (_Argument(o=None), _Argument(s=window_uuid.encode("utf-8")),
             _Argument(u=1 if cursor == "hidden" else 2)))
        if not self.stream:
            raise StreamError("Cannot request the KWin window stream")
        empty_cb = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p)
        created_cb = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p, C.c_uint32)
        failed_cb = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p, C.c_char_p)
        serial_cb = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p, C.c_uint32, C.c_uint32)

        def closed(data, proxy):
            self.finished = True
            self.emit({"event": "closed"})

        def created(data, proxy, node):
            self.created = True
            self.emit({"event": "created", "node_id": node})

        def failed(data, proxy, message):
            self.finished = True
            self.emit({"event": "failed", "message": (message or b"").decode("utf-8", "replace")})

        def serial(data, proxy, high, low):
            self.emit({"event": "serial", "serial": (high << 32) | low})

        self._listen(self.stream, [empty_cb(closed), created_cb(created),
                                   failed_cb(failed), serial_cb(serial)])

    def run(self, stop, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not self.finished and not stop():
            if not self.created and time.monotonic() >= deadline:
                raise StreamError("Timed out waiting for the KWin window stream")
            self._pump(min(0.25, max(0, deadline - time.monotonic())) if not self.created else 0.25)

    def close(self):
        if self.display:
            # Destructors release the PipeWire stream before disconnecting.
            if self.stream:
                self._request(self.stream, 0, version=self.version, destroy=True)
            if self.manager:
                self._request(self.manager, 2, version=self.version, destroy=True)
            self.lib.wl_display_flush(self.display)
            self.lib.wl_display_disconnect(self.display)
            self.display = self.registry = self.manager = self.stream = None
            self._listeners.clear()


_available_until = 0.0
_available_environment = None


def is_available() -> bool:
    """Probe the registry only; cache successes briefly, never cache failures."""
    global _available_until, _available_environment
    environment = (os.environ.get("WAYLAND_DISPLAY"), os.environ.get("XDG_RUNTIME_DIR"))
    if not environment[0]:
        return False
    if environment == _available_environment and time.monotonic() < _available_until:
        return True
    connection = None
    try:
        connection = WindowStream()
        connection.discover(timeout=0.75)
        _available_environment = environment
        _available_until = time.monotonic() + 10
        return True
    except (StreamError, OSError, ValueError):
        return False
    finally:
        if connection:
            connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("uuid", nargs="?")
    parser.add_argument("--window", dest="window")
    parser.add_argument("--cursor", choices=("hidden", "embedded"), default="hidden")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if args.check:
        available = is_available()
        print(json.dumps({"available": available}), flush=True)
        return 0 if available else 1
    target = args.window or args.uuid
    if not target:
        parser.error("a window UUID is required")
    stopped = [False]
    def stop(signum, frame):
        stopped[0] = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    connection = None
    def emit(event):
        print(json.dumps(event), flush=True)
    try:
        connection = WindowStream(emit)
        connection.discover()
        connection.start(target, args.cursor)
        connection.run(lambda: stopped[0])
        return 0
    except (StreamError, OSError, ValueError) as exc:
        emit({"event": "failed", "message": str(exc)})
        return 1
    finally:
        if connection:
            connection.close()


if __name__ == "__main__":
    sys.exit(main())
