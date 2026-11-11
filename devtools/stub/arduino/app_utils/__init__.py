"""Minimal stand-in for arduino.app_utils, for running App Lab apps on a desktop.

Mimics the real AppController closely enough for the WebUI brick: bricks register
themselves through the @brick decorator, App.run() calls start() on each brick, runs
its execute()/loop() methods in daemon threads, then calls the user loop forever.
"""
import inspect
import logging
import os
import signal
import sys
import threading
import time

__all__ = ["App", "Bridge", "brick", "Logger", "notify", "call", "provide"]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")


class Logger(logging.Logger):
    def __init__(self, name, level=logging.INFO):
        super().__init__(name, level)
        self.parent = logging.getLogger()
        self.propagate = True


_log = Logger("App")


class _AppController:
    def __init__(self):
        self._bricks = []
        self._threads = []
        self._lock = threading.Lock()

    def register(self, b):
        with self._lock:
            if b not in self._bricks:
                self._bricks.append(b)

    def _start(self, b):
        if callable(getattr(b, "start", None)):
            b.start()
        for name, member in inspect.getmembers(type(b), predicate=callable):
            is_exec = getattr(member, "_is_execute", False) or name == "execute"
            is_loop = getattr(member, "_is_loop", False) or name == "loop"
            if not (is_exec or is_loop):
                continue
            method = getattr(b, name)

            def runner(m=method, loop=is_loop):
                try:
                    if loop:
                        while True:
                            m()
                    else:
                        m()
                except Exception:
                    _log.exception("brick worker crashed")

            t = threading.Thread(target=runner, daemon=True, name=f"{type(b).__name__}.{name}")
            t.start()
            self._threads.append(t)

    def run(self, user_loop=None):
        def on_term(signum, frame):
            raise KeyboardInterrupt
        try:
            signal.signal(signal.SIGTERM, on_term)
        except ValueError:
            pass
        for b in list(self._bricks):
            self._start(b)
        try:
            while True:
                if user_loop:
                    user_loop()
                else:
                    time.sleep(1)
        except (KeyboardInterrupt, StopIteration):
            pass
        finally:
            for b in self._bricks:
                if callable(getattr(b, "stop", None)):
                    try:
                        b.stop()
                    except Exception:
                        pass
            time.sleep(0.2)


App = _AppController()


class _Brick:
    def __call__(self, user_class=None):
        if user_class is None:
            return self._decorate
        return self._decorate(user_class)

    def _decorate(self, cls):
        orig = cls.__init__

        def new_init(self_, *a, **kw):
            orig(self_, *a, **kw)
            App.register(self_)

        cls.__init__ = new_init
        return cls

    def execute(self, f=None):
        def d(fn):
            fn._is_execute = True
            return fn
        return d if f is None else d(f)

    def loop(self, f=None):
        def d(fn):
            fn._is_loop = True
            return fn
        return d if f is None else d(f)


brick = _Brick()


class Bridge:
    """Stores providers so tests can call them in-process; there is no MCU.

    Notifications towards the MCU (no Python provider) are kept in `sent`
    (method -> last arguments). With QKART_SIM_BOARD=1 a simulated Modulino
    wheel (sim_board.py) streams IMU / model / button data into the providers.
    """
    providers = {}
    sent = {}
    sim = None

    @staticmethod
    def provide(method_name, handler):
        Bridge.providers[method_name] = handler
        if method_name == "hw" and Bridge.sim is None and os.environ.get("QKART_SIM_BOARD") == "1":
            from . import sim_board
            Bridge.sim = sim_board.SimBoard(Bridge)
            Bridge.sim.start()

    @staticmethod
    def unprovide(method_name):
        Bridge.providers.pop(method_name, None)

    @staticmethod
    def call(method_name, *params, timeout=10):
        if method_name in Bridge.providers:
            return Bridge.providers[method_name](*params)
        raise RuntimeError(f"no provider for {method_name} (stub Bridge)")

    @staticmethod
    def notify(method_name, *params):
        if method_name in Bridge.providers:
            Bridge.providers[method_name](*params)
        else:
            Bridge.sent[method_name] = params


def provide(method_name=None):
    def d(fn):
        Bridge.provide(method_name or fn.__name__, fn)
        return fn
    return d


def notify(method_name=None):
    def d(fn):
        def w(*a):
            Bridge.notify(method_name or fn.__name__, *a)
        return w
    return d


def call(method_name=None, timeout=10):
    def d(fn):
        def w(*a, timeout=timeout):
            return Bridge.call(method_name or fn.__name__, *a, timeout=timeout)
        return w
    return d
