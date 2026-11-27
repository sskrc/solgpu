"""
SolGPU 貸し手エージェント
=========================
GPU を貸し出す人の PC で動かすプログラムです。

  1. GPU の性能をベンチマークで測り、1 分あたりの価格を決める
  2. 出品リンクを表示（Phantom で SolGPU プログラムに出品する）
  3. 借り手が代金をエスクロー（プログラムの口座）に預けたら、専用フォルダで Jupyter Lab と
     公開 URL を用意し、プログラムに「利用開始 (accept)」を記録する
  4. 時間が来たら Jupyter を停止し、「精算 (settle)」して代金を貸し手のウォレットへ送る

エージェントは自分の鍵 (operator, data/operator.json) を持ちますが、プログラムが許すのは
「利用開始」「精算」「URL 更新」だけで、代金の行き先はプログラムで固定されています。

使い方:  README の「GPU を貸す」を参照
"""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from chain import PROGRAM_ID, Chain, build_ix, load_or_create_operator
from runtime import free_port, kill_tree, log, popen_group, run_benchmark, start_tunnel

VERSION = "2"
AGENT_DIR = Path(__file__).resolve().parent
DATA_DIR = AGENT_DIR / "data"
STATE_FILE = DATA_DIR / "state.json"
OPERATOR_FILE = DATA_DIR / "operator.json"
SESSIONS_DIR = AGENT_DIR / "sessions"
SD_DIR = AGENT_DIR / "streamdiffusion"  # StreamDiffusion デモ（streamdiffusion/setup.sh で準備）
SD_NOTEBOOK = "StreamDiffusion.ipynb"
DEVNET_RPC = "https://api.devnet.solana.com"
MAX_MINUTES = 240
MIN_OPERATOR_LAMPORTS = 1_000_000  # 0.001 SOL（accept / settle の手数料用）

LOCK = threading.RLock()


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


def streamdiffusion_ready() -> bool:
    """StreamDiffusion 専用カーネルが Jupyter に登録済みか"""
    return (Path(sys.prefix) / "share" / "jupyter" / "kernels" / "streamdiffusion" / "kernel.json").exists()


class Session:
    def __init__(self, rental: str, data: dict):
        self.rental = rental
        self.data = data  # オンチェーンの Rental アカウントの内容
        self.secret_hash: bytes = data["secret_hash"]
        self.minutes: int = data["minutes"]
        self.status = "starting"  # starting -> ready -> ended / error
        self.error = ""
        self.url = ""
        self.expires_at = 0
        self.settled = ""
        self.jupyter: subprocess.Popen | None = None
        self.tunnel: subprocess.Popen | None = None

    def public(self) -> dict:
        return {
            "status": self.status,
            "error": self.error,
            "url": self.url if self.status == "ready" else "",
            "minutes": self.minutes,
            "expiresAt": self.expires_at,
            "settleSignature": self.settled,
            "now": int(time.time()),
        }


