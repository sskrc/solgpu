"""SolGPU エージェントの部品: ログ・ベンチマーク・プロセス管理・Cloudflare Tunnel"""

from __future__ import annotations

import os
import re
import shutil
import signal
import socket
import subprocess
import threading
import time

# 価格ルール（Web アプリの表示と同じ）: 計測 TFLOPS × 2,000 lamports / 分、最低 10,000 lamports / 分
LAMPORTS_PER_TFLOPS_MINUTE = 2_000
MIN_LAMPORTS_PER_MINUTE = 10_000

_JOB = None


def log(*args):
    print(time.strftime("[%H:%M:%S]"), *args, flush=True)


def run_benchmark() -> dict:
    """行列積 (fp16 / GPU が無ければ fp32 CPU) の速度を TFLOPS で測る"""
    try:
        import torch
    except ImportError:
        log("PyTorch が見つかりません。README の手順でインストールしてください。")
        raise SystemExit(1)

    if torch.cuda.is_available():
        backend, device, name = "cuda", torch.device("cuda"), torch.cuda.get_device_name(0)
        sync = torch.cuda.synchronize
    elif hasattr(torch, "xpu") and torch.xpu.is_available():
        backend, device, name = "xpu", torch.device("xpu"), torch.xpu.get_device_name(0)
        sync = torch.xpu.synchronize
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        backend, device, name = "mps", torch.device("mps"), "Apple GPU"
        sync = torch.mps.synchronize
    else:
        import platform

        backend, device, name = "cpu", torch.device("cpu"), f"CPU ({platform.processor() or 'unknown'})"
        sync = lambda: None  # noqa: E731

    dtype = torch.float32 if backend == "cpu" else torch.float16
    n = 2048 if backend == "cpu" else 4096
    log(f"ベンチマーク中: {name} ({backend}, {dtype}, {n}x{n} 行列積)…")
    a = torch.randn(n, n, device=device, dtype=dtype)
    b = torch.randn(n, n, device=device, dtype=dtype)
    for _ in range(3):  # ウォームアップ
        a @ b
    sync()
    iters = 5 if backend == "cpu" else 20
    t0 = time.perf_counter()
    for _ in range(iters):
        a @ b
    sync()
    elapsed = time.perf_counter() - t0
    tflops = 2 * n**3 * iters / elapsed / 1e12
    del a, b
    price = max(MIN_LAMPORTS_PER_MINUTE, round(tflops * LAMPORTS_PER_TFLOPS_MINUTE))
    result = {
        "gpu": name,
        "backend": backend,
        "dtype": str(dtype).replace("torch.", ""),
        "tflops": round(tflops, 2),
        "lamportsPerMinute": price,
        "measuredAt": int(time.time()),
    }
    log(f"結果: {result['tflops']} TFLOPS → {price} lamports/分 ({price / 1e9:.6f} SOL/分)")
    return result


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def kill_tree(proc: subprocess.Popen | None) -> None:
    """プロセスを子プロセスごと終了（Windows では Jupyter のカーネルが残らないよう /T を使う）"""
    if not proc or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception as e:
        log("終了処理でエラー:", e)
        proc.kill()


def _windows_job():
    """Windows のジョブオブジェクト: エージェントが異常終了・ウィンドウを閉じた場合でも、
    起動した Jupyter / cloudflared（とその子プロセス）を OS が自動で終了させる"""
    global _JOB
    if _JOB is not None or os.name != "nt":
        return _JOB
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE

    class BASIC(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
        ]

    class IO(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ("R", "W", "O", "RB", "WB", "OB")]

    class EXT(ctypes.Structure):
        _fields_ = [
            ("Basic", BASIC), ("Io", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    job = k32.CreateJobObjectW(None, None)
    info = EXT()
    info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    ok = k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))  # 9 = ExtendedLimitInformation
    _JOB = (k32, job) if (job and ok) else False
    return _JOB


def popen_group(cmd: list[str], **kw) -> subprocess.Popen:
    if os.name == "nt":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    proc = subprocess.Popen(cmd, **kw)
    if os.name == "nt":
        try:
            job = _windows_job()
            if job:
                k32, h = job
                k32.AssignProcessToJobObject(h, int(proc._handle))  # type: ignore[attr-defined]
        except Exception as e:
            log("ジョブオブジェクトへの登録に失敗:", e)
    return proc


def find_cloudflared() -> str | None:
    found = shutil.which("cloudflared")
    if found:
        return found
    for p in [
        r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
        r"C:\Program Files\cloudflared\cloudflared.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe"),
    ]:
        if os.path.exists(p):
            return p
    return None


def start_tunnel(port: int) -> tuple[subprocess.Popen, str]:
    """Cloudflare の Quick Tunnel で localhost:port を https://xxxx.trycloudflare.com として公開"""
    exe = find_cloudflared()
    if not exe:
        raise RuntimeError("cloudflared が見つかりません（README の手順でインストールしてください）")
    proc = popen_group(
        [exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    url_holder: list[str] = []
    registered = threading.Event()

    def reader():
        for line in proc.stderr:  # type: ignore[union-attr]
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m and not url_holder:
                url_holder.append(m.group(0))
            if "Registered tunnel connection" in line:
                registered.set()

    threading.Thread(target=reader, daemon=True).start()
    # URL の発行と、Cloudflare との接続確立の両方を待つ。
    # （準備前に URL へアクセスすると「存在しない」という DNS 結果がこの PC に
    #   しばらくキャッシュされてしまうため、ここでは自分からアクセスしない）
    deadline = time.time() + 60
    while time.time() < deadline and not (url_holder and registered.is_set()):
        if proc.poll() is not None:
            raise RuntimeError("cloudflared が終了しました")
        time.sleep(0.1)
    if not url_holder:
        kill_tree(proc)
        raise RuntimeError("トンネル URL を取得できませんでした")
    time.sleep(3)  # DNS が行き渡るまで少し待つ
    return proc, url_holder[0]

