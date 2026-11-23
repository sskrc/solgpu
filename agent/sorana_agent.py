"""
Sorana 貸し手エージェント
=========================
GPU を貸し出す人の PC で動かすプログラムです。

  1. GPU の性能をベンチマークで測り、1 分あたりの価格を決める
  2. 借り手のブラウザから届く「予約」「支払い確認」に応答する
  3. Devnet 上で支払いを確認できたら、専用フォルダで Jupyter Lab を起動し、
     借り手だけが知っている URL を発行する
  4. レンタル時間が終わったら Jupyter（とその中のプログラム）を強制終了する

秘密鍵は一切持ちません。Solana からはデータを「読む」だけです。
出品（オンチェーンへの登録）は、起動時に表示されるリンクから Phantom で署名します。

使い方:  README の「GPU を貸す」を参照
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1"
AGENT_DIR = Path(__file__).resolve().parent
DATA_DIR = AGENT_DIR / "data"
STATE_FILE = DATA_DIR / "state.json"
SESSIONS_DIR = AGENT_DIR / "sessions"

DEVNET_RPC = "https://api.devnet.solana.com"
MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

# 価格ルール（フロントエンドの表示と同じ）: 計測 TFLOPS × 2,000 lamports / 分、最低 10,000 lamports / 分
LAMPORTS_PER_TFLOPS_MINUTE = 2_000
MIN_LAMPORTS_PER_MINUTE = 10_000
MAX_MINUTES = 240
RESERVATION_SECONDS = 5 * 60  # 予約してから支払うまでの猶予
RESERVATION_KEEP_SECONDS = 60 * 60  # 支払い済みの予約を受け付ける期間（使用中で待たされた場合など）
MAX_TX_AGE_SECONDS = 60 * 60

LOCK = threading.RLock()


def log(*args):
    print(time.strftime("[%H:%M:%S]"), *args, flush=True)


# ---------------------------------------------------------------- 状態の保存
def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_state(state: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE_FILE)


# ---------------------------------------------------------------- ベンチマーク
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


# ---------------------------------------------------------------- Solana RPC（読み取りのみ）
def rpc(method: str, params: list, rpc_url: str, retries: int = 5):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    delay = 1.0
    for attempt in range(retries):
        req = urllib.request.Request(rpc_url, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read())
            if "error" in data:
                raise RuntimeError(data["error"].get("message", str(data["error"])))
            return data["result"]
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    raise RuntimeError("RPC retry exhausted")


def get_tx(signature: str, rpc_url: str):
    for _ in range(6):  # 送信直後はまだ見えないことがあるので少し待つ
        tx = rpc(
            "getTransaction",
            [signature, {"encoding": "jsonParsed", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}],
            rpc_url,
        )
        if tx:
            return tx
        time.sleep(2)
    return None


def memos_of(tx) -> list[str]:
    out = []
    for ix in tx["transaction"]["message"]["instructions"]:
        if ix.get("programId") == MEMO_PROGRAM:
            parsed = ix.get("parsed")
            if isinstance(parsed, str):
                out.append(parsed)
    return out


def fee_payer_of(tx) -> str:
    key = tx["transaction"]["message"]["accountKeys"][0]
    return key["pubkey"] if isinstance(key, dict) else key


def received_lamports(tx, address: str) -> int:
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in tx["transaction"]["message"]["accountKeys"]]
    if address not in keys:
        return 0
    i = keys.index(address)
    return tx["meta"]["postBalances"][i] - tx["meta"]["preBalances"][i]


def parse_memo(memos: list[str], kind: str) -> dict | None:
    prefix = f"sorana:v1:{kind}:"
    for m in memos:
        if m.startswith(prefix):
            try:
                return json.loads(m[len(prefix):])
            except json.JSONDecodeError:
                return None
    return None


# ---------------------------------------------------------------- プロセス管理
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


_JOB = None


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


# ---------------------------------------------------------------- レンタルセッション
class Session:
    def __init__(self, signature: str, secret_hash: str, minutes: int, renter: str):
        self.signature = signature
        self.secret_hash = secret_hash
        self.minutes = minutes
        self.renter = renter
        self.status = "starting"  # starting -> ready -> ended / error
        self.error = ""
        self.url = ""
        self.expires_at = 0
        self.jupyter: subprocess.Popen | None = None
        self.tunnel: subprocess.Popen | None = None

    def public(self) -> dict:
        return {
            "status": self.status,
            "error": self.error,
            "url": self.url if self.status == "ready" else "",
            "minutes": self.minutes,
            "expiresAt": self.expires_at,
            "now": int(time.time()),
        }


class Agent:
    def __init__(self, args):
        self.args = args
        self.rpc_url = args.rpc
        self.state = load_state()
        self.state.setdefault("usedSignatures", [])
        self.public_url = f"http://127.0.0.1:{args.port}"
        # 出品リンクにだけ含まれる使い捨てのコード。オンチェーンにはハッシュしか書かないので、
        # 他人が出品トランザクションを真似して受取先を乗っ取ることはできない
        self.activation_code = secrets.token_hex(16)
        self.activation_used = False
        self.reservations: dict[str, dict] = {}  # id -> {created, renter}
        self.session: Session | None = None
        self.sessions_by_sig: dict[str, Session] = {}
        self.self_tunnel: subprocess.Popen | None = None

    # ----- 情報
    def busy_info(self) -> tuple[bool, int]:
        now = time.time()
        if self.session and self.session.status in ("starting", "ready"):
            return True, self.session.expires_at or int(now + self.session.minutes * 60)
        for r in self.reservations.values():
            if not r["paid"] and now - r["created"] < RESERVATION_SECONDS:
                return True, int(r["created"] + RESERVATION_SECONDS)
        return False, 0

    def info(self) -> dict:
        bench = self.state["bench"]
        busy, until = self.busy_info()
        return {
            "sorana": VERSION,
            "agentUrl": self.public_url,
            "gpu": bench["gpu"],
            "backend": bench["backend"],
            "dtype": bench["dtype"],
            "tflops": bench["tflops"],
            "lamportsPerMinute": bench["lamportsPerMinute"],
            "payout": self.state.get("payout"),
            "busy": busy,
            "busyUntil": until,
            "maxMinutes": MAX_MINUTES,
        }

    # ----- 出品の有効化: Phantom で署名された出品トランザクションを確認し、受取アドレスを決める
    def activate(self, body: dict) -> dict:
        sig = str(body.get("signature", ""))
        code = str(body.get("code", ""))
        if not secrets.compare_digest(code, self.activation_code):
            raise PermissionError("認証コードが一致しません（エージェントに表示された最新のリンクを開いてください）")
        if self.activation_used:
            raise PermissionError("この出品リンクは使用済みです。出品し直すにはエージェントを再起動してください")
        tx = get_tx(sig, self.rpc_url)
        if not tx or tx["meta"]["err"]:
            raise ValueError("出品トランザクションが見つからないか、失敗しています")
        memo = parse_memo(memos_of(tx), "list")
        code_hash = hashlib.sha256(code.encode()).hexdigest()
        if not memo or memo.get("agent") != self.public_url or memo.get("codeHash") != code_hash:
            raise ValueError("出品内容がこのエージェントと一致しません（リンクを開き直してください）")
        with LOCK:
            if self.activation_used:
                raise PermissionError("この出品リンクは使用済みです")
            self.activation_used = True
            self.state["payout"] = fee_payer_of(tx)
            self.state["listingSignature"] = sig
            save_state(self.state)
        log(f"出品が有効になりました。受取ウォレット: {self.state['payout']}")
        return self.info()

    # ----- 出品リンクのコードが正しいかを、署名（手数料）の前に確認する
    def check_code(self, body: dict) -> dict:
        if not secrets.compare_digest(str(body.get("code", "")), self.activation_code):
            raise PermissionError(
                "この出品リンクは古いか、別のエージェントのものです。エージェントの画面に表示されている最新のリンクを開いてください"
            )
        if self.activation_used:
            raise PermissionError("この出品リンクは使用済みです。出品し直すにはエージェントを再起動してください")
        return {"ok": True}

    # ----- 予約
    def reserve(self, body: dict) -> dict:
        if not self.state.get("payout"):
            raise ValueError("このGPUはまだ出品が完了していません")
        renter = str(body.get("renter", ""))
        with LOCK:
            # 同じ借り手が支払いをキャンセルして予約し直す場合は、前の未払い予約を取り消す
            # （支払い済みかもしれない古い予約は、後から利用開始できるよう残しておく）
            if renter:
                for k, v in list(self.reservations.items()):
                    if v["renter"] == renter and not v["paid"] and time.time() - v["created"] < RESERVATION_SECONDS:
                        v["paid"] = True  # 「予約中」扱いをやめる（支払い済みならこの ID で claim 可能）
            busy, until = self.busy_info()
            if busy:
                raise ValueError("このGPUは現在使用中か、他の人が予約中です")
            rid = secrets.token_hex(8)
            self.reservations[rid] = {"created": time.time(), "renter": renter, "paid": False}
            # 古い予約を掃除
            for k in [k for k, v in self.reservations.items() if time.time() - v["created"] > RESERVATION_KEEP_SECONDS]:
                del self.reservations[k]
        log(f"予約を受け付けました: {rid}")
        return {
            "reservationId": rid,
            "expiresAt": int(time.time() + RESERVATION_SECONDS),
            "payout": self.state["payout"],
            "lamportsPerMinute": self.state["bench"]["lamportsPerMinute"],
        }

    # ----- 支払い確認 → セッション開始
    def claim(self, body: dict) -> dict:
        sig = str(body.get("signature", ""))
        secret = str(body.get("secret", ""))
        with LOCK:
            existing = self.sessions_by_sig.get(sig)
        if existing:
            if hashlib.sha256(secret.encode()).hexdigest() != existing.secret_hash:
                raise PermissionError("秘密の値が一致しません")
            return existing.public()
        if sig in self.state["usedSignatures"]:
            raise ValueError("この支払いはすでに使用済みです")

        tx = get_tx(sig, self.rpc_url)
        if not tx:
            raise ValueError("支払いトランザクションが見つかりません（少し待って再試行してください）")
        if tx["meta"]["err"]:
            raise ValueError("支払いトランザクションが失敗しています")
        if tx.get("blockTime") and time.time() - tx["blockTime"] > MAX_TX_AGE_SECONDS:
            raise ValueError("支払いから時間が経ちすぎています")
        memo = parse_memo(memos_of(tx), "rent")
        if not memo:
            raise ValueError("レンタル用のメモが見つかりません")
        rid, minutes, h = memo.get("r"), int(memo.get("m", 0)), memo.get("h")
        if hashlib.sha256(secret.encode()).hexdigest() != h:
            raise PermissionError("秘密の値が一致しません（支払った本人のブラウザから操作してください）")
        if not (1 <= minutes <= MAX_MINUTES):
            raise ValueError("レンタル時間が不正です")
        need = minutes * self.state["bench"]["lamportsPerMinute"]
        got = received_lamports(tx, self.state["payout"])
        if got < need:
            raise ValueError(f"支払額が足りません（必要 {need} lamports / 受取 {got} lamports）")

        with LOCK:
            res = self.reservations.get(rid)
            if not res:
                raise ValueError("予約が見つかりません（エージェントが再起動された可能性があります）")
            if self.session and self.session.status in ("starting", "ready"):
                res["paid"] = True  # 予約は保持し、後で再試行できるようにする
                raise ValueError("GPU は別のレンタルで使用中です。終了後に「再試行」で開始できます")
            if sig in self.state["usedSignatures"]:
                raise ValueError("この支払いはすでに使用済みです")
            self.state["usedSignatures"].append(sig)
            save_state(self.state)
            del self.reservations[rid]
            session = Session(sig, h, minutes, fee_payer_of(tx))
            self.session = session
            self.sessions_by_sig[sig] = session
        log(f"支払いを確認: {got / 1e9:.6f} SOL / {minutes} 分 / 借り手 {session.renter}")
        threading.Thread(target=self.run_session, args=(session,), daemon=True).start()
        return session.public()

    def session_status(self, body: dict) -> dict:
        sig = str(body.get("signature", ""))
        secret = str(body.get("secret", ""))
        s = self.sessions_by_sig.get(sig)
        if not s:
            raise ValueError("セッションが見つかりません")
        if hashlib.sha256(secret.encode()).hexdigest() != s.secret_hash:
            raise PermissionError("秘密の値が一致しません")
        return s.public()

    def run_session(self, s: Session) -> None:
        try:
            workdir = SESSIONS_DIR / s.signature[:16]
            workdir.mkdir(parents=True, exist_ok=True)
            (workdir / "README_GPU.md").write_text(
                f"# Sorana GPU レンタル\n\nGPU: {self.state['bench']['gpu']} ({self.state['bench']['backend']})\n\n"
                "```python\nimport torch\n"
                f"device = '{self.state['bench']['backend']}'\n"
                "x = torch.randn(4096, 4096, device=device)\nprint((x @ x).sum())\n```\n\n"
                f"レンタル時間は {s.minutes} 分です。時間になると自動で終了し、保存していないデータは失われます。\n",
                encoding="utf-8",
            )
            port = free_port()
            token = secrets.token_urlsafe(24)
            # 先にトンネルを作り、その URL からのアクセス（ブラウザの Origin）だけを Jupyter に許可する
            if self.args.no_tunnel:
                base = f"http://127.0.0.1:{port}"
            else:
                s.tunnel, base = start_tunnel(port)
            s.jupyter = popen_group(
                [
                    sys.executable, "-m", "jupyterlab",
                    "--no-browser",
                    f"--port={port}",
                    "--ip=127.0.0.1",
                    f"--ServerApp.root_dir={workdir}",
                    f"--IdentityProvider.token={token}",
                    "--ServerApp.allow_remote_access=True",
                    f"--ServerApp.allow_origin={base}",
                    "--ServerApp.terminals_enabled=False",
                ],
                cwd=workdir,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # Jupyter の起動を待つ
            for _ in range(120):
                if s.jupyter.poll() is not None:
                    raise RuntimeError("Jupyter が起動できませんでした")
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/api", timeout=2)
                    break
                except Exception:
                    time.sleep(0.5)
            else:
                raise RuntimeError("Jupyter の起動がタイムアウトしました")

            s.url = f"{base}/lab?token={token}"
            s.expires_at = int(time.time() + s.minutes * 60)  # 使えるようになった時点から課金時間を数える
            s.status = "ready"
            log(f"セッション開始: {s.minutes} 分 ({time.strftime('%H:%M:%S', time.localtime(s.expires_at))} まで)")
            while time.time() < s.expires_at:
                if s.jupyter.poll() is not None:
                    raise RuntimeError("Jupyter が予期せず終了しました")
                time.sleep(1)
            s.status = "ended"
            log("レンタル時間が終了しました。セッションを停止します。")
        except Exception as e:
            s.status = "error"
            s.error = str(e)
            log("セッションでエラー:", e)
        finally:
            kill_tree(s.tunnel)
            kill_tree(s.jupyter)
            # 借り手のファイルを削除（プロセス終了直後はファイルがロックされていることがあるので数回試す）
            for _ in range(10):
                shutil.rmtree(SESSIONS_DIR / s.signature[:16], ignore_errors=True)
                if not (SESSIONS_DIR / s.signature[:16]).exists():
                    break
                time.sleep(1)

    def shutdown(self) -> None:
        if self.session:
            if self.session.status in ("starting", "ready"):
                self.session.status = "ended"
            kill_tree(self.session.tunnel)
            kill_tree(self.session.jupyter)
        kill_tree(self.self_tunnel)


# ---------------------------------------------------------------- HTTP サーバー
def make_handler(agent: Agent):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # アクセスログは表示しない
            pass

        def send_json(self, code: int, obj: dict):
            data = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):  # ブラウザの CORS 事前確認（プリフライト）
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_GET(self):
            if self.path.split("?")[0] in ("/", "/info"):
                return self.send_json(200, agent.info())
            self.send_json(404, {"error": "not found"})

        def do_POST(self):
            routes = {
                "/activate": agent.activate,
                "/check-code": agent.check_code,
                "/reserve": agent.reserve,
                "/claim": agent.claim,
                "/session": agent.session_status,
            }
            fn = routes.get(self.path.split("?")[0])
            if not fn:
                return self.send_json(404, {"error": "not found"})
            try:
                length = min(int(self.headers.get("Content-Length") or 0), 10_000)
                body = json.loads(self.rfile.read(length) or b"{}")
                self.send_json(200, fn(body))
            except PermissionError as e:
                self.send_json(403, {"error": str(e)})
            except ValueError as e:
                self.send_json(400, {"error": str(e)})
            except Exception as e:
                log("エラー:", repr(e))
                self.send_json(500, {"error": f"エージェント内部エラー: {e}"})

    return Handler


def main():
    # 出力先がパイプやファイルでも日本語が化けないようにする
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    p = argparse.ArgumentParser(description="Sorana GPU 貸し手エージェント (Devnet)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--site", default="http://localhost:5173/", help="Sorana の Web アプリの URL（出品リンク用）")
    p.add_argument("--no-tunnel", action="store_true", help="インターネットに公開せず、この PC 内だけで動かす")
    p.add_argument("--i-understand-the-risk", action="store_true", help="外部公開のリスクを理解したうえで公開する")
    p.add_argument("--rebench", action="store_true", help="ベンチマークをやり直す")
    p.add_argument("--no-browser", action="store_true", help="出品リンクをブラウザで自動的に開かない")
    p.add_argument("--rpc", default=DEVNET_RPC)
    args = p.parse_args()

    if not args.no_tunnel and not args.i_understand_the_risk:
        print(
            "\n⚠️  インターネットに公開すると、借りた人はあなたの PC 上で好きなプログラムを実行できます。\n"
            "   （作業フォルダは agent/sessions/ ですが、完全な隔離ではありません。PC 内のファイルや\n"
            "    ネットワークにもアクセスできます）\n"
            "   大事なデータの無い PC で、デモの間だけ起動してください。\n\n"
            "   理解したうえで公開する場合:   --i-understand-the-risk を付けて起動\n"
            "   自分の PC 内だけで試す場合:   --no-tunnel を付けて起動\n"
        )
        raise SystemExit(2)

    agent = Agent(args)
    if args.rebench or "bench" not in agent.state:
        agent.state["bench"] = run_benchmark()
        save_state(agent.state)
    else:
        b = agent.state["bench"]
        log(f"保存済みのベンチマーク: {b['gpu']} {b['tflops']} TFLOPS → {b['lamportsPerMinute']} lamports/分（やり直すには --rebench）")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(agent))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        if not args.no_tunnel:
            log("インターネット公開用のトンネルを作成中…")
            agent.self_tunnel, agent.public_url = start_tunnel(args.port)
        # 以前の受取アドレスは引き継ぐが、URL が変わるので出品（Phantom 署名）は毎回やり直す
        site = args.site if args.site.endswith("/") else args.site + "/"
        link = f"{site}#lend?agent={urllib.parse.quote(agent.public_url, safe='')}&code={agent.activation_code}"
        print("\n" + "=" * 70)
        print(" Sorana エージェント起動完了")
        print(f"   GPU        : {agent.state['bench']['gpu']}")
        print(f"   価格       : {agent.state['bench']['lamportsPerMinute'] / 1e9:.6f} SOL / 分")
        print(f"   エージェント: {agent.public_url}")
        print("\n 次のリンクを Phantom を入れたブラウザで開き、「出品する」を押してください:")
        print(f"   {link}")
        print("   （ブラウザで自動的に開きます。古いリンクは使えません）")
        print("\n 停止するには Ctrl + C")
        print("=" * 70 + "\n", flush=True)
        if not args.no_browser:
            import webbrowser

            webbrowser.open(link)
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log("停止します…")
    finally:
        agent.shutdown()
        server.shutdown()


if __name__ == "__main__":
    main()