class Agent:
    def __init__(self, args):
        self.args = args
        self.chain = Chain(args.rpc)
        self.state = load_state()
        self.operator = load_or_create_operator(OPERATOR_FILE)
        self.public_url = f"http://127.0.0.1:{args.port}"
        # 出品リンクにだけ含まれる使い捨てのコード（他人が勝手にこのエージェントを自分の出品に紐付けるのを防ぐ）
        self.activation_code = secrets.token_hex(16)
        self.activation_used = False
        self.listing: dict | None = None  # 紐付いている出品（オンチェーンの内容）
        self.session: Session | None = None
        self.sessions: dict[str, Session] = {}
        self.self_tunnel: subprocess.Popen | None = None
        self._balance: int | None = None
        self._balance_at = 0.0
        self._balance_refreshing = False

    # ------------------------------------------------------------ 共通
    @property
    def operator_address(self) -> str:
        return str(self.operator.pubkey())

    def check_secret(self, s: Session, secret: str) -> None:
        if not secrets.compare_digest(hashlib.sha256(secret.encode()).digest(), s.secret_hash):
            raise PermissionError("秘密の値が一致しません（支払った本人のブラウザから操作してください）")

    def operator_balance(self) -> int | None:
        """/info を速く返すため、残高は 30 秒キャッシュし、更新は裏で行う"""
        now = time.time()
        if now - self._balance_at > 30 and not self._balance_refreshing:
            self._balance_refreshing = True

            def refresh():
                try:
                    self._balance = self.chain.balance(self.operator_address)
                    self._balance_at = time.time()
                except Exception:
                    pass
                finally:
                    self._balance_refreshing = False

            threading.Thread(target=refresh, daemon=True).start()
        return self._balance

    def info(self) -> dict:
        b = self.state["bench"]
        op_balance = self.operator_balance()
        return {
            "solgpu": VERSION,
            "programId": str(PROGRAM_ID),
            "agentUrl": self.public_url,
            "gpu": b["gpu"],
            "backend": b["backend"],
            "dtype": b["dtype"],
            "tflops": b["tflops"],
            "lamportsPerMinute": b["lamportsPerMinute"],
            "operator": self.operator_address,
            "operatorBalance": op_balance,
            "listing": self.state.get("listing"),
            "owner": self.listing["owner"] if self.listing else None,
            "busy": bool(self.session and self.session.status in ("starting", "ready")),
            "maxMinutes": MAX_MINUTES,
        }

    # ------------------------------------------------------------ 出品
    def check_code(self, body: dict) -> dict:
        if not secrets.compare_digest(str(body.get("code", "")), self.activation_code):
            raise PermissionError(
                "この出品リンクは古いか、別のエージェントのものです。エージェントの画面に表示されている最新のリンクを開いてください"
            )
        if self.activation_used:
            raise PermissionError("この出品リンクは使用済みです。出品し直すにはエージェントを再起動してください")
        return {"ok": True}

    def activate(self, body: dict) -> dict:
        """Phantom で作成した出品 (Listing) を、このエージェントに紐付ける"""
        self.check_code(body)
        address = str(body.get("listing", ""))
        listing = None
        for _ in range(5):  # 作成直後はまだ見えないことがある
            listing = self.chain.account("Listing", address)
            if listing:
                break
            time.sleep(2)
        if not listing:
            raise ValueError("出品アカウントが見つかりません")
        if listing["operator"] != self.operator_address:
            raise PermissionError("この出品は別のエージェントの鍵を指定しています")
        if listing["agent_url"] != self.public_url:
            raise ValueError("出品の URL がこのエージェントと一致しません（リンクを開き直してください）")
        with LOCK:
            self.activation_used = True
            self.listing = listing
            self.state["listing"] = address
            save_state(self.state)
        log(f"出品と紐付きました: {address}（受取ウォレット {listing['owner']}）")
        return self.info()

    def restore_listing(self) -> None:
        """前回紐付けた出品があれば、新しい URL をオンチェーンに書き込んで受付を再開する"""
        address = self.state.get("listing")
        if not address:
            return
        listing = self.chain.account("Listing", address)
        if not listing or listing["operator"] != self.operator_address:
            log("前回の出品が見つからない（取り下げ済み）ため、紐付けを解除しました")
            self.state.pop("listing", None)
            save_state(self.state)
            return
        self.listing = listing
        self.settle_leftover(address, listing)
        if self.chain.balance(self.operator_address) < MIN_OPERATOR_LAMPORTS:
            log("⚠️ エージェントの鍵の残高が足りないため、URL を更新できません（出品リンクから出品し直してください）")
            return
        try:
            self.chain.send(
                self.operator,
                [build_ix("update_agent", {"authority": self.operator.pubkey(), "listing": address},
                          {"agent_url": self.public_url, "active": True})],
            )
            self.listing = self.chain.account("Listing", address)
            self.activation_used = True  # 既存の出品をそのまま使う
            log(f"前回の出品 {address} の URL を更新し、受付を再開しました")
        except Exception as e:
            log("出品の URL 更新に失敗:", e)

    def settle_leftover(self, address: str, listing: dict) -> None:
        """前回の終了処理が途中だったレンタル（エージェント停止など）があれば精算する"""
        cur = listing["current_rental"]
        if cur == "11111111111111111111111111111111":
            return
        r = self.chain.account("Rental", cur)
        if r and r["status"] == "Active" and self.chain.chain_time() >= r["ends_at"]:
            log("前回の未精算レンタルを精算します…")
            self.settle(cur, r)

    def deactivate(self) -> None:
        if not self.state.get("listing"):
            return
        try:
            self.chain.send(
                self.operator,
                [build_ix("update_agent", {"authority": self.operator.pubkey(), "listing": self.state["listing"]},
                          {"agent_url": self.public_url, "active": False})],
                timeout=20,
            )
            log("出品の受付を停止しました（次回起動時に自動で再開します）")
        except Exception as e:
            log("受付停止の書き込みに失敗（そのままでも問題ありません）:", e)

    # ------------------------------------------------------------ レンタル
    def claim(self, body: dict) -> dict:
        """借り手から「支払った（エスクローに預けた）ので開始して」と依頼される"""
        address = str(body.get("rental", ""))
        secret = str(body.get("secret", ""))
        with LOCK:
            existing = self.sessions.get(address)
        if existing:
            self.check_secret(existing, secret)
            return existing.public()
        if not self.state.get("listing"):
            raise ValueError("このエージェントはまだ出品が完了していません")

        r = None
        for _ in range(5):  # 支払い直後は、RPC のノードによってはまだ見えないことがある
            r = self.chain.account("Rental", address)
            if r:
                break
            time.sleep(2)
        if not r:
            raise ValueError("レンタルが見つかりません（キャンセル・返金・精算済みの可能性があります）")
        if r["listing"] != self.state["listing"]:
            raise ValueError("このレンタルは別の GPU のものです")
        if r["status"] != "Pending":
            raise ValueError("このレンタルはすでに開始されています")
        s = Session(address, r)
        self.check_secret(s, secret)
        if self.chain.chain_time() > r["accept_deadline"] - 20:
            raise ValueError("開始の期限を過ぎています。「マイレンタル」から返金を受けてください")
        with LOCK:
            if self.session and self.session.status in ("starting", "ready"):
                raise ValueError("GPU は別のレンタルで使用中です")
            self.session = s
            self.sessions[address] = s
        log(f"レンタルを受け付けました: {r['minutes']} 分 / 預かり {r['amount'] / 1e9:.6f} SOL / 借り手 {r['renter']}")
        threading.Thread(target=self.run_session, args=(s,), daemon=True).start()
        return s.public()

    def session_status(self, body: dict) -> dict:
        s = self.sessions.get(str(body.get("rental", "")))
        if not s:
            raise ValueError("セッションが見つかりません")
        self.check_secret(s, str(body.get("secret", "")))
        return s.public()

    def run_session(self, s: Session) -> None:
        workdir = SESSIONS_DIR / s.rental[:16]
        accepted = False
        try:
            workdir.mkdir(parents=True, exist_ok=True)
            b = self.state["bench"]
            (workdir / "README_GPU.md").write_text(
                f"# SolGPU GPU レンタル\n\nGPU: {b['gpu']} ({b['backend']})\n\n"
                "```python\nimport torch\n"
                f"device = '{b['backend']}'\n"
                "x = torch.randn(4096, 4096, device=device)\nprint((x @ x).sum())\n```\n\n"
                f"レンタル時間は {s.minutes} 分です。時間になると自動で終了し、このフォルダのファイルは削除されます。\n",
                encoding="utf-8",
            )
            open_path = "lab"
            if streamdiffusion_ready():  # デモ用: StreamDiffusion のノートブックを最初から開く
                for name in (SD_NOTEBOOK, "sd_demo.py"):
                    shutil.copy(SD_DIR / name, workdir / name)
                open_path = f"lab/tree/{SD_NOTEBOOK}"
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

            # GPU 環境の準備ができたので、オンチェーンに「利用開始」を記録（ここから時間を数える）
            self.chain.send(
                self.operator,
                [build_ix("accept", {"operator": self.operator.pubkey(), "listing": self.state["listing"], "rental": s.rental})],
            )
            accepted = True
            s.url = f"{base}/{open_path}?token={token}"
            s.expires_at = int(time.time() + s.minutes * 60)
            s.status = "ready"
            log(f"利用開始: {s.minutes} 分 ({time.strftime('%H:%M:%S', time.localtime(s.expires_at))} まで)")
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
            if not accepted:
                log("利用開始前のエラーのため、借り手は全額返金を受けられます")
        finally:
            kill_tree(s.tunnel)
            kill_tree(s.jupyter)
            for _ in range(10):
                shutil.rmtree(workdir, ignore_errors=True)
                if not workdir.exists():
                    break
                time.sleep(1)
        if accepted:
            self.settle(s.rental, s.data, s)

    def settle(self, address: str, r: dict, s: Session | None = None) -> None:
        """終了時刻を過ぎたら精算（代金はプログラムが貸し手へ送る）。ブロックチェーンの時計が遅れていれば待って再試行"""
        for attempt in range(60):
            try:
                sig = self.chain.send(
                    self.operator,
                    [build_ix("settle", {
                        "caller": self.operator.pubkey(), "listing": self.state["listing"], "rental": address,
                        "owner": r["owner"], "renter": r["renter"],
                    })],
                )
                if s:
                    s.settled = sig
                log(f"精算しました: {r['amount'] / 1e9:.6f} SOL が受取ウォレットに届きました ({sig[:12]}…)")
                return
            except Exception as e:
                if self.chain.account("Rental", address) is None:
                    log("このレンタルはすでに精算済みです")
                    return
                if attempt == 0 or attempt % 6 == 5:
                    log("精算を再試行します:", str(e).splitlines()[0])
                time.sleep(10)
        log("⚠️ 精算できませんでした。Web アプリの「マイレンタル」または出品画面から誰でも精算できます")

    def shutdown(self) -> None:
        if self.session:
            if self.session.status in ("starting", "ready"):
                self.session.status = "ended"
            kill_tree(self.session.tunnel)
            kill_tree(self.session.jupyter)
        self.deactivate()
        kill_tree(self.self_tunnel)


def make_handler(agent: Agent):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send_json(self, code: int, obj: dict):
            data = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
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
                try:
                    return self.send_json(200, agent.info())
                except Exception as e:
                    return self.send_json(500, {"error": str(e)})
            self.send_json(404, {"error": "not found"})

        def do_POST(self):
            routes = {
                "/check-code": agent.check_code,
                "/activate": agent.activate,
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
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    p = argparse.ArgumentParser(description="SolGPU GPU 貸し手エージェント (Devnet)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--site", default="https://sskrc.github.io/solgpu/", help="SolGPU の Web アプリの URL（出品リンク用。ローカル開発時は http://localhost:5173/）")
    p.add_argument("--no-tunnel", action="store_true", help="インターネットに公開せず、この PC 内だけで動かす")
    p.add_argument("--i-understand-the-risk", action="store_true", help="外部公開のリスクを理解したうえで公開する")
    p.add_argument("--rebench", action="store_true", help="ベンチマークをやり直す")
    p.add_argument("--no-browser", action="store_true", help="出品リンクをブラウザで自動的に開かない")
    p.add_argument("--rpc", default=DEVNET_RPC)
    p.add_argument("--data-dir", help="鍵と設定の保存先（テスト用。通常は agent/data）")
    args = p.parse_args()
    if args.data_dir:
        global DATA_DIR, STATE_FILE, OPERATOR_FILE
        DATA_DIR = Path(args.data_dir).resolve()
        STATE_FILE, OPERATOR_FILE = DATA_DIR / "state.json", DATA_DIR / "operator.json"

    # 借り手に GPU 環境を渡すには Jupyter と PyTorch が必要。別の Python で起動されていないか確認
    import importlib.util

    missing = [m for m in ("jupyterlab", "torch") if importlib.util.find_spec(m) is None]
    if missing:
        print(
            f"\n⚠️  この Python ({sys.executable}) には {', '.join(missing)} が入っていません。\n"
            "   エージェントは start.bat（agent フォルダの .venv の Python）から起動してください。\n"
            "   まだ準備していない場合は、先に setup.bat を実行します。\n"
        )
        raise SystemExit(1)

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
    log("StreamDiffusion デモ: " + ("有効（借り手の Jupyter にノートブックを表示）" if streamdiffusion_ready()
                                   else "無効（使うには streamdiffusion/setup.sh を実行）"))
    if args.rebench or "bench" not in agent.state:
        agent.state["bench"] = run_benchmark()
        save_state(agent.state)
    else:
        b = agent.state["bench"]
        log(f"保存済みのベンチマーク: {b['gpu']} {b['tflops']} TFLOPS → {b['lamportsPerMinute']} lamports/分（やり直すには --rebench）")

    class Server(ThreadingHTTPServer):
        # Windows では既定設定だと同じポートを 2 つのエージェントが掴めてしまうので禁止する
        allow_reuse_address = False

    try:
        server = Server(("127.0.0.1", args.port), make_handler(agent))
    except OSError:
        log(f"ポート {args.port} はすでに使われています。別のエージェントが起動中ではありませんか？（別のポートは --port で指定）")
        raise SystemExit(1)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        if not args.no_tunnel:
            log("インターネット公開用のトンネルを作成中…")
            agent.self_tunnel, agent.public_url = start_tunnel(args.port)
        agent.restore_listing()
        site = args.site if args.site.endswith("/") else args.site + "/"
        link = f"{site}#lend?agent={urllib.parse.quote(agent.public_url, safe='')}&code={agent.activation_code}"
        print("\n" + "=" * 70)
        print(" SolGPU エージェント起動完了")
        print(f"   GPU          : {agent.state['bench']['gpu']}")
        print(f"   目安の価格   : {agent.state['bench']['lamportsPerMinute'] / 1e9:.6f} SOL / 分")
        print(f"   エージェント : {agent.public_url}")
        print(f"   エージェント鍵: {agent.operator_address}")
        if agent.listing and agent.activation_used:
            print(f"\n 出品中です（{agent.state['listing']}）。このまま貸し出せます。")
            print(" 出品の管理（取り下げなど）は Web アプリの「GPU を貸す」タブから。")
        else:
            print("\n 次のリンクを Phantom を入れたブラウザで開き、「出品する」を押してください:")
            print(f"   {link}")
            print("   （ブラウザで自動的に開きます。古いリンクは使えません）")
        print("\n 停止するには Ctrl + C")
        print("=" * 70 + "\n", flush=True)
        if not args.no_browser and not (agent.listing and agent.activation_used):
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
